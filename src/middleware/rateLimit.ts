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
 * Memory: O(active_ips * max). Eviction is amortized — each request prunes its
 * own IP's stale timestamps. A long-idle IP keeps its entry until it makes
 * another request, but stops accumulating memory for new requests.
 */
export function createSlidingWindowRateLimiter(options: { windowMs: number; max: number }) {
  const { windowMs, max } = options;
  const store = new Map<string, number[]>();

  return function slidingRateLimit(req: Request, res: Response, next: NextFunction): void {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const cutoff = now - windowMs;

    let timestamps = store.get(ip);
    if (!timestamps) {
      timestamps = [];
      store.set(ip, timestamps);
    }
    // Drop stale entries
    while (timestamps.length > 0 && timestamps[0] < cutoff) {
      timestamps.shift();
    }

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
