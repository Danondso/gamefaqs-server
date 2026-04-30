import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDatabase } from './helpers/testDb';
import type { IDatabase } from '../src/interfaces/IDatabase';
import {
  RetrievalService,
  type FtsHit,
  type VectorHit,
} from '../src/services/RetrievalService';
import type { EmbeddingService } from '../src/services/EmbeddingService';

// A stand-in EmbeddingService that returns a deterministic vector. The real
// service hits a remote Ollama; we don't want network in unit tests.
const mockEmbedder = {
  embed: async (_text: string) => new Float32Array(8).fill(0.1),
} as unknown as EmbeddingService;

interface SeededChunk {
  id: string;
  guide_id: string;
  index: number;
  content: string;
}

interface SeededGuide {
  id: string;
  title: string;
  game_id?: string | null;
  platform?: string;
  genre?: string;
  tags?: string[];
}

function seed(db: IDatabase, guides: SeededGuide[], chunks: SeededChunk[]): void {
  const now = Date.now();
  // Pre-create any games referenced by guides — guides.game_id has a FK to games(id).
  const gameIds = new Set(guides.map(g => g.game_id).filter((id): id is string => !!id));
  for (const id of gameIds) {
    db.run(
      `INSERT INTO games (id, title, completion_percentage, status, created_at, updated_at)
       VALUES (?, ?, 0, 'not_started', ?, ?)`,
      [id, id, now, now]
    );
  }
  for (const g of guides) {
    const metaObj: Record<string, unknown> = {};
    if (g.platform) metaObj.platform = g.platform;
    if (g.genre) metaObj.genre = g.genre;
    if (g.tags) metaObj.tags = g.tags;
    const metadata = Object.keys(metaObj).length > 0 ? JSON.stringify(metaObj) : null;
    db.run(
      `INSERT INTO guides (id, title, content, format, file_path, game_id, metadata, created_at, updated_at)
       VALUES (?, ?, ?, 'txt', ?, ?, ?, ?, ?)`,
      [g.id, g.title, 'placeholder', `/p/${g.id}.txt`, g.game_id ?? null, metadata, now, now]
    );
  }
  for (const c of chunks) {
    db.run(
      `INSERT INTO chunks (id, guide_id, chunk_index, content, char_start, char_end, token_count, created_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
      [c.id, c.guide_id, c.index, c.content, c.content.length, Math.ceil(c.content.length / 4), now]
    );
  }
}

describe('RetrievalService', () => {
  let db: IDatabase;

  beforeEach(() => {
    db = createTestDatabase();
  });

  afterEach(() => {
    db.close();
  });

  it('fuses vector + FTS via RRF and orders by combined score', async () => {
    const g1: SeededGuide = { id: 'guide-a', title: 'Guide A' };
    const g2: SeededGuide = { id: 'guide-b', title: 'Guide B' };
    const chunks: SeededChunk[] = [
      { id: 'c-A1', guide_id: g1.id, index: 0, content: 'a-one '.repeat(80) },
      { id: 'c-A2', guide_id: g1.id, index: 1, content: 'a-two '.repeat(80) },
      { id: 'c-B1', guide_id: g2.id, index: 0, content: 'b-one '.repeat(80) },
      { id: 'c-B2', guide_id: g2.id, index: 1, content: 'b-two '.repeat(80) },
    ];
    seed(db, [g1, g2], chunks);

    // Vector ranks: A2 first, B1 second, A1 third
    const vectorSearch = (): VectorHit[] => [
      { chunk_id: 'c-A2', distance: 0.1 },
      { chunk_id: 'c-B1', distance: 0.2 },
      { chunk_id: 'c-A1', distance: 0.3 },
    ];
    // FTS ranks: B1 first (overlaps with vec rank 2), then A1, then C-only B2
    const ftsSearch = (): FtsHit[] => [
      { chunk_id: 'c-B1', rank: -1.0 },
      { chunk_id: 'c-A1', rank: -0.8 },
      { chunk_id: 'c-B2', rank: -0.5 },
    ];

    const svc = new RetrievalService({
      db,
      embeddingService: mockEmbedder,
      vectorSearch,
      ftsSearch,
      rrfK: 60,
    });

    const citations = await svc.retrieve('any', {}, 4);
    const ids = citations.map(c => c.chunk_id);
    // c-B1 appears in both lists (vec rank 2, fts rank 1) → should outrank
    // single-list hits like c-A2 (vec rank 1) and c-A1 (vec rank 3 + fts rank 2).
    // RRF math:
    //   c-B1 = 1/62 + 1/61 ≈ 0.03251
    //   c-A1 = 1/63 + 1/62 ≈ 0.03200
    //   c-A2 = 1/61          ≈ 0.01639
    //   c-B2 = 1/63          ≈ 0.01587
    expect(ids).toEqual(['c-B1', 'c-A1', 'c-A2', 'c-B2']);
    // Scores are descending
    for (let i = 1; i < citations.length; i++) {
      expect(citations[i - 1].score).toBeGreaterThanOrEqual(citations[i].score);
    }
  });

  it('truncates excerpts to ~300 chars', async () => {
    const longContent = 'x'.repeat(1000);
    const g: SeededGuide = { id: 'g1', title: 'G1' };
    seed(db, [g], [{ id: 'c1', guide_id: g.id, index: 0, content: longContent }]);

    const svc = new RetrievalService({
      db,
      embeddingService: mockEmbedder,
      vectorSearch: () => [{ chunk_id: 'c1', distance: 0 }],
      ftsSearch: () => [],
    });

    const citations = await svc.retrieve('q', {}, 5);
    expect(citations).toHaveLength(1);
    expect(citations[0].excerpt.length).toBe(300);
  });

  it('drops chunks whose guide does not match gameId filter', async () => {
    const guides: SeededGuide[] = [
      { id: 'gA', title: 'A', game_id: 'game-1' },
      { id: 'gB', title: 'B', game_id: 'game-2' },
    ];
    const chunks: SeededChunk[] = [
      { id: 'c1', guide_id: 'gA', index: 0, content: 'alpha' },
      { id: 'c2', guide_id: 'gB', index: 0, content: 'beta' },
    ];
    seed(db, guides, chunks);

    const svc = new RetrievalService({
      db,
      embeddingService: mockEmbedder,
      vectorSearch: () => [
        { chunk_id: 'c1', distance: 0.1 },
        { chunk_id: 'c2', distance: 0.2 },
      ],
      ftsSearch: () => [
        { chunk_id: 'c1', rank: -1 },
        { chunk_id: 'c2', rank: -0.5 },
      ],
    });

    const citations = await svc.retrieve('q', { gameId: 'game-2' }, 5);
    expect(citations).toHaveLength(1);
    expect(citations[0].chunk_id).toBe('c2');
    expect(citations[0].guide_id).toBe('gB');
  });

  it('drops chunks whose guide does not match platform filter', async () => {
    const guides: SeededGuide[] = [
      { id: 'gPS', title: 'PS Guide', platform: 'PlayStation' },
      { id: 'gXB', title: 'XB Guide', platform: 'Xbox' },
    ];
    const chunks: SeededChunk[] = [
      { id: 'cPS', guide_id: 'gPS', index: 0, content: 'ps content' },
      { id: 'cXB', guide_id: 'gXB', index: 0, content: 'xb content' },
    ];
    seed(db, guides, chunks);

    const svc = new RetrievalService({
      db,
      embeddingService: mockEmbedder,
      vectorSearch: () => [
        { chunk_id: 'cPS', distance: 0.1 },
        { chunk_id: 'cXB', distance: 0.2 },
      ],
      ftsSearch: () => [],
    });

    const citations = await svc.retrieve('q', { platform: 'Xbox' }, 5);
    expect(citations).toHaveLength(1);
    expect(citations[0].chunk_id).toBe('cXB');
  });

  it('drops chunks whose guide does not match genre filter', async () => {
    const guides: SeededGuide[] = [
      { id: 'gRPG', title: 'RPG Guide', genre: 'JRPG' },
      { id: 'gFPS', title: 'FPS Guide', genre: 'FPS' },
    ];
    const chunks: SeededChunk[] = [
      { id: 'cRPG', guide_id: 'gRPG', index: 0, content: 'rpg content' },
      { id: 'cFPS', guide_id: 'gFPS', index: 0, content: 'fps content' },
    ];
    seed(db, guides, chunks);

    const svc = new RetrievalService({
      db,
      embeddingService: mockEmbedder,
      vectorSearch: () => [
        { chunk_id: 'cRPG', distance: 0.1 },
        { chunk_id: 'cFPS', distance: 0.2 },
      ],
      ftsSearch: () => [],
    });

    const citations = await svc.retrieve('q', { genre: 'JRPG' }, 5);
    expect(citations).toHaveLength(1);
    expect(citations[0].chunk_id).toBe('cRPG');
  });

  it("tagMatch='any' returns chunks whose guide has at least one of the requested tags", async () => {
    const guides: SeededGuide[] = [
      { id: 'g1', title: 'G1', tags: ['rpg', 'guide'] },
      { id: 'g2', title: 'G2', tags: ['fps'] },
      { id: 'g3', title: 'G3', tags: ['walkthrough'] },
    ];
    const chunks: SeededChunk[] = [
      { id: 'c1', guide_id: 'g1', index: 0, content: 'one' },
      { id: 'c2', guide_id: 'g2', index: 0, content: 'two' },
      { id: 'c3', guide_id: 'g3', index: 0, content: 'three' },
    ];
    seed(db, guides, chunks);

    const svc = new RetrievalService({
      db,
      embeddingService: mockEmbedder,
      vectorSearch: () => [
        { chunk_id: 'c1', distance: 0.1 },
        { chunk_id: 'c2', distance: 0.2 },
        { chunk_id: 'c3', distance: 0.3 },
      ],
      ftsSearch: () => [],
    });

    const citations = await svc.retrieve('q', { tags: ['rpg', 'fps'], tagMatch: 'any' }, 5);
    const ids = new Set(citations.map(c => c.chunk_id));
    expect(ids).toEqual(new Set(['c1', 'c2']));
  });

  it("tagMatch='all' returns only chunks whose guide has every requested tag", async () => {
    const guides: SeededGuide[] = [
      { id: 'gBoth', title: 'Both', tags: ['rpg', 'guide'] },
      { id: 'gRpgOnly', title: 'Rpg only', tags: ['rpg'] },
      { id: 'gGuideOnly', title: 'Guide only', tags: ['guide'] },
    ];
    const chunks: SeededChunk[] = [
      { id: 'cBoth', guide_id: 'gBoth', index: 0, content: 'both' },
      { id: 'cRpgOnly', guide_id: 'gRpgOnly', index: 0, content: 'rpg' },
      { id: 'cGuideOnly', guide_id: 'gGuideOnly', index: 0, content: 'guide' },
    ];
    seed(db, guides, chunks);

    const svc = new RetrievalService({
      db,
      embeddingService: mockEmbedder,
      vectorSearch: () => [
        { chunk_id: 'cBoth', distance: 0.1 },
        { chunk_id: 'cRpgOnly', distance: 0.2 },
        { chunk_id: 'cGuideOnly', distance: 0.3 },
      ],
      ftsSearch: () => [],
    });

    const citations = await svc.retrieve('q', { tags: ['rpg', 'guide'], tagMatch: 'all' }, 5);
    expect(citations).toHaveLength(1);
    expect(citations[0].chunk_id).toBe('cBoth');
  });

  it('returns empty array when both retrievers return nothing', async () => {
    const svc = new RetrievalService({
      db,
      embeddingService: mockEmbedder,
      vectorSearch: () => [],
      ftsSearch: () => [],
    });
    const citations = await svc.retrieve('q', {}, 5);
    expect(citations).toEqual([]);
  });

  it('survives FTS5 syntax errors by retrying with the question quoted', async () => {
    const g: SeededGuide = { id: 'g', title: 'G' };
    seed(db, [g], [{ id: 'c1', guide_id: 'g', index: 0, content: 'hello world' }]);

    let calls = 0;
    const ftsSearch = (q: string): FtsHit[] => {
      calls++;
      if (calls === 1) {
        const err = new Error('fts5: syntax error near "AND"');
        throw err;
      }
      // Second call should be the quoted version
      expect(q.startsWith('"') && q.endsWith('"')).toBe(true);
      return [{ chunk_id: 'c1', rank: -1 }];
    };

    const svc = new RetrievalService({
      db,
      embeddingService: mockEmbedder,
      vectorSearch: () => [],
      ftsSearch,
    });

    const citations = await svc.retrieve('AND OR NOT', {}, 5);
    expect(citations).toHaveLength(1);
    expect(citations[0].chunk_id).toBe('c1');
    expect(calls).toBe(2);
  });
});
