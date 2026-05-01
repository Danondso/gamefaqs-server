import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { CREATE_TABLES, CREATE_INDEXES, FULL_TEXT_SEARCH } from './schema';
import { runMigrations } from './migrations';
import type { IDatabase } from '../interfaces/IDatabase';
import { config } from '../config';

export class DatabaseService implements IDatabase {
  private db: Database.Database | null = null;
  vectorSearchAvailable = false;

  initialize(dbPath: string): void {
    // Ensure directory exists
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    // Open database connection
    this.db = new Database(dbPath, {
      verbose: process.env.NODE_ENV === 'development' ? console.log : undefined,
    });

    // Enable foreign keys
    this.db.pragma('foreign_keys = ON');

    // WAL mode: better for large imports, reduces peak disk usage
    this.db.pragma('journal_mode = WAL');

    // Sized for a 13 GB-RAM host that also runs Ollama and other containers.
    // cache_size is committed-ish memory: 256 MiB keeps the FTS5/vec0 insertion
    // hotspots resident during indexing without crowding Ollama. mmap_size is
    // a *ceiling*, not an allocation — SQLite only pages in what it touches
    // and the kernel reclaims unused mappings under memory pressure, so 2 GiB
    // is safe even with limited RAM. temp_store=MEMORY keeps temp sorts/joins
    // in RAM.
    this.db.pragma('cache_size = -262144');      // 256 MiB
    this.db.pragma('mmap_size = 2147483648');    // 2 GiB ceiling
    this.db.pragma('temp_store = MEMORY');

    // Best-effort load of sqlite-vec for vector search (must run before migrations
    // so v5 can decide whether to create the chunk_embeddings vec0 virtual table)
    this.loadVectorExtension();

    // Apply schema
    this.applySchema();

    console.log('[Database] Initialized successfully');
  }

  initializeInMemory(): void {
    // Open in-memory database
    this.db = new Database(':memory:', {
      verbose: process.env.NODE_ENV === 'development' ? console.log : undefined,
    });

    // Enable foreign keys
    this.db.pragma('foreign_keys = ON');

    this.loadVectorExtension();

    // Apply schema
    this.applySchema();

    // In-memory databases don't log by default in tests
    if (process.env.NODE_ENV !== 'test') {
      console.log('[Database] Initialized in-memory database');
    }
  }

  private loadVectorExtension(): void {
    if (!this.db) return;
    if (!config.vectorSearchEnabled) {
      this.vectorSearchAvailable = false;
      return;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sqliteVec = require('sqlite-vec');
      sqliteVec.load(this.db);
      this.vectorSearchAvailable = true;
      if (process.env.NODE_ENV !== 'test') {
        console.log('[Database] sqlite-vec extension loaded');
      }
    } catch (err: any) {
      this.vectorSearchAvailable = false;
      if (process.env.NODE_ENV !== 'test') {
        console.warn('[Database] sqlite-vec failed to load, vector search disabled:', err.message);
      }
    }
  }

  private applySchema(): void {
    if (!this.db) throw new Error('Database not initialized');

    // Run migrations (handles both new and existing databases)
    runMigrations(this.db, { vectorSearchAvailable: this.vectorSearchAvailable });

    if (process.env.NODE_ENV !== 'test') {
      console.log('[Database] Schema applied');
    }
  }

  query<T = any>(sql: string, params: any[] = []): T[] {
    if (!this.db) throw new Error('Database not initialized');
    return this.db.prepare(sql).all(...params) as T[];
  }

  get<T = any>(sql: string, params: any[] = []): T | undefined {
    if (!this.db) throw new Error('Database not initialized');
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  run(sql: string, params: any[] = []): { changes: number; lastInsertRowid: number | bigint } {
    if (!this.db) throw new Error('Database not initialized');
    return this.db.prepare(sql).run(...params);
  }

  transaction<T>(fn: () => T): T {
    if (!this.db) throw new Error('Database not initialized');
    return this.db.transaction(fn)();
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      if (process.env.NODE_ENV !== 'test') {
        console.log('[Database] Connection closed');
      }
    }
  }

  getDb(): Database.Database {
    if (!this.db) throw new Error('Database not initialized');
    return this.db;
  }
}

// Factory function for creating database instances (for testing)
export function createDatabase(): IDatabase {
  return new DatabaseService();
}

// Default singleton instance for backward compatibility
export default new DatabaseService();
