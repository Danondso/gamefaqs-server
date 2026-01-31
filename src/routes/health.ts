import { Router, Request, Response, NextFunction } from 'express';
import GuideModel from '../models/Guide';
import GameModel from '../models/Game';
import InitService from '../services/InitService';

const router = Router();

// GET /api/health - Basic health check
router.get('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const initStatus = InitService.getStatus();

    res.json({
      status: initStatus.stage === 'complete' ? 'healthy' : 'initializing',
      initialized: initStatus.stage === 'complete',
      initStage: initStatus.stage,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/health/ready - Readiness check (for Kubernetes/Docker)
router.get('/ready', (req: Request, res: Response, next: NextFunction) => {
  try {
    if (InitService.isComplete()) {
      res.json({ ready: true });
    } else if (InitService.hasError()) {
      res.status(503).json({
        ready: false,
        error: InitService.getStatus().error,
      });
    } else {
      res.status(503).json({
        ready: false,
        stage: InitService.getStatus().stage,
        progress: InitService.getStatus().progress,
      });
    }
  } catch (error) {
    next(error);
  }
});

// GET /api/health/live - Liveness check (for Kubernetes/Docker)
router.get('/live', (req: Request, res: Response) => {
  // Always return 200 if the server is running
  res.json({ live: true });
});

// GET /api/health/stats - Database statistics
router.get('/stats', (req: Request, res: Response, next: NextFunction) => {
  try {
    const initStatus = InitService.getStatus();

    if (!InitService.isComplete()) {
      res.json({
        initialized: false,
        stage: initStatus.stage,
        progress: initStatus.progress,
        message: initStatus.message,
      });
      return;
    }

    const guideCount = GuideModel.getTotalCount();
    const gameCount = GameModel.getTotalCount();

    res.json({
      initialized: true,
      guides: {
        total: guideCount,
      },
      games: {
        total: gameCount,
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

export default router;
