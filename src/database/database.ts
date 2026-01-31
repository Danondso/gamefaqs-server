import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { CREATE_TABLES, CREATE_INDEXES, FULL_TEXT_SEARCH } from './schema';
import { runMigrations, getCurrentVersion } from './migrations';

class DatabaseService {
  private db: Database.Database | null = null;

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

    // Apply schema
    this.applySchema();

    console.log('[Database] Initialized successfully');
  }

  private applySchema(): void {
    if (!this.db) throw new Error('Database not initialized');

    // Run migrations (handles both new and existing databases)
    runMigrations(this.db);

    console.log('[Database] Schema applied');
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
      console.log('[Database] Connection closed');
    }
  }

  getDb(): Database.Database {
    if (!this.db) throw new Error('Database not initialized');
    return this.db;
  }
}

export default new DatabaseService();
