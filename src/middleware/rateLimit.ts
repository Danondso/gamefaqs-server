import { Request, Response, NextFunction } from 'express';

interface WindowEntry {
  count: number;
  resetAt: number;
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
