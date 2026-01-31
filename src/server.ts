import express from 'express';
import swaggerUi from 'swagger-ui-express';
import { config } from './config';
import Database from './database/database';
import InitService from './services/InitService';
import { openApiSpec } from './openapi';

// Middleware
import { corsMiddleware } from './middleware/cors';
import { requestLogger } from './middleware/logger';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { createRateLimiter } from './middleware/rateLimit';

// Routes
import guidesRouter from './routes/guides';
import gamesRouter from './routes/games';
import healthRouter from './routes/health';
import adminRouter from './routes/admin';
import aiRouter from './routes/ai';
import bookmarksRouter from './routes/bookmarks';
import notesRouter from './routes/notes';

async function main() {
  console.log('='.repeat(50));
  console.log('GameFAQs Server');
  console.log('='.repeat(50));

  // Initialize database
  console.log('[Server] Initializing database...');
  Database.initialize(config.dbPath);

  // Create Express app
  const app = express();

  // Apply middleware
  app.use(corsMiddleware);
  app.use(express.json());
  app.use(requestLogger);
  app.use((req, res, next) => {
    if (req.path === '/api-docs' || req.path === '/api-docs/') {
      process.stdout.write(`[${new Date().toISOString()}] [Trace] request reached stack, path=${req.path}\n`);
    }
    next();
  });

  // API documentation (Swagger UI). Register exact path BEFORE use() so /api-docs isn't
  // redirected to /api-docs/ by static middleware (which would loop with a redirect back).
  app.get('/api-docs/spec.json', (req, res) => {
    console.log(`[${new Date().toISOString()}] [ApiDocs] Serving spec.json`);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(openApiSpec));
  });
  app.get('/api-docs', (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const t = () => new Date().toISOString();
    process.stdout.write(`[${t()}] [ApiDocs] ENTER GET /api-docs\n`);
    res.once('finish', () => process.stdout.write(`[${t()}] [ApiDocs] response finished GET /api-docs\n`));
    res.once('close', () => {
      if (!res.writableEnded) process.stdout.write(`[${t()}] [ApiDocs] response closed without finish GET /api-docs\n`);
    });
    try {
      const h = swaggerUi.setup(openApiSpec, { customSiteTitle: 'GameFAQs API' }) as express.RequestHandler[] | express.RequestHandler;
      const handler = Array.isArray(h) ? h[0] : h;
      process.stdout.write(`[${t()}] [ApiDocs] calling setup handler\n`);
      (handler as express.RequestHandler)(req, res, (err: unknown) => {
        process.stdout.write(`[${t()}] [ApiDocs] setup handler called next()\n`);
        next(err);
      });
      process.stdout.write(`[${t()}] [ApiDocs] setup handler returned (sync)\n`);
    } catch (err) {
      process.stdout.write(`[${t()}] [ApiDocs] ERROR in GET /api-docs: ${err}\n`);
      next(err);
    }
  });
  app.get('/api-docs/', (req: express.Request, res: express.Response, next: express.NextFunction) => {
    process.stdout.write(`[${new Date().toISOString()}] [ApiDocs] ENTER GET /api-docs/\n`);
    try {
      const h = swaggerUi.setup(openApiSpec, { customSiteTitle: 'GameFAQs API' }) as express.RequestHandler[] | express.RequestHandler;
      const handler = Array.isArray(h) ? h[0] : h;
      (handler as express.RequestHandler)(req, res, next);
    } catch (err) {
      console.error('[ApiDocs] ERROR in GET /api-docs/:', err);
      next(err);
    }
  });
  app.use(
    '/api-docs',
    (req, res, next) => {
      console.log(`[${new Date().toISOString()}] [ApiDocs] serve: ${req.method} ${req.originalUrl}`);
      next();
    },
    ...(swaggerUi.serve as express.RequestHandler[])
  );

  // API Routes
  app.use('/api/guides', guidesRouter);
  app.use('/api/guides/:guideId/bookmarks', bookmarksRouter);
  app.use('/api/guides/:guideId/notes', notesRouter);
  app.use('/api/games', gamesRouter);
  app.use('/api/health', healthRouter);
  // Rate limit admin routes (100 requests per minute per IP)
  app.use('/api/admin', createRateLimiter({ windowMs: 60_000, max: 100 }), adminRouter);
  app.use('/api/ai', aiRouter);

  // Redirect root to admin panel
  app.get('/', (req, res) => {
    res.redirect('/api/admin/panel');
  });

  // Also serve admin panel at /admin for convenience
  app.get('/admin', (req, res) => {
    res.redirect('/api/admin/panel');
  });

  // GET /api - simple index so /api isn't 404
  app.get('/api', (req, res) => {
    res.json({
      message: 'GameFAQs API',
      links: {
        docs: '/api-docs',
        health: '/api/health',
        guides: '/api/guides',
        games: '/api/games',
        admin: '/api/admin/panel',
      },
    });
  });

  // Swagger UI assets at root (browser sometimes requests /swagger-ui.css etc. when doc is at /api-docs)
  app.use(...(swaggerUi.serveFiles(openApiSpec, {}) as express.RequestHandler[]));

  // Favicon - 204 so browser stops requesting
  app.get('/favicon.ico', (req, res) => res.status(204).end());

  // Error handling
  app.use(notFoundHandler);
  app.use(errorHandler);

  // Start server
  const server = app.listen(config.port, config.host, () => {
    console.log(`[${new Date().toISOString()}] [Server] Listening on http://${config.host}:${config.port}`);
    console.log(`[Server] API docs: http://${config.host}:${config.port}/api-docs`);
    console.log(`[Server] Admin panel: http://${config.host}:${config.port}/admin`);
    console.log(`[Server] API: http://${config.host}:${config.port}/api`);
    console.log(`[Server] ApiDocs routes: GET /api-docs/spec.json, GET /api-docs/, use /api-docs (serve), GET /api-docs (setup)`);
  });

  // Start initialization in background
  console.log('[Server] Starting initialization check...');
  InitService.initialize().catch(error => {
    console.error('[Server] Initialization failed:', error);
    // Don't exit - server can still respond to health checks
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n[Server] Shutting down...');

    server.close(() => {
      console.log('[Server] HTTP server closed');
    });

    Database.close();
    console.log('[Server] Database closed');

    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Run the server
main().catch(error => {
  console.error('[Server] Fatal error:', error);
  process.exit(1);
});
