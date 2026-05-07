import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDatabase } from './helpers/testDb';
import type { IDatabase } from '../src/interfaces/IDatabase';
import {
  RetrievalService,
  sanitizeFtsQuery,
  extractGameMatchTokens,
  numeralAliasVariants,
  type FtsHit,
  type TitleHit,
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

    // Use a non-stopword query so the sanitized FTS query is non-empty and
    // the mocked ftsSearch is actually invoked.
    const citations = await svc.retrieve('sephiroth', {}, 4);
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

  it('filters common tokens out of the title-FTS query so rare game names dominate', async () => {
    // Seed enough guides that "best" / "class" exceed the 5% rarity threshold
    // while "diablo" stays well below it. Threshold = max(50, total*0.05) so we
    // need >50 "best" titles. We add many fluff guides so total is large.
    const guides: SeededGuide[] = [];
    const chunks: SeededChunk[] = [];

    // 60 fluff guides whose titles contain "best" — common token.
    for (let i = 0; i < 60; i++) {
      guides.push({ id: `fluff-${i}`, title: `Best of the Best Karate ${i}` });
      chunks.push({ id: `cf-${i}`, guide_id: `fluff-${i}`, index: 0, content: 'fluff content' });
    }
    // 60 fluff guides whose titles contain "class".
    for (let i = 0; i < 60; i++) {
      guides.push({ id: `cls-${i}`, title: `Class of Heroes ${i}` });
      chunks.push({ id: `cc-${i}`, guide_id: `cls-${i}`, index: 0, content: 'fluff content' });
    }
    // Two Diablo guides — rare token. We want chunks of THESE to win.
    guides.push({ id: 'd2-1', title: 'Diablo II — Patrick Martin' });
    chunks.push({ id: 'cd-1', guide_id: 'd2-1', index: 0, content: 'mechanics' });
    guides.push({ id: 'd2-2', title: 'Diablo II Lord of Destruction' });
    chunks.push({ id: 'cd-2', guide_id: 'd2-2', index: 0, content: 'mechanics' });

    // Pad total to make the 5% threshold meaningful (~ over 1000 guides).
    for (let i = 0; i < 1000; i++) {
      guides.push({ id: `pad-${i}`, title: `Padding Game ${i}` });
      chunks.push({ id: `cp-${i}`, guide_id: `pad-${i}`, index: 0, content: 'pad' });
    }

    seed(db, guides, chunks);

    // Capture the actual title query that gets passed in. We expect "diablo"
    // to be there; "best" and "class" should be dropped because they exceed
    // the rarity threshold.
    let observedTitleQuery: string | null = null;
    const titleSearch = (q: string): TitleHit[] => {
      observedTitleQuery = q;
      // Real FTS5 isn't running here — just return the Diablo guides if the
      // query contains "diablo".
      if (q.toLowerCase().includes('diablo')) {
        return [
          { guide_id: 'd2-1', rank: 0 },
          { guide_id: 'd2-2', rank: 1 },
        ];
      }
      return [];
    };

    const svc = new RetrievalService({
      db,
      embeddingService: mockEmbedder,
      vectorSearch: () => [],
      ftsSearch: () => [],
      titleSearch,
      rrfK: 60,
    });

    const citations = await svc.retrieve("what's the best class in diablo", {}, 5);
    expect(observedTitleQuery).not.toBeNull();
    expect(observedTitleQuery!.toLowerCase()).toContain('diablo');
    expect(observedTitleQuery!.toLowerCase()).not.toContain('best');
    expect(observedTitleQuery!.toLowerCase()).not.toContain('class');
    // Only Diablo chunks should surface (vec/FTS returned nothing).
    const ids = new Set(citations.map(c => c.chunk_id));
    expect(ids).toEqual(new Set(['cd-1', 'cd-2']));
  });

  it('boosts chunks of title-matched guides via the title source', async () => {
    // Two guides; chunk content is identical (so vec/FTS rank them equally),
    // but only "Diablo II" matches the title-FTS query. Without the title
    // source, c-D and c-X would tie. With it, c-D should outrank c-X.
    const gD: SeededGuide = { id: 'g-d2', title: 'Diablo II — Patrick Martin' };
    const gX: SeededGuide = { id: 'g-cod', title: 'Call of Duty Modern Warfare 3' };
    const chunks: SeededChunk[] = [
      { id: 'c-D', guide_id: gD.id, index: 0, content: 'mechanics talk '.repeat(50) },
      { id: 'c-X', guide_id: gX.id, index: 0, content: 'mechanics talk '.repeat(50) },
    ];
    seed(db, [gD, gX], chunks);

    // Vec + FTS rank them identically.
    const vectorSearch = (): VectorHit[] => [
      { chunk_id: 'c-D', distance: 0.1 },
      { chunk_id: 'c-X', distance: 0.1 },
    ];
    const ftsSearch = (): FtsHit[] => [
      { chunk_id: 'c-D', rank: -0.5 },
      { chunk_id: 'c-X', rank: -0.5 },
    ];
    // Title-FTS surfaces only the Diablo II guide.
    const titleSearch = (): TitleHit[] => [{ guide_id: gD.id, rank: 0 }];

    const svc = new RetrievalService({
      db,
      embeddingService: mockEmbedder,
      vectorSearch,
      ftsSearch,
      titleSearch,
      rrfK: 60,
    });

    const citations = await svc.retrieve('best class in diablo', {}, 2);
    expect(citations[0].chunk_id).toBe('c-D');
    expect(citations[0].guide_id).toBe(gD.id);
    // c-X has only vec+FTS contributions; c-D has vec+FTS+title.
    expect(citations[0].score).toBeGreaterThan(citations[1].score);
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

  it('hard gameId filter excludes wrong-game chunks from vec, fts, and title-expanded hits', async () => {
    // Distinct title tokens so title-FTS query is non-empty (rare in guides_fts_meta_vocab).
    const gWrong: SeededGuide = {
      id: 'g-wrong',
      title: 'Wrong xyzzytitle Guide',
      game_id: 'game-wrong',
    };
    const gRight: SeededGuide = {
      id: 'g-right',
      title: 'Right florpb Guide',
      game_id: 'game-right',
    };
    const chunks: SeededChunk[] = [
      { id: 'c-w1', guide_id: gWrong.id, index: 0, content: 'wrong alpha '.repeat(20) },
      { id: 'c-w2', guide_id: gWrong.id, index: 1, content: 'wrong beta '.repeat(20) },
      { id: 'c-r1', guide_id: gRight.id, index: 0, content: 'right one '.repeat(20) },
      { id: 'c-r2', guide_id: gRight.id, index: 1, content: 'right two '.repeat(20) },
    ];
    seed(db, [gWrong, gRight], chunks);

    const vectorSearch = (): VectorHit[] => [
      { chunk_id: 'c-w1', distance: 0.01 },
      { chunk_id: 'c-r1', distance: 0.5 },
    ];
    const ftsSearch = (): FtsHit[] => [
      { chunk_id: 'c-w2', rank: -2 },
      { chunk_id: 'c-r2', rank: -1 },
    ];
    const titleSearch = (): TitleHit[] => [
      { guide_id: gWrong.id, rank: 0 },
      { guide_id: gRight.id, rank: 1 },
    ];

    const svc = new RetrievalService({
      db,
      embeddingService: mockEmbedder,
      vectorSearch,
      ftsSearch,
      titleSearch,
      rrfK: 60,
    });

    const citations = await svc.retrieve('xyzzytitle florpb gameplay', { gameId: 'game-right' }, 8);
    const wrongChunkIds = new Set(['c-w1', 'c-w2']);
    for (const c of citations) {
      expect(wrongChunkIds.has(c.chunk_id)).toBe(false);
      expect(c.guide_id).toBe(gRight.id);
    }
    const ids = new Set(citations.map((c) => c.chunk_id));
    expect(ids.has('c-r1')).toBe(true);
    expect(ids.has('c-r2')).toBe(true);
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

  it('sanitizes FTS5 reserved characters in user questions', async () => {
    const g: SeededGuide = { id: 'g', title: 'G' };
    seed(db, [g], [{ id: 'c1', guide_id: 'g', index: 0, content: 'hello world' }]);

    let receivedQuery = '';
    const ftsSearch = (q: string): FtsHit[] => {
      receivedQuery = q;
      return [{ chunk_id: 'c1', rank: -1 }];
    };

    const svc = new RetrievalService({
      db,
      embeddingService: mockEmbedder,
      vectorSearch: () => [],
      ftsSearch,
    });

    const citations = await svc.retrieve('How do I beat Sephiroth?', {}, 5);
    expect(citations).toHaveLength(1);
    // No raw `?` should reach FTS5 (would syntax-error). All tokens are quoted
    // so reserved keywords are treated as literal terms. Stopwords ("How", "do",
    // "I") are dropped so BM25 ranks on meaningful terms.
    expect(receivedQuery).not.toContain('?');
    expect(receivedQuery).toContain('"Sephiroth"');
    expect(receivedQuery).not.toContain('"How"');
  });

  it('skips FTS entirely when the sanitized query is empty (only operator keywords / punctuation)', async () => {
    const g: SeededGuide = { id: 'g', title: 'G' };
    seed(db, [g], [{ id: 'c1', guide_id: 'g', index: 0, content: 'hello world' }]);

    let ftsCalls = 0;
    const ftsSearch = (): FtsHit[] => { ftsCalls++; return []; };

    const svc = new RetrievalService({
      db,
      embeddingService: mockEmbedder,
      vectorSearch: () => [{ chunk_id: 'c1', distance: 0.5 }],
      ftsSearch,
    });

    const citations = await svc.retrieve('AND OR NOT', {}, 5);
    // Vector hit still serves the query.
    expect(citations).toHaveLength(1);
    expect(citations[0].chunk_id).toBe('c1');
    // FTS was skipped — sanitization stripped the bare boolean keywords.
    expect(ftsCalls).toBe(0);
  });
});

describe('sanitizeFtsQuery', () => {
  it('strips question marks and other FTS5 reserved punctuation', () => {
    expect(sanitizeFtsQuery('beat Sephiroth?')).toBe('"beat" OR "Sephiroth"');
    expect(sanitizeFtsQuery('parens (here) work')).toBe('"parens" OR "here" OR "work"');
    expect(sanitizeFtsQuery('hyphen-word')).toBe('"hyphen" OR "word"');
  });

  it('drops bare boolean keywords AND/OR/NOT/NEAR', () => {
    expect(sanitizeFtsQuery('foo AND bar')).toBe('"foo" OR "bar"');
    expect(sanitizeFtsQuery('AND OR NOT')).toBe('');
  });

  it('drops common English stopwords so BM25 ranks on meaningful tokens', () => {
    // "How", "do", "I", "in", "the" all dropped; only Sephiroth survives.
    expect(sanitizeFtsQuery('How do I beat Sephiroth in the boss fight?'))
      .toBe('"beat" OR "Sephiroth" OR "boss" OR "fight"');
  });

  it('dedupes repeated tokens', () => {
    expect(sanitizeFtsQuery('Sephiroth boss Sephiroth')).toBe('"Sephiroth" OR "boss"');
  });

  it('returns empty string for whitespace-only or empty input', () => {
    expect(sanitizeFtsQuery('')).toBe('');
    expect(sanitizeFtsQuery('   ')).toBe('');
    expect(sanitizeFtsQuery('!!!???')).toBe('');
  });

  it('preserves unicode letters and digits', () => {
    expect(sanitizeFtsQuery('Pokémon Red')).toBe('"Pokémon" OR "Red"');
    expect(sanitizeFtsQuery('FF7 boss 99')).toBe('"FF7" OR "boss" OR "99"');
  });
});

describe('extractGameMatchTokens', () => {
  it('lowercases and preserves order', () => {
    expect(extractGameMatchTokens('How do I beat Sephiroth in Final Fantasy VII?'))
      .toEqual(['how', 'do', 'i', 'beat', 'sephiroth', 'in', 'final', 'fantasy', 'vii']);
  });

  it('keeps stopwords (game names contain "the", "of")', () => {
    // Unlike extractFtsTokens, we need "the" / "of" for phrases like
    // "Legend of Zelda" or "Symphony of the Night" to match.
    expect(extractGameMatchTokens('Symphony of the Night'))
      .toEqual(['symphony', 'of', 'the', 'night']);
  });

  it('splits punctuation into spaces (apostrophes, hyphens)', () => {
    expect(extractGameMatchTokens("Who's the first enemy in FFX?"))
      .toEqual(['who', 's', 'the', 'first', 'enemy', 'in', 'ffx']);
  });
});

describe('numeralAliasVariants', () => {
  it('returns the original alone when no numerals present', () => {
    expect(numeralAliasVariants(['final', 'fantasy', 'tactics']))
      .toEqual([['final', 'fantasy', 'tactics']]);
  });

  it('produces both arabic and roman variants for one numeric token', () => {
    const variants = numeralAliasVariants(['diablo', '2']);
    expect(variants).toContainEqual(['diablo', '2']);
    expect(variants).toContainEqual(['diablo', 'ii']);
    expect(variants.length).toBe(2);
  });

  it('round-trips roman → arabic', () => {
    const variants = numeralAliasVariants(['final', 'fantasy', 'vii']);
    expect(variants).toContainEqual(['final', 'fantasy', 'vii']);
    expect(variants).toContainEqual(['final', 'fantasy', '7']);
  });

  it('handles two numeric tokens (cartesian)', () => {
    const variants = numeralAliasVariants(['ff', 'x', '2']);
    // Original + 3 numeral combinations = 4 total
    expect(variants.length).toBe(4);
    expect(variants).toContainEqual(['ff', 'x', '2']);
    expect(variants).toContainEqual(['ff', '10', '2']);
    expect(variants).toContainEqual(['ff', 'x', 'ii']);
    expect(variants).toContainEqual(['ff', '10', 'ii']);
  });
});
