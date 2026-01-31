import cors from 'cors';

// CORS configuration for the GameFAQs server
export const corsMiddleware = cors({
  // Allow all origins for development, can be restricted in production
  origin: true,

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
