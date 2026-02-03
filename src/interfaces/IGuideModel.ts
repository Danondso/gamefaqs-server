import type { Guide, GuideMetadata } from '../types';

export interface SearchResults {
  guides: Guide[];
  content: Guide[];
}

export interface GuideFilters {
  platform?: string;
  tags?: string[];
  tagMatch?: 'any' | 'all';
}

export interface IGuideModel {
  create(data: Omit<Guide, 'id' | 'created_at' | 'updated_at'>): Guide;
  findById(id: string): Guide | null;
  findAll(limit?: number, offset?: number): Guide[];
  findByGameId(gameId: string): Guide[];
  update(id: string, data: Partial<Omit<Guide, 'id' | 'created_at'>>): boolean;
  updateLastReadPosition(id: string, position: number): boolean;
  delete(id: string): boolean;
  search(query: string, limit?: number): SearchResults;
  searchCombined(query: string, limit?: number): Guide[];
  getMetadata(id: string): GuideMetadata | null;
  setMetadata(id: string, metadata: GuideMetadata): boolean;
  getTotalCount(): number;
  getRecentlyRead(limit?: number): Guide[];
  bulkCreate(guides: Array<Omit<Guide, 'id' | 'created_at' | 'updated_at'>>): void;
  findMissingMetadata(limit?: number): Guide[];
  findMissingTags(limit?: number): Guide[];
  findMissingSummary(limit?: number): Guide[];
  findAllWithGames(): Array<{ guide: Guide; game: any | null }>;
  findAllSummary(limit?: number, offset?: number): Array<Omit<Guide, 'content'> & { content_length: number }>;
  findAllSummaryFiltered(filters: GuideFilters, limit?: number, offset?: number): Array<Omit<Guide, 'content'> & { content_length: number }>;
  getFilteredCount(filters: GuideFilters): number;
  getDistinctPlatforms(): string[];
  getDistinctTags(): string[];
}
