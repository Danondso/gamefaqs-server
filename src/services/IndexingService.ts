// Background indexer: walks guides where indexed_at IS NULL, chunks them,
// embeds the chunks, and writes the chunks table inside a transaction per
// guide. Vector embeddings go to the ANN index (USearch HNSW i8) outside the
// SQL transaction; the index is checkpointed to disk every
// `ANN_SAVE_EVERY_GUIDES` guides and on shutdown. Resumable across restarts:
// guides with chunks but no indexed_at retry from scratch (DELETE + re-insert).

import { nanoid } from 'nanoid';
import { config } from '../config';
import DefaultDatabase from '../database/database';
import type { IDatabase } from '../interfaces/IDatabase';
import type { Guide } from '../types';
import { AnnIndex } from './AnnIndex';
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

    // chunks.rowid → ANN key. Fetched alongside the existing-chunks scan in
    // writeGuide(), so deletes hit the index by rowid in O(log n).
    const selectExistingChunkRowidsStmt = this.db.getDb().prepare(
      'SELECT rowid AS rowid, id AS id FROM chunks WHERE guide_id = ?'
    );
    const ann = this.db.annIndex;

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
    const selectGameStmt = this.db.getDb().prepare(
      'SELECT title, platform FROM games WHERE id = ?'
    );

    // Build the per-chunk prefix. The format is a single line so it lives
    // outside the natural prose flow but still tokenizes cleanly for both
    // FTS5 (BM25 picks up "Final Fantasy VII") and the embedding model
    // (gives chunks a strong "this is from <game>" signal). Empty prefix
    // disables prefixing for orphan guides.
    const lookupGameContext = (gameId: string | null): { prefix: string } => {
      if (!gameId) return { prefix: '' };
      const game = selectGameStmt.get(gameId) as { title: string; platform: string | null } | undefined;
      if (!game?.title) return { prefix: '' };
      const platform = game.platform ? ` (${game.platform})` : '';
      return { prefix: `Game: ${game.title}${platform}` };
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
      const { prefix: gamePrefix } = lookupGameContext(guide.game_id ?? null);
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
      // ANN updates run *outside* the SQL transaction. The ANN file isn't
      // part of the SQLite ACID story; the worst-case crash window leaves
      // ANN out of sync with chunks for the in-flight guide. Recovery: delete
      // the .ann file and the indexer will re-embed any chunks lacking a
      // corresponding ANN entry on the next run (paid via Ollama).
      const insertedRowids: number[] = [];

      this.db.transaction(() => {
        // For force/retry runs, drop the existing chunks AND remove their
        // ANN keys. ANN deletes happen here (still inside the txn boundary
        // for symmetry; if the SQL txn rolls back, we accept the temporary
        // ANN drift over a missed delete).
        const existing = selectExistingChunkRowidsStmt.all(guide.id) as { rowid: number; id: string }[];
        if (existing.length > 0) {
          if (ann) {
            for (const row of existing) {
              try { ann.remove(row.rowid); } catch (_e) { /* not in index — fine */ }
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
          const r = insertChunkStmt.run(chunkId, guide.id, c.index, indexedContent, c.charStart, c.charEnd, c.tokenCount, now);
          insertedRowids.push(Number(r.lastInsertRowid));
        }
        updateIndexedAtStmt.run(now, guide.id);
      });

      // ANN inserts after the SQL commit. If this throws, the SQL state is
      // consistent (chunks exist) but the ANN is missing the new chunks for
      // this guide — the next bootstrap (or a manual rebuild) will recover.
      if (ann && insertedRowids.length > 0) {
        for (let i = 0; i < insertedRowids.length; i++) {
          ann.add(insertedRowids[i], vectors[i]);
        }
      }
    };

    // Periodic ANN persistence. Saving the full ~3 GB index is ~2s of IO;
    // doing it every N guides bounds crash-recovery loss to ~N guides without
    // pegging the disk. Configurable via ANN_SAVE_EVERY_GUIDES.
    let guidesSinceSave = 0;
    const maybeSaveAnn = (): void => {
      if (!ann) return;
      if (guidesSinceSave < config.annSaveEveryGuides) return;
      try {
        if (ann.saveIfDirty()) {
          console.log(`[Indexing] saved ANN index (after ${guidesSinceSave} guides)`);
        }
      } catch (err: any) {
        console.error('[Indexing] ANN save failed (non-fatal):', err.message);
      }
      guidesSinceSave = 0;
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
          guidesSinceSave++;
          maybeSaveAnn();
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
        // Persist any pending ANN writes — server may run for a long time after
        // ingest finishes, and we don't want to lose them on a later crash.
        this.flushAnn();
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
      this.flushAnn();
    } catch (err: any) {
      this.progress.status = 'error';
      this.progress.error = err.message;
      this.progress.message = `Error: ${err.message}`;
      this.notify();
      console.error('[Indexing] fatal error:', err);
      this.flushAnn();
    }
  }

  private flushAnn(): void {
    const ann = this.db.annIndex;
    if (!ann) return;
    try {
      if (ann.saveIfDirty()) {
        console.log('[Indexing] saved ANN index (final flush)');
      }
    } catch (err: any) {
      console.error('[Indexing] ANN final save failed (non-fatal):', err.message);
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

  // Vector-only rebuild. Reads existing chunks.content from SQLite (no DELETE,
  // no UPDATE, no chunk re-creation), embeds via the configured EmbeddingService,
  // and writes vectors to a separate AnnIndex file at `opts.annPath`. Used for
  // model-swap A/B and full re-embed cutover — see DEBUG-ann-recall.md and
  // /home/dublin/.claude/plans/make-a-plan-to-parallel-hartmanis.md.
  //
  // The side ANN never replaces this.db.annIndex; the live retrieval path is
  // unaffected until an operator manually swaps the file. SQL state is only
  // read, so this is safe to run while the live server is up.
  async rebuildVectors(opts: {
    annPath: string;
    dim: number;
    guideIds?: string[];
    saveEveryGuides?: number;
    onProgress?: (p: { processedGuides: number; totalGuides: number; processedChunks: number; failedGuides: number; currentGuide?: string }) => void;
  }): Promise<{ processedGuides: number; processedChunks: number; failedGuides: number; durationMs: number; annPath: string }> {
    const saveEvery = opts.saveEveryGuides ?? config.annSaveEveryGuides;
    const startedAt = Date.now();

    if (this.embeddings.getDim() !== opts.dim) {
      throw new Error(
        `rebuildVectors: EmbeddingService dim=${this.embeddings.getDim()} but opts.dim=${opts.dim}. ` +
        `Construct the EmbeddingService with the same dim as the target ANN.`
      );
    }

    // Open the side ANN. The dim guard in AnnIndex.load() throws if the file
    // exists with a different dim — desired behavior, prevents clobbering.
    const ann = new AnnIndex({
      dim: opts.dim,
      file: opts.annPath,
      M: config.annM,
      efAdd: config.annEfAdd,
      efSearch: config.annEfSearch,
    });
    if (ann.load()) {
      console.log(`[VecRebuild] resumed ${opts.annPath} (size=${ann.size().toLocaleString()})`);
    } else {
      console.log(`[VecRebuild] starting fresh at ${opts.annPath}`);
    }

    // Resolve the guide list. Filter mode = explicit subset (Stage 1 / Stage 2);
    // unfiltered = every guide that has chunks (Stage 3).
    let guideIds: string[];
    if (opts.guideIds) {
      guideIds = [...opts.guideIds];
    } else {
      // indexed_at IS NOT NULL is the indexer's "has chunks" marker. Order by
      // id so resumes are deterministic.
      const rows = this.db.query<{ id: string }>(
        'SELECT id FROM guides WHERE indexed_at IS NOT NULL ORDER BY id'
      );
      guideIds = rows.map(r => r.id);
    }
    const totalGuides = guideIds.length;
    console.log(`[VecRebuild] ${totalGuides.toLocaleString()} guides to embed`);

    const selectChunksStmt = this.db.getDb().prepare(
      'SELECT rowid AS rowid, content AS content FROM chunks WHERE guide_id = ? ORDER BY chunk_index'
    );
    const selectGuideTitleStmt = this.db.getDb().prepare(
      'SELECT title FROM guides WHERE id = ?'
    );

    let processedGuides = 0;
    let processedChunks = 0;
    let failedGuides = 0;
    let guidesSinceSave = 0;

    const isUnreachable = (err: any): boolean => {
      if (!err) return false;
      const msg = String(err.message ?? err);
      if (msg.includes('fetch failed') || msg === 'TIMEOUT') return true;
      const code = err.cause?.code ?? err.code;
      return code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EAI_AGAIN';
    };

    for (const guideId of guideIds) {
      const chunks = selectChunksStmt.all(guideId) as Array<{ rowid: number; content: string }>;
      if (chunks.length === 0) {
        processedGuides++;
        continue;
      }

      const titleRow = selectGuideTitleStmt.get(guideId) as { title?: string } | undefined;

      try {
        const vectors = await this.embeddings.embedBatch(chunks.map(c => c.content), 4);
        for (let i = 0; i < chunks.length; i++) {
          // If a rowid is already in the index (resume after crash), USearch
          // throws on duplicate add. Remove first; cheap when not present.
          try { ann.remove(chunks[i].rowid); } catch (_e) { /* not present */ }
          ann.add(chunks[i].rowid, vectors[i]);
        }
        processedChunks += chunks.length;
        processedGuides++;
        guidesSinceSave++;

        if (guidesSinceSave >= saveEvery) {
          if (ann.saveIfDirty()) {
            console.log(`[VecRebuild] saved ANN (${processedGuides}/${totalGuides} guides, ${processedChunks.toLocaleString()} chunks)`);
          }
          guidesSinceSave = 0;
        }
      } catch (err: any) {
        if (isUnreachable(err)) {
          // Save what we have so resume is meaningful, then bail.
          try { ann.saveIfDirty(); } catch (_e) { /* best-effort */ }
          throw new Error(
            `Embedding service unreachable (${err.message ?? err}). Saved partial ANN at ${opts.annPath}; rerun to resume from this guide.`
          );
        }
        failedGuides++;
        processedGuides++;
        console.error(`[VecRebuild] guide ${guideId} (${titleRow?.title ?? '?'}) failed: ${err.message ?? err}`);
      }

      if (opts.onProgress) {
        opts.onProgress({
          processedGuides,
          totalGuides,
          processedChunks,
          failedGuides,
          currentGuide: titleRow?.title,
        });
      }
    }

    // Final flush so the file on disk reflects the complete run.
    try {
      if (ann.saveIfDirty()) {
        console.log(`[VecRebuild] final save (${processedGuides} guides, ${processedChunks.toLocaleString()} chunks)`);
      }
    } catch (err: any) {
      console.error(`[VecRebuild] final save failed: ${err.message}`);
      throw err;
    }

    return {
      processedGuides,
      processedChunks,
      failedGuides,
      durationMs: Date.now() - startedAt,
      annPath: opts.annPath,
    };
  }
}
