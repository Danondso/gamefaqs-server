import type { Game, GameMetadata } from '../types';

export interface IGameModel {
  create(data: Omit<Game, 'id' | 'created_at' | 'updated_at' | 'completion_percentage' | 'status'> & {
    completion_percentage?: number;
    status?: Game['status'];
  }): Game;
  findById(id: string): Game | null;
  findByRAGameId(raGameId: string): Game | null;
  findAll(limit?: number, offset?: number): Game[];
  findByStatus(status: Game['status']): Game[];
  getInProgress(): Game[];
  getCompleted(): Game[];
  update(id: string, data: Partial<Omit<Game, 'id' | 'created_at'>>): boolean;
  updateStatus(id: string, status: Game['status']): boolean;
  updateCompletionPercentage(id: string, percentage: number): boolean;
  delete(id: string): boolean;
  getMetadata(id: string): GameMetadata | null;
  setMetadata(id: string, metadata: GameMetadata): boolean;
  getTotalCount(): number;
  getWithGuideCount(): Array<Game & { guide_count: number }>;
  searchByTitle(query: string): Game[];
  bulkCreate(games: Array<Omit<Game, 'id' | 'created_at' | 'updated_at' | 'completion_percentage' | 'status'> & {
    completion_percentage?: number;
    status?: Game['status'];
  }>): void;
  findByExternalId(externalId: string): Game | null;
}
