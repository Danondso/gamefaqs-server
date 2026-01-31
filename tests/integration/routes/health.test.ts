import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createTestApp, TestAppResult } from '../../helpers/testApp';
import { createTestDatabase } from '../../helpers/testDb';
import { createGuideModel } from '../../../src/models/Guide';
import { createGameModel } from '../../../src/models/Game';
import { createHealthRouter } from '../../../src/routes/health';
import { sampleGuideData } from '../../fixtures/guides';
import { sampleGameData } from '../../fixtures/games';
import type { IInitService } from '../../../src/interfaces/IInitService';
import type { InitStatus } from '../../../src/types';

// Helper to create mock InitService with custom state
function createMockInitService(overrides: Partial<{
  stage: InitStatus['stage'];
  isComplete: boolean;
  hasError: boolean;
  error?: string;
  progress?: number;
  message?: string;
}>): IInitService {
  const status: InitStatus = {
    stage: overrides.stage ?? 'complete',
    progress: overrides.progress ?? 100,
    message: overrides.message ?? 'Ready',
    guideCount: 0,
    gameCount: 0,
    error: overrides.error,
  };

  return {
    getStatus: () => status,
    isComplete: () => overrides.isComplete ?? true,
    hasError: () => overrides.hasError ?? false,
    onStatusChange: () => () => {},
  };
}

describe('Health Routes', () => {
  let testApp: TestAppResult;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  describe('GET /api/health', () => {
    it('should return healthy status when initialized', async () => {
      const response = await request(testApp.app)
        .get('/api/health')
        .expect(200);

      expect(response.body.status).toBe('healthy');
      expect(response.body.initialized).toBe(true);
      expect(response.body.initStage).toBe('complete');
      expect(response.body.uptime).toBeDefined();
      expect(response.body.timestamp).toBeDefined();
    });

    it('should return initializing status when not complete', async () => {
      const db = createTestDatabase();
      const guideModel = createGuideModel(db);
      const gameModel = createGameModel(db);
      const initService = createMockInitService({
        stage: 'importing',
        isComplete: false,
        progress: 50,
        message: 'Importing guides...',
      });

      const app = express();
      app.use('/api/health', createHealthRouter({ guideModel, gameModel, initService }));

      const response = await request(app)
        .get('/api/health')
        .expect(200);

      expect(response.body.status).toBe('initializing');
      expect(response.body.initialized).toBe(false);
      expect(response.body.initStage).toBe('importing');

      db.close();
    });
  });

  describe('GET /api/health/ready', () => {
    it('should return ready when initialized', async () => {
      const response = await request(testApp.app)
        .get('/api/health/ready')
        .expect(200);

      expect(response.body.ready).toBe(true);
    });

    it('should return 503 when not initialized', async () => {
      const db = createTestDatabase();
      const guideModel = createGuideModel(db);
      const gameModel = createGameModel(db);
      const initService = createMockInitService({
        stage: 'downloading',
        isComplete: false,
        progress: 25,
      });

      const app = express();
      app.use('/api/health', createHealthRouter({ guideModel, gameModel, initService }));

      const response = await request(app)
        .get('/api/health/ready')
        .expect(503);

      expect(response.body.ready).toBe(false);
      expect(response.body.stage).toBe('downloading');
      expect(response.body.progress).toBe(25);

      db.close();
    });

    it('should return 503 with error when initialization failed', async () => {
      const db = createTestDatabase();
      const guideModel = createGuideModel(db);
      const gameModel = createGameModel(db);
      const initService = createMockInitService({
        stage: 'error',
        isComplete: false,
        hasError: true,
        error: 'Download failed',
      });

      const app = express();
      app.use('/api/health', createHealthRouter({ guideModel, gameModel, initService }));

      const response = await request(app)
        .get('/api/health/ready')
        .expect(503);

      expect(response.body.ready).toBe(false);
      expect(response.body.error).toBe('Download failed');

      db.close();
    });
  });

  describe('GET /api/health/live', () => {
    it('should always return live', async () => {
      const response = await request(testApp.app)
        .get('/api/health/live')
        .expect(200);

      expect(response.body.live).toBe(true);
    });
  });

  describe('GET /api/health/stats', () => {
    it('should return database statistics when initialized', async () => {
      const response = await request(testApp.app)
        .get('/api/health/stats')
        .expect(200);

      expect(response.body.initialized).toBe(true);
      expect(response.body.guides).toBeDefined();
      expect(response.body.games).toBeDefined();
      expect(response.body.server).toBeDefined();
    });

    it('should return correct guide and game counts', async () => {
      testApp.deps.guideModel.create(sampleGuideData.basic);
      testApp.deps.guideModel.create(sampleGuideData.html);
      testApp.deps.gameModel.create(sampleGameData.basic);

      const response = await request(testApp.app)
        .get('/api/health/stats')
        .expect(200);

      expect(response.body.guides.total).toBe(2);
      expect(response.body.games.total).toBe(1);
    });

    it('should return initialization status when not complete', async () => {
      const db = createTestDatabase();
      const guideModel = createGuideModel(db);
      const gameModel = createGameModel(db);
      const initService = createMockInitService({
        stage: 'extracting',
        isComplete: false,
        progress: 75,
        message: 'Extracting archives...',
      });

      const app = express();
      app.use('/api/health', createHealthRouter({ guideModel, gameModel, initService }));

      const response = await request(app)
        .get('/api/health/stats')
        .expect(200);

      expect(response.body.initialized).toBe(false);
      expect(response.body.stage).toBe('extracting');
      expect(response.body.progress).toBe(75);
      expect(response.body.message).toBe('Extracting archives...');

      db.close();
    });

    it('should return server memory information', async () => {
      const response = await request(testApp.app)
        .get('/api/health/stats')
        .expect(200);

      const memory = response.body.server.memory;
      expect(memory.heapUsed).toBeDefined();
      expect(memory.heapTotal).toBeDefined();
      expect(memory.external).toBeDefined();
    });
  });
});
