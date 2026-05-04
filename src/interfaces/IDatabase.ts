import type Database from 'better-sqlite3';
import type { AnnIndex } from '../services/AnnIndex';

export interface IDatabase {
  initialize(dbPath: string): void;
  initializeInMemory(): void;
  query<T = any>(sql: string, params?: any[]): T[];
  get<T = any>(sql: string, params?: any[]): T | undefined;
  run(sql: string, params?: any[]): { changes: number; lastInsertRowid: number | bigint };
  transaction<T>(fn: () => T): T;
  close(): void;
  getDb(): Database.Database;
  // ANN index for vector search. Populated after initialize(); never null
  // on the production path (the server refuses to start if usearch fails to
  // load, since vector retrieval is not optional).
  annIndex: AnnIndex | null;
}
