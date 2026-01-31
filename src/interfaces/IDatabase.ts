import type Database from 'better-sqlite3';

export interface IDatabase {
  initialize(dbPath: string): void;
  initializeInMemory(): void;
  query<T = any>(sql: string, params?: any[]): T[];
  get<T = any>(sql: string, params?: any[]): T | undefined;
  run(sql: string, params?: any[]): { changes: number; lastInsertRowid: number | bigint };
  transaction<T>(fn: () => T): T;
  close(): void;
  getDb(): Database.Database;
}
