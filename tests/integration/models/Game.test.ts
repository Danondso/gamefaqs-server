import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDatabase } from '../../helpers/testDb';
import { createGameModel } from '../../../src/models/Game';
import { createGuideModel } from '../../../src/models/Guide';
import { sampleGameData, searchableGames, createManyGames } from '../../fixtures/games';
import { sampleGuideData } from '../../fixtures/guides';
import type { IDatabase } from '../../../src/interfaces/IDatabase';
import type { IGameModel } from '../../../src/interfaces/IGameModel';
import type { IGuideModel } from '../../../src/interfaces/IGuideModel';

describe('GameModel', () => {
  let db: IDatabase;
  let gameModel: IGameModel;
  let guideModel: IGuideModel;

  beforeEach(() => {
    db = createTestDatabase();
    gameModel = createGameModel(db);
    guideModel = createGuideModel(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('create', () => {
    it('should create a game with auto-generated id and timestamps', () => {
      const game = gameModel.create(sampleGameData.basic);

      expect(game.id).toBeDefined();
      expect(game.id.length).toBeGreaterThan(0);
      expect(game.title).toBe(sampleGameData.basic.title);
      expect(game.platform).toBe(sampleGameData.basic.platform);
      expect(game.created_at).toBeDefined();
      expect(game.updated_at).toBeDefined();
    });

    it('should set default status and completion_percentage', () => {
      const game = gameModel.create(sampleGameData.basic);

      expect(game.status).toBe('not_started');
      expect(game.completion_percentage).toBe(0);
    });

    it('should create a game with RA game ID', () => {
      const game = gameModel.create(sampleGameData.withRAId);

      expect(game.ra_game_id).toBe(sampleGameData.withRAId.ra_game_id);
    });

    it('should create a game with metadata', () => {
      const game = gameModel.create(sampleGameData.withMetadata);

      expect(game.metadata).toBe(sampleGameData.withMetadata.metadata);
    });

    it('should create a game with custom status', () => {
      const game = gameModel.create(sampleGameData.inProgress);

      expect(game.status).toBe('in_progress');
      expect(game.completion_percentage).toBe(45);
    });
  });

  describe('findById', () => {
    it('should find a game by id', () => {
      const created = gameModel.create(sampleGameData.basic);
      const found = gameModel.findById(created.id);

      expect(found).toBeDefined();
      expect(found?.id).toBe(created.id);
      expect(found?.title).toBe(created.title);
    });

    it('should return null for non-existent game', () => {
      const found = gameModel.findById('nonexistent-id');
      expect(found).toBeNull();
    });
  });

  describe('findByRAGameId', () => {
    it('should find a game by RetroAchievements ID', () => {
      const created = gameModel.create(sampleGameData.withRAId);
      const found = gameModel.findByRAGameId(sampleGameData.withRAId.ra_game_id!);

      expect(found).toBeDefined();
      expect(found?.id).toBe(created.id);
    });

    it('should return null for non-existent RA game ID', () => {
      const found = gameModel.findByRAGameId('nonexistent');
      expect(found).toBeNull();
    });
  });

  describe('findAll', () => {
    it('should return all games with default pagination', () => {
      const games = createManyGames(5);
      games.forEach(g => gameModel.create(g));

      const results = gameModel.findAll();
      expect(results.length).toBe(5);
    });

    it('should respect limit parameter', () => {
      const games = createManyGames(10);
      games.forEach(g => gameModel.create(g));

      const results = gameModel.findAll(3);
      expect(results.length).toBe(3);
    });

    it('should respect offset parameter', () => {
      const games = createManyGames(5);
      games.forEach(g => gameModel.create(g));

      const results = gameModel.findAll(10, 2);
      expect(results.length).toBe(3);
    });

    it('should order by title ASC', () => {
      gameModel.create({ title: 'Zelda' });
      gameModel.create({ title: 'Mario' });
      gameModel.create({ title: 'Castlevania' });

      const results = gameModel.findAll();
      expect(results[0].title).toBe('Castlevania');
      expect(results[1].title).toBe('Mario');
      expect(results[2].title).toBe('Zelda');
    });
  });

  describe('findByStatus', () => {
    beforeEach(() => {
      gameModel.create({ ...sampleGameData.basic, title: 'Not Started' });
      gameModel.create(sampleGameData.inProgress);
      gameModel.create(sampleGameData.completed);
    });

    it('should find games by status', () => {
      const inProgress = gameModel.findByStatus('in_progress');
      expect(inProgress.length).toBe(1);
      expect(inProgress[0].status).toBe('in_progress');

      const completed = gameModel.findByStatus('completed');
      expect(completed.length).toBe(1);
      expect(completed[0].status).toBe('completed');
    });

    it('should have convenience methods for common statuses', () => {
      const inProgress = gameModel.getInProgress();
      expect(inProgress.length).toBe(1);

      const completed = gameModel.getCompleted();
      expect(completed.length).toBe(1);
    });
  });

  describe('update', () => {
    it('should update game fields', () => {
      const game = gameModel.create(sampleGameData.basic);

      const success = gameModel.update(game.id, { title: 'Updated Title' });
      expect(success).toBe(true);

      const updated = gameModel.findById(game.id);
      expect(updated?.title).toBe('Updated Title');
    });

    it('should update timestamp on update', () => {
      const game = gameModel.create(sampleGameData.basic);
      const originalUpdatedAt = game.updated_at;

      gameModel.update(game.id, { title: 'New Title' });

      const updated = gameModel.findById(game.id);
      expect(updated?.updated_at).toBeGreaterThanOrEqual(originalUpdatedAt);
    });

    it('should return false for non-existent game', () => {
      const success = gameModel.update('nonexistent', { title: 'New Title' });
      expect(success).toBe(false);
    });
  });

  describe('updateStatus', () => {
    it('should update game status', () => {
      const game = gameModel.create(sampleGameData.basic);

      const success = gameModel.updateStatus(game.id, 'in_progress');
      expect(success).toBe(true);

      const updated = gameModel.findById(game.id);
      expect(updated?.status).toBe('in_progress');
    });
  });

  describe('updateCompletionPercentage', () => {
    it('should update percentage and set status to in_progress', () => {
      const game = gameModel.create(sampleGameData.basic);

      gameModel.updateCompletionPercentage(game.id, 50);

      const updated = gameModel.findById(game.id);
      expect(updated?.completion_percentage).toBe(50);
      expect(updated?.status).toBe('in_progress');
    });

    it('should set status to completed at 100%', () => {
      const game = gameModel.create(sampleGameData.basic);

      gameModel.updateCompletionPercentage(game.id, 100);

      const updated = gameModel.findById(game.id);
      expect(updated?.completion_percentage).toBe(100);
      expect(updated?.status).toBe('completed');
    });

    it('should set status to not_started at 0%', () => {
      const game = gameModel.create(sampleGameData.inProgress);

      gameModel.updateCompletionPercentage(game.id, 0);

      const updated = gameModel.findById(game.id);
      expect(updated?.completion_percentage).toBe(0);
      expect(updated?.status).toBe('not_started');
    });

    it('should clamp percentage to 0-100', () => {
      const game = gameModel.create(sampleGameData.basic);

      gameModel.updateCompletionPercentage(game.id, 150);
      let updated = gameModel.findById(game.id);
      expect(updated?.completion_percentage).toBe(100);

      gameModel.updateCompletionPercentage(game.id, -50);
      updated = gameModel.findById(game.id);
      expect(updated?.completion_percentage).toBe(0);
    });
  });

  describe('delete', () => {
    it('should delete a game', () => {
      const game = gameModel.create(sampleGameData.basic);

      const success = gameModel.delete(game.id);
      expect(success).toBe(true);

      const found = gameModel.findById(game.id);
      expect(found).toBeNull();
    });

    it('should return false for non-existent game', () => {
      const success = gameModel.delete('nonexistent');
      expect(success).toBe(false);
    });

    it('should set guide game_id to NULL when game is deleted', () => {
      const game = gameModel.create(sampleGameData.basic);
      const guide = guideModel.create({ ...sampleGuideData.basic, game_id: game.id });

      gameModel.delete(game.id);

      const updatedGuide = guideModel.findById(guide.id);
      expect(updatedGuide?.game_id).toBeNull();
    });
  });

  describe('metadata operations', () => {
    it('should get metadata from game', () => {
      const game = gameModel.create(sampleGameData.withMetadata);
      const metadata = gameModel.getMetadata(game.id);

      expect(metadata).toBeDefined();
      expect(metadata?.external_id).toBe('zelda-nes-001');
      expect(metadata?.genre).toBe('Action-Adventure');
    });

    it('should return null for game without metadata', () => {
      const game = gameModel.create(sampleGameData.basic);
      const metadata = gameModel.getMetadata(game.id);
      expect(metadata).toBeNull();
    });

    it('should set metadata on game', () => {
      const game = gameModel.create(sampleGameData.basic);

      const success = gameModel.setMetadata(game.id, {
        genre: 'Platformer',
        release_year: 1985,
      });
      expect(success).toBe(true);

      const metadata = gameModel.getMetadata(game.id);
      expect(metadata?.genre).toBe('Platformer');
      expect(metadata?.release_year).toBe(1985);
    });
  });

  describe('getTotalCount', () => {
    it('should return correct count', () => {
      expect(gameModel.getTotalCount()).toBe(0);

      gameModel.create(sampleGameData.basic);
      expect(gameModel.getTotalCount()).toBe(1);

      gameModel.create(sampleGameData.withRAId);
      expect(gameModel.getTotalCount()).toBe(2);
    });
  });

  describe('getWithGuideCount', () => {
    it('should return games with guide count', () => {
      const game1 = gameModel.create({ title: 'Game with guides' });
      const game2 = gameModel.create({ title: 'Game without guides' });

      guideModel.create({ ...sampleGuideData.basic, game_id: game1.id, title: 'Guide 1' });
      guideModel.create({ ...sampleGuideData.basic, game_id: game1.id, title: 'Guide 2' });

      const results = gameModel.getWithGuideCount();

      const withGuides = results.find(g => g.id === game1.id);
      const withoutGuides = results.find(g => g.id === game2.id);

      expect(withGuides?.guide_count).toBe(2);
      expect(withoutGuides?.guide_count).toBe(0);
    });
  });

  describe('searchByTitle', () => {
    beforeEach(() => {
      searchableGames.forEach(g => gameModel.create(g));
    });

    it('should find games by title substring', () => {
      const results = gameModel.searchByTitle('Mario');
      expect(results.length).toBe(5); // All Mario games
    });

    it('should be case insensitive', () => {
      const results = gameModel.searchByTitle('zelda');
      expect(results.length).toBeGreaterThan(0);
    });

    it('should return empty array for no matches', () => {
      const results = gameModel.searchByTitle('Nonexistent');
      expect(results).toEqual([]);
    });

    it('should limit results to 50', () => {
      // Create many games
      for (let i = 0; i < 60; i++) {
        gameModel.create({ title: `Searchable ${i}` });
      }

      const results = gameModel.searchByTitle('Searchable');
      expect(results.length).toBe(50);
    });
  });

  describe('bulkCreate', () => {
    it('should create multiple games in a transaction', () => {
      const games = createManyGames(10);
      gameModel.bulkCreate(games);

      expect(gameModel.getTotalCount()).toBe(10);
    });
  });

  describe('findByExternalId', () => {
    it('should find game by external_id in metadata', () => {
      const game = gameModel.create(sampleGameData.withMetadata);

      const found = gameModel.findByExternalId('zelda-nes-001');
      expect(found).toBeDefined();
      expect(found?.id).toBe(game.id);
    });

    it('should return null for non-existent external_id', () => {
      gameModel.create(sampleGameData.withMetadata);

      const found = gameModel.findByExternalId('nonexistent');
      expect(found).toBeNull();
    });
  });
});
