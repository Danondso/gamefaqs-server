import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createTestApp, TestAppResult } from '../../helpers/testApp';
import { sampleGuideData, searchableGuides, createManyGuides } from '../../fixtures/guides';

describe('Guides Routes', () => {
  let testApp: TestAppResult;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  describe('GET /api/guides', () => {
    it('should return empty list when no guides exist', async () => {
      const response = await request(testApp.app)
        .get('/api/guides')
        .expect(200);

      expect(response.body.data).toEqual([]);
      expect(response.body.pagination.total).toBe(0);
    });

    it('should return paginated guides', async () => {
      const guides = createManyGuides(25);
      guides.forEach(g => testApp.deps.guideModel.create(g));

      const response = await request(testApp.app)
        .get('/api/guides')
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

    it('should return guides without full content', async () => {
      testApp.deps.guideModel.create(sampleGuideData.basic);

      const response = await request(testApp.app)
        .get('/api/guides')
        .expect(200);

      expect(response.body.data[0].content).toBeUndefined();
      expect(response.body.data[0].content_length).toBeDefined();
    });

    it('should use default pagination when not specified', async () => {
      const guides = createManyGuides(30);
      guides.forEach(g => testApp.deps.guideModel.create(g));

      const response = await request(testApp.app)
        .get('/api/guides')
        .expect(200);

      expect(response.body.data.length).toBe(20); // Default page size
      expect(response.body.pagination.limit).toBe(20);
    });

    it('should cap limit at max page size', async () => {
      const guides = createManyGuides(150);
      guides.forEach(g => testApp.deps.guideModel.create(g));

      const response = await request(testApp.app)
        .get('/api/guides')
        .query({ limit: 200 })
        .expect(200);

      expect(response.body.data.length).toBe(100); // Max page size
    });
  });

  describe('GET /api/guides/search', () => {
    beforeEach(() => {
      searchableGuides.forEach(g => testApp.deps.guideModel.create(g));
    });

    it('should search guides by query', async () => {
      const response = await request(testApp.app)
        .get('/api/guides/search')
        .query({ q: 'walkthrough' })
        .expect(200);

      expect(response.body.guides.length + response.body.content.length).toBeGreaterThan(0);
      expect(response.body.query).toBe('walkthrough');
    });

    it('should return 400 for empty query', async () => {
      const response = await request(testApp.app)
        .get('/api/guides/search')
        .query({ q: '' })
        .expect(400);

      expect(response.body.error).toBe('Search query is required');
    });

    it('should return 400 for missing query', async () => {
      const response = await request(testApp.app)
        .get('/api/guides/search')
        .expect(400);

      expect(response.body.error).toBe('Search query is required');
    });

    it('should separate metadata and content matches', async () => {
      const response = await request(testApp.app)
        .get('/api/guides/search')
        .query({ q: 'strategy' })
        .expect(200);

      expect(response.body).toHaveProperty('guides');
      expect(response.body).toHaveProperty('content');
    });

    it('should strip content from search results', async () => {
      const response = await request(testApp.app)
        .get('/api/guides/search')
        .query({ q: 'guide' })
        .expect(200);

      if (response.body.guides.length > 0) {
        expect(response.body.guides[0].content).toBeUndefined();
      }
    });
  });

  describe('GET /api/guides/:id', () => {
    it('should return a single guide with full content', async () => {
      const guide = testApp.deps.guideModel.create(sampleGuideData.basic);

      const response = await request(testApp.app)
        .get(`/api/guides/${guide.id}`)
        .expect(200);

      expect(response.body.data.id).toBe(guide.id);
      expect(response.body.data.title).toBe(guide.title);
      expect(response.body.data.content).toBe(guide.content);
    });

    it('should return 404 for non-existent guide', async () => {
      const response = await request(testApp.app)
        .get('/api/guides/nonexistent-id')
        .expect(404);

      expect(response.body.error).toBe('Guide not found');
    });
  });

  describe('GET /api/guides/:id/content', () => {
    it('should return guide content with correct content-type for txt', async () => {
      const guide = testApp.deps.guideModel.create(sampleGuideData.basic);

      const response = await request(testApp.app)
        .get(`/api/guides/${guide.id}/content`)
        .expect(200);

      expect(response.text).toBe(guide.content);
      expect(response.headers['content-type']).toContain('text/plain');
    });

    it('should return guide content with correct content-type for html', async () => {
      const guide = testApp.deps.guideModel.create(sampleGuideData.html);

      const response = await request(testApp.app)
        .get(`/api/guides/${guide.id}/content`)
        .expect(200);

      expect(response.text).toBe(guide.content);
      expect(response.headers['content-type']).toContain('text/html');
    });

    it('should return guide content with correct content-type for markdown', async () => {
      const guide = testApp.deps.guideModel.create(sampleGuideData.markdown);

      const response = await request(testApp.app)
        .get(`/api/guides/${guide.id}/content`)
        .expect(200);

      expect(response.text).toBe(guide.content);
      expect(response.headers['content-type']).toContain('text/markdown');
    });

    it('should set content-disposition header', async () => {
      const guide = testApp.deps.guideModel.create(sampleGuideData.basic);

      const response = await request(testApp.app)
        .get(`/api/guides/${guide.id}/content`)
        .expect(200);

      expect(response.headers['content-disposition']).toContain('inline');
      expect(response.headers['content-disposition']).toContain(guide.title);
    });

    it('should return 404 for non-existent guide', async () => {
      await request(testApp.app)
        .get('/api/guides/nonexistent-id/content')
        .expect(404);
    });
  });

  describe('GET /api/guides/:id/metadata', () => {
    it('should return guide metadata', async () => {
      const guide = testApp.deps.guideModel.create(sampleGuideData.withMetadata);

      const response = await request(testApp.app)
        .get(`/api/guides/${guide.id}/metadata`)
        .expect(200);

      expect(response.body.data.id).toBe(guide.id);
      expect(response.body.data.title).toBe(guide.title);
      expect(response.body.data.metadata).toBeDefined();
      expect(response.body.data.metadata.platform).toBe('PlayStation');
    });

    it('should return null metadata for guide without metadata', async () => {
      const guide = testApp.deps.guideModel.create(sampleGuideData.basic);

      const response = await request(testApp.app)
        .get(`/api/guides/${guide.id}/metadata`)
        .expect(200);

      expect(response.body.data.id).toBe(guide.id);
      expect(response.body.data.metadata).toBeNull();
    });

    it('should return 404 for non-existent guide', async () => {
      await request(testApp.app)
        .get('/api/guides/nonexistent-id/metadata')
        .expect(404);
    });
  });

  describe('PUT /api/guides/:id/position', () => {
    it('should update guide position', async () => {
      const guide = testApp.deps.guideModel.create(sampleGuideData.basic);

      const response = await request(testApp.app)
        .put(`/api/guides/${guide.id}/position`)
        .send({ position: 1234 })
        .expect(200);

      expect(response.body.success).toBe(true);

      const updated = testApp.deps.guideModel.findById(guide.id);
      expect(updated?.last_read_position).toBe(1234);
    });

    it('should return 400 for invalid position', async () => {
      const guide = testApp.deps.guideModel.create(sampleGuideData.basic);

      await request(testApp.app)
        .put(`/api/guides/${guide.id}/position`)
        .send({ position: 'invalid' })
        .expect(400);

      await request(testApp.app)
        .put(`/api/guides/${guide.id}/position`)
        .send({ position: -1 })
        .expect(400);
    });

    it('should return 404 for non-existent guide', async () => {
      const response = await request(testApp.app)
        .put('/api/guides/nonexistent-id/position')
        .send({ position: 100 })
        .expect(404);

      expect(response.body.error).toBe('Guide not found');
    });
  });
});
