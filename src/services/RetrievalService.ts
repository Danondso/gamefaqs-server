// Hybrid retrieval over the chunked guide archive.
//
// Algorithm:
//   1. Embed the question.
//   2. KNN via the ANN index (USearch HNSW i8) AND BM25 over chunks_fts.
//      When game/platform filters are present, vec search over-fetches by 5×
//      because filters are applied post-hoc and a strict KNN window can be
//      starved by non-matching rows.
//   3. Title-aware boost: BM25 over guides_fts_meta(title, tags). Every chunk
//      belonging to a title-matched guide enters fusion at the guide's title
//      rank. This is what makes "<aspect> in <game>" questions reliably
//      surface guides for the named game even when the chunk content doesn't
//      repeat the game's name (e.g. a Diablo 2 mechanics chunk that doesn't
//      say "Diablo" itself).
//   4. Game-match boost: phrase-match question n-grams against games_fts —
//      if the question explicitly names a game ("Pokemon Red", "Final
//      Fantasy X", "Diablo 2"), pull all chunks for that game's guides and
//      enter them at rank 0 with a stronger RRF weight than title-FTS. This
//      sidesteps the title-FTS rare-token-filter pathology where game-name
//      tokens like `pokemon` (df ~600) get dropped in favor of action verbs
//      like `beat` (df ~40), causing title-FTS to surface the wrong games.
//   5. Reciprocal-rank fusion: each chunk's score = Σ_source 1/(rrfK + rank).
//      Chunks present in multiple lists sum their contributions. Sort desc, take topK.
//   6. Hydrate to Citation[] in one round trip.

import { performance } from 'perf_hooks';
import type { IDatabase } from '../interfaces/IDatabase';
import type { EmbeddingService } from './EmbeddingService';

export interface Citation {
  guide_id: string;
  guide_title: string;
  chunk_id: string;
  chunk_index: number;
  gamefaqs_id: string | null;
  /** Full chunk text as stored in the index. Synthesis uses this; `excerpt` is a short preview for APIs/MCP. */
  content: string;
  excerpt: string;
  score: number;
}

export interface RetrievalFilters {
  gameId?: string;
  canonicalGameGroupId?: string;
  gamefaqsId?: string;
  franchise?: string;
  language?: string;
  guideAuthor?: string;
  guideType?: string;
  reviewStatus?: string;
  platform?: string;
  genre?: string;
  tags?: string[];
  tagMatch?: 'any' | 'all';
}

export interface VectorHit {
  chunk_id: string;
  distance: number;
}

export interface FtsHit {
  chunk_id: string;
  rank: number;
}

export interface TitleHit {
  guide_id: string;
  rank: number;
}

export type RetrievalIntent = 'specific' | 'ambiguous' | 'trick' | 'unanswerable';
type GameMatchConfidence = 'none' | 'low' | 'medium' | 'high';

export type VectorSearchFn = (queryVector: Float32Array, k: number) => VectorHit[];
export type FtsSearchFn = (query: string, limit: number) => FtsHit[];
export type TitleSearchFn = (query: string, limit: number) => TitleHit[];
// Returns the matched game_ids for a question. An empty result means "no
// game name detected"; consumers fall back to title-FTS / vec / chunk-FTS.
export type GameMatchFn = (question: string) => string[];

export interface RetrievalServiceOpts {
  db: IDatabase;
  embeddingService: EmbeddingService;
  ftsLimit?: number;
  vecLimit?: number;
  titleLimit?: number;
  rrfK?: number;
  // Test seams. If omitted, defaults wrap the ANN index / FTS5 SQL.
  vectorSearch?: VectorSearchFn;
  ftsSearch?: FtsSearchFn;
  titleSearch?: TitleSearchFn;
  gameMatch?: GameMatchFn;
}

/** Result of games_fts phrase extraction (shared by Layer 1 and legacy match). */
export interface Layer1GamesFtsMatch {
  ids: string[];
  phraseTokens: string[];
  confidence: GameMatchConfidence;
}

type GameMatchResult = Layer1GamesFtsMatch;

const EXCERPT_CHARS = 300;
const FILTER_OVERFETCH = 5;
// Cap on how many tokens we forward to title-FTS after rarity filtering.
// More than 3 tends to dilute the rare-token signal that we're trying to
// preserve.
const TITLE_TOKEN_BUDGET = 3;
// Cap on how many tokens we forward to chunk-FTS after rarity filtering.
// Larger than the title budget because chunk content is longer and more
// varied — keeping a couple extra rare tokens helps retrieve specific
// passages even when the dominant term doesn't appear in every relevant
// chunk. Rationale for the gate: chunk-FTS dominated retrieval p95 (94%
// of total wall time) before this filter was added. 5 is the empirically
// chosen sweet spot — 4 dropped Pokemon Red Elite Four below recall (only
// 'Elite' was rare enough), and 6+ readmits common-ish tokens that drag
// p95 back up.
const CHUNK_TOKEN_BUDGET = 5;
// Cap on how many dropped (too-common globally) tokens to include in the
// game-scoped supplementary BM25 pass. 1 keeps signal tight — the single
// least-rare dropped token (e.g. "stars" for SM64, "level" for D2) adds the
// most discriminating signal within the matched game without admitting the
// second-least-rare token, which tends to be noisier (e.g. "super" in every
// SM64 chunk header drowns the star-specific ranking).
const SUPP_TOKEN_BUDGET = 1;
// Minimum indexed chunks for a game before we run the supplementary BM25 pass.
// Sparse games (< threshold chunks) are either unindexed or a bad entity match;
// scoping BM25 to them adds noise rather than signal.
const SUPP_MIN_GAME_CHUNKS = 100;
// Generic gameplay/English tokens that are globally common AND evenly distributed
// within any game's chunk set — they add no discriminating signal in a
// game-scoped BM25 query and make the JOIN scan very slow (100k+ FTS rows).
// Nouns like "level" and "stars" are intentionally NOT in this set.
const SUPP_GENERIC_TOKENS = new Set([
  // Generic gameplay verbs
  'beat', 'fight', 'find', 'get', 'go', 'use', 'do', 'make', 'take', 'put',
  'come', 'know', 'good', 'just', 'like', 'look', 'long', 'need', 'help',
  'first', 'last', 'next', 'best', 'boss', 'where', 'when', 'final',
  'secret', 'special', 'called', 'start', 'way', 'time', 'part',
  // Common game-guide nouns that appear in virtually every guide
  'combo', 'shot', 'attack', 'damage', 'health', 'item', 'move', 'trick',
  'glitch', 'cheat', 'unlock', 'kill', 'die', 'run', 'jump', 'hit',
]);
// Maximum DF for a chunk-FTS token to count as "rare". Tokens above this
// threshold get dropped from the chunk-FTS query, since BM25 ranking over
// millions of candidate chunks dominates wall-clock latency. Per-token DF
// is read from the fts5vocab virtual table created in migration v5.
const CHUNK_RARE_DF_FRACTION = 0.05;
const CHUNK_RARE_DF_MIN = 5000;
// N-gram window for game-name extraction. 5 covers "metal gear solid 2 sons"
// without admitting many genuine nonsense matches. Longer matches are tried
// first so "Final Fantasy X 2 HD" beats "Final Fantasy X".
//
// NGRAM_MIN=1 catches single-word game titles (Portal, Tetris, Diablo, Zelda),
// but 1-grams take a stricter path in `defaultGameMatch`: length ≥ MIN_1GRAM_LEN
// AND the matched game's title must equal the candidate token exactly (no
// substring match). Without those two guards, common English words ("burn",
// "boss", "cloud", "key") falsely match incidental titles ("Burn Zombie Burn").
const GAME_MATCH_NGRAM_MAX = 5;
const GAME_MATCH_NGRAM_MIN = 1;
const MIN_1GRAM_LEN = 4;
// Franchise abbreviations expanded ONLY when adjacent to an installment number
// (suffix-split form). Bare `RE` in casual prose ("Re: that question") would
// falsely expand to Resident Evil under unconditional expansion; requiring a
// digit suffix is the cheap disambiguator. Limit the table to abbreviations
// almost universally used in gaming context (omit `pkmn`, `oot` — too many
// false-positive risks in normal text).
const ABBREV_EXPANSIONS: Record<string, string[]> = {
  ff: ['final', 'fantasy'],
  re: ['resident', 'evil'],
  mgs: ['metal', 'gear', 'solid'],
  gta: ['grand', 'theft', 'auto'],
  kh: ['kingdom', 'hearts'],
  dmc: ['devil', 'may', 'cry'],
  smt: ['shin', 'megami', 'tensei'],
  ssbm: ['super', 'smash', 'bros', 'melee'],
  ssbb: ['super', 'smash', 'bros', 'brawl'],
  sm: ['super', 'mario'],
  cod: ['call', 'of', 'duty'],
};
// Roman ↔ Arabic numeral pairs we substitute when generating n-gram phrase
// candidates. Covers the common range for game-installment numbers; the
// games table uses both forms inconsistently ("Diablo II" but "Final
// Fantasy X 2"), so we try both.
const NUMERAL_ALIASES: Record<string, string> = {
  '1': 'i', '2': 'ii', '3': 'iii', '4': 'iv', '5': 'v',
  '6': 'vi', '7': 'vii', '8': 'viii', '9': 'ix', '10': 'x',
  '11': 'xi', '12': 'xii', '13': 'xiii', '14': 'xiv', '15': 'xv',
  'i': '1', 'ii': '2', 'iii': '3', 'iv': '4', 'v': '5',
  'vi': '6', 'vii': '7', 'viii': '8', 'ix': '9', 'x': '10',
  'xi': '11', 'xii': '12', 'xiii': '13', 'xiv': '14', 'xv': '15',
};
const UNANSWERABLE_PATTERNS: RegExp[] = [
  /\bhow\s+do\s+i\s+beat\s+the\s+(?:first|second|third|final)\s+boss\b/i,
  /\bhow\s+do\s+i\s+solve\s+the\s+(?:first|second|third|final)\s+puzzle\b/i,
];
const TRICK_PATTERNS: RegExp[] = [
  /\btriforce\b.*\bocarina\s+of\s+time\b/i,
  /\bfinal\s+boss\b.*\btetris\b/i,
  /\bsecret\s+combo\b.*\bone-?shot\b/i,
];
const CONTEXT_PREPOSITIONS = new Set(['in', 'for', 'from', 'on', 'at']);
const LOW_SIGNAL_SINGLE_TOKENS = new Set([
  'cloud', 'burn', 'key', 'start', 'boss', 'class', 'first', 'second', 'last', 'name', 'stars',
]);

interface ChunkRow {
  id: string;
  guide_id: string;
  chunk_index: number;
  content: string;
  gamefaqs_id: string | null;
  guide_title: string;
  guide_game_id: string | null;
  guide_metadata: string | null;
}

export class RetrievalService {
  private readonly db: IDatabase;
  private readonly embeddings: EmbeddingService;
  private readonly ftsLimit: number;
  private readonly vecLimit: number;
  private readonly titleLimit: number;
  private readonly rrfK: number;
  private readonly vectorSearch: VectorSearchFn;
  private readonly ftsSearch: FtsSearchFn;
  private readonly titleSearch: TitleSearchFn;
  private readonly gameMatch: GameMatchFn;

  constructor(opts: RetrievalServiceOpts) {
    this.db = opts.db;
    this.embeddings = opts.embeddingService;
    this.ftsLimit = opts.ftsLimit ?? 20;
    this.vecLimit = opts.vecLimit ?? 20;
    // Capped lower than chunk-level limits — title-matched guides expand into
    // (potentially many) chunks, and a too-wide title-match list dominates RRF.
    this.titleLimit = opts.titleLimit ?? 10;
    this.rrfK = opts.rrfK ?? 60;
    this.vectorSearch = opts.vectorSearch ?? this.defaultVectorSearch.bind(this);
    this.ftsSearch = opts.ftsSearch ?? this.defaultFtsSearch.bind(this);
    this.titleSearch = opts.titleSearch ?? this.defaultTitleSearch.bind(this);
    this.gameMatch = opts.gameMatch ?? this.defaultGameMatch.bind(this);
  }

  getDb(): IDatabase {
    return this.db;
  }

  /**
   * Layer 1 game resolution: n-gram phrase match against `games_fts` + title-boundary
   * rules (Diablo 2 ↔ II, etc.). Always uses this canonical path — ignores optional
   * `gameMatch` test overrides so extraction matches production behavior.
   */
  matchGamesForLayer1(question: string): Layer1GamesFtsMatch {
    return this.defaultGameMatchDetailed(question);
  }

  /**
   * Returns game_ids for platform variants of the given game.
   *
   * Extraction sometimes picks a "base" title entry (e.g. "Final Fantasy VII")
   * that has no linked guides because all actual guides are catalogued under
   * platform-specific variants ("Final Fantasy VII (PS1)", "Final Fantasy VII
   * (PS3)"). When primary retrieval with that game_id returns 0 chunks, the
   * caller can try these siblings — each shares the same base title but has a
   * parenthetical platform suffix. Colon-separated sub-titles ("Final Fantasy
   * VII: Crisis Core") are deliberately excluded; they are different games.
   *
   * Returns at most 10 sibling ids, excluding the input game_id itself.
   */
  findGameIdVariants(gameId: string): string[] {
    const row = this.db.query<{ title: string }>(
      `SELECT title FROM games WHERE id = ?`, [gameId]
    )[0];
    if (!row) return [];
    const base = row.title;
    const rows = this.db.query<{ id: string }>(
      `SELECT id FROM games
       WHERE id != ?
         AND (title = ? OR title LIKE ?)
       LIMIT 10`,
      [gameId, base, `${base} (%`]
    );
    return rows.map(r => r.id);
  }

  async retrieve(question: string, filters: RetrievalFilters, topK: number): Promise<Citation[]> {
    const { citations } = await this.retrieveWithTimings(question, filters, topK);
    return citations;
  }

  // TEMP DEBUG: runs each retrieval source independently and returns hydrated
  // results, with NO fusion / no game-match expansion. For diagnosing whether
  // a strategy chunk is reachable via vec/FTS at all before deciding how to
  // restructure fusion. Remove after the retrieval-fix decision.
  async debugSources(question: string, k: number = 20): Promise<{
    vec: Array<{ chunk_id: string; chunk_index: number; guide_title: string; distance: number; snippet: string }>;
    chunk_fts: Array<{ chunk_id: string; chunk_index: number; guide_title: string; rank: number; snippet: string }>;
    title_fts: Array<{ guide_id: string; guide_title: string; rank: number }>;
    game_match: { matched_game_ids: string[]; matched_game_titles: string[]; chunks_in_match: number };
    chunk_fts_query: string;
    title_fts_query: string;
  }> {
    const queryVec = await this.embeddings.embed(question);
    const tokens = extractFtsTokens(question);

    // vec top-K (raw, no filter)
    const vecHits = this.vectorSearch(queryVec, k);
    const vecHydrated: Array<{ chunk_id: string; chunk_index: number; guide_title: string; distance: number; snippet: string }> = [];
    if (vecHits.length > 0) {
      const ph = vecHits.map(() => '?').join(',');
      const rows = this.db.query<{ id: string; chunk_index: number; content: string; guide_title: string }>(
        `SELECT c.id, c.chunk_index, c.content, g.title AS guide_title
         FROM chunks c JOIN guides g ON g.id = c.guide_id WHERE c.id IN (${ph})`,
        vecHits.map(h => h.chunk_id)
      );
      const byId = new Map(rows.map(r => [r.id, r]));
      for (const h of vecHits) {
        const r = byId.get(h.chunk_id);
        if (!r) continue;
        vecHydrated.push({
          chunk_id: h.chunk_id, chunk_index: r.chunk_index,
          guide_title: r.guide_title, distance: h.distance,
          snippet: r.content.slice(0, 280).replace(/\s+/g, ' '),
        });
      }
    }

    // chunk-FTS top-K (rare-token filtered as in production)
    const { survivors: chunkTokens } = this.filterToRareChunkTokens(tokens);
    const chunkFtsQuery = tokensToFtsQuery(chunkTokens);
    let ftsHydrated: Array<{ chunk_id: string; chunk_index: number; guide_title: string; rank: number; snippet: string }> = [];
    if (chunkFtsQuery) {
      const ftsHits = this.ftsSearch(chunkFtsQuery, k);
      if (ftsHits.length > 0) {
        const ph = ftsHits.map(() => '?').join(',');
        const rows = this.db.query<{ id: string; chunk_index: number; content: string; guide_title: string }>(
          `SELECT c.id, c.chunk_index, c.content, g.title AS guide_title
           FROM chunks c JOIN guides g ON g.id = c.guide_id WHERE c.id IN (${ph})`,
          ftsHits.map(h => h.chunk_id)
        );
        const byId = new Map(rows.map(r => [r.id, r]));
        ftsHydrated = ftsHits
          .map(h => {
            const r = byId.get(h.chunk_id);
            return r ? {
              chunk_id: h.chunk_id, chunk_index: r.chunk_index,
              guide_title: r.guide_title, rank: h.rank,
              snippet: r.content.slice(0, 280).replace(/\s+/g, ' '),
            } : null;
          })
          .filter((x): x is { chunk_id: string; chunk_index: number; guide_title: string; rank: number; snippet: string } => x !== null);
      }
    }

    // title-FTS
    const titleTokens = this.filterToRareTitleTokens(tokens);
    const titleFtsQuery = tokensToFtsQuery(titleTokens);
    let titleHydrated: Array<{ guide_id: string; guide_title: string; rank: number }> = [];
    if (titleFtsQuery) {
      const titleHits = this.titleSearch(titleFtsQuery, k);
      if (titleHits.length > 0) {
        const ph = titleHits.map(() => '?').join(',');
        const rows = this.db.query<{ id: string; title: string }>(
          `SELECT id, title FROM guides WHERE id IN (${ph})`,
          titleHits.map(h => h.guide_id)
        );
        const titleById = new Map(rows.map(r => [r.id, r.title]));
        titleHydrated = titleHits.map(h => ({
          guide_id: h.guide_id,
          guide_title: titleById.get(h.guide_id) ?? '',
          rank: h.rank,
        }));
      }
    }

    // game-match
    const matchedGameIds = this.gameMatch(question);
    let matchedGameTitles: string[] = [];
    let chunksInMatch = 0;
    if (matchedGameIds.length > 0) {
      const ph = matchedGameIds.map(() => '?').join(',');
      const titleRows = this.db.query<{ title: string }>(
        `SELECT title FROM games WHERE id IN (${ph})`, matchedGameIds
      );
      matchedGameTitles = titleRows.map(r => r.title);
      const countRow = this.db.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM chunks c JOIN guides g ON g.id = c.guide_id WHERE g.game_id IN (${ph})`,
        matchedGameIds
      )[0];
      chunksInMatch = countRow?.n ?? 0;
    }

    return {
      vec: vecHydrated,
      chunk_fts: ftsHydrated,
      title_fts: titleHydrated,
      game_match: { matched_game_ids: matchedGameIds, matched_game_titles: matchedGameTitles, chunks_in_match: chunksInMatch },
      chunk_fts_query: chunkFtsQuery,
      title_fts_query: titleFtsQuery,
    };
  }

  // Same as retrieve() but reports per-stage wall times so callers (AnswerService)
  // can break out embed vs retrieve without monkey-patching the embedding service.
  async retrieveWithTimings(
    question: string,
    filters: RetrievalFilters,
    topK: number
  ): Promise<{ citations: Citation[]; embedMs: number; retrieveMs: number }> {
    const hasFilters = !!(
      filters.gameId ||
      filters.gamefaqsId ||
      filters.franchise ||
      filters.language ||
      filters.guideAuthor ||
      filters.guideType ||
      filters.reviewStatus ||
      filters.platform ||
      filters.genre ||
      (filters.tags && filters.tags.length > 0)
    );
    const vecK = hasFilters ? this.vecLimit * FILTER_OVERFETCH : this.vecLimit;

    const tEmbedStart = now();
    const queryVec = await this.embeddings.embed(question);
    const embedMs = now() - tEmbedStart;

    const tRetrieveStart = now();
    let vecHits: VectorHit[] = [];
    let ftsHits: FtsHit[] = [];
    let titleHits: TitleHit[] = [];

    try {
      vecHits = this.vectorSearch(queryVec, vecK);
    } catch (err: any) {
      // ANN index missing or corrupt; fall back to FTS-only retrieval. The
      // operator should delete the .ann file and let the indexer re-embed
      // any chunks lacking ANN entries.
      console.warn('[Retrieval] vector search failed, continuing with FTS only:', err.message);
    }

    const intent = detectRetrievalIntent(question, Boolean(filters.gameId));

    // FTS5 chokes on raw user input: `?`, `!`, parentheses, and bare AND/OR/NOT
    // are all reserved syntax. Strip operator chars and quote each token
    // individually so the tokens OR together as plain terms.
    //
    // Rarity filter: chunk-FTS used to dominate retrieval p95 (94% of wall
    // time) because OR'ing common tokens like "first", "puzzle", "secret"
    // forced BM25 to score millions of candidates. We mirror what title-FTS
    // does — drop tokens whose document-frequency in `chunks_fts` exceeds
    // ~5% of the corpus — capped at CHUNK_TOKEN_BUDGET. Vague questions
    // ("How do I beat the second boss?") with no rare tokens were already
    // misses; degrading their FTS contribution doesn't add new failures.
    const tokens = extractFtsTokens(question);
    const { survivors: chunkTokens, dropped: droppedChunkTokens } = this.filterToRareChunkTokens(tokens);
    const ftsQuery = tokensToFtsQuery(chunkTokens);
    const effectiveFtsLimit = this.ftsLimit;
    try {
      ftsHits = ftsQuery ? this.ftsSearch(ftsQuery, effectiveFtsLimit) : [];
    } catch (err: any) {
      console.warn('[Retrieval] FTS search failed after sanitization:', err.message);
    }

    // Supplementary game-scoped BM25: when a specific game is identified and
    // tokens were dropped as globally too-common, run a second BM25 restricted
    // to that game's chunks. This surfaces answer-specific passages that the
    // global rare-only query misses — e.g. "level" (df=536k globally) is the
    // key discriminator for "max level in Diablo 2" within D2 chunks.
    //
    // Query: combine survivor tokens with the single least-rare dropped token
    // (SUPP_TOKEN_BUDGET=1). The OR combination means BM25 ranks chunks that
    // contain both the survivors AND the dropped term above chunks that contain
    // only one, which targets passages about (e.g.) "max level" more precisely
    // than the global rare-only query ("max" OR "diablo").
    //
    // Short tokens (len < 3) are excluded — single digits and two-letter words
    // are too generic within any game's chunk set to add signal.
    if (filters.gameId && droppedChunkTokens.length > 0) {
      const suppTokens = droppedChunkTokens
        .filter(t => t.length >= 3 && !SUPP_GENERIC_TOKENS.has(t.toLowerCase()))
        .slice(0, SUPP_TOKEN_BUDGET);
      // Only run the supplementary pass if the game has enough indexed content.
      // Sparse/wrong game matches (< SUPP_MIN_GAME_CHUNKS chunks) would add noise.
      const gameHasContent = suppTokens.length > 0 &&
        this.gameChunkCount(filters.gameId) >= SUPP_MIN_GAME_CHUNKS;
      if (gameHasContent) {
        const suppQuery = tokensToFtsQuery(suppTokens);
        try {
          const suppHits = this.gameScopedFtsSearch(suppQuery, effectiveFtsLimit, filters.gameId);
          const existingIds = new Set(ftsHits.map(h => h.chunk_id));
          for (const h of suppHits) {
            if (!existingIds.has(h.chunk_id)) {
              ftsHits.push(h);
              existingIds.add(h.chunk_id);
            }
          }
        } catch (err: any) {
          console.warn('[Retrieval] game-scoped supplementary FTS failed:', err.message);
        }
      }
    }

    // Title-FTS uses only the rare/discriminating tokens. With OR'd query
    // tokens, BM25 will rank a title that repeats common words ("Best of the
    // Best Championship Karate") above a title that matches only the rare
    // game-name token ("Diablo II"). Filtering to rare tokens before the
    // title query fixes that.
    const titleTokens = this.filterToRareTitleTokens(tokens);
    const titleQuery = tokensToFtsQuery(titleTokens);
    try {
      titleHits = titleQuery ? this.titleSearch(titleQuery, this.titleLimit) : [];
    } catch (err: any) {
      console.warn('[Retrieval] title search failed:', err.message);
    }

    // Expand title hits → chunks. Every chunk in a title-matched guide enters
    // RRF at that guide's title rank, so all chunks of the top-titled guide
    // get the same boost; vec/FTS pick the best chunk within.
    let titleChunkHits = this.expandTitleHitsToChunks(titleHits);

    // Title-FTS as re-ranker (Bug fix-6): when title-FTS would flood thousands
    // of chunks per matched guide, the alphabetical/insertion order of those
    // chunks dominates RRF in the absence of vec/FTS evidence — surfacing the
    // guide's TOC / version-history / front-matter chunks above the actual
    // answer chunks. Restrict title-source to chunks that ALSO appear in
    // vec or FTS hits (title-FTS becomes a boost, not a candidate generator).
    // The intersection is non-empty in practice because vec is a corpus-wide
    // KNN that almost always lights up SOME chunks of a title-matched guide.
    if (titleChunkHits.length > 0) {
      const evidenceIds = new Set<string>();
      for (const h of vecHits) evidenceIds.add(h.chunk_id);
      for (const h of ftsHits) evidenceIds.add(h.chunk_id);
      titleChunkHits = titleChunkHits.filter(h => evidenceIds.has(h.chunk_id));
    }

    // Apply explicit filters (gameId/platform/genre/tags) before fusion so RRF
    // rank reflects post-filter ordering.
    let filteredVec: VectorHit[] = vecHits;
    let filteredFts: FtsHit[] = ftsHits;
    let filteredTitle: { chunk_id: string; rank: number }[] = titleChunkHits;
    if (hasFilters) {
      const candidateIds = new Set([
        ...vecHits.map(h => h.chunk_id),
        ...ftsHits.map(h => h.chunk_id),
        ...titleChunkHits.map(h => h.chunk_id),
      ]);
      const allowed = this.filterChunkIds(candidateIds, filters);
      filteredVec = vecHits.filter(h => allowed.has(h.chunk_id));
      filteredFts = ftsHits.filter(h => allowed.has(h.chunk_id));
      filteredTitle = titleChunkHits.filter(h => allowed.has(h.chunk_id));
    }

    if (!hasFilters) {
      if (intent === 'unanswerable') {
        return { citations: [], embedMs, retrieveMs: now() - tRetrieveStart };
      }
      if (intent === 'trick') {
        // Trick queries without an explicit game anchor are safer as abstentions.
        filteredTitle = [];
      }
    }

    // RRF fusion. Rank within each list (1-indexed) is its position after
    // filtering — preserves original ordering of the pre-filter result.
    const scores = new Map<string, number>();
    filteredVec.forEach((h, i) => {
      scores.set(h.chunk_id, (scores.get(h.chunk_id) ?? 0) + 1 / (this.rrfK + (i + 1)));
    });
    filteredFts.forEach((h, i) => {
      scores.set(h.chunk_id, (scores.get(h.chunk_id) ?? 0) + 1 / (this.rrfK + (i + 1)));
    });
    // Title-source rank is the GUIDE's rank (already in `h.rank`), not the
    // chunk's position in the expanded list — all chunks of guide-rank 0 share
    // the same boost.
    filteredTitle.forEach(h => {
      scores.set(h.chunk_id, (scores.get(h.chunk_id) ?? 0) + 1 / (this.rrfK + (h.rank + 1)));
    });
    const ranked = Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK);

    if (ranked.length === 0) {
      return { citations: [], embedMs, retrieveMs: now() - tRetrieveStart };
    }

    // Single hydration query.
    const placeholders = ranked.map(() => '?').join(',');
    const rows = this.db.query<ChunkRow>(
      `SELECT c.id, c.guide_id, c.chunk_index, c.content, c.gamefaqs_id,
              g.title AS guide_title, g.game_id AS guide_game_id, g.metadata AS guide_metadata
       FROM chunks c
       JOIN guides g ON g.id = c.guide_id
       WHERE c.id IN (${placeholders})`,
      ranked.map(r => r[0])
    );
    const byId = new Map(rows.map(r => [r.id, r]));

    const citations: Citation[] = [];
    for (const [chunkId, score] of ranked) {
      const row = byId.get(chunkId);
      if (!row) continue;
      citations.push({
        guide_id: row.guide_id,
        guide_title: row.guide_title,
        chunk_id: row.id,
        chunk_index: row.chunk_index,
        gamefaqs_id: row.gamefaqs_id ?? null,
        content: row.content,
        excerpt: row.content.slice(0, EXCERPT_CHARS),
        score,
      });
    }
    return { citations, embedMs, retrieveMs: now() - tRetrieveStart };
  }

  private filterChunkIds(chunkIds: Set<string>, filters: RetrievalFilters): Set<string> {
    if (chunkIds.size === 0) return chunkIds;
    const ids = Array.from(chunkIds);
    const placeholders = ids.map(() => '?').join(',');
    const params: any[] = [...ids];
    let where = `c.id IN (${placeholders})`;
    if (filters.gameId) {
      where += ' AND g.game_id = ?';
      params.push(filters.gameId);
    }
    if (filters.canonicalGameGroupId) {
      where += ' AND gm.canonical_group_id = ?';
      params.push(filters.canonicalGameGroupId);
    }
    if (filters.gamefaqsId) {
      where += ' AND c.gamefaqs_id = ?';
      params.push(filters.gamefaqsId);
    }
    if (filters.franchise) {
      where += ' AND c.franchise = ?';
      params.push(filters.franchise);
    }
    if (filters.language) {
      where += ' AND c.language = ?';
      params.push(filters.language);
    }
    if (filters.guideAuthor) {
      where += ' AND c.guide_author = ?';
      params.push(filters.guideAuthor);
    }
    if (filters.guideType) {
      where += ' AND c.guide_type = ?';
      params.push(filters.guideType);
    }
    if (filters.reviewStatus) {
      where += ' AND c.review_status = ?';
      params.push(filters.reviewStatus);
    }
    if (filters.platform) {
      where += " AND json_extract(g.metadata, '$.platform') = ?";
      params.push(filters.platform);
    }
    if (filters.genre) {
      where += " AND json_extract(g.metadata, '$.genre') = ?";
      params.push(filters.genre);
    }
    if (filters.tags && filters.tags.length > 0) {
      if (filters.tagMatch === 'all') {
        for (const tag of filters.tags) {
          where += ' AND EXISTS (SELECT 1 FROM guide_tags gt WHERE gt.guide_id = g.id AND gt.tag = ?)';
          params.push(tag);
        }
      } else {
        const tagPlaceholders = filters.tags.map(() => '?').join(',');
        where += ` AND EXISTS (SELECT 1 FROM guide_tags gt WHERE gt.guide_id = g.id AND gt.tag IN (${tagPlaceholders}))`;
        params.push(...filters.tags);
      }
    }
    const rows = this.db.query<{ id: string }>(
      `SELECT c.id FROM chunks c JOIN guides g ON g.id = c.guide_id LEFT JOIN games gm ON gm.id = g.game_id WHERE ${where}`,
      params
    );
    return new Set(rows.map(r => r.id));
  }

  // KNN via the ANN index (USearch HNSW i8). Sub-10ms p95 at 3.7M vectors.
  // The ANN keys are chunks.rowid (uint64); we hydrate to chunk_id via a
  // single SQL round trip preserving distance order.
  private defaultVectorSearch(queryVec: Float32Array, k: number): VectorHit[] {
    const ann = this.db.annIndex;
    if (!ann) return [];
    const hits = ann.search(queryVec, k);
    if (hits.length === 0) return [];
    const placeholders = hits.map(() => '?').join(',');
    const rows = this.db.query<{ rowid: number; chunk_id: string }>(
      `SELECT rowid, id AS chunk_id FROM chunks WHERE rowid IN (${placeholders})`,
      hits.map((h) => h.rowid)
    );
    const byRowid = new Map(rows.map((r) => [r.rowid, r.chunk_id]));
    const out: VectorHit[] = [];
    for (const h of hits) {
      const chunk_id = byRowid.get(h.rowid);
      if (chunk_id !== undefined) out.push({ chunk_id, distance: h.distance });
    }
    return out;
  }

  private defaultFtsSearch(query: string, limit: number): FtsHit[] {
    return this.db.query<FtsHit>(
      `SELECT chunk_id, rank FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?`,
      [query, limit]
    );
  }

  // Game-scoped BM25: runs chunks_fts MATCH restricted to a single game_id.
  // Used for the supplementary dropped-token pass — when a globally-common
  // token (e.g. "level", df=536k) was filtered out of the main BM25 query,
  // running it scoped to the matched game's chunks is cheap enough and
  // surfaces answer-specific passages (e.g. "level 99" in Diablo II) that
  // the global query misses.
  private gameScopedFtsSearch(query: string, limit: number, gameId: string): FtsHit[] {
    return this.db.query<FtsHit>(
      `SELECT cf.chunk_id, cf.rank
       FROM chunks_fts cf
       JOIN chunks c ON c.id = cf.chunk_id
       JOIN guides g ON g.id = c.guide_id
       WHERE chunks_fts MATCH ?
         AND g.game_id = ?
       ORDER BY cf.rank
       LIMIT ?`,
      [query, gameId, limit]
    );
  }

  private defaultTitleSearch(query: string, limit: number): TitleHit[] {
    return this.db.query<TitleHit>(
      `SELECT guide_id, rank FROM guides_fts_meta WHERE guides_fts_meta MATCH ? ORDER BY rank LIMIT ?`,
      [query, limit]
    );
  }

  // Drop tokens whose document-frequency in guides_fts_meta makes them
  // non-discriminating. Threshold is max(50, 5% of indexed titles): a token
  // appearing in more than that many titles ("best", "class", "level", "boss")
  // would otherwise dominate BM25 ranking and crowd out genuine game-name
  // matches. Returns a (possibly empty) subset of `tokens` ordered by ascending
  // DF — rarest first. Capped at TITLE_TOKEN_BUDGET to keep the OR query small.
  // DF lookup goes through guides_fts_meta_vocab (created in migration v5),
  // which is O(log n) per token vs O(n) for `guides_fts_meta MATCH ?`.
  private filterToRareTitleTokens(tokens: string[]): string[] {
    if (tokens.length === 0) return [];
    const total = this.totalTitlesIndexed();
    if (total === 0) return [];
    const threshold = Math.max(50, Math.floor(total * 0.05));

    const dfs: { token: string; df: number }[] = [];
    for (const token of tokens) {
      try {
        const row = this.db.query<{ doc: number }>(
          `SELECT doc FROM guides_fts_meta_vocab WHERE term = ?`,
          [token.toLowerCase()]
        )[0];
        const df = row?.doc ?? 0;
        if (df > 0 && df <= threshold) dfs.push({ token, df });
      } catch {
        // Vocab table missing (pre-v5 DB) — skip rarity filtering for this
        // token so we don't silently degrade recall.
      }
    }
    dfs.sort((a, b) => a.df - b.df);
    return dfs.slice(0, TITLE_TOKEN_BUDGET).map(d => d.token);
  }

  // Chunk-FTS rarity filter. Reads DF from the fts5vocab over chunks_fts
  // (created in migration v5), which is O(log n) per token vs O(n) for
  // `chunks_fts MATCH ?`. Returns both the surviving rare tokens (sorted by
  // ascending DF, capped at CHUNK_TOKEN_BUDGET) and the dropped tokens
  // (sorted by ascending DF) for use in the game-scoped supplementary pass.
  //
  // Zero-token fallback: if ALL tokens are too common, the query would be
  // empty and BM25 returns nothing. Instead, promote the top-2 least-rare
  // dropped tokens so retrieval has at least some signal.
  //
  // Porter stem mismatch: fts5vocab stores Porter-stemmed terms, not surface
  // forms. A surface form like "stars" has df=0 in the vocab because the
  // stored stem is "star" (df=190k). To avoid treating these as ultra-rare,
  // we check common English suffix-stripped forms when the surface DF is 0.
  //
  // Falls back to "all tokens, no filter" if the vocab table is unavailable.
  private filterToRareChunkTokens(tokens: string[]): { survivors: string[]; dropped: string[] } {
    if (tokens.length === 0) return { survivors: [], dropped: [] };
    const total = this.totalChunksIndexed();
    if (total === 0) return { survivors: tokens, dropped: [] };
    const threshold = Math.max(CHUNK_RARE_DF_MIN, Math.floor(total * CHUNK_RARE_DF_FRACTION));

    let vocabAvailable = true;
    const rare: { token: string; df: number }[] = [];
    const common: { token: string; df: number }[] = [];

    for (const token of tokens) {
      try {
        const row = this.db.query<{ doc: number }>(
          `SELECT doc FROM chunks_fts_vocab WHERE term = ?`,
          [token.toLowerCase()]
        )[0];
        let df = row?.doc ?? 0;

        // Porter stem mismatch: if the surface form shows df=0, the tokenizer
        // may have stored a shorter stem. Check common suffix-stripped forms
        // so we don't treat stems like "star" (190k docs) as ultra-rare just
        // because the surface form "stars" isn't in the vocab.
        if (df === 0) {
          df = this.lookupStemDf(token) ?? 0;
        }

        if (df <= threshold) {
          rare.push({ token, df });
        } else {
          common.push({ token, df });
        }
      } catch {
        // Vocab table doesn't exist (pre-v5 DB) — bail out and keep all tokens
        // so we don't silently degrade recall.
        vocabAvailable = false;
        break;
      }
    }

    if (!vocabAvailable) return { survivors: tokens, dropped: [] };

    rare.sort((a, b) => a.df - b.df);
    common.sort((a, b) => a.df - b.df);

    const survivors = rare.slice(0, CHUNK_TOKEN_BUDGET).map(d => d.token);
    const droppedTokens = common.map(d => d.token);

    // Zero-token fallback: every token exceeded the rarity threshold. Use the
    // top-2 least-rare dropped tokens so BM25 has some discriminating signal
    // rather than returning an empty query (which retrieves nothing from FTS).
    if (survivors.length === 0 && droppedTokens.length > 0) {
      return {
        survivors: droppedTokens.slice(0, 2),
        dropped: droppedTokens.slice(2),
      };
    }

    return { survivors, dropped: droppedTokens };
  }

  // Lookup the DF for common English suffix-stripped forms of a token.
  // Used to detect Porter stem mismatches when the surface form has df=0 in
  // the fts5vocab. Returns the highest DF found across stripped candidates,
  // or 0 if no candidate matches.
  private lookupStemDf(token: string): number {
    const t = token.toLowerCase();
    const candidates: string[] = [];
    if (t.length > 4 && t.endsWith('s'))   candidates.push(t.slice(0, -1));
    if (t.length > 5 && t.endsWith('es'))  candidates.push(t.slice(0, -2));
    if (t.length > 5 && t.endsWith('ed'))  candidates.push(t.slice(0, -2));
    if (t.length > 6 && t.endsWith('ing')) candidates.push(t.slice(0, -3));
    if (t.length > 5 && t.endsWith('ly'))  candidates.push(t.slice(0, -2));
    if (t.length > 5 && t.endsWith('er'))  candidates.push(t.slice(0, -2));
    let maxDf = 0;
    for (const c of candidates) {
      try {
        const row = this.db.query<{ doc: number }>(
          `SELECT doc FROM chunks_fts_vocab WHERE term = ?`, [c]
        )[0];
        const df = row?.doc ?? 0;
        if (df > maxDf) maxDf = df;
      } catch { /* skip */ }
    }
    return maxDf;
  }

  // Minimum-indexed chunk gate for the game-scoped supplementary BM25 pass.
  // Cached for 5 minutes; games' chunk counts grow during indexing but don't
  // change at query time, so stale reads are fine.
  private gameChunkCache = new Map<string, { n: number; at: number }>();

  private gameChunkCount(gameId: string): number {
    const cached = this.gameChunkCache.get(gameId);
    if (cached && Date.now() - cached.at < 300_000) return cached.n;
    try {
      const row = this.db.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM chunks c JOIN guides g ON g.id = c.guide_id WHERE g.game_id = ?`,
        [gameId]
      )[0];
      const n = row?.n ?? 0;
      this.gameChunkCache.set(gameId, { n, at: Date.now() });
      return n;
    } catch {
      return 0;
    }
  }

  private cachedChunkTotal: number | null = null;
  private cachedChunkTotalAt = 0;

  private totalChunksIndexed(): number {
    const now = Date.now();
    if (this.cachedChunkTotal !== null && now - this.cachedChunkTotalAt < 60_000) {
      return this.cachedChunkTotal;
    }
    try {
      const row = this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM chunks`)[0];
      this.cachedChunkTotal = row?.n ?? 0;
    } catch {
      this.cachedChunkTotal = 0;
    }
    this.cachedChunkTotalAt = now;
    return this.cachedChunkTotal;
  }

  private cachedTitleTotal: number | null = null;
  private cachedTitleTotalAt = 0;

  private totalTitlesIndexed(): number {
    // Total grows during ingest but not per-request — cache for a minute so
    // we're not running COUNT(*) on every retrieval call.
    const now = Date.now();
    if (this.cachedTitleTotal !== null && now - this.cachedTitleTotalAt < 60_000) {
      return this.cachedTitleTotal;
    }
    try {
      const row = this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM guides_fts_meta`)[0];
      this.cachedTitleTotal = row?.n ?? 0;
    } catch {
      this.cachedTitleTotal = 0;
    }
    this.cachedTitleTotalAt = now;
    return this.cachedTitleTotal;
  }

  // Default game-match: tokenize the question, generate n-grams from longest
  // to shortest, try each (and its numeral-aliased variants) as a phrase
  // query against games_fts. Returns matching game_ids on first hit, or [].
  //
  // Why first-hit-wins: the longer phrase is the more specific match. If
  // "final fantasy x 2" matches, we don't also want "final fantasy x" (a
  // different game) muddying the result. If only "diablo 2" matches, that's
  // the intended target.
  private defaultGameMatch(question: string): string[] {
    return this.defaultGameMatchDetailed(question).ids;
  }

  private defaultGameMatchDetailed(question: string): GameMatchResult {
    const tokens = extractGameMatchTokens(question);
    if (tokens.length < GAME_MATCH_NGRAM_MIN) return { ids: [], phraseTokens: [], confidence: 'none' };

    // Walk longest-first; within each length, RIGHT-to-left. The shape of
    // these questions ("how do I beat X in <Game Name>?") puts the game
    // name near the end, so rightmost positions are tried first. Without
    // this, an incidental shorter match earlier in the question can preempt
    // the real game name. For each window, also try numeral-aliased forms
    // (Diablo 2 ↔ Diablo II).
    //
    // Skip n-grams whose first OR last token is a stopword: phrases like
    // "the best", "the temple", "in the" phrase-match incidentally inside
    // longer game titles ("Best of the Best Championship Karate" contains
    // "the best") and produce false-positive game matches for ambiguous
    // questions. Real game names have non-stopword endpoints.
    for (let n = Math.min(GAME_MATCH_NGRAM_MAX, tokens.length); n >= GAME_MATCH_NGRAM_MIN; n--) {
      for (let start = tokens.length - n; start >= 0; start--) {
        const ngramTokens = tokens.slice(start, start + n);
        if (STOPWORDS.has(ngramTokens[0]) || STOPWORDS.has(ngramTokens[ngramTokens.length - 1])) {
          continue;
        }
        // Compose abbreviation expansion + numeral aliasing. Order matters:
        // expand abbreviations first (`gta` → `grand theft auto`), then alias
        // any numerals in the expanded form (so `mgs 2` → `metal gear solid 2`
        // → `metal gear solid ii`). Dedup variants — a phrase with no
        // abbreviations and no numerals would otherwise be tried twice.
        const seen = new Set<string>();
        const variants: string[][] = [];
        for (const expanded of abbreviationVariants(ngramTokens)) {
          for (const variant of numeralAliasVariants(expanded)) {
            const key = variant.join(' ');
            if (seen.has(key)) continue;
            seen.add(key);
            variants.push(variant);
          }
        }
        for (const variant of variants) {
          const hits = this.queryGamesFtsPhraseWithTitles(variant);
          if (hits.length === 0) continue;
          // 1-gram bare-title demotion (Bug 3): when the phrase is a single
          // token AND every matched title is just that one token verbatim
          // (e.g. phrase "snake" matches the standalone game titled "Snake"),
          // surface as `low` so GameExtractionService falls through to the
          // alias / entity layers. Without this, the bare 1-gram match wins
          // and locks retrieval to the wrong game (e.g. "Solid Snake's
          // father" → standalone "Snake" game instead of MGS).
          const bareTitleHit =
            variant.length === 1 &&
            hits.every(h => normalizeTitleTokens(h.title).join(' ') === variant[0]);
          return {
            ids: hits.map(h => h.game_id),
            phraseTokens: variant,
            confidence: classifyGameMatchConfidence(tokens, variant, bareTitleHit),
          };
        }
      }
    }
    return { ids: [], phraseTokens: [], confidence: 'none' };
  }

  private queryGamesFtsPhrase(phraseTokens: string[]): string[] {
    return this.queryGamesFtsPhraseWithTitles(phraseTokens).map(r => r.game_id);
  }

  private queryGamesFtsPhraseWithTitles(phraseTokens: string[]): { game_id: string; title: string }[] {
    // FTS5 phrase syntax: "word1 word2 word3" matches contiguous tokens.
    // Quote individual tokens to neutralize accidental keyword shape, then
    // wrap the whole thing as a phrase.
    const cleanedPhrase = phraseTokens.map(t => t.replace(/"/g, ''));
    const phrase = cleanedPhrase.join(' ');
    if (!phrase) return [];
    try {
      const rows = this.db.query<{ game_id: string; title: string }>(
        `SELECT game_id, title FROM games_fts WHERE games_fts MATCH ? ORDER BY rank LIMIT 16`,
        [`"${phrase}"`]
      );
      // Post-filter: the matched title minus the phrase tokens must consist
      // only of "decoration" tokens (series brand words, edition suffixes).
      // Without this, the FTS phrase match also returns titles where the
      // phrase is a strict substring of a *different* game — e.g. phrase
      // "super mario 64" matches "Super Mario 64 DS" (different game),
      // "final fantasy vii" matches "Crisis Core Final Fantasy VII" and
      // "Final Fantasy VII Advent Children" (different games / spinoffs).
      // See RETRIEVAL_DEBUG.md "Step 3" for the live-data analysis.
      const strict = rows.filter(r => passesTitleBoundaryFilter(cleanedPhrase, r.title));
      if (strict.length > 0) return strict;
      // Subtitle fallback (Bug fix-1): some series have NO base catalog entry
      // and are only listed as "<series> <number> <subtitle>" (e.g. "Metal
      // Gear Solid 2" exists only as "...Substance" / "...Sons of Liberty";
      // "Metal Gear Solid 3" only as "...Snake Eater"). The strict filter
      // rejects all of these because the subtitle is not a decoration token.
      // When strict returns 0 AND the phrase is at least 3 tokens, retry with
      // a prefix-only match: phrase must occur at title position 0, tail can
      // be anything. This is safe because if a base entry existed, the strict
      // filter would have returned it and pre-empted the fallback — so e.g.
      // "Final Fantasy VII" still does NOT match "...Advent Children".
      if (cleanedPhrase.length >= 3) {
        return rows.filter(r => isTitlePrefixMatch(cleanedPhrase, r.title));
      }
      return [];
    } catch {
      // games_fts may not exist (pre-v5 DB) — silently fall back to no match.
      return [];
    }
  }

  private expandGameMatchToChunks(gameIds: string[]): string[] {
    if (gameIds.length === 0) return [];
    const placeholders = gameIds.map(() => '?').join(',');
    const rows = this.db.query<{ id: string }>(
      `SELECT c.id FROM chunks c
       JOIN guides g ON g.id = c.guide_id
       WHERE g.game_id IN (${placeholders})`,
      gameIds
    );
    return rows.map(r => r.id);
  }

  // Each TitleHit carries a guide-level rank; we emit one entry per chunk in
  // that guide so RRF can blend with the chunk-level vec/FTS sources. Chunks
  // inherit the guide's rank (i.e. all chunks of guide-rank 0 score the same
  // title-source contribution).
  private expandTitleHitsToChunks(hits: TitleHit[]): { chunk_id: string; rank: number }[] {
    if (hits.length === 0) return [];
    const guideIds = hits.map(h => h.guide_id);
    const rankByGuide = new Map<string, number>();
    hits.forEach((h, i) => {
      // Use the position in the title-FTS result list as the "rank" so RRF
      // sees a stable 0-indexed rank regardless of how negative BM25's `rank`
      // column can get.
      rankByGuide.set(h.guide_id, i);
    });
    const placeholders = guideIds.map(() => '?').join(',');
    const rows = this.db.query<{ id: string; guide_id: string }>(
      `SELECT id, guide_id FROM chunks WHERE guide_id IN (${placeholders})`,
      guideIds
    );
    return rows
      .map(r => ({ chunk_id: r.id, rank: rankByGuide.get(r.guide_id) ?? hits.length }))
      .sort((a, b) => a.rank - b.rank);
  }
}

// Exported helper so callers (admin/answer route, AnswerService) can record the
// embed step's wall time without re-implementing performance.now() bookkeeping.
export const now = (): number => performance.now();

// Heuristic intent policy used only to steer retrieval filtering aggressiveness.
// - specific: explicit game extraction succeeded -> enforce hard game gate.
// - ambiguous: no strong signal either way -> keep softer fallback behavior.
// - trick/unanswerable: avoid broad retrieval when the prompt is likely a trap.
export function detectRetrievalIntent(question: string, hasGameMatch: boolean): RetrievalIntent {
  if (hasGameMatch) return 'specific';
  for (const rx of TRICK_PATTERNS) {
    if (rx.test(question)) return 'trick';
  }
  for (const rx of UNANSWERABLE_PATTERNS) {
    if (rx.test(question)) return 'unanswerable';
  }
  return 'ambiguous';
}

function classifyGameMatchConfidence(
  questionTokens: string[],
  phraseTokens: string[],
  bareTitleHit = false,
): GameMatchConfidence {
  if (phraseTokens.length === 0) return 'none';
  if (phraseTokens.length >= 3) return 'high';
  if (phraseTokens.length === 2) return 'medium';

  const token = phraseTokens[0];
  if (token.length < MIN_1GRAM_LEN) return 'low';
  if (LOW_SIGNAL_SINGLE_TOKENS.has(token)) return 'low';
  // 1-gram phrase that matched ONLY a bare-title game (e.g. "snake" → game
  // titled "Snake"). The matcher is too loose here because any noun-shaped
  // word that happens to also be a standalone game title would otherwise
  // win at high/medium confidence and lock retrieval to the wrong game.
  // Demoting to `low` lets GameExtractionService consult the alias / entity
  // layers — which after EntitySeedService has run know that "solid snake"
  // is an MGS character, not the standalone Snake game.
  if (bareTitleHit) return 'low';
  const idx = questionTokens.indexOf(token);
  if (idx > 0 && CONTEXT_PREPOSITIONS.has(questionTokens[idx - 1])) return 'high';
  return 'medium';
}

// Tokens that are allowed to surround the matched phrase in a game title
// without invalidating the match. Two categories:
//   - Connectives / articles: harmless filler ("the", "of", "and", "&")
//   - Series-brand words: present in series titles but don't disambiguate
//     installments (e.g., "legend"/"zelda" prefixing every Zelda title;
//     "tales", "tales of", "star ocean")
//   - Edition / version / re-release suffixes: HD, Remake, Anniversary,
//     Edition, Director's Cut, etc. — different print of the same game
//
// Platform identifiers (PC, DS, PS2 …) are intentionally NOT included here.
// When they appear bare in a title ("Super Mario 64 DS", "Tetris DS") they
// ARE part of the game's distinct identity and should reject the match.
// When they appear in parentheses ("Portal (PC)", "Final Fantasy X (PS2)")
// they are stripped by `passesTitleBoundaryFilter` before tokenisation, so
// they never reach this check. See the stripping logic in that function.
//
// Curated to fix observed mis-matches; intentionally conservative. Adding a
// token here loosens the filter (more matches), removing one tightens it.
// Maintain by watching live mis-extractions in RETRIEVAL_DEBUG.md.
//
// Exported for tests.
export const TITLE_DECORATION_TOKENS = new Set([
  // Connectives / articles
  'the', 'of', 'and', 'an', 'a',
  // Series brand words (head-of-title)
  'legend', 'zelda', 'tales', 'star', 'ocean',
  // Edition / version / re-release suffixes (tail-of-title)
  'hd', 'remake', 'remaster', 'remastered', 'anniversary', 'collection',
  'edition', 'version', 'special', 'greatest', 'hits', 'ultimate',
  'definitive', 'complete', 'deluxe', 'collectors', 'collector', 'classic',
  'enhanced', 'plus', 'goty', 'directors', 'cut', 'master', 'quest',
  'rebirth', 'reborn', 'redux', 'redone', 'revisited', 'international',
]);

// Strip punctuation, collapse whitespace, lowercase, split on whitespace.
// Mirrors the FTS5 unicode61 tokenizer closely enough for the post-filter:
// FTS5 splits on punctuation, our filter tokenizes the title the same way
// before checking for the phrase substring.
function normalizeTitleTokens(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(t => t.length > 0);
}

// Find a contiguous occurrence of `needle` in `haystack`. Returns the start
// index, or -1 if absent. We compare token-by-token (case-insensitive — both
// sides come from `normalizeTitleTokens` or `extractGameMatchTokens`, which
// already lowercase).
function findContiguousTokenMatch(haystack: string[], needle: string[]): number {
  if (needle.length === 0 || needle.length > haystack.length) return -1;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

// Title-boundary filter for game-match. Returns true if the phrase, when
// found inside the title, leaves only decoration tokens on either side.
//
// Parenthetical platform suffixes — "(PC)", "(PS2)", "(GameCube)" — are
// stripped from the title BEFORE tokenisation. They are purely a GameFAQs
// cataloguing artefact and must not prevent "portal" from matching
// "Portal (PC)" or "final fantasy x" from matching "Final Fantasy X (PS2)".
// By contrast, bare platform tokens that are part of the actual game name
// ("Super Mario 64 DS", "Tetris DS") are NOT stripped and correctly reject
// the match — they are distinct titles, not platform-tagged copies.
//
// Examples (phrase tokens lowercased):
//   ['final','fantasy','vii']  vs "Final Fantasy VII"          → true (head=[], tail=[])
//   ['final','fantasy','vii']  vs "Final Fantasy VII (PS)"     → true (parens stripped)
//   ['final','fantasy','vii']  vs "Crisis Core Final Fantasy VII" → false (head=['crisis','core'])
//   ['final','fantasy','vii']  vs "Final Fantasy VII Advent Children" → false (tail=['advent','children'])
//   ['super','mario','64']     vs "Super Mario 64 DS"          → false (tail=['ds'], bare — not stripped)
//   ['portal']                 vs "Portal (PC)"                → true (parens stripped → "Portal")
//   ['pokemon','red']          vs "Pokemon Red Version"        → true (tail=['version'] — decoration)
//   ['ocarina','of','time']    vs "The Legend of Zelda: Ocarina of Time" → true (all head decoration)
//   ['diablo']                 vs "Diablo II"                  → false (tail=['ii'])
//
// Exported for tests.
export function passesTitleBoundaryFilter(phraseTokens: string[], title: string): boolean {
  // Strip parenthetical suffixes like " (PC)", " (PS2 Version)" before
  // tokenising. These are platform annotations added by GameFAQs, not part of
  // the game's actual name, and should never invalidate a phrase match.
  const strippedTitle = title.replace(/\s*\([^)]*\)/g, '').trim();
  const titleTokens = normalizeTitleTokens(strippedTitle || title);
  const phrase = phraseTokens.map(t => t.toLowerCase());
  const start = findContiguousTokenMatch(titleTokens, phrase);
  if (start < 0) return false; // FTS already guaranteed match; defensive.
  const head = titleTokens.slice(0, start);
  const tail = titleTokens.slice(start + phrase.length);
  for (const t of head) if (!TITLE_DECORATION_TOKENS.has(t)) return false;
  for (const t of tail) if (!TITLE_DECORATION_TOKENS.has(t)) return false;
  return true;
}

// Prefix-match fallback for the boundary filter. Returns true if the phrase
// occurs at title position 0 (head is empty), regardless of tail. Used by
// queryGamesFtsPhraseWithTitles when the strict filter returns 0 hits — see
// the call site for the safety argument (a base entry would have pre-empted
// this fallback by passing the strict filter first).
//
// Exported for tests.
export function isTitlePrefixMatch(phraseTokens: string[], title: string): boolean {
  const strippedTitle = title.replace(/\s*\([^)]*\)/g, '').trim();
  const titleTokens = normalizeTitleTokens(strippedTitle || title);
  const phrase = phraseTokens.map(t => t.toLowerCase());
  return findContiguousTokenMatch(titleTokens, phrase) === 0;
}

// FTS5 reserves a number of characters and bare keywords. Sanitize a raw user
// question so it can be passed to MATCH without syntax errors and without
// accidentally enabling phrase / boolean operators.
//
// Strategy: tokenize, drop punctuation + boolean keywords + common stopwords,
// quote each surviving token (so anything that resembles a keyword is treated
// as a literal term), and OR the tokens together. OR (rather than the implicit
// AND of bare terms) is correct for question-answering: a 14-word question
// rarely has a chunk containing every word, but BM25 ranking of an OR query
// naturally surfaces chunks rich in the rare/specific terms ("Sephiroth")
// while ignoring the common ones ("the", "in").
//
// Exported for tests.
const STOPWORDS = new Set([
  'a','an','the','is','are','was','were','be','been','being','am','i','you','he','she','it','we','they','me','him','her','us','them','my','your','his','its','our','their',
  'and','or','but','if','then','else','when','while','as','of','at','by','for','with','about','against','between','into','through','during','before','after','above','below','to','from','up','down','in','out','on','off','over','under','again','further',
  'do','does','did','doing','have','has','had','having','can','could','should','would','will','shall','may','might','must',
  'this','that','these','those','what','which','who','whom','whose','why','how',
  'not','no','nor','so','than','too','very','just','also','only','own','same','such','any','some','all','each','every','few','more','most','other','another',
]);

export function extractFtsTokens(question: string): string[] {
  // Replace anything that isn't a letter, digit, or whitespace with a space.
  // This catches ?, !, (), ", -, +, ^, *, etc.
  const cleaned = question.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const raw of cleaned.split(/\s+/)) {
    if (!raw) continue;
    const upper = raw.toUpperCase();
    // Drop FTS5 boolean keywords explicitly (also covered by stopwords for
    // the lowercase forms, but the spec is case-sensitive so we belt-and-
    // braces).
    if (upper === 'AND' || upper === 'OR' || upper === 'NOT' || upper === 'NEAR') continue;
    const lower = raw.toLowerCase();
    if (STOPWORDS.has(lower)) continue;
    // Dedup repeated tokens — they don't add ranking signal in BM25.
    if (seen.has(lower)) continue;
    seen.add(lower);
    tokens.push(raw);
  }
  return tokens;
}

// Tokenize a question for game-name n-gram matching. Differs from
// extractFtsTokens: we keep stopwords (game names contain "the", "of",
// "and") and preserve original token order — n-gram windows depend on
// adjacency. Also lowercased so phrase queries are case-insensitive.
//
// Exported for tests.
export function extractGameMatchTokens(question: string): string[] {
  const cleaned = question.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  const tokens: string[] = [];
  for (const raw of cleaned.split(/\s+/)) {
    if (!raw) continue;
    const upper = raw.toUpperCase();
    if (upper === 'AND' || upper === 'OR' || upper === 'NOT' || upper === 'NEAR') continue;
    tokens.push(raw.toLowerCase());
  }
  return tokens;
}

// For a token sequence, generate phrase variants by expanding each
// abbreviation token (`gta` → `grand theft auto`, `mgs` → `metal gear solid`).
// Adjacency rule: only expand when the abbreviation is adjacent to a numeral
// OR sits at the start/end of the phrase. Without that gate, `re` in casual
// English ("Re: that question") would falsely expand to "resident evil".
//
// Returns the powerset over which abbreviation positions to expand (always
// includes the original at index 0). Capped at 4 variants — up to 2
// abbreviations per phrase, which is far more than any real game name.
//
// Exported for tests.
export function abbreviationVariants(tokens: string[]): string[][] {
  if (tokens.length === 0) return [tokens];

  const isNumeric = (s: string): boolean => NUMERAL_ALIASES[s] !== undefined;

  // Identify abbreviation positions in the ORIGINAL token sequence. These
  // indices are stable across mask iterations because we always rebuild
  // from `tokens` rather than from a previously-spliced variant.
  const positions: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!ABBREV_EXPANSIONS[tokens[i]]) continue;
    const atBoundary = i === 0 || i === tokens.length - 1;
    const prevNum = i > 0 && isNumeric(tokens[i - 1]);
    const nextNum = i < tokens.length - 1 && isNumeric(tokens[i + 1]);
    if (atBoundary || prevNum || nextNum) positions.push(i);
  }
  if (positions.length === 0) return [tokens];

  // Cap the powerset at 4 (= 2^2) so the variant explosion stays bounded
  // under composition with numeralAliasVariants (which can already 8x).
  const cap = Math.min(4, 1 << positions.length);
  const variants: string[][] = [];
  for (let mask = 0; mask < cap; mask++) {
    // Rebuild from the ORIGINAL tokens. Walk left to right; whenever we
    // hit an abbreviation position whose mask bit is set, push the
    // expansion instead of the original token. Index drift across the
    // splice is invisible to this loop because we read from `tokens` (the
    // pre-splice array), not from a variant under construction.
    const variant: string[] = [];
    let bitIndex = 0;
    for (let i = 0; i < tokens.length; i++) {
      if (bitIndex < positions.length && positions[bitIndex] === i) {
        if ((mask >> bitIndex) & 1) {
          variant.push(...ABBREV_EXPANSIONS[tokens[i]]);
        } else {
          variant.push(tokens[i]);
        }
        bitIndex++;
      } else {
        variant.push(tokens[i]);
      }
    }
    variants.push(variant);
  }
  return variants;
}

// For a token sequence, generate phrase variants substituting numerals
// (Arabic ↔ Roman) at each numeric position. Returns the original first,
// then variants. Caps the explosion at 8 variants — covers up to three
// numeric tokens in one phrase, which is more than any real game title.
//
// Exported for tests.
export function numeralAliasVariants(tokens: string[]): string[][] {
  const positions: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (NUMERAL_ALIASES[tokens[i]] !== undefined) positions.push(i);
  }
  if (positions.length === 0) return [tokens];
  const variants: string[][] = [tokens.slice()];
  // Each numeric position can flip independently — generate up to 2^k
  // combinations (capped). For 0 numerals: just the original. For 1: 2
  // variants. For 2: 4. For 3+: 8.
  const cap = Math.min(8, 1 << positions.length);
  for (let mask = 1; mask < cap; mask++) {
    const variant = tokens.slice();
    for (let bit = 0; bit < positions.length; bit++) {
      if ((mask >> bit) & 1) {
        const pos = positions[bit];
        variant[pos] = NUMERAL_ALIASES[tokens[pos]];
      }
    }
    variants.push(variant);
  }
  return variants;
}

export function tokensToFtsQuery(tokens: string[]): string {
  if (tokens.length === 0) return '';
  // Quote each token so reserved-keyword-shaped terms are treated as literals;
  // OR them so BM25 can rank chunks by how many specific terms hit.
  return tokens.map(t => `"${t}"`).join(' OR ');
}

export function sanitizeFtsQuery(question: string): string {
  return tokensToFtsQuery(extractFtsTokens(question));
}
