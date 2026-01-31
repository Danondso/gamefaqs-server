import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDatabase } from '../../helpers/testDb';
import type { IDatabase } from '../../../src/interfaces/IDatabase';

describe('Database', () => {
  let db: IDatabase;

  beforeEach(() => {
    db = createTestDatabase();
  });

  afterEach(() => {
    db.close();
  });

  describe('initialization', () => {
    it('should create all required tables', () => {
      const tables = db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      );
      const tableNames = tables.map(t => t.name);

      expect(tableNames).toContain('guides');
      expect(tableNames).toContain('games');
      expect(tableNames).toContain('bookmarks');
      expect(tableNames).toContain('notes');
      expect(tableNames).toContain('achievements');
      expect(tableNames).toContain('schema_version');
    });

    it('should create FTS tables for search', () => {
      const tables = db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'guides_fts%'"
      );
      const tableNames = tables.map(t => t.name);

      expect(tableNames).toContain('guides_fts_meta');
      expect(tableNames).toContain('guides_fts_content');
    });

    it('should record schema version', () => {
      const version = db.get<{ version: number }>('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1');
      expect(version?.version).toBe(2);
    });
  });

  describe('FTS triggers', () => {
    // These test OUR trigger logic, not SQLite itself

    it('should populate FTS meta table on guide insert', () => {
      const now = Date.now();

      db.run(
        'INSERT INTO guides (id, title, content, format, file_path, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ['guide-1', 'Pokemon Strategy Guide', 'How to catch Pikachu', 'txt', '/path/to/guide.txt', '{"tags": ["pokemon", "tips"]}', now, now]
      );

      const metaResult = db.get<{ guide_id: string; title: string }>('SELECT guide_id, title FROM guides_fts_meta WHERE guide_id = ?', ['guide-1']);
      expect(metaResult?.guide_id).toBe('guide-1');
      expect(metaResult?.title).toBe('Pokemon Strategy Guide');
    });

    it('should populate FTS content table on guide insert', () => {
      const now = Date.now();

      db.run(
        'INSERT INTO guides (id, title, content, format, file_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['guide-1', 'Test Guide', 'Searchable content here', 'txt', '/path/to/guide.txt', now, now]
      );

      const contentResult = db.get<{ guide_id: string }>('SELECT guide_id FROM guides_fts_content WHERE content MATCH ?', ['Searchable']);
      expect(contentResult?.guide_id).toBe('guide-1');
    });

    it('should update FTS meta on title change', () => {
      const now = Date.now();

      db.run(
        'INSERT INTO guides (id, title, content, format, file_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['guide-1', 'Original Title', 'Content', 'txt', '/path/to/guide.txt', now, now]
      );

      db.run('UPDATE guides SET title = ?, metadata = ? WHERE id = ?', ['Updated Title', '{"tags": ["new"]}', 'guide-1']);

      const result = db.get<{ title: string }>('SELECT title FROM guides_fts_meta WHERE guide_id = ?', ['guide-1']);
      expect(result?.title).toBe('Updated Title');
    });

    it('should remove from FTS on guide delete', () => {
      const now = Date.now();

      db.run(
        'INSERT INTO guides (id, title, content, format, file_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['guide-1', 'Test Guide', 'Test content', 'txt', '/path/to/guide.txt', now, now]
      );

      db.run('DELETE FROM guides WHERE id = ?', ['guide-1']);

      const metaResult = db.get<{ guide_id: string }>('SELECT guide_id FROM guides_fts_meta WHERE guide_id = ?', ['guide-1']);
      expect(metaResult).toBeUndefined();

      const contentResult = db.get<{ guide_id: string }>('SELECT guide_id FROM guides_fts_content WHERE guide_id = ?', ['guide-1']);
      expect(contentResult).toBeUndefined();
    });
  });

  describe('schema constraints', () => {
    // Test constraints we defined in schema.ts

    it('should enforce guide format constraint', () => {
      const now = Date.now();

      expect(() => {
        db.run(
          'INSERT INTO guides (id, title, content, format, file_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          ['guide-1', 'Test', 'Content', 'invalid_format', '/path', now, now]
        );
      }).toThrow();
    });

    it('should enforce game status constraint', () => {
      const now = Date.now();

      expect(() => {
        db.run(
          'INSERT INTO games (id, title, status, completion_percentage, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          ['game-1', 'Test', 'invalid_status', 0, now, now]
        );
      }).toThrow();
    });

    it('should enforce completion_percentage range', () => {
      const now = Date.now();

      expect(() => {
        db.run(
          'INSERT INTO games (id, title, status, completion_percentage, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          ['game-1', 'Test', 'not_started', 150, now, now]
        );
      }).toThrow();
    });
  });
});
