import cors from 'cors';
import { config } from '../config';

// CORS configuration for the GameFAQs server
export const corsMiddleware = cors({
  // In production, restrict to CORS_ORIGIN if set (comma-separated list); otherwise allow all (for dev)
  origin:
    process.env.NODE_ENV === 'production' && config.corsOrigin?.trim()
      ? config.corsOrigin.split(',').map((o) => o.trim()).filter(Boolean)
      : true,

  // Allow credentials (cookies, authorization headers)
  credentials: true,

  // Allowed HTTP methods
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],

  // Allowed headers
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'Accept',
    'Origin',
  ],

  // Expose these headers to the client
  exposedHeaders: [
    'Content-Disposition',
    'Content-Length',
  ],

  // Cache preflight requests for 24 hours
  maxAge: 86400,
});
