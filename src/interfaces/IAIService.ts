import type { GuideMetadata } from '../types';

export interface OllamaModel {
  name: string;
  size: number;
  modified_at: string;
}

export interface OllamaStatus {
  available: boolean;
  host: string;
  models?: OllamaModel[];
  error?: string;
}

export interface AIAnalysisResult {
  gameName?: string;
  platform?: string;
  author?: string;
  tags?: string[];
  summary?: string;
}

export interface BatchProgress {
  status: 'idle' | 'running' | 'stopping' | 'complete' | 'error';
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  currentGuideId?: string;
  currentGuideTitle?: string;
  message: string;
  error?: string;
}

export interface YoloProgress {
  status: 'idle' | 'running' | 'stopping' | 'complete' | 'error';
  processed: number;
  succeeded: number;
  failed: number;
  currentGuideId?: string;
  currentGuideTitle?: string;
  message: string;
  error?: string;
  startedAt?: number;
}

export type BatchProgressCallback = (progress: BatchProgress) => void;
export type YoloProgressCallback = (progress: YoloProgress) => void;

export interface IAIService {
  getHost(): string;
  setHost(host: string): void;
  getModel(): string;
  setModel(model: string): void;
  checkAvailability(): Promise<OllamaStatus>;
  getModels(): Promise<OllamaModel[]>;
  extractMetadata(content: string, title: string): Promise<Partial<AIAnalysisResult>>;
  generateSummary(content: string, title: string): Promise<string | undefined>;
  analyzeGuide(content: string, title: string, existingMetadata?: GuideMetadata): Promise<AIAnalysisResult>;
  analyzeBatch(
    guides: Array<{ id: string; title: string; content: string; metadata?: string }>,
    onProgress?: BatchProgressCallback
  ): Promise<{ succeeded: number; failed: number; results: Array<{ id: string; error?: string }> }>;
  stopBatch(): void;
  getBatchProgress(): BatchProgress;
  isBatchRunning(): boolean;
  onProgressChange(callback: BatchProgressCallback): () => void;
  startYoloMode(
    getNextGuide: () => { id: string; title: string; content: string; metadata?: string | null } | null,
    saveMetadata: (id: string, metadata: GuideMetadata) => void
  ): Promise<void>;
  stopYolo(): void;
  getYoloProgress(): YoloProgress;
  isYoloRunning(): boolean;
  onYoloProgressChange(callback: YoloProgressCallback): () => void;
}
