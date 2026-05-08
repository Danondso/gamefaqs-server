import Database from 'better-sqlite3';
import { CREATE_TABLES, CREATE_INDEXES, FULL_TEXT_SEARCH, FILTER_LOOKUP_TRIGGERS, RAG_DDL, GAMES_FTS_DDL, TITLE_FTS_V6, SCHEMA_VERSION } from './schema';

export interface Migration {
  version: number;
  up: (db: Database.Database) => void;
  down?: (db: Database.Database) => void;
}

/** Fresh DBs load current CREATE_TABLES before migrations; older migrations that ALTER ADD must skip existing columns. */
function addColumnIfMissing(db: Database.Database, table: string, column: string, typeSql: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeSql}`);
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

// Migration v6: collapsed end-state of what was previously v6..v11 plus the
// chunks.scenario tag (a never-released v7 on this branch). Idempotent so
// existing DBs at v11 can be re-stamped (`DELETE FROM schema_version WHERE
// version > 5`) and walked forward without losing the corpus or ANN file.
//
// What this rolls in:
//   - v6 — rebuild guides_fts_meta to read titles from `games.title` (drops
//     author leakage from the v5 title relabel)
//   - v7 — chunks provenance columns + backfill
//   - v8 — extraction tables (canonical_game_groups, game_aliases,
//     game_entities), games.canonical_group_id column, indexes. SEEDING
//     moved to EntitySeedService (runs post-import so games is populated).
//   - v9 / v10 — entity-table seeding and confidence recomputation. Both
//     moved to EntitySeedService; v9's `\bvii\b` regex bug is fixed at the
//     source there, so v10's cleanup pass is no longer needed.
//   - v11 — chunks.content_type / section_heading columns
//   - chunks.scenario — comma-joined gated-content tags (ng_plus / secret /
//     missable) used by RetrievalService for the soft 0.7× penalty on plain
//     questions. Backfill is content-only (no chunker re-run, no re-embed);
//     new chunks set this at insert time via Chunker.detectScenario.
//
// Idempotency rules: every CREATE uses IF NOT EXISTS; every ADD COLUMN goes
// through addColumnIfMissing; the FTS rebuild is a DELETE+INSERT gated on
// `count == 0` for guides_fts_meta (so a re-stamped DB skips the rebuild —
// it's already correct); the chunks-provenance backfill is gated on
// `gamefaqs_id IS NULL`; the scenario backfill UPDATEs are gated per-tag on
// `scenario IS NULL OR NOT LIKE '%tag%'` so re-runs no-op.
const migration_v6: Migration = {
  version: 6,
  up: (db: Database.Database) => {
    console.log('[Migrations] v6: applying collapsed schema (was v6-v11)...');

    // ── 1. Title-FTS triggers — read from games.title, not guides.title ──
    db.exec('DROP TRIGGER IF EXISTS guides_fts_meta_insert');
    db.exec('DROP TRIGGER IF EXISTS guides_fts_meta_update');
    db.exec('DROP TRIGGER IF EXISTS games_title_propagate_to_guides_fts');
    db.exec(TITLE_FTS_V6.guides_fts_meta_insert);
    db.exec(TITLE_FTS_V6.guides_fts_meta_update);
    db.exec(TITLE_FTS_V6.games_title_propagate);

    // ── 2. Rebuild guides_fts_meta from JOIN (only if empty) ──
    // On a re-stamped v11 DB this is already correct (count > 0) and we skip.
    // On a fresh DB at this point guides is empty (import runs after
    // migrations), so the INSERT no-ops anyway — but the `count == 0` guard
    // makes intent explicit and avoids a wasted DELETE on big DBs.
    const titleFtsCount = (db.prepare('SELECT COUNT(*) c FROM guides_fts_meta').get() as { c: number }).c;
    if (titleFtsCount === 0) {
      const rebuildTxn = db.transaction(() => {
        db.exec(`DELETE FROM guides_fts_meta`);
        db.exec(`
          INSERT INTO guides_fts_meta(guide_id, title, tags)
          SELECT
            g.id,
            COALESCE(gm.title, g.title),
            COALESCE(json_extract(g.metadata, '$.tags'), '')
          FROM guides g
          LEFT JOIN games gm ON gm.id = g.game_id
        `);
      });
      rebuildTxn();
    }

    // ── 3. Chunks provenance columns (was v7) ──
    addColumnIfMissing(db, 'chunks', 'gamefaqs_id', 'TEXT');
    addColumnIfMissing(db, 'chunks', 'franchise', 'TEXT');
    addColumnIfMissing(db, 'chunks', 'language', 'TEXT');
    addColumnIfMissing(db, 'chunks', 'guide_author', 'TEXT');
    addColumnIfMissing(db, 'chunks', 'guide_type', 'TEXT');
    addColumnIfMissing(db, 'chunks', 'review_status', 'TEXT');

    // Backfill provenance, gated on a NULL gamefaqs_id sentinel. New chunks
    // written by IndexingService set these at insert time, so this UPDATE
    // only matters for pre-existing rows that predate the columns.
    const needsBackfill = db.prepare(
      `SELECT 1 FROM chunks WHERE gamefaqs_id IS NULL LIMIT 1`
    ).get();
    if (needsBackfill) {
      db.exec(`
        UPDATE chunks AS c
        SET
          gamefaqs_id = COALESCE(
            json_extract(g.metadata, '$.gamefaqs_id'),
            json_extract(g.metadata, '$.external_id'),
            g.id
          ),
          franchise = COALESCE(
            json_extract(g.metadata, '$.franchise'),
            json_extract(gm.metadata, '$.franchise')
          ),
          language = COALESCE(
            json_extract(g.metadata, '$.language'),
            json_extract(g.metadata, '$.lang'),
            json_extract(gm.metadata, '$.language')
          ),
          guide_author = json_extract(g.metadata, '$.author'),
          guide_type = COALESCE(
            json_extract(g.metadata, '$.guide_type'),
            json_extract(g.metadata, '$.type')
          ),
          review_status = COALESCE(
            json_extract(g.metadata, '$.review_status'),
            json_extract(g.metadata, '$.status')
          )
        FROM guides g
        LEFT JOIN games gm ON gm.id = g.game_id
        WHERE c.guide_id = g.id
          AND c.gamefaqs_id IS NULL
      `);
    }

    // ── 4. Extraction tables + games.canonical_group_id (was v8 schema) ──
    // Seeding (canonical groups, aliases, entities) is NOT done here — it
    // moved to EntitySeedService so it can run post-import, when `games` is
    // actually populated. v8's "seed at migration time" was the bug that
    // left `game_aliases` / `game_entities` permanently empty on fresh
    // installs.
    db.exec(CREATE_TABLES.canonical_game_groups);
    addColumnIfMissing(db, 'games', 'canonical_group_id', 'TEXT');
    db.exec(CREATE_INDEXES.games_canonical_group_id);

    db.exec(CREATE_TABLES.game_aliases);
    db.exec(CREATE_INDEXES.game_aliases_game_id);
    db.exec(CREATE_TABLES.game_entities);
    db.exec(CREATE_INDEXES.game_entities_entity);
    db.exec(CREATE_INDEXES.game_entities_game_id);

    // ── 5. Chunker chunk-type columns (was v11) ──
    addColumnIfMissing(db, 'chunks', 'content_type', "TEXT NOT NULL DEFAULT 'prose'");
    addColumnIfMissing(db, 'chunks', 'section_heading', 'TEXT');

    // ── 6. chunks.scenario tag + content-only backfill ──
    // Gated-content tags drive the soft 0.7× retrieval penalty applied when a
    // question carries no scenario cue (see SCENARIO_CUE_RE in RetrievalService).
    // Multiple tags can apply to one chunk; we comma-join in deterministic order.
    addColumnIfMissing(db, 'chunks', 'scenario', 'TEXT');
    const scenarioTxn = db.transaction(() => {
      // ng_plus: New Game+ / NG+ / second playthrough markers.
      db.exec(`
        UPDATE chunks SET scenario = 'ng_plus'
        WHERE scenario IS NULL
          AND (
            content LIKE '%new game+%' COLLATE NOCASE
            OR content LIKE '%new game +%' COLLATE NOCASE
            OR content LIKE '%NG+%'
            OR content LIKE '%second playthrough%' COLLATE NOCASE
          )
      `);
      // secret: secret/hidden/easter-egg content. Word-boundary check via
      // multi-token search to avoid matching innocuous "hidden" usage in
      // mechanics text. False positives are tolerable — the retrieval-side
      // penalty is soft (0.7×) and only fires on plain questions.
      db.exec(`
        UPDATE chunks SET scenario = COALESCE(scenario || ',', '') || 'secret'
        WHERE (scenario IS NULL OR scenario NOT LIKE '%secret%')
          AND (
            content LIKE '%easter egg%' COLLATE NOCASE
            OR content LIKE '%secret boss%' COLLATE NOCASE
            OR content LIKE '%secret ending%' COLLATE NOCASE
            OR content LIKE '%secret level%' COLLATE NOCASE
            OR content LIKE '%hidden boss%' COLLATE NOCASE
            OR content LIKE '%hidden level%' COLLATE NOCASE
          )
      `);
      // missable: explicit missable / point-of-no-return markers.
      db.exec(`
        UPDATE chunks SET scenario = COALESCE(scenario || ',', '') || 'missable'
        WHERE (scenario IS NULL OR scenario NOT LIKE '%missable%')
          AND (
            content LIKE '%missable%' COLLATE NOCASE
            OR content LIKE '%point of no return%' COLLATE NOCASE
          )
      `);
    });
    scenarioTxn();
    const scenarioTagged = (db.prepare(
      `SELECT COUNT(*) c FROM chunks WHERE scenario IS NOT NULL`
    ).get() as { c: number }).c;

    db.exec(`INSERT INTO schema_version (version, applied_at) VALUES (6, ${Date.now()})`);
    console.log(`[Migrations] v6 applied (${scenarioTagged} chunks tagged with scenario)`);
  },
  down: (db: Database.Database) => {
    // Best-effort downgrade; mostly here to keep the migration interface
    // consistent. Not exercised in production paths.
    try {
      db.exec('ALTER TABLE chunks DROP COLUMN scenario');
    } catch {
      // ignore — column absent or older SQLite
    }
    db.exec('DROP TRIGGER IF EXISTS games_title_propagate_to_guides_fts');
    db.exec('DROP TRIGGER IF EXISTS guides_fts_meta_update');
    db.exec('DROP TRIGGER IF EXISTS guides_fts_meta_insert');
    db.exec(FULL_TEXT_SEARCH.guides_fts_meta_insert);
    db.exec(FULL_TEXT_SEARCH.guides_fts_meta_update);
    db.exec(`DELETE FROM guides_fts_meta`);
    db.exec(`
      INSERT INTO guides_fts_meta(guide_id, title, tags)
      SELECT id, title, COALESCE(json_extract(metadata, '$.tags'), '')
      FROM guides
    `);
    db.exec('DROP INDEX IF EXISTS idx_game_entities_game_id');
    db.exec('DROP INDEX IF EXISTS idx_game_entities_entity');
    db.exec('DROP INDEX IF EXISTS idx_game_aliases_game_id');
    db.exec('DROP TABLE IF EXISTS game_entities');
    db.exec('DROP TABLE IF EXISTS game_aliases');
    db.exec('DROP INDEX IF EXISTS idx_games_canonical_group_id');
    db.exec('DROP TABLE IF EXISTS canonical_game_groups');
    db.exec('DELETE FROM schema_version WHERE version = 6');
  },
};

// All migrations in order
export const migrations: Migration[] = [migration_v1, migration_v2, migration_v3, migration_v4, migration_v5, migration_v6];

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
