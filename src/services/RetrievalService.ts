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
    const hasFilters = !!(filters.gameId || filters.platform);
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

    try {
      ftsHits = this.ftsSearch(question, this.ftsLimit);
    } catch (err: any) {
      // FTS5 syntax error — retry with the question wrapped in quotes (same trick
      // as the MCP search_guides handler).
      if (err.message?.includes('fts5') || err.message?.includes('syntax error')) {
        const safe = `"${question.replace(/"/g, '')}"`;
        ftsHits = this.ftsSearch(safe, this.ftsLimit);
      } else {
        throw err;
      }
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
