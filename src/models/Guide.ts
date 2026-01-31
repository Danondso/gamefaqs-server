import { nanoid } from 'nanoid';
import DefaultDatabase from '../database/database';
import type { Guide, GuideMetadata } from '../types';
import type { IDatabase } from '../interfaces/IDatabase';
import type { IGuideModel, SearchResults } from '../interfaces/IGuideModel';

interface FTSResult {
  guide_id: string;
  rank: number;
}

export { SearchResults };

export class GuideModel implements IGuideModel {
  constructor(private db: IDatabase = DefaultDatabase) {}

  create(data: Omit<Guide, 'id' | 'created_at' | 'updated_at'>): Guide {
    const now = Date.now();
    const guide: Guide = {
      id: nanoid(),
      ...data,
      created_at: now,
      updated_at: now,
    };

    this.db.run(
      `INSERT INTO guides (id, title, content, format, file_path, game_id, last_read_position, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        guide.id,
        guide.title,
        guide.content,
        guide.format,
        guide.file_path,
        guide.game_id ?? null,
        guide.last_read_position ?? null,
        guide.metadata ?? null,
        guide.created_at,
        guide.updated_at,
      ]
    );

    return guide;
  }

  findById(id: string): Guide | null {
    const result = this.db.get<Guide>('SELECT * FROM guides WHERE id = ?', [id]);
    return result ?? null;
  }

  findAll(limit = 100, offset = 0): Guide[] {
    return this.db.query<Guide>(
      'SELECT * FROM guides ORDER BY updated_at DESC LIMIT ? OFFSET ?',
      [limit, offset]
    );
  }

  findByGameId(gameId: string): Guide[] {
    return this.db.query<Guide>(
      'SELECT * FROM guides WHERE game_id = ? ORDER BY title ASC',
      [gameId]
    );
  }

  /** Allowed column names for UPDATE (prevents SQL injection from untrusted keys) */
  private static readonly ALLOWED_UPDATE_KEYS = new Set([
    'title',
    'content',
    'format',
    'file_path',
    'game_id',
    'last_read_position',
    'metadata',
    'ai_analyzed_at',
    'updated_at',
  ]);

  update(id: string, data: Partial<Omit<Guide, 'id' | 'created_at'>>): boolean {
    const fields: string[] = [];
    const values: any[] = [];

    // Build dynamic update query using allowlist only (prevents SQL injection)
    Object.entries(data).forEach(([key, value]) => {
      if (GuideModel.ALLOWED_UPDATE_KEYS.has(key)) {
        fields.push(`${key} = ?`);
        values.push(value);
      }
    });

    if (fields.length === 0) return false;

    // Always update updated_at
    fields.push('updated_at = ?');
    values.push(Date.now());

    // Add id for WHERE clause
    values.push(id);

    const result = this.db.run(
      `UPDATE guides SET ${fields.join(', ')} WHERE id = ?`,
      values
    );

    return result.changes > 0;
  }

  updateLastReadPosition(id: string, position: number): boolean {
    return this.update(id, { last_read_position: position });
  }

  delete(id: string): boolean {
    const result = this.db.run('DELETE FROM guides WHERE id = ?', [id]);
    return result.changes > 0;
  }

  search(query: string, limit = 50): SearchResults {
    // Search metadata FTS (title + tags)
    const metaResults = this.db.query<FTSResult>(
      `SELECT guide_id, rank FROM guides_fts_meta WHERE guides_fts_meta MATCH ? ORDER BY rank LIMIT ?`,
      [query, limit]
    );

    // Search content FTS
    const contentResults = this.db.query<FTSResult>(
      `SELECT guide_id, rank FROM guides_fts_content WHERE guides_fts_content MATCH ? ORDER BY rank LIMIT ?`,
      [query, limit]
    );

    // Helper to fetch guides by IDs
    const fetchGuides = (ids: string[]): Guide[] => {
      if (ids.length === 0) return [];
      const placeholders = ids.map(() => '?').join(',');
      return this.db.query<Guide>(
        `SELECT * FROM guides WHERE id IN (${placeholders})`,
        ids
      );
    };

    // Get guide IDs, excluding content matches that also matched on metadata
    const metaIds = metaResults.map(r => r.guide_id);
    const metaIdSet = new Set(metaIds);
    const contentOnlyIds = contentResults
      .map(r => r.guide_id)
      .filter(id => !metaIdSet.has(id));

    return {
      guides: fetchGuides(metaIds),
      content: fetchGuides(contentOnlyIds),
    };
  }

  searchCombined(query: string, limit = 50): Guide[] {
    const results = this.search(query, limit);
    // Combine and dedupe
    const seen = new Set<string>();
    const combined: Guide[] = [];
    for (const guide of [...results.guides, ...results.content]) {
      if (!seen.has(guide.id)) {
        seen.add(guide.id);
        combined.push(guide);
      }
    }
    return combined;
  }

  getMetadata(id: string): GuideMetadata | null {
    const guide = this.findById(id);
    if (!guide?.metadata) return null;

    try {
      return JSON.parse(guide.metadata);
    } catch {
      return null;
    }
  }

  setMetadata(id: string, metadata: GuideMetadata): boolean {
    // If metadata contains aiAnalyzedAt, also update the indexed column
    const updateData: Partial<Guide> = {
      metadata: JSON.stringify(metadata),
    };
    if (metadata.aiAnalyzedAt) {
      updateData.ai_analyzed_at = metadata.aiAnalyzedAt;
    }
    return this.update(id, updateData);
  }

  getTotalCount(): number {
    const result = this.db.get<{ count: number }>('SELECT COUNT(*) as count FROM guides');
    return result?.count ?? 0;
  }

  getRecentlyRead(limit = 10): Guide[] {
    return this.db.query<Guide>(
      'SELECT * FROM guides WHERE last_read_position IS NOT NULL ORDER BY updated_at DESC LIMIT ?',
      [limit]
    );
  }

  bulkCreate(guides: Array<Omit<Guide, 'id' | 'created_at' | 'updated_at'>>): void {
    this.db.transaction(() => {
      for (const guideData of guides) {
        this.create(guideData);
      }
    });
  }

  findMissingMetadata(limit = 100): Guide[] {
    return this.db.query<Guide>(
      `SELECT * FROM guides
       WHERE metadata IS NULL
          OR json_extract(metadata, '$.aiAnalyzedAt') IS NULL
       ORDER BY updated_at DESC
       LIMIT ?`,
      [limit]
    );
  }

  findMissingTags(limit = 100): Guide[] {
    return this.db.query<Guide>(
      `SELECT * FROM guides
       WHERE metadata IS NULL
          OR json_extract(metadata, '$.tags') IS NULL
          OR json_array_length(json_extract(metadata, '$.tags')) = 0
       ORDER BY updated_at DESC
       LIMIT ?`,
      [limit]
    );
  }

  findMissingSummary(limit = 100): Guide[] {
    return this.db.query<Guide>(
      `SELECT * FROM guides
       WHERE metadata IS NULL
          OR json_extract(metadata, '$.summary') IS NULL
          OR json_extract(metadata, '$.summary') = ''
       ORDER BY updated_at DESC
       LIMIT ?`,
      [limit]
    );
  }

  findAllWithGames(): Array<{ guide: Guide; game: any | null }> {
    const results = this.db.query<any>(
      `SELECT
        g.*,
        games.id as game_id_val,
        games.title as game_title,
        games.platform as game_platform,
        games.artwork_url as game_artwork_url
      FROM guides g
      LEFT JOIN games ON g.game_id = games.id
      ORDER BY g.updated_at DESC`
    );

    return results.map(row => ({
      guide: {
        id: row.id,
        title: row.title,
        content: row.content,
        format: row.format,
        file_path: row.file_path,
        game_id: row.game_id,
        last_read_position: row.last_read_position,
        metadata: row.metadata,
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
      game: row.game_id_val ? {
        id: row.game_id_val,
        title: row.game_title,
        platform: row.game_platform,
        artwork_url: row.game_artwork_url,
      } : null,
    }));
  }

  findAllSummary(limit = 100, offset = 0): Array<Omit<Guide, 'content'> & { content_length: number }> {
    return this.db.query<Omit<Guide, 'content'> & { content_length: number }>(
      `SELECT id, title, format, file_path, game_id, last_read_position, metadata,
              created_at, updated_at, LENGTH(content) as content_length
       FROM guides ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      [limit, offset]
    );
  }
}

// Factory function for creating model instances (for testing)
export function createGuideModel(db: IDatabase): IGuideModel {
  return new GuideModel(db);
}

// Default singleton instance for backward compatibility
export default new GuideModel();
