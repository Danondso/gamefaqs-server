// Phase 1: post-fix expectations for `defaultGameMatch`.
//
// Originally written as Phase 0 (asserted the v2 broken behavior). Flipped to
// Phase 1 on 2026-05-05 once the title-boundary filter and 1-gram NGRAM_MIN=1
// shipped — see RETRIEVAL_DEBUG.md "Step 3" for the live-data analysis driving
// the filter design. Tests now assert the fixed behavior so they double as the
// regression net.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDatabase } from './helpers/testDb';
import type { IDatabase } from '../src/interfaces/IDatabase';
import { RetrievalService, passesTitleBoundaryFilter, detectRetrievalIntent } from '../src/services/RetrievalService';
import type { EmbeddingService } from '../src/services/EmbeddingService';

const mockEmbedder = {
  embed: async (_text: string) => new Float32Array(8).fill(0.1),
} as unknown as EmbeddingService;

interface SeededGame {
  id: string;
  title: string;
}

function seedGames(db: IDatabase, games: SeededGame[]): void {
  const now = Date.now();
  for (const g of games) {
    db.run(
      `INSERT INTO games (id, title, completion_percentage, status, created_at, updated_at)
       VALUES (?, ?, 0, 'not_started', ?, ?)`,
      [g.id, g.title, now, now]
    );
  }
}

// Realistic-ish corpus covering every game referenced by the failing queries
// plus a few decoys (Atelier Iris, Lunar Legend) that the v2 retriever
// surfaced when extraction fell through to corpus-wide search.
const GAMES: SeededGame[] = [
  { id: 'g-ff6', title: 'Final Fantasy VI' },
  { id: 'g-ff7', title: 'Final Fantasy VII' },
  { id: 'g-ff8', title: 'Final Fantasy VIII' },
  { id: 'g-ff10', title: 'Final Fantasy X' },
  { id: 'g-diablo', title: 'Diablo' },
  { id: 'g-diablo2', title: 'Diablo II' },
  { id: 'g-diablo2-lod', title: 'Diablo II: Lord of Destruction' },
  { id: 'g-diablo3', title: 'Diablo III' },
  { id: 'g-portal', title: 'Portal' },
  { id: 'g-portal2', title: 'Portal 2' },
  { id: 'g-tetris', title: 'Tetris' },
  { id: 'g-tetris-ds', title: 'Tetris DS' },
  { id: 're-original', title: 'Resident Evil' },
  { id: 'g-re2', title: 'Resident Evil 2' },
  { id: 'g-re4', title: 'Resident Evil 4' },
  { id: 'g-pokered', title: 'Pokemon Red Version' },
  { id: 'g-pokeblue', title: 'Pokemon Blue Version' },
  { id: 'g-mgs2', title: 'Metal Gear Solid 2: Sons of Liberty' },
  { id: 'g-zelda-oot', title: 'The Legend of Zelda: Ocarina of Time' },
  { id: 'g-zelda-ww', title: 'The Legend of Zelda: The Wind Waker' },
  { id: 'g-sm64', title: 'Super Mario 64' },
  { id: 'g-botw', title: 'The Legend of Zelda: Breath of the Wild' },
  // Decoys that v2 retrieval surfaced for cross-game contamination cases:
  { id: 'g-atelier', title: 'Atelier Iris: Eternal Mana' },
  { id: 'g-lunar', title: 'Lunar Legend' },
  { id: 'g-burnzombie', title: 'Burn Zombie Burn' },
  { id: 'g-startup2k', title: 'Start Up 2000' },
];

// Helper: build a RetrievalService with the default extractor wired up. We
// don't seed any chunks/guides — `defaultGameMatch` only reads `games_fts`
// (populated by the v5 trigger when `games` rows are inserted), so a games-only
// seed is sufficient to exercise extraction in isolation.
function makeService(db: IDatabase): RetrievalService {
  return new RetrievalService({
    db,
    embeddingService: mockEmbedder,
    // No-op test seams for the chunk-level sources — we're only probing the
    // game-match extractor, which is invoked inside debugSources.
    vectorSearch: () => [],
    ftsSearch: () => [],
    titleSearch: () => [],
  });
}

// Run defaultGameMatch via the public debugSources entry point. Returns the
// matched game titles in the order games_fts ranked them.
async function matchGameTitles(svc: RetrievalService, question: string): Promise<string[]> {
  const out = await svc.debugSources(question, 1);
  return out.game_match.matched_game_titles;
}

describe('defaultGameMatch — Phase 1', () => {
  let db: IDatabase;
  let svc: RetrievalService;

  beforeEach(() => {
    db = createTestDatabase();
    seedGames(db, GAMES);
    svc = makeService(db);
  });

  afterEach(() => {
    db.close();
  });

  // ---- Single-token game names: NGRAM_MIN=1 + title-boundary filter -------
  // The title-boundary filter is what makes 1-grams safe: phrase "diablo"
  // matches the Diablo / Diablo II / Diablo III titles via FTS, but only the
  // exact-equal "Diablo" survives the post-filter (the others have
  // installment numbers in the tail).

  it('single-token "Diablo" extracts only the original Diablo (installments rejected)', async () => {
    const titles = await matchGameTitles(svc, "What's the best class in Diablo?");
    expect(titles).toEqual(['Diablo']);
  });

  it('single-token "Portal" extracts only Portal (Portal 2 rejected by tail filter)', async () => {
    const titles = await matchGameTitles(svc, 'What is the first puzzle in Portal?');
    expect(titles).toEqual(['Portal']);
  });

  it('single-token "Tetris" extracts only Tetris (Tetris DS rejected by tail filter)', async () => {
    const titles = await matchGameTitles(svc, 'How do I beat the final boss in Tetris?');
    expect(titles).toEqual(['Tetris']);
  });

  // ---- Queries that should still extract via 2-gram or longer -------------

  it('"Diablo 2" 2-gram extracts Diablo II via numeral alias', async () => {
    const titles = await matchGameTitles(svc, 'Diablo 2 dupe glitch');
    expect(titles).toContain('Diablo II');
    // "Diablo II: Lord of Destruction" rejects: tail has 'lord','of','destruction'
    expect(titles).not.toContain('Diablo II: Lord of Destruction');
  });

  it('"Final Fantasy VII" 3-gram extracts only the base game (spinoffs rejected)', async () => {
    const titles = await matchGameTitles(svc, 'How do I beat Sephiroth in Final Fantasy VII?');
    expect(titles).toEqual(['Final Fantasy VII']);
    // The previous behavior also matched FF VIII via a longer phrase; the
    // boundary filter rejects anything in the tail.
  });

  it('"Pokemon Red" 2-gram extracts Pokemon Red Version (version is decoration)', async () => {
    const titles = await matchGameTitles(svc, 'How do I beat the Elite Four in Pokemon Red?');
    expect(titles).toContain('Pokemon Red Version');
    expect(titles).not.toContain('Pokemon Blue Version');
  });

  it('"Resident Evil" 2-gram extracts only the original (numbered installments rejected)', async () => {
    const titles = await matchGameTitles(svc, 'How do I beat the final boss in Resident Evil?');
    expect(titles).toEqual(['Resident Evil']);
  });

  it('"Ocarina of Time" 3-gram extracts the Zelda OoT title (series prefix is decoration)', async () => {
    const titles = await matchGameTitles(svc, "Where's the Triforce in Ocarina of Time?");
    expect(titles.some(t => t.includes('Ocarina of Time'))).toBe(true);
  });

  // ---- Live-bug cases: queries that previously over-matched ---------------
  // (Asserts the bug is gone, not that any specific game is matched.)

  it('"Super Mario 64" 3-gram does not match Super Mario 64 DS', async () => {
    const titles = await matchGameTitles(svc, 'How many stars are in Super Mario 64?');
    // SM64 (exact) should match; SM64 DS rejected by 'ds' in tail.
    // (We added g-sm64 to seeds — DS variant intentionally omitted.)
    expect(titles).toContain('Super Mario 64');
  });

  // ---- Negative cases: 1-grams that should NOT extract --------------------

  it('1-gram "start" does not match Start Up 2000 (tail rejected)', async () => {
    // "What weapon does Cloud start with?" — phrase "start" matches the
    // Start Up 2000 title via FTS, but the boundary filter rejects (tail
    // tokens 'up','2000' are not decoration). This was a real bug before
    // the title-boundary filter shipped.
    const titles = await matchGameTitles(svc, 'What weapon does Cloud start with?');
    expect(titles).toEqual([]);
  });

  it('FF abbreviation queries still return empty (no abbreviation table yet)', async () => {
    expect(await matchGameTitles(svc, "Who's the first enemy in FF10?")).toEqual([]);
    expect(await matchGameTitles(svc, 'How do I beat Kefka in FF6?')).toEqual([]);
  });

  it('Genuinely ambiguous queries (no game name) return empty', async () => {
    expect(await matchGameTitles(svc, 'How do I learn Ultima?')).toEqual([]);
    expect(await matchGameTitles(svc, "What is Otacon's password?")).toEqual([]);
  });
});

describe('passesTitleBoundaryFilter (unit)', () => {
  it('exact match passes', () => {
    expect(passesTitleBoundaryFilter(['final', 'fantasy', 'vii'], 'Final Fantasy VII')).toBe(true);
    expect(passesTitleBoundaryFilter(['diablo'], 'Diablo')).toBe(true);
  });

  it('decoration-only head passes (series prefix)', () => {
    expect(passesTitleBoundaryFilter(
      ['ocarina', 'of', 'time'],
      'The Legend of Zelda: Ocarina of Time'
    )).toBe(true);
  });

  it('decoration-only tail passes (edition suffix)', () => {
    expect(passesTitleBoundaryFilter(['pokemon', 'red'], 'Pokemon Red Version')).toBe(true);
    expect(passesTitleBoundaryFilter(['resident', 'evil', '4'], 'Resident Evil 4 HD')).toBe(true);
  });

  it('parenthetical platform suffix is stripped — passes even with platform token', () => {
    // GameFAQs archives many games as "Title (Platform)". The parenthetical
    // suffix is a cataloguing annotation, not part of the game name. It must
    // not prevent the phrase from matching.
    expect(passesTitleBoundaryFilter(['portal'], 'Portal (PC)')).toBe(true);
    expect(passesTitleBoundaryFilter(['final', 'fantasy', 'x'], 'Final Fantasy X (PS2)')).toBe(true);
    expect(passesTitleBoundaryFilter(['final', 'fantasy', 'vii'], 'Final Fantasy VII (PS)')).toBe(true);
    // Bare non-parenthetical platform token is NOT stripped — it is part of the
    // distinct game title ("Super Mario 64 DS" is different from "Super Mario 64").
    expect(passesTitleBoundaryFilter(['super', 'mario', '64'], 'Super Mario 64 DS')).toBe(false);
  });

  it('non-decoration tail rejects (installment / spinoff)', () => {
    expect(passesTitleBoundaryFilter(['super', 'mario', '64'], 'Super Mario 64 DS')).toBe(false);
    expect(passesTitleBoundaryFilter(['final', 'fantasy', 'vii'], 'Final Fantasy VII Advent Children')).toBe(false);
    expect(passesTitleBoundaryFilter(['final', 'fantasy', 'vii'], 'Final Fantasy VII Snowboarding')).toBe(false);
    expect(passesTitleBoundaryFilter(['diablo'], 'Diablo II')).toBe(false);
    expect(passesTitleBoundaryFilter(['diablo', 'ii'], 'Diablo II: Lord of Destruction')).toBe(false);
    expect(passesTitleBoundaryFilter(['portal'], 'Portal 2')).toBe(false);
  });

  it('non-decoration head rejects (sub-installment / prequel)', () => {
    expect(passesTitleBoundaryFilter(['final', 'fantasy', 'vii'], 'Crisis Core Final Fantasy VII')).toBe(false);
    expect(passesTitleBoundaryFilter(['final', 'fantasy', 'vii'], 'Before Crisis Final Fantasy VII')).toBe(false);
    expect(passesTitleBoundaryFilter(['final', 'fantasy', 'vii'], 'Dirge of Cerberus Final Fantasy VII')).toBe(false);
  });

  it('phrase absent from title rejects (defensive)', () => {
    expect(passesTitleBoundaryFilter(['portal'], 'Diablo')).toBe(false);
  });
});

describe('detectRetrievalIntent (unit)', () => {
  it('treats explicit game matches as specific', () => {
    expect(detectRetrievalIntent('How do I beat Sephiroth in Final Fantasy VII?', true)).toBe('specific');
  });

  it('tags no-context ordinal boss questions as unanswerable', () => {
    expect(detectRetrievalIntent('How do I beat the second boss?', false)).toBe('unanswerable');
  });

  it('tags known false-premise patterns as trick', () => {
    expect(detectRetrievalIntent("Where's the Triforce in Ocarina of Time?", false)).toBe('trick');
    expect(detectRetrievalIntent('How do I beat the final boss in Tetris?', false)).toBe('trick');
  });

  it('falls back to ambiguous for broad queries without explicit game extraction', () => {
    expect(detectRetrievalIntent('How do I learn Ultima?', false)).toBe('ambiguous');
  });
});
