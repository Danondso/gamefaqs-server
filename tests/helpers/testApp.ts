import express, { Express, Request, Response, NextFunction } from 'express';
import { createTestDatabase } from './testDb';
import { createGuideModel } from '../../src/models/Guide';
import { createGameModel } from '../../src/models/Game';
import { createGuidesRouter } from '../../src/routes/guides';
import { createGamesRouter } from '../../src/routes/games';
import { createHealthRouter } from '../../src/routes/health';
import type { IDatabase } from '../../src/interfaces/IDatabase';
import type { IGuideModel } from '../../src/interfaces/IGuideModel';
import type { IGameModel } from '../../src/interfaces/IGameModel';
import type { IInitService } from '../../src/interfaces/IInitService';
import type { InitStatus } from '../../src/types';

export interface TestAppDependencies {
  db: IDatabase;
  guideModel: IGuideModel;
  gameModel: IGameModel;
  initService: IInitService;
}

export interface TestAppResult {
  app: Express;
  deps: TestAppDependencies;
  cleanup: () => void;
}

/**
 * Mock InitService that always reports complete status
 */
function createMockInitService(): IInitService {
  const status: InitStatus = {
    stage: 'complete',
    progress: 100,
    message: 'Ready',
    guideCount: 0,
    gameCount: 0,
  };

  return {
    getStatus: () => status,
    isComplete: () => true,
    hasError: () => false,
    onStatusChange: () => () => {},
  };
}

/**
 * Creates a test Express app with injected dependencies.
 * Uses an in-memory database and the REAL route implementations.
 */
export function createTestApp(overrides?: Partial<TestAppDependencies>): TestAppResult {
  // Create database
  const db = overrides?.db ?? createTestDatabase();

  // Create models with the test database
  const guideModel = overrides?.guideModel ?? createGuideModel(db);
  const gameModel = overrides?.gameModel ?? createGameModel(db);
  const initService = overrides?.initService ?? createMockInitService();

  const deps: TestAppDependencies = {
    db,
    guideModel,
    gameModel,
    initService,
  };

  // Create Express app
  const app = express();
  app.use(express.json());

  // Use the REAL route factories with injected dependencies
  app.use('/api/guides', createGuidesRouter({ guideModel }));
  app.use('/api/games', createGamesRouter({ gameModel, guideModel }));
  app.use('/api/health', createHealthRouter({ guideModel, gameModel, initService }));

  // Error handler
  app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    const statusCode = err.statusCode || 500;
    res.status(statusCode).json({
      error: err.message || 'Internal Server Error',
      code: err.code,
    });
  });

  // 404 handler
  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' });
  });

  return {
    app,
    deps,
    cleanup: () => db.close(),
  };
}
