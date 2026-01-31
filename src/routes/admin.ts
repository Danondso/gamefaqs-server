import { Router, Request, Response, NextFunction } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import InitService from '../services/InitService';
import OllamaService from '../services/OllamaService';
import GuideModel from '../models/Guide';
import GameModel from '../models/Game';
import Database from '../database/database';
import { config } from '../config';
import type { GuideMetadata, Guide } from '../types';

const router = Router();

// Login page shown when ADMIN_TOKEN is set but request has no valid token
const loginPageHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin Login – GameFAQs Server</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      background: #1e293b;
      border-radius: 12px;
      padding: 32px;
      border: 1px solid #334155;
      width: 100%;
      max-width: 360px;
    }
    h1 { font-size: 1.5rem; margin-bottom: 8px; color: #fff; }
    p { color: #94a3b8; font-size: 0.875rem; margin-bottom: 24px; }
    label { display: block; font-size: 0.875rem; color: #94a3b8; margin-bottom: 8px; }
    input {
      width: 100%;
      padding: 12px 16px;
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 8px;
      color: #e2e8f0;
      font-size: 1rem;
      margin-bottom: 20px;
    }
    input:focus { outline: none; border-color: #3b82f6; }
    button {
      width: 100%;
      padding: 12px;
      background: #3b82f6;
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
    }
    button:hover { background: #2563eb; }
    .error { color: #ef4444; font-size: 0.875rem; margin-top: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Admin login</h1>
    <p>Enter the admin token to access the dashboard.</p>
    <form id="loginForm" method="get" action="/api/admin/panel">
      <label for="token">Admin token</label>
      <input type="password" id="token" name="token" placeholder="Token" required autofocus />
      <div id="error" class="error" style="display: none;"></div>
      <button type="submit">Continue</button>
    </form>
  </div>
</body>
</html>
`;

// Admin authentication middleware (optional)
const adminAuth = (req: Request, res: Response, next: NextFunction) => {
  if (!config.adminToken) {
    next();
    return;
  }

  const token = req.headers.authorization?.replace('Bearer ', '') || (req.query.token as string);

  if (token === config.adminToken) {
    next();
    return;
  }

  // No valid token: for panel HTML request, show login page instead of 401
  const isPanelRequest = req.method === 'GET' && (req.path === '/panel' || req.path === '/');
  const wantsHtml = req.accepts('html') || !req.accepts('json');
  if (isPanelRequest && wantsHtml) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(loginPageHtml);
    return;
  }

  res.status(401).json({ error: 'Unauthorized' });
};

// Apply auth to all admin routes
router.use(adminAuth);

// GET /api/admin/status - Get detailed server status
router.get('/status', (req: Request, res: Response, next: NextFunction) => {
  try {
    const initStatus = InitService.getStatus();
    const guideCount = GuideModel.getTotalCount();
    const gameCount = GameModel.getTotalCount();

    // Get database size if possible
    let dbSizeMB = 0;
    try {
      if (fs.existsSync(config.dbPath)) {
        const dbStats = fs.statSync(config.dbPath);
        dbSizeMB = parseFloat((dbStats.size / 1024 / 1024).toFixed(2));
      }
    } catch (err) {
      // Ignore errors
    }

    res.json({
      init: initStatus,
      database: {
        guides: guideCount,
        games: gameCount,
        sizeMB: dbSizeMB,
      },
      server: {
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        nodeVersion: process.version,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/admin/stats - Get statistics
router.get('/stats', (req: Request, res: Response, next: NextFunction) => {
  try {
    const formatStats = Database.query<{ format: string; count: number }>(`
      SELECT format, COUNT(*) as count
      FROM guides
      GROUP BY format
    `);

    const recentGuides = GuideModel.findAllSummary(10, 0);

    const gamesWithGuides = Database.get<{ count: number }>(`
      SELECT COUNT(DISTINCT game_id) as count
      FROM guides
      WHERE game_id IS NOT NULL
    `);

    const stats = {
      guides: {
        total: GuideModel.getTotalCount(),
        byFormat: formatStats,
        recentlyAdded: recentGuides,
      },
      games: {
        total: GameModel.getTotalCount(),
        withGuides: gamesWithGuides?.count || 0,
      },
    };

    res.json(stats);
  } catch (error) {
    next(error);
  }
});

// GET /api/admin/status/stream - Server-Sent Events for live progress
router.get('/status/stream', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

  // Send current status immediately
  res.write(`data: ${JSON.stringify(InitService.getStatus())}\n\n`);

  // Subscribe to status updates
  const unsubscribe = InitService.onStatusChange((status) => {
    res.write(`data: ${JSON.stringify(status)}\n\n`);
  });

  // Send keepalive every 15 seconds
  const keepaliveInterval = setInterval(() => {
    res.write(`: keepalive\n\n`);
  }, 15000);

  // Cleanup on disconnect
  req.on('close', () => {
    clearInterval(keepaliveInterval);
    unsubscribe();
  });
});

// POST /api/admin/ai/batch - Start batch AI analysis
router.post('/ai/batch', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Check if batch is already running
    if (OllamaService.isBatchRunning()) {
      res.status(409).json({ error: 'Batch analysis already in progress' });
      return;
    }

    // Check Ollama availability with timeout
    let status = { available: false, error: 'Check pending' };
    try {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Ollama check timeout')), 3000)
      );
      status = await Promise.race([
        OllamaService.checkAvailability(),
        timeoutPromise
      ]) as typeof status;
    } catch (err: any) {
      status = { available: false, error: err.message };
    }

    if (!status.available) {
      res.status(503).json({
        error: 'Ollama service unavailable',
        details: status.error,
      });
      return;
    }

    const { guideIds } = req.body;

    if (!guideIds || !Array.isArray(guideIds) || guideIds.length === 0) {
      res.status(400).json({ error: 'guideIds array is required' });
      return;
    }

    const safeIds = guideIds.slice(0, 100); // Limit to 100 guides max

    // Respond immediately
    res.json({
      success: true,
      message: 'Batch analysis starting...',
      total: safeIds.length,
    });

    console.log(`[Admin] Starting batch AI analysis for ${safeIds.length} guides`);

    // Run batch processing in background
    setImmediate(async () => {
      try {
        // Fetch guides by ID (fast - uses primary key)
        const guides = safeIds
          .map(id => GuideModel.findById(id))
          .filter((g): g is NonNullable<typeof g> => g !== null);

        if (guides.length === 0) {
          console.log(`[Admin] No valid guides found`);
          return;
        }

        console.log(`[Admin] Found ${guides.length} guides, starting analysis...`);

        // Map guides to remove null metadata
        const mappedGuides = guides.map(g => ({
          id: g.id,
          title: g.title,
          content: g.content,
          metadata: g.metadata ?? undefined,
        }));

        const result = await OllamaService.analyzeBatch(mappedGuides);

        // Save results to database
        for (const item of result.results) {
          if ((item as any).analysis) {
            const guide = GuideModel.findById(item.id);
            if (guide) {
              let existingMetadata: GuideMetadata = {};
              if (guide.metadata) {
                try {
                  existingMetadata = JSON.parse(guide.metadata);
                } catch {
                  // Ignore parse errors
                }
              }

              const newMetadata: GuideMetadata = {
                ...existingMetadata,
                ...(item as any).analysis,
                aiAnalyzedAt: Date.now(),
              };

              GuideModel.setMetadata(item.id, newMetadata);
            }
          }
        }

        console.log(`[Admin] Batch analysis complete: ${result.succeeded} succeeded, ${result.failed} failed`);
      } catch (err) {
        console.error('[Admin] Batch analysis error:', err);
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/admin/ai/batch/stream - SSE stream for batch progress
router.get('/ai/batch/stream', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Send current progress immediately
  res.write(`data: ${JSON.stringify(OllamaService.getBatchProgress())}\n\n`);

  // Subscribe to progress updates
  const unsubscribe = OllamaService.onProgressChange((progress) => {
    res.write(`data: ${JSON.stringify(progress)}\n\n`);
  });

  // Send keepalive every 15 seconds
  const keepaliveInterval = setInterval(() => {
    res.write(`: keepalive\n\n`);
  }, 15000);

  // Cleanup on disconnect
  req.on('close', () => {
    clearInterval(keepaliveInterval);
    unsubscribe();
  });
});

// POST /api/admin/ai/batch/stop - Stop running batch
router.post('/ai/batch/stop', (req: Request, res: Response) => {
  if (!OllamaService.isBatchRunning()) {
    res.status(400).json({ error: 'No batch analysis in progress' });
    return;
  }

  OllamaService.stopBatch();
  res.json({ success: true, message: 'Batch stop requested' });
});

// GET /api/admin/ai/status - Get AI service status (admin version with more details)
// NOTE: Expensive metadata counts removed - they block the event loop for 4+ minutes
// with 143k+ guides. Use /api/admin/ai/counts endpoint if counts are needed.
router.get('/ai/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Check Ollama with a safety timeout - don't let it block the response
    let status = { available: false, host: OllamaService.getHost(), error: 'Check pending' };
    try {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Ollama check timeout')), 3000)
      );
      status = await Promise.race([
        OllamaService.checkAvailability(),
        timeoutPromise
      ]) as typeof status;
    } catch (err: any) {
      console.log('[Admin] Ollama check failed:', err.message);
      status = { available: false, host: OllamaService.getHost(), error: err.message };
    }

    const batchProgress = OllamaService.getBatchProgress();
    const yoloProgress = OllamaService.getYoloProgress();

    res.json({
      ollama: status,
      batch: batchProgress,
      yolo: yoloProgress,
      host: OllamaService.getHost(),
      model: OllamaService.getModel(),
      // Counts removed - too expensive with 143k+ guides (blocks event loop)
      // Frontend will show "—" instead of counts
      counts: null,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/admin/ai/settings - Update Ollama settings
router.post('/ai/settings', (req: Request, res: Response) => {
  const { host, model } = req.body;

  if (host && typeof host === 'string') {
    OllamaService.setHost(host.trim());
  }
  if (model && typeof model === 'string') {
    OllamaService.setModel(model.trim());
  }

  res.json({
    success: true,
    host: OllamaService.getHost(),
    model: OllamaService.getModel(),
  });
});

// ========== YOLO Mode Endpoints ==========

// POST /api/admin/ai/yolo/start - Start YOLO mode
router.post('/ai/yolo/start', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Check if YOLO or batch is already running
    if (OllamaService.isYoloRunning()) {
      res.status(409).json({ error: 'YOLO mode already running' });
      return;
    }
    if (OllamaService.isBatchRunning()) {
      res.status(409).json({ error: 'Batch analysis already in progress' });
      return;
    }

    // Check Ollama availability
    let status = { available: false, error: 'Check pending' };
    try {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Ollama check timeout')), 3000)
      );
      status = await Promise.race([
        OllamaService.checkAvailability(),
        timeoutPromise
      ]) as typeof status;
    } catch (err: any) {
      status = { available: false, error: err.message };
    }

    if (!status.available) {
      res.status(503).json({
        error: 'Ollama service unavailable',
        details: (status as any).error,
      });
      return;
    }

    // Respond immediately
    res.json({
      success: true,
      message: 'YOLO mode starting...',
    });

    console.log('[Admin] Starting YOLO mode');

    // Start YOLO in background
    setImmediate(async () => {
      console.log('[Admin] YOLO setImmediate fired, calling startYoloMode');
      try {
        await OllamaService.startYoloMode(
          // getNextGuide callback - uses indexed ai_analyzed_at column
          () => {
            console.log('[Admin] YOLO getNextGuide called');
            // Fast query using indexed column
            const guide = Database.get<Guide>(`
              SELECT * FROM guides
              WHERE ai_analyzed_at IS NULL
              LIMIT 1
            `);
            console.log('[Admin] YOLO found guide:', guide ? guide.id : 'none');
            if (!guide) return null;
            return {
              id: guide.id,
              title: guide.title,
              content: guide.content,
              metadata: guide.metadata,
            };
          },
          // saveMetadata callback
          (id, metadata) => {
            console.log('[Admin] YOLO saving metadata for', id);
            GuideModel.setMetadata(id, metadata); // Also updates ai_analyzed_at column
          }
        );
      } catch (err) {
        console.error('[Admin] YOLO error:', err);
      }
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/admin/ai/yolo/stop - Stop YOLO mode
router.post('/ai/yolo/stop', (req: Request, res: Response) => {
  if (!OllamaService.isYoloRunning()) {
    res.status(400).json({ error: 'YOLO mode not running' });
    return;
  }

  OllamaService.stopYolo();
  res.json({ success: true, message: 'YOLO stop requested' });
});

// GET /api/admin/ai/yolo/stream - SSE stream for YOLO progress
router.get('/ai/yolo/stream', (req: Request, res: Response) => {
  console.log('[Admin] YOLO SSE stream connected');

  // Disable any compression/buffering
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Content-Encoding', 'none');
  res.flushHeaders();

  const sendProgress = (progress: any) => {
    const data = `data: ${JSON.stringify(progress)}\n\n`;
    console.log('[Admin] YOLO SSE sending:', progress.status, progress.processed || 0);
    res.write(data);
    // Force flush - cast to any to access flush if available
    if (typeof (res as any).flush === 'function') {
      (res as any).flush();
    }
  };

  // Send current progress immediately
  sendProgress(OllamaService.getYoloProgress());

  // Subscribe to progress updates
  const unsubscribe = OllamaService.onYoloProgressChange(sendProgress);

  // Send keepalive every 5 seconds (more frequent)
  const keepaliveInterval = setInterval(() => {
    res.write(`: keepalive\n\n`);
  }, 5000);

  // Cleanup on disconnect
  req.on('close', () => {
    console.log('[Admin] YOLO SSE disconnected');
    clearInterval(keepaliveInterval);
    unsubscribe();
  });
});

// Serve admin panel HTML at /admin
router.get('/panel', (req: Request, res: Response) => {
  const adminHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GameFAQs Server Admin</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      padding: 20px;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 { font-size: 2.5rem; margin-bottom: 10px; color: #fff; }
    .subtitle { color: #94a3b8; margin-bottom: 40px; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 20px;
      margin-bottom: 20px;
    }
    .card {
      background: #1e293b;
      border-radius: 12px;
      padding: 24px;
      border: 1px solid #334155;
    }
    .card-title {
      font-size: 0.875rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #94a3b8;
      margin-bottom: 8px;
    }
    .card-value {
      font-size: 2.5rem;
      font-weight: 700;
      color: #fff;
    }
    .card-label {
      font-size: 0.875rem;
      color: #64748b;
      margin-top: 4px;
    }
    .progress-section { margin-top: 30px; }
    .progress-bar {
      width: 100%;
      height: 32px;
      background: #334155;
      border-radius: 8px;
      overflow: hidden;
      position: relative;
      margin-top: 12px;
    }
    .progress-fill {
      height: 100%;
      background: linear-gradient(90deg, #3b82f6, #8b5cf6);
      transition: width 0.3s ease;
      display: flex;
      align-items: center;
      padding: 0 12px;
      font-weight: 600;
      font-size: 0.875rem;
    }
    .status-badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 0.875rem;
      font-weight: 600;
      margin-top: 8px;
    }
    .status-idle { background: #475569; color: #cbd5e1; }
    .status-downloading { background: #3b82f6; color: #fff; }
    .status-extracting { background: #8b5cf6; color: #fff; }
    .status-importing { background: #f59e0b; color: #fff; }
    .status-complete { background: #10b981; color: #fff; }
    .status-error { background: #ef4444; color: #fff; }
    .message { margin-top: 16px; font-size: 0.9375rem; color: #cbd5e1; }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 12px;
      margin-top: 16px;
    }
    .stat-item {
      display: flex;
      justify-content: space-between;
      padding: 12px;
      background: #0f172a;
      border-radius: 8px;
    }
    .stat-label { color: #94a3b8; font-size: 0.875rem; }
    .stat-value { color: #fff; font-weight: 600; }
    .refresh-indicator {
      color: #10b981;
      font-size: 0.875rem;
      margin-top: 8px;
      opacity: 0;
      transition: opacity 0.2s;
    }
    .refresh-indicator.active { opacity: 1; }
    .ai-section { margin-top: 20px; }
    .ai-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
    .ai-status-badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 0.75rem;
      font-weight: 600;
    }
    .ai-available { background: #10b981; color: #fff; }
    .ai-unavailable { background: #ef4444; color: #fff; }
    .ai-running { background: #3b82f6; color: #fff; }
    .ai-controls { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 16px; }
    .ai-input-group { display: flex; gap: 8px; flex: 1; min-width: 200px; }
    .ai-input {
      flex: 1;
      padding: 10px 14px;
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 8px;
      color: #e2e8f0;
      font-size: 0.875rem;
    }
    .ai-input:focus { outline: none; border-color: #3b82f6; }
    .ai-select {
      padding: 10px 14px;
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 8px;
      color: #e2e8f0;
      font-size: 0.875rem;
      min-width: 180px;
    }
    .ai-btn {
      padding: 10px 20px;
      border: none;
      border-radius: 8px;
      font-size: 0.875rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }
    .ai-btn-primary { background: #3b82f6; color: #fff; }
    .ai-btn-primary:hover { background: #2563eb; }
    .ai-btn-primary:disabled { background: #475569; cursor: not-allowed; }
    .ai-btn-danger { background: #ef4444; color: #fff; }
    .ai-btn-danger:hover { background: #dc2626; }
    .ai-progress { margin-top: 16px; }
    .ai-progress-bar {
      width: 100%;
      height: 24px;
      background: #334155;
      border-radius: 6px;
      overflow: hidden;
      margin-top: 8px;
    }
    .ai-progress-fill {
      height: 100%;
      background: linear-gradient(90deg, #10b981, #3b82f6);
      transition: width 0.3s ease;
      display: flex;
      align-items: center;
      padding: 0 10px;
      font-size: 0.75rem;
      font-weight: 600;
    }
    .ai-result {
      margin-top: 16px;
      padding: 12px;
      background: #0f172a;
      border-radius: 8px;
      font-family: monospace;
      font-size: 0.8rem;
      max-height: 200px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .ai-stats { display: flex; gap: 20px; margin-top: 12px; flex-wrap: wrap; }
    .ai-stat { font-size: 0.875rem; color: #94a3b8; }
    .ai-stat strong { color: #fff; }
  </style>
</head>
<body>
  <div class="container">
    <h1>GameFAQs Server</h1>
    <p class="subtitle">Server Administration Dashboard</p>

    <div class="grid">
      <div class="card">
        <div class="card-title">Total Guides</div>
        <div class="card-value" id="guideCount">-</div>
        <div class="card-label">Imported to database</div>
      </div>

      <div class="card">
        <div class="card-title">Total Games</div>
        <div class="card-value" id="gameCount">-</div>
        <div class="card-label">Unique game entries</div>
      </div>

      <div class="card">
        <div class="card-title">Database Size</div>
        <div class="card-value" id="dbSize">-</div>
        <div class="card-label">Storage used</div>
      </div>

      <div class="card">
        <div class="card-title">Server Uptime</div>
        <div class="card-value" id="uptime">-</div>
        <div class="card-label">Time running</div>
      </div>
    </div>

    <div class="card progress-section">
      <div class="card-title">Initialization Status</div>
      <div>
        <span class="status-badge" id="statusBadge">Idle</span>
        <div class="refresh-indicator" id="refreshIndicator">Live</div>
      </div>
      <div class="progress-bar">
        <div class="progress-fill" id="progressBar" style="width: 0%;">
          <span id="progressText">0%</span>
        </div>
      </div>
      <div class="message" id="statusMessage">Connecting...</div>
    </div>

    <div class="card">
      <div class="card-title">Server Information</div>
      <div class="stats-grid">
        <div class="stat-item">
          <span class="stat-label">Memory Usage</span>
          <span class="stat-value" id="memoryUsage">-</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">Node Version</span>
          <span class="stat-value" id="nodeVersion">-</span>
        </div>
      </div>
    </div>

    <div class="card ai-section">
      <div class="ai-header">
        <div class="card-title" style="margin-bottom: 0;">AI Analysis</div>
        <span class="ai-status-badge ai-unavailable" id="aiStatusBadge">Checking...</span>
      </div>

      <div class="ai-controls" style="margin-top: 12px;">
        <div class="ai-input-group">
          <input type="text" class="ai-input" id="ollamaHost" placeholder="Ollama Host URL" style="flex: 2;" />
          <select class="ai-select" id="ollamaModel" style="flex: 1;">
            <option value="">Select model...</option>
          </select>
          <button class="ai-btn ai-btn-primary" id="saveSettingsBtn">Save</button>
        </div>
      </div>

      <div class="ai-controls">
        <div class="ai-input-group" style="position: relative; flex: 1;">
          <input type="text" class="ai-input" id="guideSearch" placeholder="Search for a guide..." autocomplete="off" style="width: 100%;" />
          <div id="searchResults" style="display: none; position: absolute; top: 100%; left: 0; right: 0; background: #1e293b; border: 1px solid #334155; border-radius: 8px; max-height: 300px; overflow-y: auto; z-index: 100; margin-top: 4px;"></div>
        </div>
        <button class="ai-btn ai-btn-primary" id="analyzeBtn" disabled>Analyze</button>
      </div>
      <div id="selectedGuide" style="display: none; margin-top: 8px; padding: 12px; background: #0f172a; border-radius: 8px;">
        <div style="display: flex; justify-content: space-between; align-items: start;">
          <div>
            <div style="font-weight: 600; color: #e2e8f0;" id="selectedGuideTitle"></div>
            <div style="font-size: 0.75rem; color: #64748b; margin-top: 4px;" id="selectedGuideId"></div>
          </div>
          <button onclick="clearSelectedGuide()" style="background: none; border: none; color: #94a3b8; cursor: pointer; font-size: 1.2rem;">×</button>
        </div>
      </div>

      <div id="analysisPreview" style="display: none; margin-top: 16px; padding: 16px; background: #0f172a; border-radius: 8px; border: 1px solid #334155;">
        <div style="font-weight: 600; color: #e2e8f0; margin-bottom: 12px;">AI Analysis Preview</div>
        <div id="previewFields"></div>
        <div class="ai-controls" style="margin-top: 16px;">
          <button class="ai-btn ai-btn-primary" id="saveAnalysisBtn">Save Changes</button>
          <button class="ai-btn" id="discardAnalysisBtn" style="background: #475569;">Discard</button>
        </div>
      </div>

      <div class="ai-progress" id="aiProgressSection" style="display: none;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span id="aiProgressStatus">Processing...</span>
          <span id="aiProgressCount">0/0</span>
        </div>
        <div class="ai-progress-bar">
          <div class="ai-progress-fill" id="aiProgressBar" style="width: 0%;"></div>
        </div>
        <div id="aiProgressMessage" style="font-size: 0.875rem; color: #94a3b8; margin-top: 8px;"></div>
      </div>

      <div class="ai-result" id="aiResult" style="display: none;"></div>

      <div style="margin-top: 24px; padding-top: 20px; border-top: 1px solid #334155;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
          <div>
            <div style="font-weight: 600; color: #e2e8f0;">YOLO Mode</div>
            <div style="font-size: 0.75rem; color: #64748b; margin-top: 4px;">Auto-analyze all unprocessed guides without review</div>
          </div>
          <div style="display: flex; gap: 8px;">
            <button class="ai-btn ai-btn-primary" id="yoloStartBtn" disabled>Start YOLO Mode</button>
            <button class="ai-btn ai-btn-danger" id="yoloStopBtn" style="display: none;">Stop</button>
          </div>
        </div>
        <div id="yoloStatus" style="display: none; padding: 16px; background: #0f172a; border-radius: 8px;">
          <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
            <div class="yolo-spinner" style="width: 20px; height: 20px; border: 3px solid #334155; border-top-color: #3b82f6; border-radius: 50%; animation: spin 1s linear infinite;"></div>
            <span id="yoloStatusText" style="color: #e2e8f0; font-weight: 500;">Starting...</span>
          </div>
          <div id="yoloStats" style="display: none; display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 12px;">
            <div style="text-align: center; padding: 12px; background: #1e293b; border-radius: 6px;">
              <div style="font-size: 1.5rem; font-weight: 700; color: #fff;" id="yoloProcessed">0</div>
              <div style="font-size: 0.75rem; color: #94a3b8;">Processed</div>
            </div>
            <div style="text-align: center; padding: 12px; background: #1e293b; border-radius: 6px;">
              <div style="font-size: 1.5rem; font-weight: 700; color: #10b981;" id="yoloSucceeded">0</div>
              <div style="font-size: 0.75rem; color: #94a3b8;">Succeeded</div>
            </div>
            <div style="text-align: center; padding: 12px; background: #1e293b; border-radius: 6px;">
              <div style="font-size: 1.5rem; font-weight: 700; color: #ef4444;" id="yoloFailed">0</div>
              <div style="font-size: 0.75rem; color: #94a3b8;">Failed</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <style>
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  </style>

  <script>
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get('token');
    const authSuffix = token ? '?token=' + encodeURIComponent(token) : '';

    let eventSource = null;
    let sseRetryCount = 0;
    const MAX_SSE_RETRIES = 3;

    function connectSSE() {
      if (eventSource) {
        eventSource.close();
      }

      eventSource = new EventSource('/api/admin/status/stream' + authSuffix);

      eventSource.onmessage = (event) => {
        sseRetryCount = 0; // Reset on successful message
        const status = JSON.parse(event.data);
        updateUI(status);
        flashRefreshIndicator();
      };

      eventSource.onerror = (error) => {
        console.error('SSE error:', error);
        eventSource.close();
        sseRetryCount++;
        if (sseRetryCount < MAX_SSE_RETRIES) {
          document.getElementById('statusMessage').textContent = 'Connection lost. Retrying...';
          setTimeout(connectSSE, 2000);
        } else {
          document.getElementById('statusMessage').textContent = 'Connection failed. Refresh page to retry.';
        }
      };
    }

    // Close SSE connection on page unload to prevent connection issues
    window.addEventListener('beforeunload', () => {
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
    });

    connectSSE();

    async function fetchStatus() {
      try {
        const response = await fetch('/api/admin/status' + authSuffix);
        if (response.status === 401) {
          window.location.href = '/api/admin/panel';
          return;
        }
        const data = await response.json();
        updateFullStatus(data);
      } catch (error) {
        console.error('Failed to fetch status:', error);
      }
    }

    function updateUI(initStatus) {
      const progressBar = document.getElementById('progressBar');
      const progressText = document.getElementById('progressText');
      progressBar.style.width = initStatus.progress + '%';
      progressText.textContent = initStatus.progress + '%';

      const statusBadge = document.getElementById('statusBadge');
      statusBadge.textContent = initStatus.stage.charAt(0).toUpperCase() + initStatus.stage.slice(1);
      statusBadge.className = 'status-badge status-' + initStatus.stage;

      document.getElementById('statusMessage').textContent = initStatus.message;
      document.getElementById('guideCount').textContent = initStatus.guideCount.toLocaleString();
      document.getElementById('gameCount').textContent = initStatus.gameCount.toLocaleString();
    }

    function updateFullStatus(data) {
      updateUI(data.init);
      document.getElementById('dbSize').textContent = data.database.sizeMB + ' MB';

      const uptimeHours = Math.floor(data.server.uptime / 3600);
      const uptimeMinutes = Math.floor((data.server.uptime % 3600) / 60);
      document.getElementById('uptime').textContent = uptimeHours + 'h ' + uptimeMinutes + 'm';

      const memoryMB = Math.floor(data.server.memory.heapUsed / 1024 / 1024);
      document.getElementById('memoryUsage').textContent = memoryMB + ' MB';

      document.getElementById('nodeVersion').textContent = data.server.nodeVersion;
    }

    function flashRefreshIndicator() {
      const indicator = document.getElementById('refreshIndicator');
      indicator.classList.add('active');
      setTimeout(() => indicator.classList.remove('active'), 200);
    }

    // Initial fetch
    fetchStatus();

    // AI Analysis functionality
    let aiAvailable = false;

    async function fetchAIStatus() {
      console.log('Fetching AI status...');
      try {
        const response = await fetch('/api/admin/ai/status' + authSuffix);
        console.log('AI status response:', response.status);
        if (!response.ok) {
          showAIError('API error: ' + response.status);
          return;
        }
        const data = await response.json();
        console.log('AI status data:', data);
        updateAIStatus(data);
      } catch (error) {
        console.error('Failed to fetch AI status:', error);
        showAIError(error.message || 'Failed to connect');
      }
    }

    function showAIError(message) {
      const badge = document.getElementById('aiStatusBadge');
      const analyzeBtn = document.getElementById('analyzeBtn');

      badge.textContent = 'Error: ' + message;
      badge.className = 'ai-status-badge ai-unavailable';
      if (analyzeBtn) analyzeBtn.disabled = true;
    }

    function updateAIStatus(data) {
      console.log('updateAIStatus called with:', data);

      if (!data || !data.ollama) {
        console.error('Invalid AI status data:', data);
        showAIError('Invalid response');
        return;
      }

      const badge = document.getElementById('aiStatusBadge');
      const hostInput = document.getElementById('ollamaHost');
      const modelSelect = document.getElementById('ollamaModel');

      // Update host input if not focused
      if (document.activeElement !== hostInput) {
        hostInput.value = data.host || '';
      }

      // Populate model dropdown with available models
      const models = data.ollama.models || [];
      if (document.activeElement !== modelSelect) {
        const currentValue = modelSelect.value || data.model;
        modelSelect.innerHTML = '';

        // Add placeholder option
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Select model...';
        modelSelect.appendChild(placeholder);

        // Add available models
        if (models.length > 0) {
          models.forEach(m => {
            const option = document.createElement('option');
            option.value = m.name;
            option.textContent = m.name;
            if (m.name === currentValue) {
              option.selected = true;
            }
            modelSelect.appendChild(option);
          });
        }

        // If current model not in list, add it
        if (currentValue && !models.find(m => m.name === currentValue)) {
          const option = document.createElement('option');
          option.value = currentValue;
          option.textContent = currentValue + ' (configured)';
          option.selected = true;
          modelSelect.appendChild(option);
        }
      }

      aiAvailable = data.ollama.available || false;
      const analyzeBtn = document.getElementById('analyzeBtn');
      const hasSelection = document.getElementById('selectedGuide')?.style.display !== 'none';

      if (aiAvailable) {
        badge.textContent = 'Equipped: (' + (data.model || 'no model') + ')';
        badge.className = 'ai-status-badge ai-available';
        if (analyzeBtn && hasSelection) analyzeBtn.disabled = false;
      } else {
        badge.textContent = 'Unavailable: ' + (data.ollama.error || 'Unknown error');
        badge.className = 'ai-status-badge ai-unavailable';
        if (analyzeBtn) analyzeBtn.disabled = true;
      }

      // Update YOLO button state based on AI availability
      const yoloStartBtn = document.getElementById('yoloStartBtn');
      const yoloRunning = data.yolo && (data.yolo.status === 'running' || data.yolo.status === 'stopping');
      if (yoloStartBtn) {
        yoloStartBtn.disabled = !aiAvailable || yoloRunning;
      }
    }

    // Batch progress functions removed - using single guide analysis with preview now

    // Guide search and single-select with preview
    let selectedGuide = null; // {id, title}
    let pendingAnalysis = null; // AI results waiting for approval
    let searchTimeout = null;
    const searchInput = document.getElementById('guideSearch');
    const searchResults = document.getElementById('searchResults');

    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimeout);
      const query = searchInput.value.trim();
      if (query.length < 2) {
        searchResults.style.display = 'none';
        return;
      }
      searchTimeout = setTimeout(() => searchGuides(query), 300);
    });

    searchInput.addEventListener('focus', () => {
      if (searchInput.value.trim().length >= 2) {
        searchGuides(searchInput.value.trim());
      }
    });

    document.addEventListener('click', (e) => {
      if (!searchInput.contains(e.target) && !searchResults.contains(e.target)) {
        searchResults.style.display = 'none';
      }
    });

    async function searchGuides(query) {
      try {
        const response = await fetch('/api/guides/search?q=' + encodeURIComponent(query) + '&limit=15');
        const data = await response.json();
        // Combine guides (title/tag matches) and content matches
        const allResults = [...(data.guides || []), ...(data.content || [])];
        if (allResults.length > 0) {
          let html = '';
          // Show title/tag matches first
          if (data.guides && data.guides.length > 0) {
            html += '<div style="padding: 6px 14px; font-size: 0.7rem; color: #94a3b8; background: #0f172a;">TITLE/TAG MATCHES</div>';
            html += data.guides.map(g =>
              '<div class="search-result-item" data-id="' + g.id + '" data-title="' + escapeHtml(g.title) + '" style="padding: 10px 14px; cursor: pointer; border-bottom: 1px solid #334155;">' +
              '<div style="font-weight: 500; color: #e2e8f0;">' + escapeHtml(g.title) + '</div>' +
              '<div style="font-size: 0.75rem; color: #64748b; margin-top: 2px;">ID: ' + g.id + ' • ' + (g.format || 'txt').toUpperCase() + '</div>' +
              '</div>'
            ).join('');
          }
          // Show content matches
          if (data.content && data.content.length > 0) {
            html += '<div style="padding: 6px 14px; font-size: 0.7rem; color: #94a3b8; background: #0f172a;">CONTENT MATCHES</div>';
            html += data.content.map(g =>
              '<div class="search-result-item" data-id="' + g.id + '" data-title="' + escapeHtml(g.title) + '" style="padding: 10px 14px; cursor: pointer; border-bottom: 1px solid #334155;">' +
              '<div style="font-weight: 500; color: #e2e8f0;">' + escapeHtml(g.title) + '</div>' +
              '<div style="font-size: 0.75rem; color: #64748b; margin-top: 2px;">ID: ' + g.id + ' • ' + (g.format || 'txt').toUpperCase() + '</div>' +
              '</div>'
            ).join('');
          }
          searchResults.innerHTML = html;
          searchResults.style.display = 'block';

          searchResults.querySelectorAll('.search-result-item').forEach(item => {
            item.addEventListener('click', () => selectGuide(item.dataset.id, item.dataset.title));
            item.addEventListener('mouseenter', () => item.style.background = '#334155');
            item.addEventListener('mouseleave', () => item.style.background = 'transparent');
          });
        } else {
          searchResults.innerHTML = '<div style="padding: 10px 14px; color: #64748b;">No guides found</div>';
          searchResults.style.display = 'block';
        }
      } catch (error) {
        console.error('Search failed:', error);
      }
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function selectGuide(id, title) {
      selectedGuide = { id, title };
      searchResults.style.display = 'none';
      searchInput.value = '';
      document.getElementById('selectedGuide').style.display = 'block';
      document.getElementById('selectedGuideTitle').textContent = title;
      document.getElementById('selectedGuideId').textContent = 'ID: ' + id;
      document.getElementById('analyzeBtn').disabled = !aiAvailable;
      document.getElementById('analysisPreview').style.display = 'none';
      pendingAnalysis = null;
    }

    window.clearSelectedGuide = function() {
      selectedGuide = null;
      pendingAnalysis = null;
      document.getElementById('selectedGuide').style.display = 'none';
      document.getElementById('analysisPreview').style.display = 'none';
      document.getElementById('analyzeBtn').disabled = true;
    };

    // Analyze single guide and show preview
    document.getElementById('analyzeBtn').addEventListener('click', async () => {
      if (!selectedGuide) return;

      const btn = document.getElementById('analyzeBtn');
      btn.disabled = true;
      btn.textContent = 'Analyzing...';

      try {
        const response = await fetch('/api/ai/analyze/' + encodeURIComponent(selectedGuide.id) + '?preview=true', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        const data = await response.json();
        if (response.ok && data.analysis) {
          pendingAnalysis = data.analysis;
          showAnalysisPreview(data.analysis, data.existing || {});
        } else {
          alert('Error: ' + (data.error?.message || data.error || 'Analysis failed'));
        }
      } catch (error) {
        alert('Error: ' + error.message);
      } finally {
        btn.disabled = !aiAvailable || !selectedGuide;
        btn.textContent = 'Analyze';
      }
    });

    function showAnalysisPreview(analysis, existing) {
      const fields = ['gameName', 'platform', 'author', 'tags', 'summary'];
      const labels = { gameName: 'Game Name', platform: 'Platform', author: 'Author', tags: 'Tags', summary: 'Summary' };

      let html = '';
      for (const field of fields) {
        const newVal = analysis[field];
        const oldVal = existing[field];
        if (newVal === undefined || newVal === null) continue;

        const displayNew = Array.isArray(newVal) ? newVal.join(', ') : newVal;
        const displayOld = oldVal ? (Array.isArray(oldVal) ? oldVal.join(', ') : oldVal) : 'not set';
        const isChanged = JSON.stringify(newVal) !== JSON.stringify(oldVal);

        const inputStyle = 'width: 100%; padding: 8px; background: #0f172a; border: 1px solid #334155; border-radius: 4px; color: #e2e8f0; font-size: 0.875rem; margin-top: 4px;';
        const inputField = field === 'summary'
          ? '<textarea id="input_' + field + '" style="' + inputStyle + ' min-height: 80px; resize: vertical;">' + escapeHtml(displayNew) + '</textarea>'
          : '<input type="text" id="input_' + field + '" value="' + escapeHtml(displayNew) + '" style="' + inputStyle + '">';

        html += '<div style="margin-bottom: 12px; padding: 10px; background: #1e293b; border-radius: 6px;">' +
          '<div style="display: flex; align-items: start;">' +
          '<input type="checkbox" name="field_' + field + '" value="1" ' + (isChanged ? 'checked' : '') + ' style="margin-right: 10px; margin-top: 3px;">' +
          '<div style="flex: 1;">' +
          '<div style="font-weight: 500; color: #e2e8f0;">' + labels[field] + '</div>' +
          '<div style="font-size: 0.75rem; margin-top: 2px; color: #64748b;">Current: ' + escapeHtml(displayOld) + '</div>' +
          inputField +
          '</div>' +
          '</div>' +
          '</div>';
      }

      if (!html) {
        html = '<div style="color: #64748b;">No new metadata extracted</div>';
      }

      document.getElementById('previewFields').innerHTML = html;
      document.getElementById('analysisPreview').style.display = 'block';
    }

    // Save selected fields
    document.getElementById('saveAnalysisBtn').addEventListener('click', async () => {
      if (!selectedGuide || !pendingAnalysis) return;

      const fieldsToSave = {};
      const checkboxes = document.querySelectorAll('#previewFields input[type="checkbox"]:checked');
      checkboxes.forEach(cb => {
        const field = cb.name.replace('field_', '');
        const input = document.getElementById('input_' + field);
        if (input) {
          let value = input.value.trim();
          // Convert tags back to array
          if (field === 'tags') {
            value = value.split(',').map(t => t.trim()).filter(t => t);
          }
          fieldsToSave[field] = value;
        }
      });

      if (Object.keys(fieldsToSave).length === 0) {
        alert('No fields selected to save');
        return;
      }

      const btn = document.getElementById('saveAnalysisBtn');
      btn.disabled = true;
      btn.textContent = 'Saving...';

      try {
        const response = await fetch('/api/ai/analyze/' + encodeURIComponent(selectedGuide.id) + '/save' + authSuffix, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: fieldsToSave })
        });
        const data = await response.json();
        if (response.ok) {
          document.getElementById('analysisPreview').style.display = 'none';
          pendingAnalysis = null;
          alert('Saved successfully!');
        } else {
          alert('Error: ' + (data.error?.message || data.error || 'Save failed'));
        }
      } catch (error) {
        alert('Error: ' + error.message);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Save Changes';
      }
    });

    // Discard analysis
    document.getElementById('discardAnalysisBtn').addEventListener('click', () => {
      pendingAnalysis = null;
      document.getElementById('analysisPreview').style.display = 'none';
    });

    // Save Ollama settings
    document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
      const host = document.getElementById('ollamaHost').value.trim();
      const model = document.getElementById('ollamaModel').value.trim();
      const btn = document.getElementById('saveSettingsBtn');

      btn.disabled = true;
      btn.textContent = 'Saving...';

      try {
        const response = await fetch('/api/admin/ai/settings' + authSuffix, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ host, model })
        });
        if (response.ok) {
          btn.textContent = 'Saved!';
          setTimeout(() => { btn.textContent = 'Save'; btn.disabled = false; }, 1500);
          // Refresh status with new settings
          fetchAIStatus();
        } else {
          const data = await response.json();
          alert('Error: ' + (data.error?.message || data.error || 'Failed to save'));
          btn.textContent = 'Save';
          btn.disabled = false;
        }
      } catch (error) {
        alert('Error: ' + error.message);
        btn.textContent = 'Save';
        btn.disabled = false;
      }
    });

    // Initial AI status fetch
    fetchAIStatus();

    // ========== YOLO Mode ==========
    let yoloEventSource = null;

    function connectYoloSSE() {
      if (yoloEventSource) yoloEventSource.close();

      console.log('[YOLO] Connecting to SSE stream...');
      yoloEventSource = new EventSource('/api/admin/ai/yolo/stream' + authSuffix);

      yoloEventSource.onopen = () => {
        console.log('[YOLO] SSE connected');
      };

      yoloEventSource.onmessage = (event) => {
        console.log('[YOLO] SSE message:', event.data);
        const progress = JSON.parse(event.data);
        updateYoloUI(progress);
      };

      yoloEventSource.onerror = (error) => {
        console.error('[YOLO] SSE error:', error);
        yoloEventSource.close();
        yoloEventSource = null;
        // Show error in UI
        const statusText = document.getElementById('yoloStatusText');
        if (statusText) statusText.textContent = 'Connection lost. Refresh to retry.';
      };
    }

    let yoloStarted = false; // Track if we clicked start

    function updateYoloUI(progress) {
      console.log('[YOLO UI] Updating with:', progress);

      const startBtn = document.getElementById('yoloStartBtn');
      const stopBtn = document.getElementById('yoloStopBtn');
      const statusDiv = document.getElementById('yoloStatus');
      const statusText = document.getElementById('yoloStatusText');
      const spinner = statusDiv.querySelector('.yolo-spinner');
      const statsDiv = document.getElementById('yoloStats');

      const isRunning = progress.status === 'running' || progress.status === 'stopping';
      const isComplete = progress.status === 'complete';
      const isIdle = progress.status === 'idle';

      // If running, mark that we've started (to handle reconnects)
      if (isRunning) yoloStarted = true;

      // Update stats numbers
      document.getElementById('yoloProcessed').textContent = progress.processed || 0;
      document.getElementById('yoloSucceeded').textContent = progress.succeeded || 0;
      document.getElementById('yoloFailed').textContent = progress.failed || 0;

      // Only reset UI to idle state if we didn't just click start
      if (isIdle && !yoloStarted) {
        startBtn.style.display = 'inline-block';
        startBtn.disabled = !aiAvailable;
        stopBtn.style.display = 'none';
        statusDiv.style.display = 'none';
        return;
      }

      // Show running state
      if (isRunning) {
        startBtn.style.display = 'none';
        stopBtn.style.display = 'inline-block';
        statusDiv.style.display = 'block';
        spinner.style.display = 'block';
        statsDiv.style.display = 'grid';
        statusText.textContent = progress.currentGuideTitle
          ? 'Analyzing: ' + progress.currentGuideTitle.slice(0, 50) + '...'
          : (progress.message || 'Processing...');
      }
      // Show complete state
      else if (isComplete) {
        startBtn.style.display = 'inline-block';
        startBtn.disabled = !aiAvailable;
        stopBtn.style.display = 'none';
        statusDiv.style.display = 'block';
        spinner.style.display = 'none';
        statsDiv.style.display = 'grid';
        statusText.textContent = 'Complete! All guides processed.';
        yoloStarted = false;
      }
      // Idle after we stopped
      else if (isIdle && yoloStarted) {
        startBtn.style.display = 'inline-block';
        startBtn.disabled = !aiAvailable;
        stopBtn.style.display = 'none';
        statusDiv.style.display = 'block';
        spinner.style.display = 'none';
        statsDiv.style.display = 'grid';
        statusText.textContent = 'Stopped.';
        yoloStarted = false;
      }
    }

    document.getElementById('yoloStartBtn').addEventListener('click', async () => {
      const btn = document.getElementById('yoloStartBtn');
      const statusDiv = document.getElementById('yoloStatus');
      const statusText = document.getElementById('yoloStatusText');
      const spinner = statusDiv.querySelector('.yolo-spinner');

      // Mark that we clicked start (prevents hiding on initial 'idle' status)
      yoloStarted = true;

      // Show immediate feedback
      btn.disabled = true;
      btn.style.display = 'none';
      document.getElementById('yoloStopBtn').style.display = 'inline-block';
      statusDiv.style.display = 'block';
      spinner.style.display = 'block';
      statusText.textContent = 'Starting YOLO mode...';

      try {
        const response = await fetch('/api/admin/ai/yolo/start' + authSuffix, { method: 'POST' });
        const data = await response.json();

        if (response.ok) {
          statusText.textContent = 'Connecting...';
          connectYoloSSE();
        } else {
          // Show error and reset UI
          statusText.textContent = 'Error: ' + (data.error || 'Failed to start');
          spinner.style.display = 'none';
          setTimeout(() => {
            statusDiv.style.display = 'none';
            btn.style.display = 'inline-block';
            btn.disabled = false;
            document.getElementById('yoloStopBtn').style.display = 'none';
          }, 3000);
        }
      } catch (error) {
        statusText.textContent = 'Error: ' + error.message;
        spinner.style.display = 'none';
        setTimeout(() => {
          statusDiv.style.display = 'none';
          btn.style.display = 'inline-block';
          btn.disabled = false;
          document.getElementById('yoloStopBtn').style.display = 'none';
        }, 3000);
      }
    });

    document.getElementById('yoloStopBtn').addEventListener('click', async () => {
      const btn = document.getElementById('yoloStopBtn');
      btn.disabled = true;
      btn.textContent = 'Stopping...';

      try {
        await fetch('/api/admin/ai/yolo/stop' + authSuffix, { method: 'POST' });
      } catch (error) {
        console.error('Stop failed:', error);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Stop';
      }
    });

    // Check if YOLO is already running on page load
    function checkYoloStatus() {
      fetch('/api/admin/ai/status' + authSuffix)
        .then(r => r.json())
        .then(data => {
          if (data.yolo && (data.yolo.status === 'running' || data.yolo.status === 'stopping')) {
            connectYoloSSE();
          }
        })
        .catch(() => {});
    }
    checkYoloStatus();
  </script>
</body>
</html>
  `;

  res.setHeader('Content-Type', 'text/html');
  res.send(adminHtml);
});

export default router;
