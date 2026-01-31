import { nanoid } from 'nanoid';
import DefaultDatabase from '../database/database';
import type { Note } from '../types';
import type { IDatabase } from '../interfaces/IDatabase';

export interface INoteModel {
  create(data: Omit<Note, 'id' | 'created_at' | 'updated_at'>): Note;
  findById(id: string): Note | null;
  findByGuideId(guideId: string): Note[];
  update(id: string, data: Partial<Pick<Note, 'position' | 'content'>>): boolean;
  delete(id: string): boolean;
  deleteByGuideId(guideId: string): number;
}

export class NoteModel implements INoteModel {
  constructor(private db: IDatabase = DefaultDatabase) {}

  create(data: Omit<Note, 'id' | 'created_at' | 'updated_at'>): Note {
    const now = Date.now();
    const note: Note = {
      id: nanoid(),
      ...data,
      created_at: now,
      updated_at: now,
    };

    this.db.run(
      `INSERT INTO notes (id, guide_id, position, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        note.id,
        note.guide_id,
        note.position ?? null,
        note.content,
        note.created_at,
        note.updated_at,
      ]
    );

    return note;
  }

  findById(id: string): Note | null {
    const result = this.db.get<Note>('SELECT * FROM notes WHERE id = ?', [id]);
    return result ?? null;
  }

  findByGuideId(guideId: string): Note[] {
    return this.db.query<Note>(
      'SELECT * FROM notes WHERE guide_id = ? ORDER BY position ASC NULLS LAST, created_at ASC',
      [guideId]
    );
  }

  private static readonly ALLOWED_UPDATE_KEYS = new Set(['position', 'content']);

  update(id: string, data: Partial<Pick<Note, 'position' | 'content'>>): boolean {
    const fields: string[] = [];
    const values: any[] = [];

    Object.entries(data).forEach(([key, value]) => {
      if (NoteModel.ALLOWED_UPDATE_KEYS.has(key)) {
        fields.push(`${key} = ?`);
        values.push(value);
      }
    });

    if (fields.length === 0) return false;

    fields.push('updated_at = ?');
    values.push(Date.now());

    values.push(id);

    const result = this.db.run(
      `UPDATE notes SET ${fields.join(', ')} WHERE id = ?`,
      values
    );

    return result.changes > 0;
  }

  delete(id: string): boolean {
    const result = this.db.run('DELETE FROM notes WHERE id = ?', [id]);
    return result.changes > 0;
  }

  deleteByGuideId(guideId: string): number {
    const result = this.db.run('DELETE FROM notes WHERE guide_id = ?', [guideId]);
    return result.changes;
  }
}

export function createNoteModel(db: IDatabase): INoteModel {
  return new NoteModel(db);
}

export default new NoteModel();
