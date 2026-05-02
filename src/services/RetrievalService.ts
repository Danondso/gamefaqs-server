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
//   4. Reciprocal-rank fusion: each chunk's score = Σ_source 1/(rrfK + rank).
//      Chunks present in multiple lists sum their contributions. Sort desc, take topK.
//   5. Hydrate to Citation[] in one round trip.

import { performance } from 'perf_hooks';
import type { IDatabase } from '../interfaces/IDatabase';
import type { EmbeddingService } from './EmbeddingService';

export interface Citation {
  guide_id: string;
  guide_title: string;
  chunk_id: string;
  chunk_index: number;
  excerpt: string;
  score: number;
}

export interface RetrievalFilters {
  gameId?: string;
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

export type VectorSearchFn = (queryVector: Float32Array, k: number) => VectorHit[];
export type FtsSearchFn = (query: string, limit: number) => FtsHit[];
export type TitleSearchFn = (query: string, limit: number) => TitleHit[];

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
}

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
// Maximum DF for a chunk-FTS token to count as "rare". Tokens above this
// threshold get dropped from the chunk-FTS query, since BM25 ranking over
// millions of candidate chunks dominates wall-clock latency. Per-token DF
// is read from the fts5vocab virtual table created in migration v9.
const CHUNK_RARE_DF_FRACTION = 0.05;
const CHUNK_RARE_DF_MIN = 5000;

interface ChunkRow {
  id: string;
  guide_id: string;
  chunk_index: number;
  content: string;
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
  }

  async retrieve(question: string, filters: RetrievalFilters, topK: number): Promise<Citation[]> {
    const { citations } = await this.retrieveWithTimings(question, filters, topK);
    return citations;
  }

  // Same as retrieve() but reports per-stage wall times so callers (AnswerService)
  // can break out embed vs retrieve without monkey-patching the embedding service.
  async retrieveWithTimings(
    question: string,
    filters: RetrievalFilters,
    topK: number
  ): Promise<{ citations: Citation[]; embedMs: number; retrieveMs: number }> {
    const hasFilters = !!(filters.gameId || filters.platform || filters.genre || (filters.tags && filters.tags.length > 0));
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
    const chunkTokens = this.filterToRareChunkTokens(tokens);
    const ftsQuery = tokensToFtsQuery(chunkTokens);
    try {
      ftsHits = ftsQuery ? this.ftsSearch(ftsQuery, this.ftsLimit) : [];
    } catch (err: any) {
      console.warn('[Retrieval] FTS search failed after sanitization:', err.message);
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
    const titleChunkHits = this.expandTitleHitsToChunks(titleHits);

    // Apply filters before fusion so RRF rank reflects post-filter ordering.
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
      `SELECT c.id, c.guide_id, c.chunk_index, c.content,
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
      `SELECT c.id FROM chunks c JOIN guides g ON g.id = c.guide_id WHERE ${where}`,
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
  private filterToRareTitleTokens(tokens: string[]): string[] {
    if (tokens.length === 0) return [];
    const total = this.totalTitlesIndexed();
    if (total === 0) return [];
    const threshold = Math.max(50, Math.floor(total * 0.05));

    const dfs: { token: string; df: number }[] = [];
    for (const token of tokens) {
      try {
        const row = this.db.query<{ n: number }>(
          `SELECT COUNT(*) AS n FROM guides_fts_meta WHERE guides_fts_meta MATCH ?`,
          [`"${token}"`]
        )[0];
        const df = row?.n ?? 0;
        if (df > 0 && df <= threshold) dfs.push({ token, df });
      } catch {
        // Malformed token (shouldn't happen post-sanitize) — skip.
      }
    }
    dfs.sort((a, b) => a.df - b.df);
    return dfs.slice(0, TITLE_TOKEN_BUDGET).map(d => d.token);
  }

  // Chunk-FTS rarity filter. Same shape as filterToRareTitleTokens but reads
  // DF from the fts5vocab over chunks_fts (created in migration v9), which
  // is O(log n) per token vs O(n) for `chunks_fts MATCH ?`. Tokens above the
  // rarity threshold are dropped; the survivors are sorted by ascending DF
  // and capped at CHUNK_TOKEN_BUDGET. Falls back to "all tokens, no filter"
  // if the vocab table is unavailable (older DBs that haven't run v9).
  private filterToRareChunkTokens(tokens: string[]): string[] {
    if (tokens.length === 0) return tokens;
    const total = this.totalChunksIndexed();
    if (total === 0) return tokens;
    const threshold = Math.max(CHUNK_RARE_DF_MIN, Math.floor(total * CHUNK_RARE_DF_FRACTION));

    let vocabAvailable = true;
    const dfs: { token: string; df: number }[] = [];
    for (const token of tokens) {
      try {
        const row = this.db.query<{ doc: number }>(
          `SELECT doc FROM chunks_fts_vocab WHERE term = ?`,
          [token.toLowerCase()]
        )[0];
        const df = row?.doc ?? 0;
        // Include tokens whose DF is either 0 (token absent or not yet
        // indexed; FTS will harmlessly return nothing for them) or below the
        // rarity threshold. Drop only tokens that are demonstrably common.
        if (df <= threshold) dfs.push({ token, df });
      } catch {
        // Vocab table doesn't exist (pre-v9 DB) — bail out and keep all tokens
        // so we don't silently degrade recall.
        vocabAvailable = false;
        break;
      }
    }
    if (!vocabAvailable) return tokens;
    dfs.sort((a, b) => a.df - b.df);
    return dfs.slice(0, CHUNK_TOKEN_BUDGET).map(d => d.token);
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

export function tokensToFtsQuery(tokens: string[]): string {
  if (tokens.length === 0) return '';
  // Quote each token so reserved-keyword-shaped terms are treated as literals;
  // OR them so BM25 can rank chunks by how many specific terms hit.
  return tokens.map(t => `"${t}"`).join(' OR ');
}

export function sanitizeFtsQuery(question: string): string {
  return tokensToFtsQuery(extractFtsTokens(question));
}
