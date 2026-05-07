import type { IDatabase } from '../interfaces/IDatabase';
import type { RetrievalService } from './RetrievalService';

export type ExtractionOutcome =
  | { status: 'confident'; gameId: string; confidence: number; reason: string }
  | { status: 'ambiguous'; gameIds: string[]; reason: string }
  | { status: 'unclear'; reason: string };

export interface ConversationTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface ExtractionContext {
  establishedGameId?: string;
  recentTurns?: ConversationTurn[];
}

interface AliasRow {
  alias: string;
  game_id: string;
  confidence: number;
}

interface EntityRow {
  entity: string;
  game_id: string;
  is_unique: number;
  confidence: number;
  canonical_group_id: string | null;
}

const ROMAN_TO_ARABIC: Record<string, string> = {
  i: '1', ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9', x: '10',
};
const OUT_OF_SCOPE_PATTERNS = [
  /\bweather\b/i,
  /\bstock\b/i,
  /\brecipe\b/i,
  /\bpolitic/i,
  /\bvot(?:e|ing)\b/i,
];

export class GameExtractionService {
  constructor(
    private readonly db: IDatabase,
    /** When set, uses the same `games_fts` phrase match as retrieval (numerals, boundaries). */
    private readonly retrieval?: Pick<RetrievalService, 'matchGamesForLayer1'>
  ) {}

  extract(question: string, context: ExtractionContext = {}): ExtractionOutcome {
    const normalized = normalize(question);
    if (!normalized) return { status: 'unclear', reason: 'empty_query' };

    // games_fts runs first: it uses the title-boundary filter which correctly
    // resolves installment-specific names ("Final Fantasy VII" vs. "Final Fantasy")
    // and is immune to the substring-alias problem where a short generic alias like
    // "final fantasy" would otherwise claim every FF question.
    const fts = this.matchGamesFtsTitle(question);
    if (fts.status === 'confident') return fts;

    // Explicit aliases are the right path for abbreviations/nicknames ("ff7",
    // "sotn", "botw") that don't appear verbatim in game titles.
    const explicit = this.matchExplicitAlias(normalized);
    if (explicit.status !== 'unclear') return explicit;

    // games_fts ambiguous is still more reliable than entity matching, so emit
    // it here rather than letting entities override a multi-game FTS hit.
    if (fts.status === 'ambiguous') return fts;

    const entity = this.matchEntity(normalized);
    if (entity.status !== 'unclear') return entity;

    if (context.establishedGameId) {
      return { status: 'confident', gameId: context.establishedGameId, confidence: 0.6, reason: 'conversation_context' };
    }

    return { status: 'unclear', reason: 'no_signal' };
  }

  isOutOfScope(question: string): boolean {
    return OUT_OF_SCOPE_PATTERNS.some(rx => rx.test(question));
  }

  private matchGamesFtsTitle(question: string): ExtractionOutcome {
    if (!this.retrieval) return { status: 'unclear', reason: 'no_retrieval_hook' };
    const m = this.retrieval.matchGamesForLayer1(question);
    if (m.ids.length === 0 || m.confidence === 'low') return { status: 'unclear', reason: 'no_games_fts_match' };
    const unique = [...new Set(m.ids)];
    if (unique.length === 1) {
      return {
        status: 'confident',
        gameId: unique[0],
        confidence: layer1FtsConfidenceScore(m.confidence),
        reason: 'games_fts_title',
      };
    }
    // Multiple games matched the same phrase (e.g. "Final Fantasy VII" AND "Final Fantasy VII
    // Remake" both pass the title-boundary filter because 'remake' is a decoration token).
    // Prefer the game whose title exactly equals the phrase tokens — no decoration at all.
    const phraseNorm = m.phraseTokens.join(' ');
    const placeholders = unique.map(() => '?').join(',');
    const rows = this.db.query<{ id: string; title: string }>(
      `SELECT id, title FROM games WHERE id IN (${placeholders})`,
      unique
    );
    const exactMatch = rows.find(r =>
      r.title.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim() === phraseNorm
    );
    if (exactMatch) {
      return {
        status: 'confident',
        gameId: exactMatch.id,
        confidence: layer1FtsConfidenceScore(m.confidence),
        reason: 'games_fts_title',
      };
    }
    return { status: 'ambiguous', gameIds: unique.slice(0, 3), reason: 'games_fts_multiple' };
  }

  private matchExplicitAlias(normalizedQuestion: string): ExtractionOutcome {
    const rows = this.db.query<AliasRow>(
      `SELECT alias, game_id, confidence FROM game_aliases ORDER BY confidence DESC LIMIT 4000`
    );
    const matches = rows.filter(r => {
      const alias = normalize(r.alias);
      return alias.length > 0 && normalizedQuestion.includes(alias);
    });
    if (matches.length === 0) return { status: 'unclear', reason: 'no_alias_match' };
    const byGame = new Map<string, number>();
    for (const m of matches) byGame.set(m.game_id, Math.max(byGame.get(m.game_id) ?? 0, m.confidence));
    const ranked = Array.from(byGame.entries()).sort((a, b) => b[1] - a[1]);
    if (ranked.length === 1 || (ranked[0][1] - (ranked[1]?.[1] ?? 0) >= 0.15)) {
      return { status: 'confident', gameId: ranked[0][0], confidence: ranked[0][1], reason: 'explicit_alias' };
    }
    return { status: 'ambiguous', gameIds: ranked.slice(0, 3).map(x => x[0]), reason: 'multiple_alias_matches' };
  }

  private matchEntity(normalizedQuestion: string): ExtractionOutcome {
    // Join games to pick up canonical_group_id so we can distinguish
    // "same game on different platforms" from "genuinely different games".
    const rows = this.db.query<EntityRow>(
      `SELECT e.entity, e.game_id, e.is_unique, e.confidence, g.canonical_group_id
       FROM game_entities e
       LEFT JOIN games g ON g.id = e.game_id
       ORDER BY e.confidence DESC LIMIT 3000`
    );
    const matched = rows.filter(r => normalizedQuestion.includes(normalize(r.entity)));
    if (matched.length === 0) return { status: 'unclear', reason: 'no_entity_match' };
    const unique = matched.filter(r => r.is_unique === 1);
    if (unique.length === 0) {
      const ids = Array.from(new Set(matched.map(m => m.game_id))).slice(0, 3);
      return { status: 'ambiguous', gameIds: ids, reason: 'entity_ambiguous' };
    }
    if (unique.length === 1) {
      return {
        status: 'confident',
        gameId: unique[0].game_id,
        confidence: Math.max(0.7, unique[0].confidence),
        reason: 'unique_entity',
      };
    }
    // Multiple unique-entity matches. If they all share the same canonical
    // group they are platform variants of the same game — still confident.
    // Use the highest-confidence variant as the primary game_id.
    const groups = new Set(unique.map(r => r.canonical_group_id).filter((id): id is string => Boolean(id)));
    if (groups.size === 1) {
      const best = unique.reduce((a, b) => b.confidence > a.confidence ? b : a);
      return {
        status: 'confident',
        gameId: best.game_id,
        confidence: Math.max(0.7, best.confidence),
        reason: 'unique_entity',
      };
    }
    // Guard: if any matched unique entity appears in too many distinct canonical
    // groups it was bulk-seeded with flat confidence and has no real discriminative
    // power (e.g. migration v9's /final fantasy vii/ regex matched "viii" as a
    // substring, seeding Cloud/Sephiroth into FF8 at the same confidence as FF7).
    // Rather than emitting a misleading 7-game ambiguous list, return unclear so
    // the user is asked to name the game.
    const MAX_ENTITY_GROUPS = 4;
    const entityGroupCounts = new Map<string, Set<string>>();
    for (const r of unique) {
      const norm = normalize(r.entity);
      if (!entityGroupCounts.has(norm)) entityGroupCounts.set(norm, new Set());
      entityGroupCounts.get(norm)!.add(r.canonical_group_id ?? r.game_id);
    }
    const overSeeded = [...entityGroupCounts.values()].some(s => s.size >= MAX_ENTITY_GROUPS);
    if (overSeeded) {
      return { status: 'unclear', reason: 'entity_over_seeded' };
    }

    // Matches span different canonical groups. Build a per-group profile from
    // all matched unique entries and use two adaptive signals to find a winner:
    //
    // 1. Gap filter: drop any group whose best entity confidence is more than
    //    GAP_THRESHOLD below the top group's. These are false positives from
    //    entity extraction (e.g. "Cloud" tagged to FF8 via franchise cross-mentions
    //    in guide text at a lower score than its true owner FF7).
    //
    // 2. Entity coverage count: a group that has records for MORE of the matched
    //    entity names is a stronger signal. If Sephiroth+Nibelheim both point to
    //    FF7 but only Sephiroth points to Before Crisis, FF7 wins outright.
    //
    // 3. Confidence gap tiebreaker: if coverage is tied, the group with a clearly
    //    higher max confidence (≥ DOMINANT_CONF_GAP ahead and ≥ 0.85 absolute)
    //    wins.
    interface GroupProfile {
      gameId: string;
      maxConf: number;
      entityNames: Set<string>;
    }
    const groupMap = new Map<string, GroupProfile>();
    for (const r of unique) {
      const key = r.canonical_group_id ?? r.game_id;
      const cur = groupMap.get(key);
      if (!cur) {
        groupMap.set(key, { gameId: r.game_id, maxConf: r.confidence, entityNames: new Set([normalize(r.entity)]) });
      } else {
        cur.entityNames.add(normalize(r.entity));
        if (r.confidence > cur.maxConf) {
          cur.maxConf = r.confidence;
          cur.gameId = r.game_id;
        }
      }
    }

    const GAP_THRESHOLD = 0.25;
    const allGroups = Array.from(groupMap.values()).sort((a, b) => b.maxConf - a.maxConf);
    const topMaxConf = allGroups[0].maxConf;
    const plausible = allGroups.filter(g => topMaxConf - g.maxConf <= GAP_THRESHOLD);

    if (plausible.length === 1) {
      return {
        status: 'confident',
        gameId: plausible[0].gameId,
        confidence: Math.max(0.7, plausible[0].maxConf),
        reason: 'unique_entity',
      };
    }

    // Sort plausible groups: entity coverage count first, then max confidence.
    plausible.sort((a, b) =>
      b.entityNames.size !== a.entityNames.size
        ? b.entityNames.size - a.entityNames.size
        : b.maxConf - a.maxConf
    );

    const topGroup = plausible[0];
    const runnerUp = plausible[1];

    // More distinct entities covered → stronger claim.
    if (topGroup.entityNames.size > runnerUp.entityNames.size) {
      return {
        status: 'confident',
        gameId: topGroup.gameId,
        confidence: Math.max(0.7, topGroup.maxConf),
        reason: 'unique_entity',
      };
    }

    // Entity coverage tied — defer to confidence gap.
    const DOMINANT_CONF_GAP = 0.20;
    if (topGroup.maxConf >= 0.85 && topGroup.maxConf - runnerUp.maxConf >= DOMINANT_CONF_GAP) {
      return {
        status: 'confident',
        gameId: topGroup.gameId,
        confidence: Math.max(0.7, topGroup.maxConf),
        reason: 'unique_entity',
      };
    }

    // Genuinely ambiguous among plausible candidates (false positives already removed).
    const ids = plausible.slice(0, 3).map(g => g.gameId);
    return { status: 'ambiguous', gameIds: ids, reason: 'entity_ambiguous' };
  }
}

function layer1FtsConfidenceScore(c: 'none' | 'low' | 'medium' | 'high'): number {
  switch (c) {
    case 'high':
      return 0.95;
    case 'medium':
      return 0.85;
    case 'low':
      return 0.55;
    default:
      return 0.5;
  }
}

function normalize(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    // Voice-mangled "f f 7" / "f f vii" → "ff7" / "ffvii" before ff expansion.
    .replace(/\bf\s+f\s*([0-9]{1,2}|[ivx]{1,4})\b/gi, 'ff$1')
    .replace(/\bff\s*([0-9]{1,2}|[ivx]{1,4})\b/gi, (_m, n) => `final fantasy ${ROMAN_TO_ARABIC[n.toLowerCase()] ?? n}`)
    .replace(/\s+/g, ' ')
    .trim();
}

