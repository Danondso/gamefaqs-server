import * as fs from 'fs';
import * as path from 'path';
import yauzl, { ZipFile, Entry } from 'yauzl';
import Seven from 'node-7z';
import type { ExtractionProgress, ExtractionProgressCallback } from '../types';

class ArchiveExtractor {
  private progress: ExtractionProgress = {
    totalArchives: 0,
    currentArchive: 0,
    currentArchiveName: '',
    currentArchiveProgress: 0,
    totalFiles: 0,
    extractedFiles: 0,
    status: 'idle',
  };
  private progressCallback?: ExtractionProgressCallback;

  /**
   * Extract the main ZIP archive and all nested 7z archives
   */
  async extractArchive(
    archivePath: string,
    outputDir: string,
    onProgress?: ExtractionProgressCallback
  ): Promise<string> {
    this.progressCallback = onProgress;
    this.updateProgress({ status: 'extracting' });

    try {
      console.log('[Extraction] Starting extraction from:', archivePath);
      console.log('[Extraction] Output directory:', outputDir);

      // Ensure output directory exists
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      // Stage 1: Extract outer ZIP
      console.log('[Extraction] Stage 1: Extracting outer ZIP');
      const sevenZipArchives = await this.extractZipArchive(archivePath, outputDir);

      console.log('[Extraction] Found', sevenZipArchives.length, '7z archives');
      this.updateProgress({
        totalArchives: sevenZipArchives.length,
        currentArchive: 0,
      });

      // Stage 2: Extract nested 7z archives
      console.log('[Extraction] Stage 2: Extracting nested 7z archives');
      for (let i = 0; i < sevenZipArchives.length; i++) {
        const sevenZipPath = sevenZipArchives[i];
        const archiveName = path.basename(sevenZipPath);

        this.updateProgress({
          currentArchive: i + 1,
          currentArchiveName: archiveName,
          currentArchiveProgress: 0,
        });

        console.log(`[Extraction] Extracting 7z archive ${i + 1}/${sevenZipArchives.length}:`, archiveName);

        try {
          await this.extract7zArchive(sevenZipPath, outputDir);
        } catch (error) {
          console.error('[Extraction] Error extracting 7z archive:', error);
          this.updateProgress({
            error: `Failed to extract ${archiveName}: ${error}`,
          });
        }

        // Delete the 7z archive after extraction to save space
        try {
          fs.unlinkSync(sevenZipPath);
          console.log('[Extraction] Deleted 7z archive:', archiveName);
        } catch (err) {
          console.warn('[Extraction] Could not delete 7z archive:', err);
        }
      }

      this.updateProgress({ status: 'complete' });
      console.log('[Extraction] Extraction complete. Output:', outputDir);

      return outputDir;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Extraction failed';
      console.error('[Extraction] Extraction error:', error);
      this.updateProgress({
        status: 'error',
        error: errorMessage,
      });
      throw error;
    }
  }

  /**
   * Extract ZIP archive using yauzl (streaming-focused)
   */
  private extractZipArchive(zipPath: string, outputDir: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      console.log('[ZIP] Reading ZIP file:', zipPath);

      const sevenZipArchives: string[] = [];

      yauzl.open(zipPath, { lazyEntries: true }, (err: Error | null, zipfile?: ZipFile) => {
        if (err) {
          reject(err);
          return;
        }

        if (!zipfile) {
          reject(new Error('Failed to open ZIP file'));
          return;
        }

        console.log('[ZIP] ZIP file opened, total entries:', zipfile.entryCount);

        zipfile.readEntry();

        zipfile.on('entry', (entry: Entry) => {
          const relativePath = entry.fileName;

          // Skip directories
          if (/\/$/.test(relativePath)) {
            zipfile.readEntry();
            return;
          }

          // Only extract 7z files from the outer ZIP
          if (!relativePath.toLowerCase().endsWith('.7z')) {
            zipfile.readEntry();
            return;
          }

          const fullPath = path.join(outputDir, relativePath);
          const dirname = path.dirname(fullPath);

          // Create directory if needed
          if (!fs.existsSync(dirname)) {
            fs.mkdirSync(dirname, { recursive: true });
          }

          zipfile.openReadStream(entry, (err: Error | null, readStream?: NodeJS.ReadableStream) => {
            if (err) {
              console.error('[ZIP] Error reading entry:', relativePath, err);
              zipfile.readEntry();
              return;
            }

            if (!readStream) {
              zipfile.readEntry();
              return;
            }

            const writeStream = fs.createWriteStream(fullPath);

            readStream.pipe(writeStream);

            writeStream.on('finish', () => {
              sevenZipArchives.push(fullPath);
              console.log('[ZIP] Extracted:', relativePath);
              zipfile.readEntry();
            });

            writeStream.on('error', (err: Error) => {
              console.error('[ZIP] Error writing file:', relativePath, err);
              zipfile.readEntry();
            });
          });
        });

        zipfile.on('end', () => {
          console.log('[ZIP] ZIP extraction complete. Extracted', sevenZipArchives.length, '7z archives');
          resolve(sevenZipArchives);
        });

        zipfile.on('error', (err: Error) => {
          console.error('[ZIP] ZIP error:', err);
          reject(err);
        });
      });
    });
  }

  /**
   * Extract 7z archive using node-7z
   */
  private extract7zArchive(sevenZipPath: string, outputDir: string): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log('[7z] Extracting:', sevenZipPath);

      const extractStream = Seven.extractFull(sevenZipPath, outputDir, {
        $progress: true,
        recursive: true,
      });

      let extractedCount = 0;

      extractStream.on('data', () => {
        extractedCount++;
        if (extractedCount % 100 === 0) {
          console.log(`[7z] Extracted ${extractedCount} files...`);
        }
      });

      extractStream.on('progress', (progress: { percent?: number }) => {
        this.updateProgress({
          currentArchiveProgress: progress.percent || 0,
        });
      });

      extractStream.on('end', () => {
        console.log('[7z] Extraction complete. Extracted', extractedCount, 'files');
        resolve();
      });

      extractStream.on('error', (err: Error) => {
        console.error('[7z] Extraction error:', err);
        reject(err);
      });
    });
  }

  /**
   * Get current progress
   */
  getProgress(): ExtractionProgress {
    return { ...this.progress };
  }

  /**
   * Update progress and notify callback
   */
  private updateProgress(updates: Partial<ExtractionProgress>): void {
    this.progress = {
      ...this.progress,
      ...updates,
    };

    if (this.progressCallback) {
      this.progressCallback(this.progress);
    }
  }
}

export default new ArchiveExtractor();
