import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { CREATE_TABLES, CREATE_INDEXES, FULL_TEXT_SEARCH } from './schema';
import { runMigrations } from './migrations';
import type { IDatabase } from '../interfaces/IDatabase';
import { config } from '../config';
import { AnnIndex } from '../services/AnnIndex';

export class DatabaseService implements IDatabase {
  private db: Database.Database | null = null;
  annIndex: AnnIndex | null = null;

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

    // Apply schema
    this.applySchema();

    // Open the ANN index. Loads from `${dbPath}.ann` if it exists, otherwise
    // starts empty and grows as the indexer adds chunks. Vectors live in
    // this file, not in SQLite — there is no v2-table fallback.
    this.openAnnIndex(dbPath);

    console.log('[Database] Initialized successfully');
  }

  private openAnnIndex(dbPath: string): void {
    if (!this.db) return;
    const file = config.annIndexPath || `${dbPath}.ann`;
    const ann = new AnnIndex({
      dim: config.embeddingDim,
      file,
      M: config.annM,
      efAdd: config.annEfAdd,
      efSearch: config.annEfSearch,
    });

    if (ann.load()) {
      console.log(`[Database] ANN index loaded from ${file} (size=${ann.size().toLocaleString()})`);
    } else {
      console.log(`[Database] ANN index file missing at ${file}; starting empty (indexer will populate)`);
    }
    this.annIndex = ann;
  }

  initializeInMemory(): void {
    // Open in-memory database
    this.db = new Database(':memory:', {
      verbose: process.env.NODE_ENV === 'development' ? console.log : undefined,
    });

    // Enable foreign keys
    this.db.pragma('foreign_keys = ON');

    // Apply schema
    this.applySchema();

    // In-memory databases get an empty in-memory ANN index. Tests that need
    // vector search add vectors via annIndex.add(); no file IO.
    this.annIndex = new AnnIndex({
      dim: config.embeddingDim,
      file: '/dev/null', // never saved for in-memory
      M: config.annM,
      efAdd: config.annEfAdd,
      efSearch: config.annEfSearch,
    });

    // In-memory databases don't log by default in tests
    if (process.env.NODE_ENV !== 'test') {
      console.log('[Database] Initialized in-memory database');
    }
  }

  private applySchema(): void {
    if (!this.db) throw new Error('Database not initialized');

    // Run migrations (handles both new and existing databases)
    runMigrations(this.db);

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
    if (this.annIndex) {
      try {
        if (this.annIndex.saveIfDirty()) {
          if (process.env.NODE_ENV !== 'test') console.log('[Database] ANN index saved on close');
        }
      } catch (err: any) {
        console.error('[Database] ANN save on close failed:', err.message);
      }
      this.annIndex = null;
    }
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
