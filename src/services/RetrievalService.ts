// Hybrid retrieval over the chunked guide archive.
//
// Algorithm:
//   1. Embed the question.
//   2. KNN over chunk_embeddings (sqlite-vec) AND BM25 over chunks_fts.
//      When game/platform filters are present, vec search over-fetches by 5×
//      because filters are applied post-hoc and a strict KNN window can be
//      starved by non-matching rows.
//   3. Reciprocal-rank fusion: each chunk's score = Σ_source 1/(rrfK + rank).
//      Chunks present in both lists sum their contributions. Sort desc, take topK.
//   4. Hydrate to Citation[] in one round trip.

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

export type VectorSearchFn = (queryVector: Float32Array, k: number) => VectorHit[];
export type FtsSearchFn = (query: string, limit: number) => FtsHit[];

export interface RetrievalServiceOpts {
  db: IDatabase;
  embeddingService: EmbeddingService;
  ftsLimit?: number;
  vecLimit?: number;
  rrfK?: number;
  // Test seams. If omitted, defaults wrap the db with sqlite-vec / FTS5 SQL.
  vectorSearch?: VectorSearchFn;
  ftsSearch?: FtsSearchFn;
}

const EXCERPT_CHARS = 300;
const FILTER_OVERFETCH = 5;

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
  private readonly rrfK: number;
  private readonly vectorSearch: VectorSearchFn;
  private readonly ftsSearch: FtsSearchFn;

  constructor(opts: RetrievalServiceOpts) {
    this.db = opts.db;
    this.embeddings = opts.embeddingService;
    this.ftsLimit = opts.ftsLimit ?? 20;
    this.vecLimit = opts.vecLimit ?? 20;
    this.rrfK = opts.rrfK ?? 60;
    this.vectorSearch = opts.vectorSearch ?? this.defaultVectorSearch.bind(this);
    this.ftsSearch = opts.ftsSearch ?? this.defaultFtsSearch.bind(this);
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

    try {
      vecHits = this.vectorSearch(queryVec, vecK);
    } catch (err: any) {
      // sqlite-vec might not be loaded; fall back to FTS-only retrieval.
      console.warn('[Retrieval] vector search failed, continuing with FTS only:', err.message);
    }

    // FTS5 chokes on raw user input: `?`, `!`, parentheses, and bare AND/OR/NOT
    // are all reserved syntax. The previous fallback wrapped the entire question
    // in quotes, which turns it into a phrase search ("the literal sentence
    // appears verbatim") — that never matches a chunk and silently zeros out
    // the FTS contribution to RRF. Strip operator chars and quote each token
    // individually so the tokens AND together as plain terms.
    const ftsQuery = sanitizeFtsQuery(question);
    try {
      ftsHits = ftsQuery ? this.ftsSearch(ftsQuery, this.ftsLimit) : [];
    } catch (err: any) {
      // Should not happen after sanitization, but if it does we fall back to
      // vector-only retrieval rather than failing the whole request.
      console.warn('[Retrieval] FTS search failed after sanitization:', err.message);
    }

    // Apply filters before fusion so RRF rank reflects post-filter ordering.
    let filteredVec: VectorHit[] = vecHits;
    let filteredFts: FtsHit[] = ftsHits;
    if (hasFilters) {
      const candidateIds = new Set([...vecHits, ...ftsHits].map(h => h.chunk_id));
      const allowed = this.filterChunkIds(candidateIds, filters);
      filteredVec = vecHits.filter(h => allowed.has(h.chunk_id));
      filteredFts = ftsHits.filter(h => allowed.has(h.chunk_id));
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

  private defaultVectorSearch(queryVec: Float32Array, k: number): VectorHit[] {
    if (!this.db.vectorSearchAvailable) return [];
    const buf = Buffer.from(queryVec.buffer, queryVec.byteOffset, queryVec.byteLength);
    return this.db.query<VectorHit>(
      `SELECT chunk_id, distance FROM chunk_embeddings
       WHERE embedding MATCH ? AND k = ? ORDER BY distance`,
      [buf, k]
    );
  }

  private defaultFtsSearch(query: string, limit: number): FtsHit[] {
    return this.db.query<FtsHit>(
      `SELECT chunk_id, rank FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?`,
      [query, limit]
    );
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

export function sanitizeFtsQuery(question: string): string {
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
  if (tokens.length === 0) return '';
  // Quote each token so reserved-keyword-shaped terms are treated as literals;
  // OR them so BM25 can rank chunks by how many specific terms hit.
  return tokens.map(t => `"${t}"`).join(' OR ');
}
