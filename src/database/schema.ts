// SQLite database schema definitions
// Ported from gamefaqs-reader mobile app

export const SCHEMA_VERSION = 7;

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
      ra_game_id TEXT UNIQUE,
      platform TEXT,
      completion_percentage REAL DEFAULT 0 CHECK(completion_percentage >= 0 AND completion_percentage <= 100),
      status TEXT NOT NULL DEFAULT 'not_started' CHECK(status IN ('in_progress', 'completed', 'not_started')),
      artwork_url TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
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
};

export const CREATE_INDEXES = {
  guides_game_id: 'CREATE INDEX IF NOT EXISTS idx_guides_game_id ON guides(game_id);',
  guides_created_at: 'CREATE INDEX IF NOT EXISTS idx_guides_created_at ON guides(created_at);',
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
