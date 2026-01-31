import { Request, Response, NextFunction } from 'express';
import { config } from '../config';

interface ApiError extends Error {
  statusCode?: number;
  code?: string;
}

export function errorHandler(
  err: ApiError,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Log error
  console.error(`[${new Date().toISOString()}] [Error]`, {
    message: err.message,
    code: err.code,
    stack: config.isDev ? err.stack : undefined,
    path: req.path,
    method: req.method,
  });

  // Determine status code
  const statusCode = err.statusCode || 500;

  // Send error response
  res.status(statusCode).json({
    error: {
      message: err.message || 'Internal server error',
      code: err.code,
      ...(config.isDev && { stack: err.stack }),
    },
  });
}

// 404 handler for unknown routes
export function notFoundHandler(req: Request, res: Response): void {
  console.warn(`[${new Date().toISOString()}] [404] Not found: ${req.method} ${req.originalUrl}`);
  res.status(404).json({
    error: {
      message: 'Not found',
      path: req.path,
      url: req.originalUrl,
    },
  });
}
