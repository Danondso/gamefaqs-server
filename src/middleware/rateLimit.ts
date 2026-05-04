import { Request, Response, NextFunction } from 'express';

interface WindowEntry {
  count: number;
  resetAt: number;
}

/**
 * Sliding-window rate limiter: tracks request timestamps per IP and counts how
 * many fall within the trailing window. More accurate than fixed-window for
 * spiky traffic (no "free" allotment at the boundary). On limit, responds with
 * 429 and a `retryAfter` (seconds until the oldest in-window request ages out).
 *
 * Memory: O(active_ips * max). Each request prunes its own IP's stale
 * timestamps in a single splice (no per-shift O(n) churn), and a periodic
 * sweep drops entries whose timestamps have all aged out so a long-idle or
 * one-shot scanner doesn't accumulate forever.
 */
export function createSlidingWindowRateLimiter(options: {
  windowMs: number;
  max: number;
  // Cadence for the inactive-IP sweep. Defaults to windowMs (one sweep per
  // window is plenty — sweep work is amortized over many requests).
  sweepIntervalMs?: number;
}) {
  const { windowMs, max } = options;
  const sweepIntervalMs = options.sweepIntervalMs ?? windowMs;
  const store = new Map<string, number[]>();
  let lastSweep = Date.now();

  const sweep = (now: number): void => {
    const cutoff = now - windowMs;
    for (const [ip, timestamps] of store) {
      // An entry is removable when every timestamp has aged past the cutoff.
      // Since timestamps are appended in order, checking the tail is enough.
      if (timestamps.length === 0 || timestamps[timestamps.length - 1] < cutoff) {
        store.delete(ip);
      }
    }
    lastSweep = now;
  };

  return function slidingRateLimit(req: Request, res: Response, next: NextFunction): void {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const cutoff = now - windowMs;

    if (now - lastSweep > sweepIntervalMs) {
      sweep(now);
    }

    let timestamps = store.get(ip);
    if (!timestamps) {
      timestamps = [];
      store.set(ip, timestamps);
    }
    // Find the first non-stale index and drop the prefix in a single splice
    // — array.shift() in a loop is O(n) per shift, which gets ugly quickly
    // when `max` is large.
    let firstFresh = 0;
    while (firstFresh < timestamps.length && timestamps[firstFresh] < cutoff) {
      firstFresh++;
    }
    if (firstFresh > 0) timestamps.splice(0, firstFresh);

    if (timestamps.length >= max) {
      const retryAfter = Math.max(1, Math.ceil((timestamps[0] + windowMs - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({
        error: 'Rate limit exceeded',
        retryAfter,
      });
      return;
    }

    timestamps.push(now);
    next();
  };
}

/**
 * Simple in-memory rate limiter. Use for admin or sensitive routes.
 * Resets after windowMs; rejects with 429 when count exceeds max per window per IP.
 */
export function createRateLimiter(options: {
  windowMs: number;
  max: number;
}) {
  const { windowMs, max } = options;
  const store = new Map<string, WindowEntry>();

  return function rateLimit(req: Request, res: Response, next: NextFunction): void {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    let entry = store.get(ip);

    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      store.set(ip, entry);
    }

    entry.count += 1;

    if (entry.count > max) {
      res.status(429).json({
        error: 'Too many requests',
        retryAfter: Math.ceil((entry.resetAt - now) / 1000),
      });
      return;
    }

    next();
  };
}
