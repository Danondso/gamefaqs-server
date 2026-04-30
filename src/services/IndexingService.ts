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
  totalGuides: number;
  processedGuides: number;
  succeededGuides: number;
  failedGuides: number;
  totalChunks: number;
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
    return { ...this.progress };
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
    const deleteEmbeddingsStmt = this.db.vectorSearchAvailable
      ? this.db.getDb().prepare('DELETE FROM chunk_embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE guide_id = ?)')
      : null;

    try {
      while (!this.stopRequested) {
        if (opts.limit && this.progress.processedGuides >= opts.limit) break;

        const guide = this.db.get<Guide>(
          opts.force
            ? 'SELECT * FROM guides ORDER BY id LIMIT 1 OFFSET ?'
            : 'SELECT * FROM guides WHERE indexed_at IS NULL LIMIT 1',
          opts.force ? [this.progress.processedGuides] : []
        );

        if (!guide) {
          this.progress.status = 'complete';
          this.progress.message = `Indexing complete: ${this.progress.succeededGuides} succeeded, ${this.progress.failedGuides} failed`;
          this.progress.currentGuideId = undefined;
          this.progress.currentGuideTitle = undefined;
          this.notify();
          console.log('[Indexing] complete');
          return;
        }

        this.progress.currentGuideId = guide.id;
        this.progress.currentGuideTitle = guide.title;
        this.progress.message = `Indexing: ${guide.title.slice(0, 60)}`;
        this.notify();

        try {
          const chunks = chunkGuide(guide.content, {
            chunkSizeTokens: config.chunkSizeTokens,
            chunkOverlapTokens: config.chunkOverlapTokens,
          });

          if (chunks.length === 0) {
            // Nothing to index, but mark indexed so we don't retry forever.
            this.db.transaction(() => {
              deleteEmbeddingsStmt?.run(guide.id);
              deleteChunksStmt.run(guide.id);
              updateIndexedAtStmt.run(Date.now(), guide.id);
            });
            this.progress.succeededGuides++;
          } else {
            const vectors = await this.embeddings.embedBatch(chunks.map(c => c.content), 4);

            this.db.transaction(() => {
              deleteEmbeddingsStmt?.run(guide.id);
              deleteChunksStmt.run(guide.id);
              const now = Date.now();
              for (let i = 0; i < chunks.length; i++) {
                const c = chunks[i];
                const chunkId = nanoid();
                insertChunkStmt.run(chunkId, guide.id, c.index, c.content, c.charStart, c.charEnd, c.tokenCount, now);
                if (insertEmbeddingStmt) {
                  insertEmbeddingStmt.run(chunkId, Buffer.from(vectors[i].buffer));
                }
              }
              updateIndexedAtStmt.run(now, guide.id);
            });

            this.progress.totalChunks += chunks.length;
            this.progress.succeededGuides++;
          }
        } catch (err: any) {
          // Embedding or DB write failed for this guide. Record + continue.
          // Mark indexed_at so the loop advances past this guide — otherwise
          // SELECT WHERE indexed_at IS NULL LIMIT 1 returns the same broken
          // guide every iteration and the indexer infinite-loops. To retry
          // failures, run with ?force=true.
          this.progress.failedGuides++;
          console.error(`[Indexing] guide ${guide.id} failed (marked, will not retry without force):`, err.message);
          try {
            updateIndexedAtStmt.run(Date.now(), guide.id);
          } catch (markErr: any) {
            console.error(`[Indexing] could not mark ${guide.id} as tried:`, markErr.message);
          }
        }

        this.progress.processedGuides++;
        this.progress.message = `${this.progress.processedGuides} processed (${this.progress.succeededGuides} ok, ${this.progress.failedGuides} failed)`;
        this.notify();

        // Yield to event loop
        await new Promise(resolve => setImmediate(resolve));
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
