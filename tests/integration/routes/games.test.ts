import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createTestApp, TestAppResult } from '../../helpers/testApp';
import { sampleGameData, searchableGames, createManyGames } from '../../fixtures/games';
import { sampleGuideData } from '../../fixtures/guides';

describe('Games Routes', () => {
  let testApp: TestAppResult;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  describe('GET /api/games', () => {
    it('should return empty list when no games exist', async () => {
      const response = await request(testApp.app)
        .get('/api/games')
        .expect(200);

      expect(response.body.data).toEqual([]);
      expect(response.body.pagination.total).toBe(0);
    });

    it('should return paginated games', async () => {
      const games = createManyGames(25);
      games.forEach(g => testApp.deps.gameModel.create(g));

      const response = await request(testApp.app)
        .get('/api/games')
        .query({ page: 1, limit: 10 })
        .expect(200);

      expect(response.body.data.length).toBe(10);
      expect(response.body.pagination).toEqual({
        page: 1,
        limit: 10,
        total: 25,
        totalPages: 3,
      });
    });

    it('should use default pagination when not specified', async () => {
      const games = createManyGames(30);
      games.forEach(g => testApp.deps.gameModel.create(g));

      const response = await request(testApp.app)
        .get('/api/games')
        .expect(200);

      expect(response.body.data.length).toBe(20); // Default page size
    });

    it('should return second page correctly', async () => {
      const games = createManyGames(25);
      games.forEach(g => testApp.deps.gameModel.create(g));

      const response = await request(testApp.app)
        .get('/api/games')
        .query({ page: 2, limit: 10 })
        .expect(200);

      expect(response.body.data.length).toBe(10);
      expect(response.body.pagination.page).toBe(2);
    });
  });

  describe('GET /api/games/search', () => {
    beforeEach(() => {
      searchableGames.forEach(g => testApp.deps.gameModel.create(g));
    });

    it('should search games by title', async () => {
      const response = await request(testApp.app)
        .get('/api/games/search')
        .query({ q: 'Mario' })
        .expect(200);

      expect(response.body.data.length).toBe(5);
      expect(response.body.query).toBe('Mario');
    });

    it('should return 400 for empty query', async () => {
      const response = await request(testApp.app)
        .get('/api/games/search')
        .query({ q: '' })
        .expect(400);

      expect(response.body.error).toBe('Search query is required');
    });

    it('should return 400 for missing query', async () => {
      await request(testApp.app)
        .get('/api/games/search')
        .expect(400);
    });

    it('should return empty array for no matches', async () => {
      const response = await request(testApp.app)
        .get('/api/games/search')
        .query({ q: 'Nonexistent' })
        .expect(200);

      expect(response.body.data).toEqual([]);
      expect(response.body.total).toBe(0);
    });
  });

  describe('GET /api/games/:id', () => {
    it('should return a single game', async () => {
      const game = testApp.deps.gameModel.create(sampleGameData.basic);

      const response = await request(testApp.app)
        .get(`/api/games/${game.id}`)
        .expect(200);

      expect(response.body.data.id).toBe(game.id);
      expect(response.body.data.title).toBe(game.title);
      expect(response.body.data.platform).toBe(game.platform);
    });

    it('should return 404 for non-existent game', async () => {
      const response = await request(testApp.app)
        .get('/api/games/nonexistent-id')
        .expect(404);

      expect(response.body.error).toBe('Game not found');
    });
  });

  describe('GET /api/games/:id/guides', () => {
    it('should return guides for a game', async () => {
      const game = testApp.deps.gameModel.create(sampleGameData.basic);
      testApp.deps.guideModel.create({ ...sampleGuideData.basic, title: 'Guide 1', game_id: game.id });
      testApp.deps.guideModel.create({ ...sampleGuideData.basic, title: 'Guide 2', game_id: game.id });

      const response = await request(testApp.app)
        .get(`/api/games/${game.id}/guides`)
        .expect(200);

      expect(response.body.data.length).toBe(2);
      expect(response.body.game.id).toBe(game.id);
      expect(response.body.total).toBe(2);
    });

    it('should return empty array when game has no guides', async () => {
      const game = testApp.deps.gameModel.create(sampleGameData.basic);

      const response = await request(testApp.app)
        .get(`/api/games/${game.id}/guides`)
        .expect(200);

      expect(response.body.data).toEqual([]);
      expect(response.body.total).toBe(0);
    });

    it('should return 404 for non-existent game', async () => {
      const response = await request(testApp.app)
        .get('/api/games/nonexistent-id/guides')
        .expect(404);

      expect(response.body.error).toBe('Game not found');
    });

    it('should not include full guide content', async () => {
      const game = testApp.deps.gameModel.create(sampleGameData.basic);
      testApp.deps.guideModel.create({ ...sampleGuideData.basic, game_id: game.id });

      const response = await request(testApp.app)
        .get(`/api/games/${game.id}/guides`)
        .expect(200);

      expect(response.body.data[0].content).toBeUndefined();
    });
  });

  describe('GET /api/games/with-guides', () => {
    it('should return games with guide counts', async () => {
      const game1 = testApp.deps.gameModel.create({ title: 'Game with guides' });
      const game2 = testApp.deps.gameModel.create({ title: 'Game without guides' });
      testApp.deps.guideModel.create({ ...sampleGuideData.basic, title: 'Guide 1', game_id: game1.id });
      testApp.deps.guideModel.create({ ...sampleGuideData.basic, title: 'Guide 2', game_id: game1.id });

      const response = await request(testApp.app)
        .get('/api/games/with-guides')
        .expect(200);

      expect(response.body.data.length).toBe(2);
      const withGuides = response.body.data.find((g: any) => g.id === game1.id);
      const withoutGuides = response.body.data.find((g: any) => g.id === game2.id);
      expect(withGuides.guide_count).toBe(2);
      expect(withoutGuides.guide_count).toBe(0);
    });
  });

  describe('PUT /api/games/:id/status', () => {
    it('should update game status', async () => {
      const game = testApp.deps.gameModel.create(sampleGameData.basic);

      const response = await request(testApp.app)
        .put(`/api/games/${game.id}/status`)
        .send({ status: 'in_progress' })
        .expect(200);

      expect(response.body.success).toBe(true);

      const updated = testApp.deps.gameModel.findById(game.id);
      expect(updated?.status).toBe('in_progress');
    });

    it('should accept all valid statuses', async () => {
      const game = testApp.deps.gameModel.create(sampleGameData.basic);

      for (const status of ['in_progress', 'completed', 'not_started']) {
        await request(testApp.app)
          .put(`/api/games/${game.id}/status`)
          .send({ status })
          .expect(200);

        const updated = testApp.deps.gameModel.findById(game.id);
        expect(updated?.status).toBe(status);
      }
    });

    it('should return 400 for invalid status', async () => {
      const game = testApp.deps.gameModel.create(sampleGameData.basic);

      const response = await request(testApp.app)
        .put(`/api/games/${game.id}/status`)
        .send({ status: 'invalid' })
        .expect(400);

      expect(response.body.error).toBe('Invalid status');
    });

    it('should return 404 for non-existent game', async () => {
      const response = await request(testApp.app)
        .put('/api/games/nonexistent-id/status')
        .send({ status: 'completed' })
        .expect(404);

      expect(response.body.error).toBe('Game not found');
    });
  });

  describe('PUT /api/games/:id/completion', () => {
    it('should update completion percentage', async () => {
      const game = testApp.deps.gameModel.create(sampleGameData.basic);

      const response = await request(testApp.app)
        .put(`/api/games/${game.id}/completion`)
        .send({ percentage: 50 })
        .expect(200);

      expect(response.body.success).toBe(true);

      const updated = testApp.deps.gameModel.findById(game.id);
      expect(updated?.completion_percentage).toBe(50);
      expect(updated?.status).toBe('in_progress');
    });

    it('should set status to completed at 100%', async () => {
      const game = testApp.deps.gameModel.create(sampleGameData.basic);

      await request(testApp.app)
        .put(`/api/games/${game.id}/completion`)
        .send({ percentage: 100 })
        .expect(200);

      const updated = testApp.deps.gameModel.findById(game.id);
      expect(updated?.completion_percentage).toBe(100);
      expect(updated?.status).toBe('completed');
    });

    it('should set status to not_started at 0%', async () => {
      const game = testApp.deps.gameModel.create(sampleGameData.inProgress);

      await request(testApp.app)
        .put(`/api/games/${game.id}/completion`)
        .send({ percentage: 0 })
        .expect(200);

      const updated = testApp.deps.gameModel.findById(game.id);
      expect(updated?.completion_percentage).toBe(0);
      expect(updated?.status).toBe('not_started');
    });

    it('should return 400 for invalid percentage', async () => {
      const game = testApp.deps.gameModel.create(sampleGameData.basic);

      await request(testApp.app)
        .put(`/api/games/${game.id}/completion`)
        .send({ percentage: 'invalid' })
        .expect(400);

      await request(testApp.app)
        .put(`/api/games/${game.id}/completion`)
        .send({ percentage: -10 })
        .expect(400);

      await request(testApp.app)
        .put(`/api/games/${game.id}/completion`)
        .send({ percentage: 150 })
        .expect(400);
    });

    it('should return 404 for non-existent game', async () => {
      const response = await request(testApp.app)
        .put('/api/games/nonexistent-id/completion')
        .send({ percentage: 50 })
        .expect(404);

      expect(response.body.error).toBe('Game not found');
    });
  });
});
