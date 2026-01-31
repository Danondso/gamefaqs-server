import { config } from '../config';
import type { GuideMetadata } from '../types';

// Runtime-configurable Ollama settings
let ollamaHost: string = config.ollamaHost;
let ollamaModel: string = config.ollamaModel;

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

const METADATA_EXTRACTION_PROMPT = `You are analyzing a video game guide. Extract the following information from the guide content and return ONLY valid JSON with no additional text:

{
  "gameName": "the name of the game this guide is for",
  "platform": "the gaming platform (e.g., PlayStation, Xbox, PC, Nintendo, etc.)",
  "author": "the guide author's name if mentioned",
  "tags": ["array", "of", "relevant", "tags", "like", "walkthrough", "FAQ", "cheats", "etc"]
}

Rules:
- Return ONLY the JSON object, no explanations
- If a field cannot be determined, use null
- Tags should be lowercase and relevant to the content type
- Keep gameName as the official game title`;

const SUMMARY_PROMPT = `You are analyzing a video game guide. Write a 2-3 sentence summary describing what this guide covers and what a reader can expect to learn from it.

Rules:
- Be concise and informative
- Mention the game name if apparent
- Describe the main topics covered
- Return ONLY the summary text, nothing else`;

class OllamaService {
  private batchProgress: BatchProgress = {
    status: 'idle',
    total: 0,
    processed: 0,
    succeeded: 0,
    failed: 0,
    message: 'Idle',
  };

  private yoloProgress: YoloProgress = {
    status: 'idle',
    processed: 0,
    succeeded: 0,
    failed: 0,
    message: 'Idle',
  };

  private batchListeners: Array<BatchProgressCallback> = [];
  private yoloListeners: Array<YoloProgressCallback> = [];
  private stopRequested = false;
  private yoloStopRequested = false;

  /**
   * Get current Ollama host URL
   */
  getHost(): string {
    return ollamaHost;
  }

  /**
   * Set Ollama host URL (runtime configuration)
   */
  setHost(host: string): void {
    ollamaHost = host;
    console.log(`[OllamaService] Host changed to: ${host}`);
  }

  /**
   * Get current model name
   */
  getModel(): string {
    return ollamaModel;
  }

  /**
   * Set model name (runtime configuration)
   */
  setModel(model: string): void {
    ollamaModel = model;
    console.log(`[OllamaService] Model changed to: ${model}`);
  }

  /**
   * Create a fetch with timeout using AbortController
   */
  private async fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 5000): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      return response;
    } catch (error: any) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error('TIMEOUT');
      }
      throw error;
    }
  }

  /**
   * Check if Ollama is available and get model list
   */
  async checkAvailability(): Promise<OllamaStatus> {
    console.log(`[OllamaService] Checking availability at ${ollamaHost}...`);

    try {
      const response = await this.fetchWithTimeout(
        `${ollamaHost}/api/tags`,
        {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
        },
        3000
      );

      console.log(`[OllamaService] Got response: ${response.status}`);

      if (!response.ok) {
        return {
          available: false,
          host: ollamaHost,
          error: `HTTP ${response.status}: ${response.statusText}`,
        };
      }

      const data = await response.json() as { models?: OllamaModel[] };
      console.log(`[OllamaService] Available with ${data.models?.length || 0} models`);
      return {
        available: true,
        host: ollamaHost,
        models: data.models || [],
      };
    } catch (error: any) {
      console.log(`[OllamaService] Error: ${error.message} (code: ${error.code})`);

      let errorMessage = error.message;
      if (error.message === 'TIMEOUT') {
        errorMessage = 'Connection timeout - is Ollama running?';
      } else if (error.code === 'ECONNREFUSED') {
        errorMessage = 'Connection refused - is Ollama running?';
      } else if (error.cause?.code === 'ECONNREFUSED') {
        errorMessage = 'Connection refused - is Ollama running?';
      }

      return {
        available: false,
        host: ollamaHost,
        error: errorMessage,
      };
    }
  }

  /**
   * Get list of available models
   */
  async getModels(): Promise<OllamaModel[]> {
    const status = await this.checkAvailability();
    return status.models || [];
  }

  /**
   * Generate a completion from Ollama
   */
  private async generate(prompt: string, content: string): Promise<string> {
    // Longer timeout for generation (60 seconds)
    const response = await this.fetchWithTimeout(
      `${ollamaHost}/api/generate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: ollamaModel,
          prompt: `${prompt}\n\nGuide content (first 8000 characters):\n${content.slice(0, 8000)}`,
          stream: false,
          options: {
            temperature: 0.3,
            num_predict: 500,
          },
        }),
      },
      60000
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as { response?: string };
    return data.response || '';
  }

  /**
   * Extract metadata from a guide using AI
   */
  async extractMetadata(content: string, title: string): Promise<Partial<AIAnalysisResult>> {
    try {
      const contextContent = `Title: ${title}\n\n${content}`;
      const response = await this.generate(METADATA_EXTRACTION_PROMPT, contextContent);

      // Try to parse JSON from response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          gameName: parsed.gameName || undefined,
          platform: parsed.platform || undefined,
          author: parsed.author || undefined,
          tags: Array.isArray(parsed.tags) ? parsed.tags.filter((t: any) => typeof t === 'string') : undefined,
        };
      }

      console.warn('[OllamaService] Could not parse metadata JSON from response');
      return {};
    } catch (error: any) {
      console.error('[OllamaService] Metadata extraction failed:', error.message);
      throw error;
    }
  }

  /**
   * Generate a summary for a guide
   */
  async generateSummary(content: string, title: string): Promise<string | undefined> {
    try {
      const contextContent = `Title: ${title}\n\n${content}`;
      const response = await this.generate(SUMMARY_PROMPT, contextContent);
      const summary = response.trim();
      return summary.length > 0 ? summary : undefined;
    } catch (error: any) {
      console.error('[OllamaService] Summary generation failed:', error.message);
      throw error;
    }
  }

  /**
   * Analyze a guide - extract metadata and generate summary
   */
  async analyzeGuide(
    content: string,
    title: string,
    existingMetadata?: GuideMetadata
  ): Promise<AIAnalysisResult> {
    const result: AIAnalysisResult = {};

    // Extract metadata
    const metadata = await this.extractMetadata(content, title);
    Object.assign(result, metadata);

    // Generate summary
    const summary = await this.generateSummary(content, title);
    if (summary) {
      result.summary = summary;
    }

    // Merge with existing metadata where AI didn't find values
    if (existingMetadata) {
      if (!result.platform && existingMetadata.platform) {
        result.platform = existingMetadata.platform;
      }
      if (!result.author && existingMetadata.author) {
        result.author = existingMetadata.author;
      }
      if (!result.tags?.length && existingMetadata.tags?.length) {
        result.tags = existingMetadata.tags;
      }
    }

    return result;
  }

  /**
   * Analyze multiple guides in batch
   */
  async analyzeBatch(
    guides: Array<{ id: string; title: string; content: string; metadata?: string }>,
    onProgress?: BatchProgressCallback
  ): Promise<{ succeeded: number; failed: number; results: Array<{ id: string; error?: string }> }> {
    this.stopRequested = false;

    this.batchProgress = {
      status: 'running',
      total: guides.length,
      processed: 0,
      succeeded: 0,
      failed: 0,
      message: 'Starting batch analysis...',
    };
    this.notifyBatchListeners();
    if (onProgress) onProgress(this.batchProgress);

    const results: Array<{ id: string; error?: string }> = [];

    for (const guide of guides) {
      if (this.stopRequested) {
        this.batchProgress.status = 'stopping';
        this.batchProgress.message = 'Stopping batch...';
        this.notifyBatchListeners();
        break;
      }

      this.batchProgress.currentGuideId = guide.id;
      this.batchProgress.currentGuideTitle = guide.title;
      this.batchProgress.message = `Analyzing: ${guide.title}`;
      this.notifyBatchListeners();
      if (onProgress) onProgress(this.batchProgress);

      try {
        const existingMetadata = guide.metadata ? JSON.parse(guide.metadata) : undefined;
        const analysis = await this.analyzeGuide(guide.content, guide.title, existingMetadata);

        results.push({ id: guide.id });
        this.batchProgress.succeeded++;

        // Return result for caller to save
        (results[results.length - 1] as any).analysis = analysis;

      } catch (error: any) {
        results.push({ id: guide.id, error: error.message });
        this.batchProgress.failed++;
        console.error(`[OllamaService] Failed to analyze guide ${guide.id}:`, error.message);
      }

      this.batchProgress.processed++;
      this.notifyBatchListeners();
      if (onProgress) onProgress(this.batchProgress);
    }

    this.batchProgress.status = this.stopRequested ? 'idle' : 'complete';
    this.batchProgress.currentGuideId = undefined;
    this.batchProgress.currentGuideTitle = undefined;
    this.batchProgress.message = this.stopRequested
      ? 'Batch stopped'
      : `Complete: ${this.batchProgress.succeeded} succeeded, ${this.batchProgress.failed} failed`;
    this.notifyBatchListeners();
    if (onProgress) onProgress(this.batchProgress);

    return {
      succeeded: this.batchProgress.succeeded,
      failed: this.batchProgress.failed,
      results,
    };
  }

  /**
   * Stop the current batch operation
   */
  stopBatch(): void {
    if (this.batchProgress.status === 'running') {
      this.stopRequested = true;
      console.log('[OllamaService] Batch stop requested');
    }
  }

  /**
   * Get current batch progress
   */
  getBatchProgress(): BatchProgress {
    return { ...this.batchProgress };
  }

  /**
   * Check if batch is currently running
   */
  isBatchRunning(): boolean {
    return this.batchProgress.status === 'running';
  }

  /**
   * Subscribe to batch progress updates
   */
  onProgressChange(callback: BatchProgressCallback): () => void {
    this.batchListeners.push(callback);
    return () => {
      const index = this.batchListeners.indexOf(callback);
      if (index > -1) {
        this.batchListeners.splice(index, 1);
      }
    };
  }

  private notifyBatchListeners(): void {
    this.batchListeners.forEach(listener => {
      try {
        listener(this.batchProgress);
      } catch (error) {
        console.error('[OllamaService] Error in batch listener:', error);
      }
    });
  }

  // ========== YOLO Mode Methods ==========

  /**
   * Start YOLO mode - automatically analyze all unprocessed guides
   * Runs until stopped or no more guides to process
   */
  async startYoloMode(
    getNextGuide: () => { id: string; title: string; content: string; metadata?: string | null } | null,
    saveMetadata: (id: string, metadata: GuideMetadata) => void
  ): Promise<void> {
    if (this.yoloProgress.status === 'running') {
      console.log('[OllamaService] YOLO mode already running');
      return;
    }

    this.yoloStopRequested = false;
    this.yoloProgress = {
      status: 'running',
      processed: 0,
      succeeded: 0,
      failed: 0,
      message: 'Starting YOLO mode...',
      startedAt: Date.now(),
    };
    this.notifyYoloListeners();

    console.log('[OllamaService] YOLO mode started');

    const processNext = async (): Promise<void> => {
      if (this.yoloStopRequested) {
        this.yoloProgress.status = 'idle';
        this.yoloProgress.message = 'Stopped';
        this.notifyYoloListeners();
        console.log('[OllamaService] YOLO mode stopped by user');
        return;
      }

      const guide = getNextGuide();
      if (!guide) {
        this.yoloProgress.status = 'complete';
        this.yoloProgress.message = 'All guides processed';
        this.notifyYoloListeners();
        console.log('[OllamaService] YOLO mode complete - no more guides');
        return;
      }

      this.yoloProgress.currentGuideId = guide.id;
      this.yoloProgress.currentGuideTitle = guide.title;
      this.yoloProgress.message = `Analyzing: ${guide.title.slice(0, 50)}...`;
      this.notifyYoloListeners();

      try {
        // Parse existing metadata
        let existingMetadata: GuideMetadata = {};
        if (guide.metadata) {
          try {
            existingMetadata = JSON.parse(guide.metadata);
          } catch {
            // Ignore parse errors
          }
        }

        // Analyze the guide
        const analysis = await this.analyzeGuide(guide.content, guide.title, existingMetadata);

        // Merge and save
        const newMetadata: GuideMetadata = {
          ...existingMetadata,
          ...analysis,
          aiAnalyzedAt: Date.now(),
        };
        saveMetadata(guide.id, newMetadata);

        this.yoloProgress.succeeded++;
        console.log(`[OllamaService] YOLO: Analyzed "${guide.title.slice(0, 40)}..."`);
      } catch (error: any) {
        this.yoloProgress.failed++;
        console.error(`[OllamaService] YOLO: Failed on "${guide.title}":`, error.message);

        // Mark as analyzed (with error) to avoid infinite retry
        let existingMetadata: GuideMetadata = {};
        if (guide.metadata) {
          try {
            existingMetadata = JSON.parse(guide.metadata);
          } catch {
            // Ignore
          }
        }
        const errorMetadata: GuideMetadata = {
          ...existingMetadata,
          aiAnalyzedAt: Date.now(),
          aiAnalysisError: error.message,
        };
        saveMetadata(guide.id, errorMetadata);
      }

      this.yoloProgress.processed++;
      this.yoloProgress.currentGuideId = undefined;
      this.yoloProgress.currentGuideTitle = undefined;
      this.yoloProgress.message = `${this.yoloProgress.processed} analyzed (${this.yoloProgress.succeeded} succeeded, ${this.yoloProgress.failed} failed)`;
      this.notifyYoloListeners();

      // Use setImmediate to keep event loop responsive, then continue
      await new Promise(resolve => setTimeout(resolve, 500));
      setImmediate(() => processNext());
    };

    // Start processing
    processNext();
  }

  /**
   * Stop YOLO mode gracefully
   */
  stopYolo(): void {
    if (this.yoloProgress.status === 'running') {
      this.yoloStopRequested = true;
      this.yoloProgress.status = 'stopping';
      this.yoloProgress.message = 'Stopping...';
      this.notifyYoloListeners();
      console.log('[OllamaService] YOLO stop requested');
    }
  }

  /**
   * Get current YOLO progress
   */
  getYoloProgress(): YoloProgress {
    return { ...this.yoloProgress };
  }

  /**
   * Check if YOLO mode is running
   */
  isYoloRunning(): boolean {
    return this.yoloProgress.status === 'running' || this.yoloProgress.status === 'stopping';
  }

  /**
   * Subscribe to YOLO progress updates
   */
  onYoloProgressChange(callback: YoloProgressCallback): () => void {
    this.yoloListeners.push(callback);
    return () => {
      const index = this.yoloListeners.indexOf(callback);
      if (index > -1) {
        this.yoloListeners.splice(index, 1);
      }
    };
  }

  private notifyYoloListeners(): void {
    this.yoloListeners.forEach(listener => {
      try {
        listener(this.yoloProgress);
      } catch (error) {
        console.error('[OllamaService] Error in YOLO listener:', error);
      }
    });
  }
}

export default new OllamaService();
