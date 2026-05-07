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

// Migration v6: rebuild guides_fts_meta from games.title (not guides.title).
//
// Why: `guides_fts_meta` indexes title + tags for the title-FTS retrieval
// source. After the v5 title relabel, `guides.title` is `${games.title} —
// ${author}`, so author tokens leak into title-FTS. Authors named "Sephiroth"
// etc. produce false-positive title matches on unrelated games. This
// migration drops the v1 triggers that used `new.title`, reinstalls them
// using a `games.title` lookup with a `guides.title` fallback, adds a
// games-title propagation trigger, and rebuilds the table contents from a
// JOIN.
//
// The rebuild is idempotent (DELETE + INSERT) and the triggers are CREATE
// OR REPLACE-style via DROP + CREATE — safe to re-run on a partially-
// migrated DB. No SQL transaction needed for the trigger swap; the data
// rebuild runs inside one.
const migration_v6: Migration = {
  version: 6,
  up: (db: Database.Database) => {
    console.log('[Migrations] v6: rebuilding guides_fts_meta from games.title...');

    db.exec('DROP TRIGGER IF EXISTS guides_fts_meta_insert');
    db.exec('DROP TRIGGER IF EXISTS guides_fts_meta_update');
    db.exec('DROP TRIGGER IF EXISTS games_title_propagate_to_guides_fts');

    db.exec(TITLE_FTS_V6.guides_fts_meta_insert);
    db.exec(TITLE_FTS_V6.guides_fts_meta_update);
    db.exec(TITLE_FTS_V6.games_title_propagate);

    const txn = db.transaction(() => {
      // FTS5 contentless rebuild: delete-all then re-insert from canonical join.
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
      db.exec(`INSERT INTO schema_version (version, applied_at) VALUES (6, ${Date.now()})`);
    });
    txn();

    console.log('[Migrations] v6 applied');
  },
  down: (db: Database.Database) => {
    db.exec('DROP TRIGGER IF EXISTS games_title_propagate_to_guides_fts');
    db.exec('DROP TRIGGER IF EXISTS guides_fts_meta_update');
    db.exec('DROP TRIGGER IF EXISTS guides_fts_meta_insert');
    // Reinstate the v1 triggers (read title from `new.title`).
    db.exec(FULL_TEXT_SEARCH.guides_fts_meta_insert);
    db.exec(FULL_TEXT_SEARCH.guides_fts_meta_update);
    // Rebuild data from `guides.title` to mirror v1 behavior.
    db.exec(`DELETE FROM guides_fts_meta`);
    db.exec(`
      INSERT INTO guides_fts_meta(guide_id, title, tags)
      SELECT id, title, COALESCE(json_extract(metadata, '$.tags'), '')
      FROM guides
    `);
    db.exec('DELETE FROM schema_version WHERE version = 6');
  },
};

// Migration v7: add per-chunk provenance metadata used by retrieval filters and
// contamination auditing.
//
// Added columns:
//   - gamefaqs_id: stable guide external id when available
//   - franchise: coarse game family label (from games/guides metadata if present)
//   - language: chunk/guide language tag
//   - guide_author: normalized author copied from guides metadata
//   - guide_type: faq/walkthrough/cheats/etc metadata
//   - review_status: optional quality/review marker
//
// Backfill source of truth is guides + games metadata JSON (joined by FK). New
// chunks written by IndexingService set these at insert time.
const migration_v7: Migration = {
  version: 7,
  up: (db: Database.Database) => {
    console.log('[Migrations] v7: adding chunk metadata columns and backfilling...');

    addColumnIfMissing(db, 'chunks', 'gamefaqs_id', 'TEXT');
    addColumnIfMissing(db, 'chunks', 'franchise', 'TEXT');
    addColumnIfMissing(db, 'chunks', 'language', 'TEXT');
    addColumnIfMissing(db, 'chunks', 'guide_author', 'TEXT');
    addColumnIfMissing(db, 'chunks', 'guide_type', 'TEXT');
    addColumnIfMissing(db, 'chunks', 'review_status', 'TEXT');

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
    `);

    db.exec(`INSERT INTO schema_version (version, applied_at) VALUES (7, ${Date.now()})`);
    console.log('[Migrations] v7 applied');
  },
  down: (db: Database.Database) => {
    // SQLite DROP COLUMN support varies; keep rollback non-destructive.
    db.exec('DELETE FROM schema_version WHERE version = 7');
  },
};

// Migration v8: extraction/disambiguation foundation.
// Adds:
// - canonical game groups + FK on games
// - canonical game aliases
// - entity-to-game mappings
const migration_v8: Migration = {
  version: 8,
  up: (db: Database.Database) => {
    console.log('[Migrations] v8: adding extraction/disambiguation tables...');

    db.exec(CREATE_TABLES.canonical_game_groups);
    try {
      db.exec('ALTER TABLE games ADD COLUMN canonical_group_id TEXT');
    } catch {
      // Fresh DBs created from current schema already include this column.
    }
    db.exec(CREATE_INDEXES.games_canonical_group_id);

    db.exec(CREATE_TABLES.game_aliases);
    db.exec(CREATE_INDEXES.game_aliases_game_id);
    db.exec(CREATE_TABLES.game_entities);
    db.exec(CREATE_INDEXES.game_entities_entity);
    db.exec(CREATE_INDEXES.game_entities_game_id);

    // Seed canonical groups as normalized-title buckets and link games.
    db.exec(`
      INSERT OR IGNORE INTO canonical_game_groups (id, normalized_title, display_title, created_at, updated_at)
      SELECT
        lower(trim(replace(replace(replace(replace(replace(title, ':', ' '), '-', ' '), 'hd', ''), 'remaster', ''), 'remastered', ''))) AS id,
        lower(trim(replace(replace(replace(replace(replace(title, ':', ' '), '-', ' '), 'hd', ''), 'remaster', ''), 'remastered', ''))) AS normalized_title,
        title AS display_title,
        ${Date.now()},
        ${Date.now()}
      FROM games
      WHERE trim(title) != ''
    `);
    db.exec(`
      UPDATE games
      SET canonical_group_id = lower(trim(replace(replace(replace(replace(replace(title, ':', ' '), '-', ' '), 'hd', ''), 'remaster', ''), 'remastered', '')))
      WHERE canonical_group_id IS NULL
    `);

    // Seed aliases with canonical titles and normalized variants.
    db.exec(`
      INSERT OR IGNORE INTO game_aliases (alias, game_id, alias_type, confidence, created_at, updated_at)
      SELECT lower(title), id, 'title', 1.0, ${Date.now()}, ${Date.now()}
      FROM games
      WHERE trim(title) != ''
    `);
    db.exec(`
      INSERT OR IGNORE INTO game_aliases (alias, game_id, alias_type, confidence, created_at, updated_at)
      SELECT lower(replace(title, ' ', '')), id, 'title_compact', 0.9, ${Date.now()}, ${Date.now()}
      FROM games
      WHERE trim(title) != ''
    `);
    // Roman/Arabic simple series alias seed.
    db.exec(`
      INSERT OR IGNORE INTO game_aliases (alias, game_id, alias_type, confidence, created_at, updated_at)
      SELECT lower(replace(replace(title, ' vii', ' 7'), ' vi', ' 6')), id, 'roman_arabic', 0.8, ${Date.now()}, ${Date.now()}
      FROM games
      WHERE title LIKE '% VI%' OR title LIKE '% VII%'
    `);

    db.exec(`INSERT INTO schema_version (version, applied_at) VALUES (8, ${Date.now()})`);
    console.log('[Migrations] v8 applied');
  },
  down: (db: Database.Database) => {
    db.exec('DROP INDEX IF EXISTS idx_game_entities_game_id');
    db.exec('DROP INDEX IF EXISTS idx_game_entities_entity');
    db.exec('DROP INDEX IF EXISTS idx_game_aliases_game_id');
    db.exec('DROP TABLE IF EXISTS game_entities');
    db.exec('DROP TABLE IF EXISTS game_aliases');
    db.exec('DROP INDEX IF EXISTS idx_games_canonical_group_id');
    db.exec('DROP TABLE IF EXISTS canonical_game_groups');
    db.exec('DELETE FROM schema_version WHERE version = 8');
  },
};

// Migration v9: seed game_entities with curated character / location / mechanic →
// game mappings for major franchises in the bench corpus.
//
// Why: GameExtractionService.matchEntity() relies on game_entities being
// populated, but migration v8 only seeds game_aliases (title forms). Entity
// matching therefore never fires and questions like "What weapon does Cloud
// start with?" (Q12) and "Why did Sephiroth burn down Nibelheim?" (Q18) both
// return status=unclear because "Cloud" / "Sephiroth" / "Nibelheim" don't
// appear in any game title.
//
// Strategy: scan all games rows in TypeScript (safer than chained SQL LIKE/NOT
// LIKE patterns), pick matching game_ids by title regex, then INSERT OR IGNORE
// one row per (entity, game_id) pair. Idempotent — re-running inserts nothing
// if the rows already exist. Only seeds entities where the title regex matches
// at least one game in this DB; unknown games are silently skipped.
//
// Entity names are stored lowercase (per `lower(?)` in the INSERT), matching
// the `normalize(r.entity)` call in GameExtractionService.matchEntity().
// is_unique=1 means the entity reliably identifies a single canonical game;
// is_unique=0 means it appears across multiple distinct games (only triggers
// `ambiguous` outcome, not `confident`).
const migration_v9: Migration = {
  version: 9,
  up: (db: Database.Database) => {
    const ts = Date.now();
    console.log('[Migrations] v9: seeding game entities...');

    const allGames = db.prepare(`SELECT id, title FROM games`).all() as { id: string; title: string }[];

    const gameIdsByPattern = (include: RegExp, exclude?: RegExp): string[] =>
      allGames
        .filter(r => include.test(r.title) && (!exclude || !exclude.test(r.title)))
        .map(r => r.id);

    type Spec = [entity: string, type: string, isUnique: 0 | 1, confidence: number];

    const insert = db.prepare(
      `INSERT OR IGNORE INTO game_entities
         (entity, game_id, is_unique, entity_type, confidence, created_at, updated_at)
       VALUES (lower(?), ?, ?, ?, ?, ?, ?)`
    );

    function seed(ids: string[], specs: Spec[]) {
      for (const id of ids) {
        for (const [entity, type, isUnique, conf] of specs) {
          insert.run(entity, id, isUnique, type, conf, ts, ts);
        }
      }
    }

    const txn = db.transaction(() => {
      // ── Final Fantasy VII ─────────────────────────────────────────────────
      seed(
        gameIdsByPattern(
          /final fantasy vii/i,
          /crisis core|advent children|dirge of cerberus|remake|rebirth|intergrade/i
        ),
        [
          ['cloud',        'character', 1, 0.92],
          ['sephiroth',    'character', 1, 0.97],
          ['tifa',         'character', 1, 0.95],
          ['aerith',       'character', 1, 0.95],
          ['aeris',        'character', 1, 0.92],
          ['barret',       'character', 1, 0.90],
          ['yuffie',       'character', 1, 0.95],
          ['vincent',      'character', 1, 0.88],
          ['cait sith',    'character', 1, 0.97],
          ['red xiii',     'character', 1, 0.97],
          ['nanaki',       'character', 1, 0.97],
          ['jenova',       'character', 1, 0.97],
          ['zack',         'character', 1, 0.85],
          ['rufus',        'character', 1, 0.82],
          ['midgar',       'location',  1, 0.97],
          ['nibelheim',    'location',  1, 0.99],
          ['sector 7',     'location',  1, 0.97],
          ['cosmo canyon', 'location',  1, 0.97],
          ['gold saucer',  'location',  1, 0.95],
          ['junon',        'location',  1, 0.88],
          ['mideel',       'location',  1, 0.97],
          ['rocket town',  'location',  1, 0.97],
          ['northern crater','location',1, 0.97],
          ['wutai',        'location',  1, 0.92],
          ['shinra',       'lore',      1, 0.90],
          ['materia',      'mechanic',  1, 0.92],
          ['w-item',       'mechanic',  1, 0.99],
          ['w-magic',      'mechanic',  1, 0.99],
          ['w-summon',     'mechanic',  1, 0.99],
          ['buster sword', 'item',      1, 0.92],
          ['lifestream',   'lore',      1, 0.97],
        ]
      );

      // ── Final Fantasy VIII ────────────────────────────────────────────────
      seed(
        gameIdsByPattern(
          /final fantasy viii/i,
          /remake|remaster/i
        ),
        [
          ['squall',           'character', 1, 0.95],
          ['rinoa',            'character', 1, 0.97],
          ['quistis',          'character', 1, 0.99],
          ['zell',             'character', 1, 0.97],
          ['selphie',          'character', 1, 0.97],
          ['irvine',           'character', 1, 0.95],
          ['seifer',           'character', 1, 0.95],
          ['edea',             'character', 1, 0.95],
          ['ultimecia',        'character', 1, 0.99],
          ['laguna',           'character', 1, 0.97],
          ['junctioning',      'mechanic',  1, 0.99],
          ['junction',         'mechanic',  1, 0.90],
          ['sorceress',        'lore',      1, 0.85],
          ['balamb garden',    'location',  1, 0.99],
          ['galbadia',         'location',  1, 0.95],
          ['time compression', 'mechanic',  1, 0.97],
          ['dollet',           'location',  1, 0.95],
        ]
      );

      // ── Final Fantasy VI ──────────────────────────────────────────────────
      seed(
        gameIdsByPattern(
          /final fantasy vi(\b|$)/i,   // VI only — not VII/VIII/etc.
          /advance|pixel/i
        ),
        [
          ['kefka',       'character', 1, 0.99],
          ['terra',       'character', 1, 0.95],
          ['celes',       'character', 1, 0.95],
          ['locke',       'character', 1, 0.92],
          ['edgar',       'character', 1, 0.92],
          ['sabin',       'character', 1, 0.97],
          ['cyan',        'character', 1, 0.92],
          ['gau',         'character', 1, 0.97],
          ['setzer',      'character', 1, 0.97],
          ['strago',      'character', 1, 0.97],
          ['relm',        'character', 1, 0.97],
          ['umaro',       'character', 1, 0.97],
          ['espers',      'mechanic',  1, 0.88],
          ['magitek',     'lore',      1, 0.97],
          ['narshe',      'location',  1, 0.99],
          ['figaro',      'location',  1, 0.97],
          ['thamasa',     'location',  1, 0.99],
          ['opera house', 'location',  1, 0.92],
        ]
      );

      // ── Final Fantasy X ───────────────────────────────────────────────────
      // Exclude X-2 ("Final Fantasy X-2") but keep HD Remaster variants.
      seed(
        gameIdsByPattern(
          /final fantasy x(\b|$|\s)/i,
          /x-2|x2/i
        ),
        [
          ['tidus',       'character', 1, 0.99],
          ['yuna',        'character', 1, 0.92],
          ['auron',       'character', 1, 0.99],
          ['lulu',        'character', 1, 0.92],
          ['wakka',       'character', 1, 0.99],
          ['kimahri',     'character', 1, 0.99],
          ['rikku',       'character', 1, 0.90],
          ['jecht',       'character', 1, 0.99],
          ['zanarkand',   'location',  1, 0.99],
          ['spira',       'location',  1, 0.99],
          ['besaid',      'location',  1, 0.99],
          ['kilika',      'location',  1, 0.97],
          ['sphere grid', 'mechanic',  1, 0.99],
          ['blitzball',   'mechanic',  1, 0.99],
        ]
      );

      // ── Chrono Trigger ────────────────────────────────────────────────────
      seed(
        gameIdsByPattern(/chrono trigger/i),
        [
          ['crono',       'character', 1, 0.99],
          ['marle',       'character', 1, 0.99],
          ['lucca',       'character', 1, 0.95],
          ['frog',        'character', 1, 0.88],
          ['robo',        'character', 1, 0.92],
          ['ayla',        'character', 1, 0.97],
          ['magus',       'character', 1, 0.97],
          ['schala',      'character', 1, 0.99],
          ['lavos',       'character', 1, 0.99],
          ['dalton',      'character', 1, 0.97],
          ['zeal',        'location',  1, 0.95],
          ['guardia',     'location',  1, 0.92],
          ['black omen',  'location',  1, 0.99],
          ['epoch',       'item',      1, 0.99],
          ['dual tech',   'mechanic',  1, 0.97],
          ['triple tech', 'mechanic',  1, 0.97],
        ]
      );

      // ── Kingdom Hearts ────────────────────────────────────────────────────
      seed(
        gameIdsByPattern(
          /kingdom hearts/i,
          /chain of memories|358|dream drop|birth by sleep|coded|re:/i
        ),
        [
          ['sora',             'character', 1, 0.92],
          ['riku',             'character', 1, 0.92],
          ['kairi',            'character', 1, 0.92],
          ['xemnas',           'character', 1, 0.95],
          ['axel',             'character', 1, 0.90],
          ['roxas',            'character', 1, 0.90],
          ['namine',           'character', 1, 0.90],
          ['organization xiii','lore',      1, 0.97],
          ['keyblade',         'item',      1, 0.88],
          ['traverse town',    'location',  1, 0.95],
          ['hollow bastion',   'location',  1, 0.95],
          ['destiny islands',  'location',  1, 0.95],
        ]
      );

      // ── Portal ────────────────────────────────────────────────────────────
      // Exclude Portal 2, Portal Stories, etc.
      seed(
        gameIdsByPattern(
          /portal/i,
          /portal 2|stories|mel|still alive/i
        ),
        [
          ['glados',            'character', 1, 0.99],
          ['chell',             'character', 1, 0.97],
          ['companion cube',    'item',      1, 0.99],
          ['portal gun',        'item',      1, 0.90],
          ['aperture science',  'lore',      1, 0.99],
          ['aperture',          'lore',      1, 0.90],
          ['neurotoxin',        'mechanic',  1, 0.97],
        ]
      );

      // ── Metal Gear Solid 2 ────────────────────────────────────────────────
      seed(
        gameIdsByPattern(
          /metal gear solid 2|metal gear solid two/i,
          /legacy|substance/i
        ),
        [
          ['raiden',       'character', 1, 0.97],
          ['solidus',      'character', 1, 0.97],
          ['vamp',         'character', 1, 0.92],
          ['fortune',      'character', 1, 0.90],
          ['arsenal gear', 'location',  1, 0.99],
          ['emma',         'character', 1, 0.80],
        ]
      );

      // ── Castlevania: Symphony of the Night ────────────────────────────────
      seed(
        gameIdsByPattern(/symphony of the night/i),
        [
          ['alucard',         'character', 1, 0.95],
          ['richter',         'character', 1, 0.85],
          ['shaft',           'character', 1, 0.90],
          ['inverted castle', 'location',  1, 0.99],
          ['soul of bat',     'item',      1, 0.99],
          ['luck mode',       'mechanic',  1, 0.97],
        ]
      );

      // ── Diablo II ─────────────────────────────────────────────────────────
      seed(
        gameIdsByPattern(/\bdiablo ii\b|\bdiablo 2\b/i),
        [
          ['mephisto',       'character', 1, 0.92],
          ['baal',           'character', 1, 0.90],
          ['andariel',       'character', 1, 0.97],
          ['duriel',         'character', 1, 0.97],
          ['stone of jordan','item',      1, 0.95],
          ['horadric cube',  'item',      1, 0.95],
          ['cow level',      'location',  1, 0.97],
        ]
      );

      // ── Grand Theft Auto: San Andreas ─────────────────────────────────────
      seed(
        gameIdsByPattern(/grand theft auto.*san andreas|gta.*san andreas/i),
        [
          ['cj',           'character', 1, 0.92],
          ['big smoke',    'character', 1, 0.97],
          ['ryder',        'character', 1, 0.88],
          ['grove street', 'location',  1, 0.97],
          ['san fierro',   'location',  1, 0.97],
          ['las venturas', 'location',  1, 0.97],
        ]
      );

      // ── Ocarina of Time ───────────────────────────────────────────────────
      seed(
        gameIdsByPattern(/ocarina of time/i),
        [
          ['navi',         'character', 1, 0.90],
          ['lon lon ranch','location',  1, 0.95],
          ['kokiri forest','location',  1, 0.92],
          ['zoras domain', 'location',  1, 0.90],
          ['lake hylia',   'location',  0, 0.70],  // shared across Zelda titles
          ['shadow temple','location',  1, 0.88],
          ['gerudo valley','location',  1, 0.92],
        ]
      );

      db.prepare(`INSERT INTO schema_version (version, applied_at) VALUES (9, ?)`).run(ts);
    });

    txn();
    console.log('[Migrations] v9 applied');
  },
  down: (db: Database.Database) => {
    // Remove only entities seeded by this migration (match by the timestamp
    // stored in created_at). On a fresh DB all v9 entities will share the same
    // ts, so this is safe. For partial rollback (re-run), delete all rows that
    // were inserted at or after the v9 applied_at timestamp.
    db.exec(`
      DELETE FROM game_entities
      WHERE created_at >= (
        SELECT applied_at FROM schema_version WHERE version = 9
      )
    `);
    db.exec(`DELETE FROM schema_version WHERE version = 9`);
  },
};

// Migration v10: fix game_entity false-positives from the v9 regex bug and
// recompute confidence from chunk-frequency share.
//
// Root cause: migration v9 used /final fantasy vii/i to identify FF7 games.
// That regex matches "Final Fantasy VIII" because "vii" is a substring of
// "viii", so Cloud/Sephiroth/Nibelheim were seeded into FF8 rows at the same
// confidence as FF7. Every entity therefore had identical confidence across
// all matched games, making the gap filter in GameExtractionService useless.
//
// Fix in two steps:
//   1. Delete false-positive rows: FF7 entities seeded into games whose title
//      contains "viii" but not a standalone "vii" word.
//   2. Recompute confidence as entity share per game:
//        confidence = chunks_mentioning_entity_in_game
//                     / total_chunks_mentioning_entity_across_all_games
//      capped at 0.99. Multi-word entities use FTS phrase match ("buster sword").
//      Entities with no FTS hits are left unchanged (fresh DB, no indexed chunks).
const migration_v10: Migration = {
  version: 10,
  up: (db: Database.Database) => {
    console.log('[Migrations] v10: fixing entity false-positives and recomputing confidence...');
    const ts = Date.now();

    // Step 1 — delete rows where the v9 regex falsely matched FF8 titles.
    // A game title with "viii" that lacks a word-boundary "vii" (i.e. the VII
    // only appears as part of VIII) is a false positive.
    db.prepare(`
      DELETE FROM game_entities
      WHERE game_id IN (
        SELECT id FROM games
        WHERE LOWER(title) LIKE '%viii%'
          AND LOWER(title) NOT LIKE '% vii %'
          AND LOWER(title) NOT LIKE '% vii'
          AND LOWER(title) NOT GLOB 'vii *'
      )
    `).run();

    // Step 1b — zero out entity rows for games that have no indexed chunks at all.
    // Without chunk evidence, a game's seeded confidence is meaningless and will
    // incorrectly dominate the gap filter (seeded 0.9+ beats a properly-indexed
    // game's 0.05 share). Games with no chunks have no evidence for any entity.
    db.prepare(`
      UPDATE game_entities SET confidence = 0, updated_at = ?
      WHERE game_id NOT IN (
        SELECT DISTINCT g.game_id FROM chunks c
        JOIN guides g ON g.id = c.guide_id
        WHERE g.game_id IS NOT NULL
      )
    `).run(ts);

    // Step 2 — recompute confidence from FTS chunk frequency share.
    // Only update rows that actually have indexed chunks; fresh DBs with no
    // chunks yet keep their static seeded confidence (still correct ordering
    // once chunks are indexed later).
    const chunkCountQuery = db.prepare(`
      SELECT g.game_id, COUNT(*) AS cnt
      FROM chunks_fts cf
      JOIN chunks c ON c.rowid = cf.rowid
      JOIN guides g ON g.id = c.guide_id
      WHERE cf.content MATCH ?
        AND g.game_id IS NOT NULL
      GROUP BY g.game_id
    `);

    const updateConf = db.prepare(`
      UPDATE game_entities SET confidence = ?, updated_at = ?
      WHERE entity = ? AND game_id = ?
    `);

    const entities = (db.prepare(
      `SELECT DISTINCT entity FROM game_entities`
    ).all() as { entity: string }[]).map(r => r.entity);

    const updateTxn = db.transaction(() => {
      const zeroConf = db.prepare(
        `UPDATE game_entities SET confidence = 0, updated_at = ? WHERE entity = ? AND game_id = ?`
      );
      const entityGameIds = db.prepare(
        `SELECT game_id FROM game_entities WHERE entity = ?`
      );

      for (const entity of entities) {
        // FTS MATCH: wrap multi-word entities in double quotes for phrase match.
        const matchTerm = entity.includes(' ') ? `"${entity}"` : entity;
        let rows: { game_id: string; cnt: number }[];
        try {
          rows = chunkCountQuery.all(matchTerm) as { game_id: string; cnt: number }[];
        } catch {
          // FTS syntax error (e.g. entity contains special chars) — skip.
          continue;
        }

        if (rows.length === 0) continue; // no corpus hits — leave seeded values intact

        const total = rows.reduce((s, r) => s + r.cnt, 0);
        if (total === 0) continue;

        // Update games that DID have hits.
        const hitGameIds = new Set(rows.map(r => r.game_id));
        for (const { game_id, cnt } of rows) {
          updateConf.run(Math.min(0.99, cnt / total), ts, entity, game_id);
        }

        // Zero out games that had NO hits: their seeded confidence is meaningless
        // and would corrupt the gap filter by ranking above properly-indexed games.
        for (const { game_id } of entityGameIds.all(entity) as { game_id: string }[]) {
          if (!hitGameIds.has(game_id)) {
            zeroConf.run(ts, entity, game_id);
          }
        }
      }
    });

    updateTxn();
    db.exec(`INSERT INTO schema_version (version, applied_at) VALUES (10, ${Date.now()})`);
    console.log('[Migrations] v10 applied');
  },
  down: (db: Database.Database) => {
    // Confidence recomputation is not reversible; only remove version marker.
    db.exec(`DELETE FROM schema_version WHERE version = 10`);
  },
};

// Migration v11: chunker v2 — add content_type / section_heading columns.
//
// content_type tags each emitted chunk as 'prose' | 'reference' | 'mixed'.
// section_heading carries the nearest preceding section/banner header text
// when one was attached at pack time. Both are populated by chunkGuideV2;
// legacy chunks indexed under v1 keep the column default ('prose') and a
// NULL section_heading until re-indexed.
//
// Defaulting content_type to 'prose' for legacy rows means retrieval-side
// filters that scope to prose-only see legacy chunks at neutral baseline
// — they are *not* retroactively demoted, only newly-indexed reference
// blocks are. This is the property that makes the v1→v2 cutover safe to
// roll forward incrementally as guides re-index.
const migration_v11: Migration = {
  version: 11,
  up: (db: Database.Database) => {
    console.log('[Migrations] v11: adding chunks.content_type and chunks.section_heading...');
    addColumnIfMissing(db, 'chunks', 'content_type', "TEXT NOT NULL DEFAULT 'prose'");
    addColumnIfMissing(db, 'chunks', 'section_heading', 'TEXT');
    db.exec(`INSERT INTO schema_version (version, applied_at) VALUES (11, ${Date.now()})`);
    console.log('[Migrations] v11 applied');
  },
  down: (db: Database.Database) => {
    // SQLite 3.35+ supports DROP COLUMN. Wrap in try/catch like v5's
    // indexed_at rollback so older runtimes don't trip the rollback.
    try {
      db.exec('ALTER TABLE chunks DROP COLUMN section_heading');
    } catch (err: any) {
      console.warn('[Migrations] Could not drop column section_heading (older SQLite?):', err.message);
    }
    try {
      db.exec('ALTER TABLE chunks DROP COLUMN content_type');
    } catch (err: any) {
      console.warn('[Migrations] Could not drop column content_type (older SQLite?):', err.message);
    }
    db.exec('DELETE FROM schema_version WHERE version = 11');
  },
};

// All migrations in order
export const migrations: Migration[] = [migration_v1, migration_v2, migration_v3, migration_v4, migration_v5, migration_v6, migration_v7, migration_v8, migration_v9, migration_v10, migration_v11];

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
