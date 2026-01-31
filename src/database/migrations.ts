import Database from 'better-sqlite3';
import { CREATE_TABLES, CREATE_INDEXES, FULL_TEXT_SEARCH, SCHEMA_VERSION } from './schema';

export interface Migration {
  version: number;
  up: (db: Database.Database) => void;
  down?: (db: Database.Database) => void;
}

// Migration v1: Initial schema
const migration_v1: Migration = {
  version: 1,
  up: (db: Database.Database) => {
    // Create all tables
    Object.values(CREATE_TABLES).forEach(sql => {
      db.exec(sql);
    });

    // Create indexes
    Object.values(CREATE_INDEXES).forEach(sql => {
      db.exec(sql);
    });

    // Create split FTS5 tables and triggers
    // - guides_fts_meta: title + tags (small, fast updates)
    // - guides_fts_content: content only (large, rarely updated)
    db.exec(FULL_TEXT_SEARCH.guides_fts_meta);
    db.exec(FULL_TEXT_SEARCH.guides_fts_content);
    db.exec(FULL_TEXT_SEARCH.guides_fts_meta_insert);
    db.exec(FULL_TEXT_SEARCH.guides_fts_content_insert);
    db.exec(FULL_TEXT_SEARCH.guides_fts_meta_update);
    db.exec(FULL_TEXT_SEARCH.guides_fts_content_update);
    db.exec(FULL_TEXT_SEARCH.guides_fts_meta_delete);
    db.exec(FULL_TEXT_SEARCH.guides_fts_content_delete);

    // Record schema version
    db.exec(`INSERT INTO schema_version (version, applied_at) VALUES (1, ${Date.now()})`);
  },
  down: (db: Database.Database) => {
    // Drop triggers first
    db.exec('DROP TRIGGER IF EXISTS guides_fts_delete');
    db.exec('DROP TRIGGER IF EXISTS guides_fts_update');
    db.exec('DROP TRIGGER IF EXISTS guides_fts_insert');

    // Drop FTS table
    db.exec('DROP TABLE IF EXISTS guides_fts');

    // Drop tables in reverse order (respecting foreign keys)
    db.exec('DROP TABLE IF EXISTS achievements');
    db.exec('DROP TABLE IF EXISTS notes');
    db.exec('DROP TABLE IF EXISTS bookmarks');
    db.exec('DROP TABLE IF EXISTS guides');
    db.exec('DROP TABLE IF EXISTS games');
    db.exec('DROP TABLE IF EXISTS schema_version');
  },
};

// Migration v2: Fix FTS5 trigger to not re-index on metadata-only updates
// Note: This is now a no-op since v1 creates the optimized triggers directly
const migration_v2: Migration = {
  version: 2,
  up: (db: Database.Database) => {
    // Original migration dropped and recreated guides_fts_update with WHEN clause
    // Since we now use split triggers (title/content) from v1, this is a no-op
    db.exec(`INSERT INTO schema_version (version, applied_at) VALUES (2, ${Date.now()})`);
  },
};

// Migration v3-v5: Legacy migrations (superseded by v6)
// These are kept for version tracking but are no-ops since v6 does a full rebuild
const migration_v3: Migration = {
  version: 3,
  up: (db: Database.Database) => {
    db.exec(`INSERT INTO schema_version (version, applied_at) VALUES (3, ${Date.now()})`);
  },
};

const migration_v4: Migration = {
  version: 4,
  up: (db: Database.Database) => {
    db.exec(`INSERT INTO schema_version (version, applied_at) VALUES (4, ${Date.now()})`);
  },
};

const migration_v5: Migration = {
  version: 5,
  up: (db: Database.Database) => {
    db.exec(`INSERT INTO schema_version (version, applied_at) VALUES (5, ${Date.now()})`);
  },
};

// Migration v6: Split FTS into two tables for fast metadata updates
// - guides_fts_meta: title + tags (small, fast to update)
// - guides_fts_content: content only (large, only updated on insert/content change)
const migration_v6: Migration = {
  version: 6,
  up: (db: Database.Database) => {
    console.log('[Migration v6] Splitting FTS into meta + content tables...');

    // Drop all old triggers
    db.exec('DROP TRIGGER IF EXISTS guides_fts_insert');
    db.exec('DROP TRIGGER IF EXISTS guides_fts_update');
    db.exec('DROP TRIGGER IF EXISTS guides_fts_update_title');
    db.exec('DROP TRIGGER IF EXISTS guides_fts_update_content');
    db.exec('DROP TRIGGER IF EXISTS guides_fts_update_tags');
    db.exec('DROP TRIGGER IF EXISTS guides_fts_delete');

    // Drop old FTS table
    db.exec('DROP TABLE IF EXISTS guides_fts');

    // Create new split FTS tables
    db.exec(FULL_TEXT_SEARCH.guides_fts_meta);
    db.exec(FULL_TEXT_SEARCH.guides_fts_content);

    // Populate meta FTS from guides
    console.log('[Migration v6] Populating meta FTS index...');
    db.exec(`
      INSERT INTO guides_fts_meta(guide_id, title, tags)
      SELECT
        id,
        title,
        COALESCE(json_extract(metadata, '$.tags'), '')
      FROM guides
    `);

    // Populate content FTS from guides
    console.log('[Migration v6] Populating content FTS index (this may take a while)...');
    db.exec(`
      INSERT INTO guides_fts_content(guide_id, content)
      SELECT id, content FROM guides
    `);

    // Create new triggers
    db.exec(FULL_TEXT_SEARCH.guides_fts_meta_insert);
    db.exec(FULL_TEXT_SEARCH.guides_fts_content_insert);
    db.exec(FULL_TEXT_SEARCH.guides_fts_meta_update);
    db.exec(FULL_TEXT_SEARCH.guides_fts_content_update);
    db.exec(FULL_TEXT_SEARCH.guides_fts_meta_delete);
    db.exec(FULL_TEXT_SEARCH.guides_fts_content_delete);

    db.exec(`INSERT INTO schema_version (version, applied_at) VALUES (6, ${Date.now()})`);
    console.log('[Migration v6] FTS split complete - metadata updates are now instant');
  },
};

// Migration v7: Add ai_analyzed_at column for fast querying
const migration_v7: Migration = {
  version: 7,
  up: (db: Database.Database) => {
    console.log('[Migration v7] Adding ai_analyzed_at column to guides table...');

    // Add the column
    db.exec(`ALTER TABLE guides ADD COLUMN ai_analyzed_at INTEGER DEFAULT NULL`);

    // Create index for fast "find unanalyzed" queries
    db.exec(`CREATE INDEX IF NOT EXISTS idx_guides_ai_analyzed_at ON guides(ai_analyzed_at)`);

    db.exec(`INSERT INTO schema_version (version, applied_at) VALUES (7, ${Date.now()})`);
    console.log('[Migration v7] ai_analyzed_at column added with index');
  },
};

// All migrations in order
export const migrations: Migration[] = [migration_v1, migration_v2, migration_v3, migration_v4, migration_v5, migration_v6, migration_v7];

// Get current schema version from database
export function getCurrentVersion(db: Database.Database): number {
  try {
    const result = db.prepare(
      'SELECT version FROM schema_version ORDER BY version DESC LIMIT 1'
    ).get() as { version: number } | undefined;
    return result?.version ?? 0;
  } catch (error) {
    // Table doesn't exist yet
    return 0;
  }
}

// Run all pending migrations
export function runMigrations(db: Database.Database): void {
  const currentVersion = getCurrentVersion(db);

  console.log(`[Migrations] Current database version: ${currentVersion}`);
  console.log(`[Migrations] Target database version: ${SCHEMA_VERSION}`);

  if (currentVersion === SCHEMA_VERSION) {
    console.log('[Migrations] Database is up to date');
    return;
  }

  if (currentVersion > SCHEMA_VERSION) {
    throw new Error(
      `Database version (${currentVersion}) is higher than app version (${SCHEMA_VERSION}). Please update the app.`
    );
  }

  // Run migrations
  const pendingMigrations = migrations.filter(m => m.version > currentVersion);

  console.log(`[Migrations] Running ${pendingMigrations.length} migration(s)...`);

  pendingMigrations.forEach(migration => {
    console.log(`[Migrations] Applying migration v${migration.version}...`);
    try {
      migration.up(db);
      console.log(`[Migrations] Migration v${migration.version} applied successfully`);
    } catch (error) {
      console.error(`[Migrations] Failed to apply migration v${migration.version}:`, error);
      throw error;
    }
  });

  console.log('[Migrations] All migrations completed successfully');
}

// Rollback to a specific version (for development/testing)
export function rollbackTo(db: Database.Database, targetVersion: number): void {
  const currentVersion = getCurrentVersion(db);

  if (targetVersion >= currentVersion) {
    console.log('[Migrations] Nothing to rollback');
    return;
  }

  const migrationsToRollback = migrations
    .filter(m => m.version > targetVersion && m.version <= currentVersion)
    .reverse();

  console.log(`[Migrations] Rolling back ${migrationsToRollback.length} migration(s)...`);

  migrationsToRollback.forEach(migration => {
    if (!migration.down) {
      throw new Error(`Migration v${migration.version} does not have a rollback function`);
    }
    console.log(`[Migrations] Rolling back migration v${migration.version}...`);
    migration.down(db);
  });

  // Update version
  db.exec(`DELETE FROM schema_version WHERE version > ${targetVersion}`);

  console.log(`[Migrations] Rolled back to version ${targetVersion}`);
}
