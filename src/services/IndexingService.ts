// Background indexer: walks guides where indexed_at IS NULL, chunks them,
// embeds the chunks, and writes both the chunks table and the chunk_embeddings
// vec0 table in a single transaction per guide. Resumable across restarts:
// guides with chunks but no indexed_at retry from scratch (DELETE + re-insert).

import { nanoid } from 'nanoid';
import { config } from '../config';
import DefaultDatabase from '../database/database';
import type { IDatabase } from '../interfaces/IDatabase';
import type { Guide } from '../types';
import { chunkGuide } from './Chunker';
import { EmbeddingService } from './EmbeddingService';

export interface IndexProgress {
  status: 'idle' | 'running' | 'stopping' | 'complete' | 'error';
  // Per-run counters (reset on each start)
  totalGuides: number;
  processedGuides: number;
  succeededGuides: number;
  failedGuides: number;
  totalChunks: number;
  // Whole-archive counters (live from DB, not affected by run boundaries)
  cumulativeIndexed: number;
  cumulativeTotal: number;
  currentGuideId?: string;
  currentGuideTitle?: string;
  message: string;
  error?: string;
  startedAt?: number;
}

export type IndexProgressCallback = (progress: IndexProgress) => void;

export interface StartOpts {
  limit?: number;
  force?: boolean;
}

export interface IndexingServiceDeps {
  db?: IDatabase;
  embeddingService: EmbeddingService;
}

const initialProgress = (): IndexProgress => ({
  status: 'idle',
  totalGuides: 0,
  processedGuides: 0,
  succeededGuides: 0,
  failedGuides: 0,
  totalChunks: 0,
  cumulativeIndexed: 0,
  cumulativeTotal: 0,
  message: 'Idle',
});

export class IndexingService {
  private readonly db: IDatabase;
  private readonly embeddings: EmbeddingService;
  private progress: IndexProgress = initialProgress();
  private listeners: IndexProgressCallback[] = [];
  private stopRequested = false;

  constructor(deps: IndexingServiceDeps) {
    this.db = deps.db ?? DefaultDatabase;
    this.embeddings = deps.embeddingService;
  }

  isRunning(): boolean {
    return this.progress.status === 'running' || this.progress.status === 'stopping';
  }

  getProgress(): IndexProgress {
    // Cumulative counters come straight from the DB so callers can't drift
    // from truth (e.g., when the panel is opened mid-run, when force-mode
    // re-indexes already-indexed guides, or after restarts). The per-run
    // counters in this.progress are still authoritative for the in-flight run.
    const cumulativeIndexed = this.db.get<{ c: number }>(
      'SELECT COUNT(*) as c FROM guides WHERE indexed_at IS NOT NULL'
    )?.c ?? 0;
    const cumulativeTotal = this.db.get<{ c: number }>(
      'SELECT COUNT(*) as c FROM guides'
    )?.c ?? 0;
    return { ...this.progress, cumulativeIndexed, cumulativeTotal };
  }

  // Persistent counts from the DB — survive process restarts and reflect work
  // done across all prior runs, not just the current in-memory progress.
  getDbStats(): { totalGuides: number; indexedGuides: number; totalChunks: number } {
    const totalGuides = this.db.get<{ c: number }>('SELECT COUNT(*) as c FROM guides')?.c ?? 0;
    const indexedGuides = this.db.get<{ c: number }>(
      'SELECT COUNT(*) as c FROM guides WHERE indexed_at IS NOT NULL'
    )?.c ?? 0;
    const totalChunks = this.db.get<{ c: number }>('SELECT COUNT(*) as c FROM chunks')?.c ?? 0;
    return { totalGuides, indexedGuides, totalChunks };
  }

  onProgressChange(cb: IndexProgressCallback): () => void {
    this.listeners.push(cb);
    return () => {
      const i = this.listeners.indexOf(cb);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  stop(): void {
    if (this.isRunning()) {
      this.stopRequested = true;
      this.progress.status = 'stopping';
      this.progress.message = 'Stopping...';
      this.notify();
    }
  }

  async start(opts: StartOpts = {}): Promise<void> {
    if (this.isRunning()) {
      console.log('[Indexing] already running');
      return;
    }

    const totalUnindexed = this.db.get<{ count: number }>(
      opts.force
        ? 'SELECT COUNT(*) as count FROM guides'
        : 'SELECT COUNT(*) as count FROM guides WHERE indexed_at IS NULL'
    )?.count ?? 0;

    this.stopRequested = false;
    this.progress = {
      ...initialProgress(),
      status: 'running',
      totalGuides: opts.limit ? Math.min(opts.limit, totalUnindexed) : totalUnindexed,
      message: 'Starting indexing...',
      startedAt: Date.now(),
    };
    this.notify();

    console.log(`[Indexing] starting (limit=${opts.limit ?? 'none'}, force=${!!opts.force})`);

    setImmediate(() => this.loop(opts));
  }

  private async loop(opts: StartOpts): Promise<void> {
    const insertChunkStmt = this.db.getDb().prepare(
      `INSERT INTO chunks (id, guide_id, chunk_index, content, char_start, char_end, token_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const deleteChunksStmt = this.db.getDb().prepare('DELETE FROM chunks WHERE guide_id = ?');
    const updateIndexedAtStmt = this.db.getDb().prepare('UPDATE guides SET indexed_at = ? WHERE id = ?');

    const insertEmbeddingStmt = this.db.vectorSearchAvailable
      ? this.db.getDb().prepare('INSERT INTO chunk_embeddings(chunk_id, embedding) VALUES (?, ?)')
      : null;
    // Per-id delete: vec0 can't push down `chunk_id IN (subquery)` and ends up
    // scanning the whole embeddings table (~400ms per guide at 1M rows). Direct
    // PRIMARY KEY deletes are O(log n).
    const deleteEmbeddingByIdStmt = this.db.vectorSearchAvailable
      ? this.db.getDb().prepare('DELETE FROM chunk_embeddings WHERE chunk_id = ?')
      : null;
    const selectExistingChunkIdsStmt = this.db.getDb().prepare('SELECT id FROM chunks WHERE guide_id = ?');

    // Pipeline state. We always have at most one guide in the "embedding"
    // stage and one in the "loaded + chunked, waiting" stage. Loading the next
    // guide while the current one's embeddings are in flight is the whole
    // point: SELECT + chunk are sync CPU/IO, embed is HTTP-bound.
    //
    // Why we track lastLoadedId for non-force mode: the current guide's
    // indexed_at is still NULL until its transaction commits, so a naive
    // `WHERE indexed_at IS NULL LIMIT 1` would return the in-flight guide
    // again. Using `id > lastLoadedId` keeps us monotonically advancing.
    let lastLoadedId: string | null = null;
    let forceCursor = 0;
    type Loaded = {
      guide: Guide;
      chunks: ReturnType<typeof chunkGuide>;
      // Game-context prefix prepended to every chunk before FTS / embedding.
      // Empty string when no game is linked. Captured per-guide so the
      // join cost is paid once, not per-chunk.
      gamePrefix: string;
    };

    // Loaded once at start; per-guide game lookup uses this prepared statement.
    // Most guides are linked to a game (143376/143376 in the current archive);
    // the LEFT JOIN handles the unlikely orphan case without erroring.
    const selectGameStmt = this.db.getDb().prepare(
      'SELECT title, platform FROM games WHERE id = ?'
    );

    // Build the per-chunk prefix. The format is a single line so it lives
    // outside the natural prose flow but still tokenizes cleanly for both
    // FTS5 (BM25 picks up "Final Fantasy VII") and the embedding model
    // (gives chunks a strong "this is from <game>" signal). Empty string
    // disables prefixing for orphan guides.
    const buildGamePrefix = (gameId: string | null): string => {
      if (!gameId) return '';
      const game = selectGameStmt.get(gameId) as { title: string; platform: string | null } | undefined;
      if (!game?.title) return '';
      const platform = game.platform ? ` (${game.platform})` : '';
      return `Game: ${game.title}${platform}`;
    };

    const loadAndChunkNext = (): Loaded | null => {
      const guide = this.db.get<Guide>(
        opts.force
          ? 'SELECT * FROM guides ORDER BY id LIMIT 1 OFFSET ?'
          : (lastLoadedId === null
              ? 'SELECT * FROM guides WHERE indexed_at IS NULL ORDER BY id LIMIT 1'
              : 'SELECT * FROM guides WHERE indexed_at IS NULL AND id > ? ORDER BY id LIMIT 1'),
        opts.force ? [forceCursor++] : (lastLoadedId === null ? [] : [lastLoadedId])
      );
      if (!guide) return null;
      lastLoadedId = guide.id;
      const chunks = chunkGuide(guide.content, {
        chunkSizeTokens: config.chunkSizeTokens,
        chunkOverlapTokens: config.chunkOverlapTokens,
      });
      const gamePrefix = buildGamePrefix(guide.game_id ?? null);
      return { guide, chunks, gamePrefix };
    };

    // Compose the indexed-and-embedded text for a chunk by prepending the game
    // prefix. Guide content alone strands chunks without a "this is X game"
    // signal — a chunk that says "head north and fight the boss" has no
    // tokens that link it to e.g. Final Fantasy VII for BM25, and the
    // embedding loses the same context. Prepending fixes both retrieval
    // paths in one shot.
    const composeIndexedContent = (gamePrefix: string, body: string): string =>
      gamePrefix ? `${gamePrefix}\n\n${body}` : body;

    const writeGuide = (loaded: Loaded, vectors: Float32Array[]): void => {
      const { guide, chunks, gamePrefix } = loaded;
      this.db.transaction(() => {
        // Cleanup is conditional on existing rows because vec0 can't push down
        // `chunk_id IN (subquery)` and would scan the whole embeddings table
        // otherwise (~400ms per guide at ~1M rows). For first-time indexing
        // (the common case) there are no rows to delete and we skip both
        // statements; for force/retry runs we delete by primary key one row
        // at a time, which is O(log n).
        const existing = selectExistingChunkIdsStmt.all(guide.id) as { id: string }[];
        if (existing.length > 0) {
          if (deleteEmbeddingByIdStmt) {
            for (const row of existing) {
              deleteEmbeddingByIdStmt.run(row.id);
            }
          }
          deleteChunksStmt.run(guide.id);
        }

        const now = Date.now();
        for (let i = 0; i < chunks.length; i++) {
          const c = chunks[i];
          const chunkId = nanoid();
          // Store the prefixed text in chunks.content so the chunks_fts_insert
          // trigger picks up the game prefix automatically. Excerpts shown to
          // users will include the "Game: X" line at the top — that doubles
          // as helpful citation context.
          const indexedContent = composeIndexedContent(gamePrefix, c.content);
          insertChunkStmt.run(chunkId, guide.id, c.index, indexedContent, c.charStart, c.charEnd, c.tokenCount, now);
          if (insertEmbeddingStmt) {
            insertEmbeddingStmt.run(chunkId, Buffer.from(vectors[i].buffer));
          }
        }
        updateIndexedAtStmt.run(now, guide.id);
      });
    };

    const recordFailure = (guideId: string, err: any): void => {
      // Mark indexed_at so the loop advances past this guide — otherwise the
      // next SELECT (in non-force mode without our id-cursor advance) would
      // return it again. To retry failures, run with ?force=true.
      this.progress.failedGuides++;
      console.error(`[Indexing] guide ${guideId} failed (marked, will not retry without force):`, err?.message ?? err);
      try {
        updateIndexedAtStmt.run(Date.now(), guideId);
      } catch (markErr: any) {
        throw new Error(
          `Indexer stuck on guide ${guideId}: could not mark as tried (${markErr.message}); aborting to avoid infinite loop`
        );
      }
    };

    // Embedding-side connection failures (Ollama down, DNS/refused, timeout)
    // are infrastructure problems, not per-guide problems — every subsequent
    // guide will hit the same wall and get falsely marked as failed. Detect
    // them so we can abort the run instead. Once the embedding service is
    // back, the indexer can be restarted and will pick up where it left off.
    const isEmbeddingUnreachable = (err: any): boolean => {
      if (!err) return false;
      const msg = String(err.message ?? err);
      if (msg.includes('fetch failed') || msg === 'TIMEOUT') return true;
      const code = err.cause?.code ?? err.code;
      return code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EAI_AGAIN';
    };

    try {
      let current = loadAndChunkNext();

      while (!this.stopRequested && current) {
        if (opts.limit && this.progress.processedGuides >= opts.limit) break;

        const { guide, chunks, gamePrefix } = current;

        this.progress.currentGuideId = guide.id;
        this.progress.currentGuideTitle = guide.title;
        this.progress.message = `Indexing: ${guide.title.slice(0, 60)}`;
        this.notify();

        // Kick off embedding for the current guide. Prefix every chunk with
        // the game header so the embedding carries game-specific signal —
        // mirrors what we store in chunks.content for FTS consistency.
        const embedPromise: Promise<Float32Array[]> = chunks.length === 0
          ? Promise.resolve([])
          : this.embeddings.embedBatch(
              chunks.map(c => composeIndexedContent(gamePrefix, c.content)),
              4
            );

        // While embeddings are in flight, load + chunk the NEXT guide. SELECT
        // and chunkGuide are synchronous, so the only real wall-clock cost
        // here is the SELECT row read; chunking happens during the network
        // wait for embedPromise. Deeper pipelines (>1 active embed) were
        // tested and didn't help — the Ollama runner is parallel=1 for
        // embedding models, so concurrent requests serialize at the GPU.
        let next: Loaded | null = null;
        try {
          next = loadAndChunkNext();
        } catch (err: any) {
          // Pre-fetching the next guide should never fail under normal
          // conditions, but if it does we don't want to lose the current
          // guide's in-flight work — fall through and try to finish current.
          console.error('[Indexing] prefetch failed:', err.message);
        }

        try {
          const vectors = await embedPromise;
          writeGuide(current, vectors);
          this.progress.totalChunks += chunks.length;
          this.progress.succeededGuides++;
        } catch (err: any) {
          if (isEmbeddingUnreachable(err)) {
            // Embedding service is gone — every subsequent guide will hit
            // the same wall and get falsely marked as failed. Abort the run
            // so the user can restart once Ollama is back. Guide N+1 has
            // already been loaded but no embed was kicked off, so nothing to
            // drain.
            throw new Error(
              `Embedding service unreachable (${err.message ?? err}). Aborting; restart the indexer once Ollama is healthy. Guide ${guide.id} was NOT marked.`
            );
          }
          recordFailure(guide.id, err);
        }

        this.progress.processedGuides++;
        this.progress.message = `${this.progress.processedGuides} processed (${this.progress.succeededGuides} ok, ${this.progress.failedGuides} failed)`;
        this.notify();

        current = next;

        // Yield to event loop
        await new Promise(resolve => setImmediate(resolve));
      }

      if (!current && !this.stopRequested && !(opts.limit && this.progress.processedGuides >= opts.limit)) {
        this.progress.status = 'complete';
        this.progress.message = `Indexing complete: ${this.progress.succeededGuides} succeeded, ${this.progress.failedGuides} failed`;
        this.progress.currentGuideId = undefined;
        this.progress.currentGuideTitle = undefined;
        this.notify();
        console.log('[Indexing] complete');
        return;
      }

      if (this.stopRequested) {
        this.progress.status = 'idle';
        this.progress.message = 'Stopped';
        this.progress.currentGuideId = undefined;
        this.progress.currentGuideTitle = undefined;
        this.notify();
        console.log('[Indexing] stopped by user');
      } else {
        // limit reached
        this.progress.status = 'complete';
        this.progress.message = `Indexing complete (limit reached): ${this.progress.succeededGuides} ok, ${this.progress.failedGuides} failed`;
        this.notify();
      }
    } catch (err: any) {
      this.progress.status = 'error';
      this.progress.error = err.message;
      this.progress.message = `Error: ${err.message}`;
      this.notify();
      console.error('[Indexing] fatal error:', err);
    }
  }

  private notify(): void {
    const snapshot = this.getProgress();
    for (const cb of this.listeners) {
      try {
        cb(snapshot);
      } catch (err) {
        console.error('[Indexing] listener error:', err);
      }
    }
  }
}
