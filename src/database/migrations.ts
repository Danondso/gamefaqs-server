import Database from 'better-sqlite3';
import { CREATE_TABLES, CREATE_INDEXES, FULL_TEXT_SEARCH, FILTER_LOOKUP_TRIGGERS, RAG_DDL, GAMES_FTS_DDL, SCHEMA_VERSION } from './schema';

export interface Migration {
  version: number;
  up: (db: Database.Database) => void;
  down?: (db: Database.Database) => void;
}

// Title-relabel CASE for migration v5. Evaluated against `g` (guides row) and
// `gm` (joined games row): returns `${gm.title} — ${author}` when the author
// passes the cleanliness filter, otherwise `${gm.title}`.
//
// IMPORTANT: must stay in sync with cleanAuthor() in GuideImporter.ts. The
// `cleanAuthor` parity test in tests/cleanAuthorParity.test.ts evaluates this
// SQL against the JS implementation across a parameter table to catch drift.
export const TITLE_RELABEL_CASE_SQL = `CASE
            WHEN json_extract(g.metadata, '$.author') IS NOT NULL
              AND LENGTH(TRIM(json_extract(g.metadata, '$.author'))) BETWEEN 2 AND 60
              AND instr(json_extract(g.metadata, '$.author'), char(10)) = 0
              AND instr(json_extract(g.metadata, '$.author'), '|') = 0
              AND instr(json_extract(g.metadata, '$.author'), '=') = 0
              AND instr(json_extract(g.metadata, '$.author'), '>') = 0
              AND (LENGTH(TRIM(json_extract(g.metadata, '$.author')))
                   - LENGTH(REPLACE(TRIM(json_extract(g.metadata, '$.author')), ' ', ''))) <= 5
            THEN gm.title || ' — ' || TRIM(json_extract(g.metadata, '$.author'))
            ELSE gm.title
          END`;

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

// Migration v2: Add missing updated_at index for pagination performance
const migration_v2: Migration = {
  version: 2,
  up: (db: Database.Database) => {
    // Add index on updated_at for ORDER BY updated_at DESC queries (pagination)
    db.exec('CREATE INDEX IF NOT EXISTS idx_guides_updated_at ON guides(updated_at);');
    db.exec(`INSERT INTO schema_version (version, applied_at) VALUES (2, ${Date.now()})`);
  },
  down: (db: Database.Database) => {
    db.exec('DROP INDEX IF EXISTS idx_guides_updated_at');
    db.exec('DELETE FROM schema_version WHERE version = 2');
  },
};

// Migration v3: Add indexes for platform filtering
const migration_v3: Migration = {
  version: 3,
  up: (db: Database.Database) => {
    // Add index on guides metadata platform for filtering
    db.exec("CREATE INDEX IF NOT EXISTS idx_guides_metadata_platform ON guides(json_extract(metadata, '$.platform'));");
    // Add index on games platform for filtering
    db.exec('CREATE INDEX IF NOT EXISTS idx_games_platform ON games(platform);');
    db.exec(`INSERT INTO schema_version (version, applied_at) VALUES (3, ${Date.now()})`);
  },
  down: (db: Database.Database) => {
    db.exec('DROP INDEX IF EXISTS idx_guides_metadata_platform');
    db.exec('DROP INDEX IF EXISTS idx_games_platform');
    db.exec('DELETE FROM schema_version WHERE version = 3');
  },
};

// Migration v4: Add denormalized lookup tables for fast filter queries
const migration_v4: Migration = {
  version: 4,
  up: (db: Database.Database) => {
    console.log('[Migrations] Creating filter lookup tables...');

    // Create guide_tags and guide_platforms tables
    db.exec(CREATE_TABLES.guide_tags);
    db.exec(CREATE_TABLES.guide_platforms);

    // Create index for tag lookups
    db.exec(CREATE_INDEXES.guide_tags_tag);

    // Populate guide_tags from existing data
    console.log('[Migrations] Populating guide_tags from existing guides...');
    db.exec(`
      INSERT OR IGNORE INTO guide_tags (guide_id, tag)
      SELECT g.id, j.value
      FROM guides g, json_each(json_extract(g.metadata, '$.tags')) j
      WHERE json_extract(g.metadata, '$.tags') IS NOT NULL
    `);

    // Populate guide_platforms from existing data
    console.log('[Migrations] Populating guide_platforms from existing guides...');
    db.exec(`
      INSERT OR IGNORE INTO guide_platforms (platform)
      SELECT DISTINCT json_extract(metadata, '$.platform')
      FROM guides
      WHERE json_extract(metadata, '$.platform') IS NOT NULL
    `);

    // Create triggers to maintain lookup tables
    db.exec(FILTER_LOOKUP_TRIGGERS.guide_tags_insert);
    db.exec(FILTER_LOOKUP_TRIGGERS.guide_platforms_insert);
    db.exec(FILTER_LOOKUP_TRIGGERS.guide_tags_update);
    db.exec(FILTER_LOOKUP_TRIGGERS.guide_platforms_update);

    db.exec(`INSERT INTO schema_version (version, applied_at) VALUES (4, ${Date.now()})`);
    console.log('[Migrations] Filter lookup tables created and populated');
  },
  down: (db: Database.Database) => {
    db.exec('DROP TRIGGER IF EXISTS guide_tags_insert');
    db.exec('DROP TRIGGER IF EXISTS guide_platforms_insert');
    db.exec('DROP TRIGGER IF EXISTS guide_tags_update');
    db.exec('DROP TRIGGER IF EXISTS guide_platforms_update');
    db.exec('DROP TABLE IF EXISTS guide_tags');
    db.exec('DROP TABLE IF EXISTS guide_platforms');
    db.exec('DELETE FROM schema_version WHERE version = 4');
  },
};

// Migration v5: RAG bring-up + title relabel. Adds chunks table, chunk FTS,
// fts5vocab views for rare-token filtering, the indexer's per-guide
// checkpoint column with its composite cursor index, the games_fts virtual
// table for direct game-name lookup at retrieval time, and relabels existing
// guide titles to the linked game's name (the parser's content-extracted
// title is unreliable — banners and bylines slip through). Vectors live in
// the ANN file (`${dbPath}.ann`, see AnnIndex), not in SQLite.
//
// The relabel UPDATE is idempotent: rows with metadata.original_title set
// are skipped, so this is safe on fresh DBs (zero rows match) and on
// already-relabeled DBs.
const migration_v5: Migration = {
  version: 5,
  up: (db: Database.Database) => {
    console.log('[Migrations] Applying RAG schema, games_fts, and title relabel...');

    db.exec('ALTER TABLE guides ADD COLUMN indexed_at INTEGER');
    // Composite (indexed_at, id) serves both `indexed_at IS NULL` filtering
    // and the indexer's `ORDER BY id` cursor — no separate single-column
    // index needed.
    db.exec('CREATE INDEX IF NOT EXISTS idx_guides_indexed_at_id ON guides(indexed_at, id)');

    db.exec(CREATE_TABLES.chunks);
    db.exec(CREATE_INDEXES.chunks_guide_id);

    db.exec(RAG_DDL.chunksFts);
    db.exec(RAG_DDL.chunksFtsInsert);
    db.exec(RAG_DDL.chunksFtsDelete);

    // fts5vocab virtual tables expose (term, doc, col) over an FTS5 index
    // in `row` mode — per-term distinct-document counts in O(log n). Used
    // by RetrievalService.filterToRareChunkTokens / filterToRareTitleTokens
    // to drop common tokens before BM25 scoring.
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts_vocab USING fts5vocab(chunks_fts, row)`);
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS guides_fts_meta_vocab USING fts5vocab(guides_fts_meta, row)`);

    // games_fts powers RetrievalService.defaultGameMatch — phrase-matching
    // question n-grams against game titles. Triggers keep it in sync after
    // bring-up; the backfill below seeds it from existing rows.
    db.exec(GAMES_FTS_DDL.gamesFts);
    db.exec(GAMES_FTS_DDL.gamesFtsInsert);
    db.exec(GAMES_FTS_DDL.gamesFtsUpdate);
    db.exec(GAMES_FTS_DDL.gamesFtsDelete);

    // Title relabel: stash original title in metadata.original_title AND set
    // the new title in one shot, so the guides_fts_meta_update trigger fires
    // exactly once per row.
    // The author filter must stay in sync with cleanAuthor() in
    // GuideImporter.ts: length 2..60, no newlines / | / = / >, and ≤ 5 spaces
    // (the parser sometimes grabs whole sentences).
    const txn = db.transaction(() => {
      db.exec(`INSERT INTO games_fts(game_id, title) SELECT id, title FROM games`);
      db.exec(`
        UPDATE guides AS g
        SET
          metadata = json_set(COALESCE(g.metadata, '{}'), '$.original_title', g.title),
          title = ${TITLE_RELABEL_CASE_SQL}
        FROM games gm
        WHERE g.game_id = gm.id
          AND TRIM(gm.title) != ''
          AND json_extract(g.metadata, '$.original_title') IS NULL
      `);
      db.exec(`INSERT INTO schema_version (version, applied_at) VALUES (5, ${Date.now()})`);
    });
    txn();

    console.log('[Migrations] v5 applied');
  },
  down: (db: Database.Database) => {
    // Restore titles from metadata.original_title where present.
    db.exec(`
      UPDATE guides
      SET
        title = json_extract(metadata, '$.original_title'),
        metadata = json_remove(metadata, '$.original_title')
      WHERE json_extract(metadata, '$.original_title') IS NOT NULL
    `);
    db.exec('DROP TRIGGER IF EXISTS games_fts_delete');
    db.exec('DROP TRIGGER IF EXISTS games_fts_update');
    db.exec('DROP TRIGGER IF EXISTS games_fts_insert');
    db.exec('DROP TABLE IF EXISTS games_fts');
    db.exec('DROP TABLE IF EXISTS guides_fts_meta_vocab');
    db.exec('DROP TABLE IF EXISTS chunks_fts_vocab');
    db.exec('DROP TRIGGER IF EXISTS chunks_fts_delete');
    db.exec('DROP TRIGGER IF EXISTS chunks_fts_insert');
    db.exec('DROP TABLE IF EXISTS chunks_fts');
    db.exec('DROP INDEX IF EXISTS idx_chunks_guide_id');
    db.exec('DROP TABLE IF EXISTS chunks');
    db.exec('DROP INDEX IF EXISTS idx_guides_indexed_at_id');
    // SQLite 3.35+ supports DROP COLUMN
    try {
      db.exec('ALTER TABLE guides DROP COLUMN indexed_at');
    } catch (err: any) {
      console.warn('[Migrations] Could not drop column indexed_at (older SQLite?):', err.message);
    }
    db.exec('DELETE FROM schema_version WHERE version = 5');
  },
};

// All migrations in order
export const migrations: Migration[] = [migration_v1, migration_v2, migration_v3, migration_v4, migration_v5];

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

/**
 * Rollback to a specific version (for development/testing only).
 * SECURITY: Never expose this function to user input (e.g. HTTP request).
 * It uses string interpolation for targetVersion; if called with untrusted input, SQL injection is possible.
 */
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
