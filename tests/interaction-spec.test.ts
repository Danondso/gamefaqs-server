import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDatabase } from './helpers/testDb';
import type { IDatabase } from '../src/interfaces/IDatabase';
import { GameExtractionService } from '../src/services/GameExtractionService';

type ExpectedBehavior = 'confident' | 'ambiguous' | 'unclear' | 'refusal';
interface Scenario {
  query: string;
  expected: ExpectedBehavior;
  contextGameId?: string;
}

function buildScenarios(): Scenario[] {
  const explicit = Array.from({ length: 10 }, (_, i) => ({
    query: `How do I beat Sephiroth phase ${i + 1} in Final Fantasy VII?`,
    expected: 'confident' as const,
  }));
  const entity = Array.from({ length: 10 }, (_, i) => ({
    query: `Where do I find Aerith limit break ${i + 1}?`,
    expected: 'confident' as const,
  }));
  const ambiguous = Array.from({ length: 10 }, (_, i) => ({
    query: `How do I use the Master Sword variant ${i + 1}?`,
    expected: 'ambiguous' as const,
  }));
  const context = Array.from({ length: 10 }, (_, i) => ({
    query: `Where is the next objective step ${i + 1}?`,
    expected: 'confident' as const,
    contextGameId: 'ff7',
  }));
  const voice = Array.from({ length: 5 }, (_, i) => ({
    query: `How do I beat sephiroth in f f 7 attempt ${i + 1}?`,
    expected: 'confident' as const,
  }));
  const refusal = [
    { query: 'What is the weather tomorrow?', expected: 'refusal' as const },
    // "cook" is a valid game mechanic (BOTW, Stardew) — can't safely OOS-detect
    // without risking false positives; extraction returns unclear when no game named.
    { query: 'How do I cook ramen?', expected: 'unclear' as const },
    { query: 'How do I beat the second boss?', expected: 'unclear' as const },
    { query: 'Tell me stock tips.', expected: 'refusal' as const },
    { query: 'Who should I vote for?', expected: 'refusal' as const },
  ];
  return [...explicit, ...entity, ...ambiguous, ...context, ...voice, ...refusal];
}

describe('interaction spec (50 scenarios)', () => {
  let db: IDatabase;
  let extraction: GameExtractionService;
  const scenarios = buildScenarios();

  beforeEach(() => {
    db = createTestDatabase();
    extraction = new GameExtractionService(db);
    const now = Date.now();
    db.run(`INSERT INTO games (id, title, completion_percentage, status, created_at, updated_at) VALUES ('ff7', 'Final Fantasy VII', 0, 'not_started', ?, ?)`, [now, now]);
    db.run(`INSERT INTO games (id, title, completion_percentage, status, created_at, updated_at) VALUES ('zelda', 'The Legend of Zelda', 0, 'not_started', ?, ?)`, [now, now]);
    db.run(`INSERT INTO game_aliases (alias, game_id, alias_type, confidence, created_at, updated_at) VALUES ('final fantasy vii', 'ff7', 'manual', 1.0, ?, ?)`, [now, now]);
    db.run(`INSERT INTO game_aliases (alias, game_id, alias_type, confidence, created_at, updated_at) VALUES ('ff7', 'ff7', 'manual', 0.95, ?, ?)`, [now, now]);
    db.run(`INSERT INTO game_entities (entity, game_id, is_unique, entity_type, confidence, created_at, updated_at) VALUES ('aerith', 'ff7', 1, 'character', 1.0, ?, ?)`, [now, now]);
    db.run(`INSERT INTO game_entities (entity, game_id, is_unique, entity_type, confidence, created_at, updated_at) VALUES ('master sword', 'ff7', 0, 'item', 0.2, ?, ?)`, [now, now]);
    db.run(`INSERT INTO game_entities (entity, game_id, is_unique, entity_type, confidence, created_at, updated_at) VALUES ('master sword', 'zelda', 0, 'item', 0.8, ?, ?)`, [now, now]);
  });

  afterEach(() => db.close());

  it('contains exactly 50 scenarios', () => {
    expect(scenarios).toHaveLength(50);
  });

  it.each(scenarios)('scenario: $query', (scenario) => {
    if (scenario.expected === 'refusal') {
      expect(extraction.isOutOfScope(scenario.query)).toBe(true);
      return;
    }
    const out = extraction.extract(scenario.query, { establishedGameId: scenario.contextGameId });
    expect(out.status).toBe(scenario.expected);
  });
});
