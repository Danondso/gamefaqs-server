import { nanoid } from 'nanoid';
import DefaultDatabase from '../database/database';
import type { Game, GameMetadata } from '../types';
import type { IDatabase } from '../interfaces/IDatabase';
import type { IGameModel } from '../interfaces/IGameModel';

export class GameModel implements IGameModel {
  constructor(private db: IDatabase = DefaultDatabase) {}

  create(data: Omit<Game, 'id' | 'created_at' | 'updated_at' | 'completion_percentage' | 'status'> & {
    completion_percentage?: number;
    status?: Game['status'];
  }): Game {
    const now = Date.now();
    const game: Game = {
      ...data,
      id: nanoid(),
      completion_percentage: data.completion_percentage ?? 0,
      status: data.status ?? 'not_started',
      created_at: now,
      updated_at: now,
    };

    this.db.run(
      `INSERT INTO games (id, title, ra_game_id, platform, completion_percentage, status, artwork_url, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        game.id,
        game.title,
        game.ra_game_id ?? null,
        game.platform ?? null,
        game.completion_percentage,
        game.status,
        game.artwork_url ?? null,
        game.metadata ?? null,
        game.created_at,
        game.updated_at,
      ]
    );

    return game;
  }

  findById(id: string): Game | null {
    const result = this.db.get<Game>('SELECT * FROM games WHERE id = ?', [id]);
    return result ?? null;
  }

  findByRAGameId(raGameId: string): Game | null {
    const result = this.db.get<Game>('SELECT * FROM games WHERE ra_game_id = ?', [raGameId]);
    return result ?? null;
  }

  findAll(limit = 100, offset = 0): Game[] {
    return this.db.query<Game>(
      'SELECT * FROM games ORDER BY title ASC LIMIT ? OFFSET ?',
      [limit, offset]
    );
  }

  findByStatus(status: Game['status']): Game[] {
    return this.db.query<Game>(
      'SELECT * FROM games WHERE status = ? ORDER BY updated_at DESC',
      [status]
    );
  }

  getInProgress(): Game[] {
    return this.findByStatus('in_progress');
  }

  getCompleted(): Game[] {
    return this.findByStatus('completed');
  }

  update(id: string, data: Partial<Omit<Game, 'id' | 'created_at'>>): boolean {
    const fields: string[] = [];
    const values: any[] = [];

    Object.entries(data).forEach(([key, value]) => {
      if (key !== 'id' && key !== 'created_at') {
        fields.push(`${key} = ?`);
        values.push(value);
      }
    });

    fields.push('updated_at = ?');
    values.push(Date.now());

    values.push(id);

    const result = this.db.run(
      `UPDATE games SET ${fields.join(', ')} WHERE id = ?`,
      values
    );

    return result.changes > 0;
  }

  updateStatus(id: string, status: Game['status']): boolean {
    return this.update(id, { status });
  }

  updateCompletionPercentage(id: string, percentage: number): boolean {
    const clampedPercentage = Math.max(0, Math.min(100, percentage));

    const status: Game['status'] =
      clampedPercentage === 0
        ? 'not_started'
        : clampedPercentage === 100
          ? 'completed'
          : 'in_progress';

    return this.update(id, {
      completion_percentage: clampedPercentage,
      status,
    });
  }

  delete(id: string): boolean {
    const result = this.db.run('DELETE FROM games WHERE id = ?', [id]);
    return result.changes > 0;
  }

  getMetadata(id: string): GameMetadata | null {
    const game = this.findById(id);
    if (!game?.metadata) return null;

    try {
      return JSON.parse(game.metadata);
    } catch {
      return null;
    }
  }

  setMetadata(id: string, metadata: GameMetadata): boolean {
    return this.update(id, {
      metadata: JSON.stringify(metadata),
    });
  }

  getTotalCount(): number {
    const result = this.db.get<{ count: number }>('SELECT COUNT(*) as count FROM games');
    return result?.count ?? 0;
  }

  getWithGuideCount(): Array<Game & { guide_count: number }> {
    return this.db.query<Game & { guide_count: number }>(`
      SELECT g.*, COUNT(gu.id) as guide_count
      FROM games g
      LEFT JOIN guides gu ON g.id = gu.game_id
      GROUP BY g.id
      ORDER BY g.title ASC
    `);
  }

  searchByTitle(query: string): Game[] {
    return this.db.query<Game>(
      'SELECT * FROM games WHERE title LIKE ? ORDER BY title ASC LIMIT 50',
      [`%${query}%`]
    );
  }

  bulkCreate(games: Array<Omit<Game, 'id' | 'created_at' | 'updated_at' | 'completion_percentage' | 'status'> & {
    completion_percentage?: number;
    status?: Game['status'];
  }>): void {
    this.db.transaction(() => {
      for (const gameData of games) {
        this.create(gameData);
      }
    });
  }

  findByExternalId(externalId: string): Game | null {
    const result = this.db.get<Game>(
      "SELECT * FROM games WHERE json_extract(metadata, '$.external_id') = ? LIMIT 1",
      [externalId]
    );
    return result ?? null;
  }
}

// Factory function for creating model instances (for testing)
export function createGameModel(db: IDatabase): IGameModel {
  return new GameModel(db);
}

// Default singleton instance for backward compatibility
export default new GameModel();
