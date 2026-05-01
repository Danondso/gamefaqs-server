import * as fs from 'fs';
import * as path from 'path';
import GuideModel from '../models/Guide';
import GameModel from '../models/Game';
import ArchiveDownloadService from './ArchiveDownloadService';
import ArchiveExtractor from './ArchiveExtractor';
import GuideImporter from './GuideImporter';
import { config } from '../config';
import type { InitStatus, InitStatusCallback } from '../types';

class InitService {
  private status: InitStatus = {
    stage: 'idle',
    progress: 0,
    message: 'Checking database...',
    guideCount: 0,
    gameCount: 0,
  };

  private listeners: Array<InitStatusCallback> = [];

  /**
   * Initialize the server - download, extract, and import if needed
   */
  async initialize(): Promise<void> {
    try {
      console.log('[Init] Starting initialization...');

      // Check if database exists and has guides
      const guideCount = GuideModel.getTotalCount();
      const gameCount = GameModel.getTotalCount();

      if (guideCount > 0) {
        console.log('[Init] Database already initialized');
        console.log(`[Init]   Guides: ${guideCount.toLocaleString()}`);
        console.log(`[Init]   Games: ${gameCount.toLocaleString()}`);

        this.status = {
          stage: 'complete',
          progress: 100,
          message: 'Database ready',
          guideCount,
          gameCount,
        };
        this.notifyListeners();
        return;
      }

      console.log('[Init] Empty database detected');
      console.log('[Init] This will take approximately 20-40 minutes...');

      this.status.startTime = Date.now();

      // Ensure temp + archive directories exist. archiveDir is intentionally
      // decoupled from tempDir so the operator can mount it from a persistent
      // host path; that lets the archive survive volume wipes (e.g.
      // `docker compose down -v`) and avoids re-downloading ~12 GB.
      if (!fs.existsSync(config.tempDir)) {
        fs.mkdirSync(config.tempDir, { recursive: true });
      }
      if (!fs.existsSync(config.archiveDir)) {
        fs.mkdirSync(config.archiveDir, { recursive: true });
      }

      // Stage 1: Download archive (30% of progress)
      this.updateStatus('downloading', 0, 'Downloading archive from Internet Archive...');
      const archivePath = path.join(config.archiveDir, 'gamefaqs_archive.zip');

      // Reuse any archive already on disk. Saves a ~12 GB re-download for
      // users who ran with KEEP_ARCHIVE=true on a prior setup, and supports
      // the "browser-download the file faster, then drop it in" workflow.
      // We never auto-delete a file the operator put here — if it's actually
      // corrupt or truncated, extraction will fail loudly downstream.
      let skipDownload = false;
      if (fs.existsSync(archivePath)) {
        const localSize = fs.statSync(archivePath).size;
        const remoteSize = await ArchiveDownloadService.getRemoteSize(config.archiveUrl);
        if (remoteSize !== null && localSize !== remoteSize) {
          console.warn(`[Init] Existing archive size mismatch (local ${localSize}, remote ${remoteSize}) — using it anyway; extraction will fail if it's truncated`);
        } else {
          console.log(`[Init] Found existing archive at ${archivePath} (${(localSize / 1024 / 1024).toFixed(1)} MB) — skipping download`);
        }
        this.updateStatus('downloading', 30, 'Reusing existing archive');
        skipDownload = true;
      }

      if (!skipDownload) {
        await ArchiveDownloadService.downloadArchive(
          config.archiveUrl,
          archivePath,
          (progress) => {
            const percentage = Math.floor(progress.percentage * 0.3);
            const downloaded = (progress.downloaded / 1024 / 1024).toFixed(1);
            const total = progress.total > 0
              ? (progress.total / 1024 / 1024).toFixed(1)
              : '?';
            this.updateStatus('downloading', percentage, `Downloading: ${downloaded}MB / ${total}MB`);
          }
        );
        console.log('[Init] Download complete');
      }

      // Stage 2: Extract archives (30% of progress, offset 30)
      this.updateStatus('extracting', 30, 'Extracting ZIP and 7z archives...');
      const extractedDir = path.join(config.tempDir, 'extracted');

      await ArchiveExtractor.extractArchive(
        archivePath,
        extractedDir,
        (progress) => {
          const currentProgress = progress.totalArchives > 0
            ? ((progress.currentArchive - 1) / progress.totalArchives + progress.currentArchiveProgress / 100 / progress.totalArchives)
            : 0;
          const percentage = 30 + Math.floor(currentProgress * 30);
          this.updateStatus('extracting', percentage,
            `Extracting: ${progress.currentArchiveName} (${progress.currentArchive}/${progress.totalArchives})`
          );
        }
      );

      console.log('[Init] Extraction complete');

      // Free the ~12 GB archive unless the operator opted to keep it for
      // future setups. Keeping is useful if you anticipate yeeting the DB
      // and don't want to re-download.
      if (config.keepArchive) {
        console.log(`[Init] Keeping archive at ${archivePath} (KEEP_ARCHIVE=true)`);
      } else {
        console.log('[Init] Deleting archive to free space (set KEEP_ARCHIVE=true to retain)...');
        try {
          fs.unlinkSync(archivePath);
        } catch (err) {
          console.warn('[Init] Could not delete archive:', err);
        }
      }

      // Stage 3: Import guides (40% of progress, offset 60)
      this.updateStatus('importing', 60, 'Importing guides to database...');

      const result = await GuideImporter.importFromDirectory(
        extractedDir,
        (progress) => {
          const percentage = 60 + Math.floor((progress.current / Math.max(progress.total, 1)) * 40);
          this.updateStatus('importing', percentage,
            `Importing: ${progress.current.toLocaleString()}/${progress.total.toLocaleString()} guides`
          );
        }
      );

      console.log('[Init] Import complete!');
      console.log(`[Init]   Imported: ${result.imported.toLocaleString()} guides`);
      console.log(`[Init]   Errors: ${result.errors}`);
      console.log(`[Init]   Skipped: ${result.skipped}`);

      // Cleanup extracted files
      console.log('[Init] Cleaning up temporary files...');
      try {
        fs.rmSync(extractedDir, { recursive: true, force: true });
      } catch (err) {
        console.warn('[Init] Could not cleanup temp files:', err);
      }

      const finalGuideCount = GuideModel.getTotalCount();
      const finalGameCount = GameModel.getTotalCount();

      const elapsedMinutes = this.status.startTime
        ? Math.floor((Date.now() - this.status.startTime) / 1000 / 60)
        : 0;

      this.updateStatus('complete', 100, 'Initialization complete!', finalGuideCount, finalGameCount);
      console.log(`[Init] Ready to serve requests! (took ${elapsedMinutes} minutes)`);

    } catch (error: any) {
      console.error('[Init] Initialization failed:', error);
      // Best-effort cleanup on failure: free temp space (zip already deleted after extract; remove any leftover extracted files)
      const extractedDir = path.join(config.tempDir, 'extracted');
      if (fs.existsSync(extractedDir)) {
        try {
          fs.rmSync(extractedDir, { recursive: true, force: true });
          console.log('[Init] Cleaned up partial extraction on failure');
        } catch (err) {
          console.warn('[Init] Could not cleanup temp on failure:', err);
        }
      }
      this.status = {
        stage: 'error',
        progress: 0,
        message: 'Initialization failed',
        guideCount: 0,
        gameCount: 0,
        error: error.message || 'Unknown error',
      };
      this.notifyListeners();
      throw error;
    }
  }

  // Track what we last printed so progress stages don't spam the log: SSE
  // listeners still get every update, but stdout only sees one line per
  // integer percentage tick (Docker logs) or in-place updates (TTY).
  private lastLoggedStage: InitStatus['stage'] | null = null;
  private lastLoggedProgress = -1;
  private progressLineActive = false;

  private updateStatus(
    stage: InitStatus['stage'],
    progress: number,
    message: string,
    guideCount?: number,
    gameCount?: number
  ): void {
    this.status = {
      ...this.status,
      stage,
      progress,
      message,
      guideCount: guideCount ?? this.status.guideCount,
      gameCount: gameCount ?? this.status.gameCount,
    };
    this.notifyListeners();
    this.logProgress(stage, progress, message);
  }

  private logProgress(stage: InitStatus['stage'], progress: number, message: string): void {
    const isProgressStage = stage === 'downloading' || stage === 'extracting' || stage === 'importing';
    const stageChanged = stage !== this.lastLoggedStage;

    // Close out an in-progress \r line before emitting anything new.
    if (stageChanged && this.progressLineActive) {
      process.stdout.write('\n');
      this.progressLineActive = false;
    }

    if (!isProgressStage) {
      console.log(`[Init] ${message} (${progress}%)`);
      this.lastLoggedStage = stage;
      this.lastLoggedProgress = -1;
      return;
    }

    // Skip duplicate ticks within a progress stage.
    if (!stageChanged && progress === this.lastLoggedProgress) return;

    const line = `[Init] ${message} (${progress}%)`;
    if (process.stdout.isTTY) {
      process.stdout.write(`\r\x1b[K${line}`);
      this.progressLineActive = true;
    } else {
      console.log(line);
    }

    this.lastLoggedStage = stage;
    this.lastLoggedProgress = progress;
  }

  getStatus(): InitStatus {
    return { ...this.status };
  }

  isComplete(): boolean {
    return this.status.stage === 'complete';
  }

  isProcessing(): boolean {
    return ['downloading', 'extracting', 'importing'].includes(this.status.stage);
  }

  hasError(): boolean {
    return this.status.stage === 'error';
  }

  /**
   * Subscribe to status updates (for admin panel)
   */
  onStatusChange(callback: InitStatusCallback): () => void {
    this.listeners.push(callback);
    // Return unsubscribe function
    return () => {
      const index = this.listeners.indexOf(callback);
      if (index > -1) {
        this.listeners.splice(index, 1);
      }
    };
  }

  private notifyListeners(): void {
    this.listeners.forEach(listener => {
      try {
        listener(this.status);
      } catch (error) {
        console.error('[Init] Error in status listener:', error);
      }
    });
  }
}

export default new InitService();
