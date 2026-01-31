import { nanoid } from 'nanoid';
import DefaultDatabase from '../database/database';
import type { Bookmark } from '../types';
import type { IDatabase } from '../interfaces/IDatabase';

export interface IBookmarkModel {
  create(data: Omit<Bookmark, 'id' | 'created_at'>): Bookmark;
  findById(id: string): Bookmark | null;
  findByGuideId(guideId: string): Bookmark[];
  delete(id: string): boolean;
  deleteByGuideId(guideId: string): number;
}

export class BookmarkModel implements IBookmarkModel {
  constructor(private db: IDatabase = DefaultDatabase) {}

  create(data: Omit<Bookmark, 'id' | 'created_at'>): Bookmark {
    const now = Date.now();
    const bookmark: Bookmark = {
      id: nanoid(),
      ...data,
      created_at: now,
    };

    this.db.run(
      `INSERT INTO bookmarks (id, guide_id, position, name, page_reference, is_last_read, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        bookmark.id,
        bookmark.guide_id,
        bookmark.position,
        bookmark.name ?? null,
        bookmark.page_reference ?? null,
        bookmark.is_last_read ? 1 : 0,
        bookmark.created_at,
      ]
    );

    return bookmark;
  }

  findById(id: string): Bookmark | null {
    const result = this.db.get<any>('SELECT * FROM bookmarks WHERE id = ?', [id]);
    if (!result) return null;

    return {
      ...result,
      is_last_read: Boolean(result.is_last_read),
    };
  }

  findByGuideId(guideId: string): Bookmark[] {
    const results = this.db.query<any>(
      'SELECT * FROM bookmarks WHERE guide_id = ? ORDER BY position ASC',
      [guideId]
    );

    return results.map(row => ({
      ...row,
      is_last_read: Boolean(row.is_last_read),
    }));
  }

  delete(id: string): boolean {
    const result = this.db.run('DELETE FROM bookmarks WHERE id = ?', [id]);
    return result.changes > 0;
  }

  deleteByGuideId(guideId: string): number {
    const result = this.db.run('DELETE FROM bookmarks WHERE guide_id = ?', [guideId]);
    return result.changes;
  }
}

export function createBookmarkModel(db: IDatabase): IBookmarkModel {
  return new BookmarkModel(db);
}

export default new BookmarkModel();
