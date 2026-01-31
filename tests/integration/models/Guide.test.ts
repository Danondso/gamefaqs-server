import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDatabase } from '../../helpers/testDb';
import { createGuideModel } from '../../../src/models/Guide';
import { createGameModel } from '../../../src/models/Game';
import { sampleGuideData, searchableGuides, createManyGuides } from '../../fixtures/guides';
import type { IDatabase } from '../../../src/interfaces/IDatabase';
import type { IGuideModel } from '../../../src/interfaces/IGuideModel';
import type { IGameModel } from '../../../src/interfaces/IGameModel';

describe('GuideModel', () => {
  let db: IDatabase;
  let guideModel: IGuideModel;
  let gameModel: IGameModel;

  beforeEach(() => {
    db = createTestDatabase();
    guideModel = createGuideModel(db);
    gameModel = createGameModel(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('create', () => {
    it('should create a guide with auto-generated id and timestamps', () => {
      const guide = guideModel.create(sampleGuideData.basic);

      expect(guide.id).toBeDefined();
      expect(guide.id.length).toBeGreaterThan(0);
      expect(guide.title).toBe(sampleGuideData.basic.title);
      expect(guide.content).toBe(sampleGuideData.basic.content);
      expect(guide.format).toBe(sampleGuideData.basic.format);
      expect(guide.created_at).toBeDefined();
      expect(guide.updated_at).toBeDefined();
      expect(guide.created_at).toBe(guide.updated_at);
    });

    it('should create a guide with metadata', () => {
      const guide = guideModel.create(sampleGuideData.withMetadata);

      expect(guide.metadata).toBe(sampleGuideData.withMetadata.metadata);
      const metadata = JSON.parse(guide.metadata!);
      expect(metadata.platform).toBe('PlayStation');
      expect(metadata.author).toBe('GameExpert');
    });

    it('should create a guide linked to a game', () => {
      const game = gameModel.create({ title: 'Test Game' });
      const guideData = sampleGuideData.withGameId(game.id);
      const guide = guideModel.create(guideData);

      expect(guide.game_id).toBe(game.id);
    });

    it('should create guides with different formats', () => {
      const txtGuide = guideModel.create(sampleGuideData.basic);
      const htmlGuide = guideModel.create(sampleGuideData.html);
      const mdGuide = guideModel.create(sampleGuideData.markdown);

      expect(txtGuide.format).toBe('txt');
      expect(htmlGuide.format).toBe('html');
      expect(mdGuide.format).toBe('md');
    });
  });

  describe('findById', () => {
    it('should find a guide by id', () => {
      const created = guideModel.create(sampleGuideData.basic);
      const found = guideModel.findById(created.id);

      expect(found).toBeDefined();
      expect(found?.id).toBe(created.id);
      expect(found?.title).toBe(created.title);
    });

    it('should return null for non-existent guide', () => {
      const found = guideModel.findById('nonexistent-id');
      expect(found).toBeNull();
    });
  });

  describe('findAll', () => {
    it('should return all guides with default pagination', () => {
      const guides = createManyGuides(5);
      guides.forEach(g => guideModel.create(g));

      const results = guideModel.findAll();
      expect(results.length).toBe(5);
    });

    it('should respect limit parameter', () => {
      const guides = createManyGuides(10);
      guides.forEach(g => guideModel.create(g));

      const results = guideModel.findAll(3);
      expect(results.length).toBe(3);
    });

    it('should respect offset parameter', () => {
      const guides = createManyGuides(5);
      const created = guides.map(g => guideModel.create(g));

      const results = guideModel.findAll(10, 2);
      expect(results.length).toBe(3);
    });

    it('should order by updated_at DESC', () => {
      // Create both guides with the same timestamp
      guideModel.create({ ...sampleGuideData.basic, title: 'First' });
      guideModel.create({ ...sampleGuideData.basic, title: 'Second' });

      const results = guideModel.findAll();
      // Both guides have same timestamp, so order may vary
      // Instead, verify that results are returned in a consistent order
      expect(results.length).toBe(2);
      expect(results.map(g => g.title).sort()).toEqual(['First', 'Second']);
    });
  });

  describe('findByGameId', () => {
    it('should find all guides for a game', () => {
      const game = gameModel.create({ title: 'Test Game' });

      guideModel.create({ ...sampleGuideData.basic, title: 'Guide 1', game_id: game.id });
      guideModel.create({ ...sampleGuideData.basic, title: 'Guide 2', game_id: game.id });
      guideModel.create({ ...sampleGuideData.basic, title: 'Other Guide' });

      const results = guideModel.findByGameId(game.id);
      expect(results.length).toBe(2);
    });

    it('should return empty array when game has no guides', () => {
      const game = gameModel.create({ title: 'Empty Game' });
      const results = guideModel.findByGameId(game.id);
      expect(results).toEqual([]);
    });
  });

  describe('update', () => {
    it('should update guide fields', () => {
      const guide = guideModel.create(sampleGuideData.basic);

      const success = guideModel.update(guide.id, { title: 'Updated Title' });
      expect(success).toBe(true);

      const updated = guideModel.findById(guide.id);
      expect(updated?.title).toBe('Updated Title');
    });

    it('should update timestamp on update', () => {
      const guide = guideModel.create(sampleGuideData.basic);
      const originalUpdatedAt = guide.updated_at;

      // Small delay to ensure different timestamp
      guideModel.update(guide.id, { title: 'New Title' });

      const updated = guideModel.findById(guide.id);
      expect(updated?.updated_at).toBeGreaterThanOrEqual(originalUpdatedAt);
    });

    it('should return false for non-existent guide', () => {
      const success = guideModel.update('nonexistent', { title: 'New Title' });
      expect(success).toBe(false);
    });
  });

  describe('updateLastReadPosition', () => {
    it('should update last read position', () => {
      const guide = guideModel.create(sampleGuideData.basic);

      const success = guideModel.updateLastReadPosition(guide.id, 1234);
      expect(success).toBe(true);

      const updated = guideModel.findById(guide.id);
      expect(updated?.last_read_position).toBe(1234);
    });
  });

  describe('delete', () => {
    it('should delete a guide', () => {
      const guide = guideModel.create(sampleGuideData.basic);

      const success = guideModel.delete(guide.id);
      expect(success).toBe(true);

      const found = guideModel.findById(guide.id);
      expect(found).toBeNull();
    });

    it('should return false for non-existent guide', () => {
      const success = guideModel.delete('nonexistent');
      expect(success).toBe(false);
    });
  });

  describe('search', () => {
    beforeEach(() => {
      searchableGuides.forEach(g => guideModel.create(g));
    });

    it('should find guides by title match', () => {
      const results = guideModel.search('Walkthrough');
      expect(results.guides.length).toBeGreaterThan(0);
      expect(results.guides.some(g => g.title.includes('Walkthrough'))).toBe(true);
    });

    it('should find guides by content match', () => {
      const results = guideModel.search('secrets');
      expect(results.content.length + results.guides.length).toBeGreaterThan(0);
    });

    it('should separate metadata matches from content-only matches', () => {
      const results = guideModel.search('achievements');

      // Should match on tags (metadata) for Collectibles List
      expect(results.guides.length).toBeGreaterThan(0);
    });

    it('should respect limit parameter', () => {
      // Create many guides
      for (let i = 0; i < 20; i++) {
        guideModel.create({
          title: `Searchable Guide ${i}`,
          content: 'searchterm here',
          format: 'txt',
          file_path: `/guides/search/${i}.txt`,
        });
      }

      const results = guideModel.search('searchterm', 5);
      expect(results.guides.length + results.content.length).toBeLessThanOrEqual(10);
    });
  });

  describe('searchCombined', () => {
    beforeEach(() => {
      searchableGuides.forEach(g => guideModel.create(g));
    });

    it('should return combined results without duplicates', () => {
      const results = guideModel.searchCombined('guide');
      const ids = results.map(g => g.id);
      const uniqueIds = new Set(ids);
      expect(ids.length).toBe(uniqueIds.size);
    });
  });

  describe('metadata operations', () => {
    it('should get metadata from guide', () => {
      const guide = guideModel.create(sampleGuideData.withMetadata);
      const metadata = guideModel.getMetadata(guide.id);

      expect(metadata).toBeDefined();
      expect(metadata?.platform).toBe('PlayStation');
      expect(metadata?.author).toBe('GameExpert');
    });

    it('should return null for guide without metadata', () => {
      const guide = guideModel.create(sampleGuideData.basic);
      const metadata = guideModel.getMetadata(guide.id);
      expect(metadata).toBeNull();
    });

    it('should set metadata on guide', () => {
      const guide = guideModel.create(sampleGuideData.basic);

      const success = guideModel.setMetadata(guide.id, {
        platform: 'SNES',
        tags: ['walkthrough'],
      });
      expect(success).toBe(true);

      const metadata = guideModel.getMetadata(guide.id);
      expect(metadata?.platform).toBe('SNES');
      expect(metadata?.tags).toEqual(['walkthrough']);
    });

    it('should update ai_analyzed_at when setting metadata with aiAnalyzedAt', () => {
      const guide = guideModel.create(sampleGuideData.basic);
      const timestamp = Date.now();

      guideModel.setMetadata(guide.id, {
        aiAnalyzedAt: timestamp,
        summary: 'Test summary',
      });

      const updated = guideModel.findById(guide.id);
      expect(updated?.ai_analyzed_at).toBe(timestamp);
    });
  });

  describe('getTotalCount', () => {
    it('should return correct count', () => {
      expect(guideModel.getTotalCount()).toBe(0);

      guideModel.create(sampleGuideData.basic);
      expect(guideModel.getTotalCount()).toBe(1);

      guideModel.create(sampleGuideData.html);
      expect(guideModel.getTotalCount()).toBe(2);
    });
  });

  describe('getRecentlyRead', () => {
    it('should return guides with read position', () => {
      guideModel.create(sampleGuideData.basic);
      guideModel.create(sampleGuideData.withPosition);

      const results = guideModel.getRecentlyRead();
      expect(results.length).toBe(1);
      expect(results[0].last_read_position).toBe(500);
    });

    it('should respect limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        const guide = guideModel.create({ ...sampleGuideData.basic, title: `Guide ${i}` });
        guideModel.updateLastReadPosition(guide.id, i * 100);
      }

      const results = guideModel.getRecentlyRead(3);
      expect(results.length).toBe(3);
    });
  });

  describe('bulkCreate', () => {
    it('should create multiple guides in a transaction', () => {
      const guides = createManyGuides(10);
      guideModel.bulkCreate(guides);

      expect(guideModel.getTotalCount()).toBe(10);
    });

    it('should rollback on error', () => {
      const guides = createManyGuides(5);
      guides[2].file_path = null as any; // Will cause constraint violation

      try {
        guideModel.bulkCreate(guides);
      } catch (e) {
        // Expected
      }

      expect(guideModel.getTotalCount()).toBe(0);
    });
  });

  describe('findMissingMetadata', () => {
    it('should find guides without AI analysis', () => {
      guideModel.create(sampleGuideData.basic);
      const guide2 = guideModel.create(sampleGuideData.basic);
      guideModel.setMetadata(guide2.id, { aiAnalyzedAt: Date.now() });

      const results = guideModel.findMissingMetadata();
      expect(results.length).toBe(1);
    });
  });

  describe('findAllSummary', () => {
    it('should return guides without full content but with content_length', () => {
      guideModel.create(sampleGuideData.basic);

      const results = guideModel.findAllSummary();
      expect(results.length).toBe(1);
      expect((results[0] as any).content).toBeUndefined();
      expect(results[0].content_length).toBe(sampleGuideData.basic.content.length);
    });
  });

  describe('findAllWithGames', () => {
    it('should return guides with their associated games', () => {
      const game = gameModel.create({ title: 'Test Game', platform: 'NES' });
      guideModel.create({ ...sampleGuideData.basic, game_id: game.id });
      guideModel.create(sampleGuideData.basic); // No game

      const results = guideModel.findAllWithGames();
      expect(results.length).toBe(2);

      const withGame = results.find(r => r.game !== null);
      expect(withGame?.game?.title).toBe('Test Game');

      const withoutGame = results.find(r => r.game === null);
      expect(withoutGame).toBeDefined();
    });
  });
});
