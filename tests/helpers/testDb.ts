import { createDatabase } from '../../src/database/database';
import type { IDatabase } from '../../src/interfaces/IDatabase';

/**
 * Creates a fresh in-memory database for testing.
 * Each call returns a new isolated database instance.
 */
export function createTestDatabase(): IDatabase {
  const db = createDatabase();
  db.initializeInMemory();
  return db;
}

/**
 * Creates a test database and returns it along with a cleanup function.
 */
export function createTestDatabaseWithCleanup(): { db: IDatabase; cleanup: () => void } {
  const db = createTestDatabase();
  return {
    db,
    cleanup: () => db.close(),
  };
}
