import { Router, Request, Response, NextFunction } from 'express';
import DefaultGuideModel from '../models/Guide';
import DefaultGameModel from '../models/Game';
import DefaultInitService from '../services/InitService';
import type { IGuideModel } from '../interfaces/IGuideModel';
import type { IGameModel } from '../interfaces/IGameModel';
import type { IInitService } from '../interfaces/IInitService';

export interface HealthRouterDeps {
  guideModel: IGuideModel;
  gameModel: IGameModel;
  initService: IInitService;
}

export function createHealthRouter(deps: HealthRouterDeps): Router {
  const router = Router();
  const { guideModel, gameModel, initService } = deps;

  // GET /api/health - Basic health check
  router.get('/', (req: Request, res: Response, next: NextFunction) => {
    try {
      const initStatus = initService.getStatus();

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
      if (initService.isComplete()) {
        res.json({ ready: true });
      } else if (initService.hasError()) {
        res.status(503).json({
          ready: false,
          error: initService.getStatus().error,
        });
      } else {
        res.status(503).json({
          ready: false,
          stage: initService.getStatus().stage,
          progress: initService.getStatus().progress,
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
      const initStatus = initService.getStatus();

      if (!initService.isComplete()) {
        res.json({
          initialized: false,
          stage: initStatus.stage,
          progress: initStatus.progress,
          message: initStatus.message,
        });
        return;
      }

      const guideCount = guideModel.getTotalCount();
      const gameCount = gameModel.getTotalCount();

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

  return router;
}

// Default router using singletons for backward compatibility
export default createHealthRouter({
  guideModel: DefaultGuideModel,
  gameModel: DefaultGameModel,
  initService: DefaultInitService,
});
