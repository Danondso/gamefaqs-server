// SQLite database schema definitions
// Ported from gamefaqs-reader mobile app

export const SCHEMA_VERSION = 11;

export const CREATE_TABLES = {
  guides: `
    CREATE TABLE IF NOT EXISTS guides (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      format TEXT NOT NULL CHECK(format IN ('txt', 'html', 'md', 'pdf')),
      file_path TEXT NOT NULL,
      game_id TEXT,
      last_read_position INTEGER,
      metadata TEXT,
      ai_analyzed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE SET NULL
    );
  `,

  games: `
    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      canonical_group_id TEXT,
      ra_game_id TEXT UNIQUE,
      platform TEXT,
      completion_percentage REAL DEFAULT 0 CHECK(completion_percentage >= 0 AND completion_percentage <= 100),
      status TEXT NOT NULL DEFAULT 'not_started' CHECK(status IN ('in_progress', 'completed', 'not_started')),
      artwork_url TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (canonical_group_id) REFERENCES canonical_game_groups(id) ON DELETE SET NULL
    );
  `,

  bookmarks: `
    CREATE TABLE IF NOT EXISTS bookmarks (
      id TEXT PRIMARY KEY,
      guide_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      name TEXT,
      page_reference TEXT,
      is_last_read INTEGER NOT NULL DEFAULT 0 CHECK(is_last_read IN (0, 1)),
      created_at INTEGER NOT NULL,
      FOREIGN KEY (guide_id) REFERENCES guides(id) ON DELETE CASCADE
    );
  `,

  notes: `
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      guide_id TEXT NOT NULL,
      position INTEGER,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (guide_id) REFERENCES guides(id) ON DELETE CASCADE
    );
  `,

  achievements: `
    CREATE TABLE IF NOT EXISTS achievements (
      id TEXT PRIMARY KEY,
      ra_achievement_id TEXT NOT NULL,
      game_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      points INTEGER,
      badge_url TEXT,
      is_pinned INTEGER NOT NULL DEFAULT 0 CHECK(is_pinned IN (0, 1)),
      is_unlocked INTEGER NOT NULL DEFAULT 0 CHECK(is_unlocked IN (0, 1)),
      unlock_time INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
      UNIQUE(ra_achievement_id, game_id)
    );
  `,

  // Version tracking table
  schema_version: `
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `,

  // Denormalized lookup tables for fast filter queries
  guide_tags: `
    CREATE TABLE IF NOT EXISTS guide_tags (
      guide_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (guide_id, tag),
      FOREIGN KEY (guide_id) REFERENCES guides(id) ON DELETE CASCADE
    );
  `,

  guide_platforms: `
    CREATE TABLE IF NOT EXISTS guide_platforms (
      platform TEXT PRIMARY KEY
    );
  `,

  // Chunks of guide content for retrieval-augmented generation.
  // content_type / section_heading added in migration v11 (chunker v2):
  // tags each chunk with its dominant content shape ('prose' | 'reference' |
  // 'mixed') and the nearest preceding section header text. The default
  // 'prose' on content_type is what makes legacy v1-indexed rows still
  // queryable with a neutral baseline before they re-index under v2.
  chunks: `
    CREATE TABLE IF NOT EXISTS chunks (
      id              TEXT PRIMARY KEY,
      guide_id        TEXT NOT NULL,
      chunk_index     INTEGER NOT NULL,
      content         TEXT NOT NULL,
      gamefaqs_id     TEXT,
      franchise       TEXT,
      language        TEXT,
      guide_author    TEXT,
      guide_type      TEXT,
      review_status   TEXT,
      char_start      INTEGER NOT NULL,
      char_end        INTEGER NOT NULL,
      token_count     INTEGER NOT NULL,
      created_at      INTEGER NOT NULL,
      content_type    TEXT NOT NULL DEFAULT 'prose',
      section_heading TEXT,
      FOREIGN KEY (guide_id) REFERENCES guides(id) ON DELETE CASCADE,
      UNIQUE(guide_id, chunk_index)
    );
  `,

  game_aliases: `
    CREATE TABLE IF NOT EXISTS game_aliases (
      alias TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      alias_type TEXT NOT NULL DEFAULT 'manual',
      confidence REAL NOT NULL DEFAULT 1.0 CHECK(confidence >= 0 AND confidence <= 1),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
    );
  `,

  game_entities: `
    CREATE TABLE IF NOT EXISTS game_entities (
      entity TEXT NOT NULL,
      game_id TEXT NOT NULL,
      is_unique INTEGER NOT NULL DEFAULT 1 CHECK(is_unique IN (0, 1)),
      entity_type TEXT NOT NULL DEFAULT 'character',
      confidence REAL NOT NULL DEFAULT 1.0 CHECK(confidence >= 0 AND confidence <= 1),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (entity, game_id),
      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
    );
  `,

  canonical_game_groups: `
    CREATE TABLE IF NOT EXISTS canonical_game_groups (
      id TEXT PRIMARY KEY,
      normalized_title TEXT NOT NULL UNIQUE,
      display_title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `,
};

export const CREATE_INDEXES = {
  guides_game_id: 'CREATE INDEX IF NOT EXISTS idx_guides_game_id ON guides(game_id);',
  guides_created_at: 'CREATE INDEX IF NOT EXISTS idx_guides_created_at ON guides(created_at);',
  guides_updated_at: 'CREATE INDEX IF NOT EXISTS idx_guides_updated_at ON guides(updated_at);',
  guides_ai_analyzed_at: 'CREATE INDEX IF NOT EXISTS idx_guides_ai_analyzed_at ON guides(ai_analyzed_at);',
  games_ra_game_id: 'CREATE INDEX IF NOT EXISTS idx_games_ra_game_id ON games(ra_game_id);',
  games_status: 'CREATE INDEX IF NOT EXISTS idx_games_status ON games(status);',
  bookmarks_guide_id:
    'CREATE INDEX IF NOT EXISTS idx_bookmarks_guide_id ON bookmarks(guide_id);',
  bookmarks_is_last_read:
    'CREATE INDEX IF NOT EXISTS idx_bookmarks_is_last_read ON bookmarks(guide_id, is_last_read);',
  notes_guide_id: 'CREATE INDEX IF NOT EXISTS idx_notes_guide_id ON notes(guide_id);',
  achievements_game_id:
    'CREATE INDEX IF NOT EXISTS idx_achievements_game_id ON achievements(game_id);',
  achievements_is_pinned:
    'CREATE INDEX IF NOT EXISTS idx_achievements_is_pinned ON achievements(game_id, is_pinned);',
  // Fast lookup by external_id during bulk import (used in metadata JSON)
  games_external_id:
    "CREATE INDEX IF NOT EXISTS idx_games_external_id ON games(json_extract(metadata, '$.external_id'));",
  // Index for fast tag lookups (for filtering by tag)
  guide_tags_tag: 'CREATE INDEX IF NOT EXISTS idx_guide_tags_tag ON guide_tags(tag);',
  // RAG indexes
  chunks_guide_id: 'CREATE INDEX IF NOT EXISTS idx_chunks_guide_id ON chunks(guide_id);',
  game_aliases_game_id: 'CREATE INDEX IF NOT EXISTS idx_game_aliases_game_id ON game_aliases(game_id);',
  game_entities_entity: 'CREATE INDEX IF NOT EXISTS idx_game_entities_entity ON game_entities(entity);',
  game_entities_game_id: 'CREATE INDEX IF NOT EXISTS idx_game_entities_game_id ON game_entities(game_id);',
  games_canonical_group_id: 'CREATE INDEX IF NOT EXISTS idx_games_canonical_group_id ON games(canonical_group_id);',
};

// DDL for the RAG chunk-level search infrastructure. Vectors live in the ANN
// file (see `AnnIndex`), not in SQLite. The chunks_fts table backs BM25
// retrieval; chunks_fts_vocab (created in migration v5 alongside the FTS
// table) supports rare-token filtering.
// FTS5 over `games.title` for direct game-name lookup at retrieval time.
// Used by RetrievalService.extractGameCandidates to convert "<aspect> in
// <Game Name>" questions into the matching game_id, then to a guide-id set
// that gets a strong RRF boost — sidestepping the rare-token-filter issue
// where action verbs like "beat", "elite" outrank actual game-name tokens.
//
// Default tokenizer (porter unicode61) splits on whitespace + punctuation,
// so a phrase query for `"final fantasy x"` will NOT match `Final Fantasy XI`
// (token `x` ≠ token `xi`). That word-boundary behavior is the whole point
// — it's what plain `LIKE '%final fantasy x%'` can't give us.
export const GAMES_FTS_DDL = {
  gamesFts: `
    CREATE VIRTUAL TABLE IF NOT EXISTS games_fts USING fts5(
      game_id UNINDEXED,
      title,
      tokenize = 'porter unicode61'
    );
  `,

  gamesFtsInsert: `
    CREATE TRIGGER IF NOT EXISTS games_fts_insert AFTER INSERT ON games
    BEGIN
      INSERT INTO games_fts(game_id, title) VALUES (new.id, new.title);
    END;
  `,

  gamesFtsUpdate: `
    CREATE TRIGGER IF NOT EXISTS games_fts_update AFTER UPDATE OF title ON games
    BEGIN
      UPDATE games_fts SET title = new.title WHERE game_id = new.id;
    END;
  `,

  gamesFtsDelete: `
    CREATE TRIGGER IF NOT EXISTS games_fts_delete AFTER DELETE ON games
    BEGIN
      DELETE FROM games_fts WHERE game_id = old.id;
    END;
  `,
};

// Migration v6 rebuild of guides_fts_meta triggers. Indexes the *canonical*
// game title (from `games.title` via FK lookup) instead of `guides.title`.
//
// Why: after the v5 title relabel, `guides.title` is `${games.title} — ${author}`
// for guides with a clean author. That puts author tokens into the title-FTS
// index — and authors are sometimes named "Sephiroth", "Cloud", "Diablo", so
// title-FTS surfaces unrelated guides on FF7 / Diablo questions. Indexing the
// game title (without author) eliminates the leak. Display-side `guide_title`
// in citations still comes from `guides.title` and keeps the author for
// disambiguation between multiple guides for the same game.
//
// We include a `games_fts_meta_propagate_title` trigger so renaming a game
// (rare — usually only on import correction) refreshes the FTS rows for all
// linked guides.
export const TITLE_FTS_V6 = {
  guides_fts_meta_insert: `
    CREATE TRIGGER IF NOT EXISTS guides_fts_meta_insert AFTER INSERT ON guides
    BEGIN
      INSERT INTO guides_fts_meta(guide_id, title, tags)
      VALUES (
        new.id,
        COALESCE((SELECT title FROM games WHERE id = new.game_id), new.title),
        COALESCE(json_extract(new.metadata, '$.tags'), '')
      );
    END;
  `,

  guides_fts_meta_update: `
    CREATE TRIGGER IF NOT EXISTS guides_fts_meta_update AFTER UPDATE ON guides
    WHEN old.title != new.title
      OR old.metadata IS NOT new.metadata
      OR old.game_id IS NOT new.game_id
    BEGIN
      UPDATE guides_fts_meta SET
        title = COALESCE((SELECT title FROM games WHERE id = new.game_id), new.title),
        tags = COALESCE(json_extract(new.metadata, '$.tags'), '')
      WHERE guide_id = new.id;
    END;
  `,

  // Keep guides_fts_meta in sync when a game's title changes after import.
  // Updates every guide row that references the renamed game.
  games_title_propagate: `
    CREATE TRIGGER IF NOT EXISTS games_title_propagate_to_guides_fts
    AFTER UPDATE OF title ON games
    BEGIN
      UPDATE guides_fts_meta SET title = new.title
      WHERE guide_id IN (SELECT id FROM guides WHERE game_id = new.id);
    END;
  `,
};

export const RAG_DDL = {
  chunksFts: `
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      chunk_id UNINDEXED,
      content,
      tokenize = 'porter unicode61'
    );
  `,

  chunksFtsInsert: `
    CREATE TRIGGER IF NOT EXISTS chunks_fts_insert AFTER INSERT ON chunks
    BEGIN
      INSERT INTO chunks_fts(chunk_id, content) VALUES (new.id, new.content);
    END;
  `,

  chunksFtsDelete: `
    CREATE TRIGGER IF NOT EXISTS chunks_fts_delete AFTER DELETE ON chunks
    BEGIN
      DELETE FROM chunks_fts WHERE chunk_id = old.id;
    END;
  `,
};

// Split FTS architecture:
// - guides_fts_meta: title + tags (small, fast updates)
// - guides_fts_content: content only (large, only updated on insert/content change)
export const FULL_TEXT_SEARCH = {
  // FTS table for metadata (title + tags) - fast to update
  guides_fts_meta: `
    CREATE VIRTUAL TABLE IF NOT EXISTS guides_fts_meta USING fts5(
      guide_id UNINDEXED,
      title,
      tags,
      tokenize = 'porter unicode61'
    );
  `,

  // FTS table for content - only updated on insert or content change
  guides_fts_content: `
    CREATE VIRTUAL TABLE IF NOT EXISTS guides_fts_content USING fts5(
      guide_id UNINDEXED,
      content,
      tokenize = 'porter unicode61'
    );
  `,

  // Insert triggers - populate both FTS tables
  guides_fts_meta_insert: `
    CREATE TRIGGER IF NOT EXISTS guides_fts_meta_insert AFTER INSERT ON guides
    BEGIN
      INSERT INTO guides_fts_meta(guide_id, title, tags)
      VALUES (
        new.id,
        new.title,
        COALESCE(json_extract(new.metadata, '$.tags'), '')
      );
    END;
  `,

  guides_fts_content_insert: `
    CREATE TRIGGER IF NOT EXISTS guides_fts_content_insert AFTER INSERT ON guides
    BEGIN
      INSERT INTO guides_fts_content(guide_id, content)
      VALUES (new.id, new.content);
    END;
  `,

  // Update trigger for meta - fires on title or metadata change (fast)
  guides_fts_meta_update: `
    CREATE TRIGGER IF NOT EXISTS guides_fts_meta_update AFTER UPDATE ON guides
    WHEN old.title != new.title OR old.metadata != new.metadata
    BEGIN
      UPDATE guides_fts_meta SET
        title = new.title,
        tags = COALESCE(json_extract(new.metadata, '$.tags'), '')
      WHERE guide_id = new.id;
    END;
  `,

  // Update trigger for content - only fires when content changes (rare)
  guides_fts_content_update: `
    CREATE TRIGGER IF NOT EXISTS guides_fts_content_update AFTER UPDATE ON guides
    WHEN old.content != new.content
    BEGIN
      UPDATE guides_fts_content SET content = new.content
      WHERE guide_id = new.id;
    END;
  `,

  // Delete triggers - remove from both FTS tables
  guides_fts_meta_delete: `
    CREATE TRIGGER IF NOT EXISTS guides_fts_meta_delete AFTER DELETE ON guides
    BEGIN
      DELETE FROM guides_fts_meta WHERE guide_id = old.id;
    END;
  `,

  guides_fts_content_delete: `
    CREATE TRIGGER IF NOT EXISTS guides_fts_content_delete AFTER DELETE ON guides
    BEGIN
      DELETE FROM guides_fts_content WHERE guide_id = old.id;
    END;
  `,
};

// Triggers for maintaining denormalized filter lookup tables
export const FILTER_LOOKUP_TRIGGERS = {
  // Insert trigger: populate guide_tags from metadata JSON
  guide_tags_insert: `
    CREATE TRIGGER IF NOT EXISTS guide_tags_insert AFTER INSERT ON guides
    WHEN json_extract(new.metadata, '$.tags') IS NOT NULL
    BEGIN
      INSERT OR IGNORE INTO guide_tags (guide_id, tag)
      SELECT new.id, value FROM json_each(json_extract(new.metadata, '$.tags'));
    END;
  `,

  // Insert trigger: add platform to guide_platforms if new
  guide_platforms_insert: `
    CREATE TRIGGER IF NOT EXISTS guide_platforms_insert AFTER INSERT ON guides
    WHEN json_extract(new.metadata, '$.platform') IS NOT NULL
    BEGIN
      INSERT OR IGNORE INTO guide_platforms (platform)
      VALUES (json_extract(new.metadata, '$.platform'));
    END;
  `,

  // Update trigger: refresh guide_tags when metadata changes
  guide_tags_update: `
    CREATE TRIGGER IF NOT EXISTS guide_tags_update AFTER UPDATE ON guides
    WHEN old.metadata IS NOT new.metadata
    BEGIN
      DELETE FROM guide_tags WHERE guide_id = new.id;
      INSERT OR IGNORE INTO guide_tags (guide_id, tag)
      SELECT new.id, value FROM json_each(json_extract(new.metadata, '$.tags'))
      WHERE json_extract(new.metadata, '$.tags') IS NOT NULL;
    END;
  `,

  // Update trigger: add new platform to guide_platforms if needed
  guide_platforms_update: `
    CREATE TRIGGER IF NOT EXISTS guide_platforms_update AFTER UPDATE ON guides
    WHEN old.metadata IS NOT new.metadata AND json_extract(new.metadata, '$.platform') IS NOT NULL
    BEGIN
      INSERT OR IGNORE INTO guide_platforms (platform)
      VALUES (json_extract(new.metadata, '$.platform'));
    END;
  `,

  // Delete from guide_tags handled by ON DELETE CASCADE
};
