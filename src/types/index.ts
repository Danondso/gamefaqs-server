// Database entity types

export interface Guide {
  id: string;
  title: string;
  content: string;
  format: 'txt' | 'html' | 'md' | 'pdf';
  file_path: string;
  game_id?: string | null;
  last_read_position?: number | null;
  metadata?: string | null; // JSON string for tags, platform, etc.
  ai_analyzed_at?: number | null; // Timestamp when AI analysis was performed
  created_at: number;
  updated_at: number;
}

export interface Game {
  id: string;
  title: string;
  ra_game_id?: string | null; // RetroAchievements game ID
  platform?: string | null;
  completion_percentage: number;
  status: 'in_progress' | 'completed' | 'not_started';
  artwork_url?: string | null;
  metadata?: string | null; // JSON string for additional data
  created_at: number;
  updated_at: number;
}

export interface Bookmark {
  id: string;
  guide_id: string;
  position: number;
  name?: string | null;
  page_reference?: string | null;
  is_last_read: boolean;
  created_at: number;
}

export interface Note {
  id: string;
  guide_id: string;
  position?: number | null;
  content: string;
  created_at: number;
  updated_at: number;
}

export interface Achievement {
  id: string;
  ra_achievement_id: string;
  game_id: string;
  title: string;
  description: string;
  points?: number | null;
  badge_url?: string | null;
  is_pinned: boolean;
  is_unlocked: boolean;
  unlock_time?: number | null;
  created_at: number;
  updated_at: number;
}

// Metadata types
export interface GuideMetadata {
  platform?: string;
  genre?: string;
  author?: string;
  version?: string;
  tags?: string[];
  // AI-generated fields
  summary?: string;
  gameName?: string;
  aiAnalyzedAt?: number;
  aiAnalysisError?: string;
}

export interface GameMetadata {
  external_id?: string;
  genre?: string;
  release_year?: number;
  developer?: string;
  guide_count?: number;
}

// Parsed guide result
export interface ParsedGuide {
  title: string;
  content: string;
  format: 'txt' | 'html' | 'md' | 'pdf';
  metadata: GuideMetadata;
}

// Progress types for services
export interface DownloadProgress {
  downloaded: number;
  total: number;
  percentage: number;
}

export interface ExtractionProgress {
  totalArchives: number;
  currentArchive: number;
  currentArchiveName: string;
  currentArchiveProgress: number;
  totalFiles: number;
  extractedFiles: number;
  status: 'idle' | 'extracting' | 'complete' | 'error';
  error?: string;
}

export interface ImportProgress {
  total: number;
  current: number;
  currentFile: string;
  status: 'idle' | 'scanning' | 'importing' | 'indexing' | 'complete' | 'error' | 'extracting';
  error?: string;
}

export interface InitStatus {
  stage: 'idle' | 'downloading' | 'extracting' | 'importing' | 'complete' | 'error';
  progress: number; // 0-100
  message: string;
  guideCount: number;
  gameCount: number;
  startTime?: number;
  error?: string;
}

// Callback types
export type DownloadProgressCallback = (progress: DownloadProgress) => void;
export type ExtractionProgressCallback = (progress: ExtractionProgress) => void;
export type ImportProgressCallback = (progress: ImportProgress) => void;
export type InitStatusCallback = (status: InitStatus) => void;
