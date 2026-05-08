import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDatabase } from './helpers/testDb';
import type { IDatabase } from '../src/interfaces/IDatabase';
import { GameExtractionService } from '../src/services/GameExtractionService';
import { SessionContextService } from '../src/services/SessionContextService';
import { RetrievalService } from '../src/services/RetrievalService';
import type { EmbeddingService } from '../src/services/EmbeddingService';

const mockEmbedder = {
  embed: async (_text: string) => new Float32Array(8).fill(0.1),
} as unknown as EmbeddingService;

describe('GameExtractionService', () => {
  let db: IDatabase;
  let svc: GameExtractionService;

  beforeEach(() => {
    db = createTestDatabase();
    const retrieval = new RetrievalService({ db, embeddingService: mockEmbedder });
    svc = new GameExtractionService(db, retrieval);
    const now = Date.now();
    db.run(`INSERT INTO games (id, title, completion_percentage, status, created_at, updated_at) VALUES ('ff7', 'Final Fantasy VII', 0, 'not_started', ?, ?)`, [now, now]);
    db.run(`INSERT INTO games (id, title, completion_percentage, status, created_at, updated_at) VALUES ('ff10', 'Final Fantasy X', 0, 'not_started', ?, ?)`, [now, now]);
    db.run(`INSERT INTO game_aliases (alias, game_id, alias_type, confidence, created_at, updated_at) VALUES ('final fantasy vii', 'ff7', 'manual', 1.0, ?, ?)`, [now, now]);
    db.run(`INSERT INTO game_aliases (alias, game_id, alias_type, confidence, created_at, updated_at) VALUES ('ff7', 'ff7', 'manual', 0.95, ?, ?)`, [now, now]);
    db.run(`INSERT INTO game_aliases (alias, game_id, alias_type, confidence, created_at, updated_at) VALUES ('final fantasy x', 'ff10', 'manual', 1.0, ?, ?)`, [now, now]);
    db.run(`INSERT INTO game_entities (entity, game_id, is_unique, entity_type, confidence, created_at, updated_at) VALUES ('aerith', 'ff7', 1, 'character', 1.0, ?, ?)`, [now, now]);
    db.run(`INSERT INTO game_entities (entity, game_id, is_unique, entity_type, confidence, created_at, updated_at) VALUES ('hyrule castle', 'ff7', 0, 'location', 0.4, ?, ?)`, [now, now]);
    db.run(`INSERT INTO game_entities (entity, game_id, is_unique, entity_type, confidence, created_at, updated_at) VALUES ('hyrule castle', 'ff10', 0, 'location', 0.4, ?, ?)`, [now, now]);
  });

  afterEach(() => db.close());

  it('extracts explicit aliases confidently', () => {
    const out = svc.extract('How do I beat Sephiroth in Final Fantasy VII?');
    expect(out.status).toBe('confident');
    if (out.status === 'confident') expect(out.gameId).toBe('ff7');
  });

  it('extracts unique entities confidently', () => {
    const out = svc.extract("What's Aerith's weapon?");
    expect(out.status).toBe('confident');
    if (out.status === 'confident') expect(out.gameId).toBe('ff7');
  });

  it('returns ambiguous for multi-game entities', () => {
    const out = svc.extract('How do I get to Hyrule Castle?');
    expect(out.status).toBe('ambiguous');
  });

  it('uses conversation context fallback', () => {
    const out = svc.extract('How do I get the best sword?', { establishedGameId: 'ff10' });
    expect(out.status).toBe('confident');
    if (out.status === 'confident') expect(out.gameId).toBe('ff10');
  });

  it('returns unclear with no signal', () => {
    const out = svc.extract('How do I beat the second boss?');
    expect(out.status).toBe('unclear');
  });

  it('resolves game via games_fts when alias row is missing (Diablo 2 ↔ II)', () => {
    const now = Date.now();
    db.run(
      `INSERT INTO games (id, title, completion_percentage, status, created_at, updated_at) VALUES ('d2', 'Diablo II', 0, 'not_started', ?, ?)`,
      [now, now]
    );
    const out = svc.extract('How does the duplicate item glitch work in Diablo 2?');
    expect(out.status).toBe('confident');
    if (out.status === 'confident') expect(out.gameId).toBe('d2');
    if (out.status === 'confident') expect(out.reason).toBe('games_fts_title');
  });

  it('resolves entity to confident when entity maps to a single game', () => {
    const now = Date.now();
    db.run(`INSERT INTO game_entities (entity, game_id, is_unique, entity_type, confidence, created_at, updated_at) VALUES ('sephiroth', 'ff7', 1, 'character', 0.97, ?, ?)`, [now, now]);
    const out = svc.extract('Why did Sephiroth burn down Nibelheim?');
    expect(out.status).toBe('confident');
    if (out.status === 'confident') {
      expect(out.gameId).toBe('ff7');
      expect(out.reason).toBe('unique_entity');
    }
  });

  it('treats platform variants in same canonical group as confident via entity matching', () => {
    const now = Date.now();
    // Two platform variants of the same game, sharing a canonical_group_id.
    db.run(`INSERT INTO canonical_game_groups (id, normalized_title, display_title, created_at, updated_at) VALUES ('ff7-group', 'final fantasy vii', 'Final Fantasy VII', ?, ?)`, [now, now]);
    db.run(`INSERT INTO games (id, title, canonical_group_id, completion_percentage, status, created_at, updated_at) VALUES ('ff7-ps', 'Final Fantasy VII (PS)', 'ff7-group', 0, 'not_started', ?, ?)`, [now, now]);
    db.run(`INSERT INTO games (id, title, canonical_group_id, completion_percentage, status, created_at, updated_at) VALUES ('ff7-pc', 'Final Fantasy VII (PC)', 'ff7-group', 0, 'not_started', ?, ?)`, [now, now]);
    db.run(`INSERT INTO game_entities (entity, game_id, is_unique, entity_type, confidence, created_at, updated_at) VALUES ('cloud', 'ff7-ps', 1, 'character', 0.95, ?, ?)`, [now, now]);
    db.run(`INSERT INTO game_entities (entity, game_id, is_unique, entity_type, confidence, created_at, updated_at) VALUES ('cloud', 'ff7-pc', 1, 'character', 0.95, ?, ?)`, [now, now]);
    const out = svc.extract('What weapon does Cloud start with?');
    // Both platform variants match "cloud" as a unique entity, but they share
    // the same canonical group — so the outcome should be confident, not ambiguous.
    expect(out.status).toBe('confident');
    if (out.status === 'confident') expect(out.reason).toBe('unique_entity');
  });

  it('gap filter removes false-positive game when confidence is >0.25 below the top', () => {
    const now = Date.now();
    // FF7 owns Cloud at 0.95; FF8 is a false positive at 0.65 (0.30 below → excluded).
    db.run(`INSERT INTO games (id, title, completion_percentage, status, created_at, updated_at) VALUES ('ff8', 'Final Fantasy VIII', 0, 'not_started', ?, ?)`, [now, now]);
    db.run(`INSERT INTO game_entities (entity, game_id, is_unique, entity_type, confidence, created_at, updated_at) VALUES ('cloud', 'ff7', 1, 'character', 0.95, ?, ?)`, [now, now]);
    db.run(`INSERT INTO game_entities (entity, game_id, is_unique, entity_type, confidence, created_at, updated_at) VALUES ('cloud', 'ff8', 1, 'character', 0.65, ?, ?)`, [now, now]);
    const out = svc.extract('What weapon does Cloud start with?');
    // FF8 entry is 0.30 below FF7 → exceeds gap threshold → stripped; only FF7 survives.
    expect(out.status).toBe('confident');
    if (out.status === 'confident') {
      expect(out.gameId).toBe('ff7');
      expect(out.reason).toBe('unique_entity');
    }
  });

  it('entity coverage count resolves multi-entity question when one game covers more entities', () => {
    const now = Date.now();
    // Sephiroth appears in FF7 (0.95) and a second game (0.80, within gap window).
    // Nibelheim appears only in FF7 (0.95).
    // FF7 covers both entities → wins even though it is within gap distance of the other game.
    db.run(`INSERT INTO games (id, title, completion_percentage, status, created_at, updated_at) VALUES ('spinoff', 'Before Crisis Final Fantasy VII', 0, 'not_started', ?, ?)`, [now, now]);
    db.run(`INSERT INTO game_entities (entity, game_id, is_unique, entity_type, confidence, created_at, updated_at) VALUES ('sephiroth', 'ff7', 1, 'character', 0.95, ?, ?)`, [now, now]);
    db.run(`INSERT INTO game_entities (entity, game_id, is_unique, entity_type, confidence, created_at, updated_at) VALUES ('sephiroth', 'spinoff', 1, 'character', 0.80, ?, ?)`, [now, now]);
    db.run(`INSERT INTO game_entities (entity, game_id, is_unique, entity_type, confidence, created_at, updated_at) VALUES ('nibelheim', 'ff7', 1, 'location', 0.95, ?, ?)`, [now, now]);
    const out = svc.extract('Why did Sephiroth burn down Nibelheim?');
    expect(out.status).toBe('confident');
    if (out.status === 'confident') {
      expect(out.gameId).toBe('ff7');
      expect(out.reason).toBe('unique_entity');
    }
  });

  it('returns ambiguous when multiple plausible games cover the same entities at similar confidence', () => {
    const now = Date.now();
    // Mario appears in both SM64 and SMW at similar confidence — legitimately ambiguous.
    db.run(`INSERT INTO games (id, title, completion_percentage, status, created_at, updated_at) VALUES ('sm64', 'Super Mario 64', 0, 'not_started', ?, ?)`, [now, now]);
    db.run(`INSERT INTO games (id, title, completion_percentage, status, created_at, updated_at) VALUES ('smw', 'Super Mario World', 0, 'not_started', ?, ?)`, [now, now]);
    db.run(`INSERT INTO game_entities (entity, game_id, is_unique, entity_type, confidence, created_at, updated_at) VALUES ('mario', 'sm64', 1, 'character', 0.80, ?, ?)`, [now, now]);
    db.run(`INSERT INTO game_entities (entity, game_id, is_unique, entity_type, confidence, created_at, updated_at) VALUES ('mario', 'smw', 1, 'character', 0.80, ?, ?)`, [now, now]);
    const out = svc.extract('How many lives does Mario start with?');
    expect(out.status).toBe('ambiguous');
    if (out.status === 'ambiguous') {
      expect(out.gameIds).toContain('sm64');
      expect(out.gameIds).toContain('smw');
    }
  });

  it('resolves platform-suffixed title via TITLE_DECORATION_TOKENS (e.g. Portal (PC))', () => {
    const now = Date.now();
    db.run(`INSERT INTO games (id, title, completion_percentage, status, created_at, updated_at) VALUES ('portal-pc', 'Portal (PC)', 0, 'not_started', ?, ?)`, [now, now]);
    // games_fts is populated by trigger on INSERT; use a fresh retrieval service.
    const retrieval2 = new RetrievalService({ db, embeddingService: mockEmbedder });
    const svc2 = new GameExtractionService(db, retrieval2);
    const out = svc2.extract('How do I solve the first puzzle in Portal?');
    // "portal" as a 1-gram + preposition context "in" should match "Portal (PC)"
    // now that "pc" is a decoration token.
    expect(out.status).toBe('confident');
    if (out.status === 'confident') expect(out.gameId).toBe('portal-pc');
  });
});

describe('SessionContextService', () => {
  it('retains and overrides game context', () => {
    const svc = new SessionContextService(2);
    svc.setGame('s1', 'ff7');
    svc.appendTurn('s1', { role: 'user', text: 'hi' });
    svc.appendTurn('s1', { role: 'assistant', text: 'hello' });
    svc.appendTurn('s1', { role: 'user', text: 'next' });
    const ctx = svc.get('s1');
    expect(ctx.establishedGameId).toBe('ff7');
    expect(ctx.turns.length).toBe(2);
    svc.setGame('s1', 'ff10');
    expect(svc.get('s1').establishedGameId).toBe('ff10');
    svc.clear('s1');
    expect(svc.get('s1').establishedGameId).toBeUndefined();
  });
});
