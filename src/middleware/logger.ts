import { Request, Response, NextFunction } from 'express';

function ts(): string {
  return new Date().toISOString();
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  const pathWithQuery =
    Object.keys(req.query || {}).length > 0
      ? `${req.path}?${new URLSearchParams(req.query as Record<string, string>).toString()}`
      : req.path;

  console.log(`[${ts()}] [Request] ${req.method} ${pathWithQuery}`);

  res.on('finish', () => {
    const duration = Date.now() - start;
    const status = res.statusCode;

    const statusColor =
      status >= 500 ? '\x1b[31m' :
      status >= 400 ? '\x1b[33m' :
      status >= 300 ? '\x1b[36m' :
      '\x1b[32m';
    const reset = '\x1b[0m';

    const slow = duration > 2000 ? ' \x1b[33m(SLOW)\x1b[0m' : '';
    console.log(
      `[${ts()}] [Response] ${req.method} ${pathWithQuery} ${statusColor}${status}${reset} ${duration}ms${slow}`
    );

    if (status === 404) {
      console.warn(`[${ts()}] [404] No route for ${req.method} ${req.originalUrl}`);
    }
  });

  res.on('close', () => {
    if (!res.writableEnded) {
      const duration = Date.now() - start;
      console.warn(
        `[${ts()}] [Closed] ${req.method} ${pathWithQuery} - client disconnected before response (${duration}ms)`
      );
    }
  });

  next();
}
