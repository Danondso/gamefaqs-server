import * as fs from 'fs';
import * as path from 'path';
import yauzl, { ZipFile, Entry } from 'yauzl';
import Seven from 'node-7z';
import type { ExtractionProgress, ExtractionProgressCallback } from '../types';
import { buildDedupePlan } from './DedupePlanner';

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

      // Stage 1.5: Plan dedup across all archives before any extraction.
      // GameFAQs cross-lists the same guide under multiple game directories
      // (often spanning gens), so the plan must be global. Survivors are
      // chosen by size DESC → gen ASC → path lex ASC.
      console.log('[Extraction] Stage 1.5: Planning dedup across archives');
      const plan = await buildDedupePlan(sevenZipArchives);
      console.log(
        `[Dedupe] keep ${plan.stats.uniqueGuides} unique + ${plan.stats.passthrough} passthrough, ` +
          `drop ${plan.stats.dropped} (${(plan.stats.bytesDropped / 1e9).toFixed(2)} GB redundant)`
      );

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

        // Per-archive progress is already surfaced via updateProgress → InitService's
        // throttled [Init] log; no per-archive console line needed here.

        const include = plan.cherryPicks.get(sevenZipPath) ?? [];
        if (include.length === 0) {
          // An empty listfile would silently make 7z exit with an error; an
          // unset $cherryPick would extract everything. Bail explicitly.
          console.warn(`[Dedupe] No survivors for ${archiveName} — skipping extract`);
        } else {
          try {
            await this.extract7zArchive(sevenZipPath, outputDir, include);
          } catch (error) {
            console.error('[Extraction] Error extracting 7z archive:', archiveName, error);
            this.updateProgress({
              error: `Failed to extract ${archiveName}: ${error}`,
            });
          }
        }

        // Delete the 7z archive after extraction to save space
        try {
          fs.unlinkSync(sevenZipPath);
        } catch (err) {
          console.warn('[Extraction] Could not delete 7z archive:', archiveName, err);
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
   * Extract ZIP archive using yauzl (streaming-focused). Per-entry failures
   * (read errors, write errors, path-traversal rejections) are counted and
   * surfaced to the caller; an outer extraction with non-zero failures still
   * resolves but the count is logged so the operator knows the output is
   * incomplete. The outer ZIP comes from a configurable URL, so we explicitly
   * reject entries whose resolved path escapes outputDir (zip-slip).
   */
  private extractZipArchive(zipPath: string, outputDir: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      console.log('[ZIP] Reading ZIP file:', zipPath);

      const sevenZipArchives: string[] = [];
      let entryFailures = 0;
      const outputDirAbs = path.resolve(outputDir);

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

          // Zip-slip guard: refuse entries whose resolved destination escapes
          // outputDir. Defends against a hostile or accidentally-malformed
          // archive writing to arbitrary filesystem paths.
          const fullPath = path.resolve(outputDirAbs, relativePath);
          if (fullPath !== outputDirAbs && !fullPath.startsWith(outputDirAbs + path.sep)) {
            console.warn('[ZIP] Refusing path-traversing entry:', relativePath);
            entryFailures++;
            zipfile.readEntry();
            return;
          }
          const dirname = path.dirname(fullPath);

          // Create directory if needed
          if (!fs.existsSync(dirname)) {
            fs.mkdirSync(dirname, { recursive: true });
          }

          zipfile.openReadStream(entry, (err: Error | null, readStream?: NodeJS.ReadableStream) => {
            if (err) {
              console.error('[ZIP] Error reading entry:', relativePath, err);
              entryFailures++;
              zipfile.readEntry();
              return;
            }

            if (!readStream) {
              entryFailures++;
              zipfile.readEntry();
              return;
            }

            const writeStream = fs.createWriteStream(fullPath);

            readStream.pipe(writeStream);

            writeStream.on('finish', () => {
              sevenZipArchives.push(fullPath);
              zipfile.readEntry();
            });

            writeStream.on('error', (err: Error) => {
              console.error('[ZIP] Error writing file:', relativePath, err);
              entryFailures++;
              zipfile.readEntry();
            });
          });
        });

        zipfile.on('end', () => {
          if (entryFailures > 0) {
            console.warn(
              `[ZIP] Extraction complete with ${entryFailures} per-entry failure(s); extracted ${sevenZipArchives.length} 7z archive(s)`
            );
            this.updateProgress({
              error: `${entryFailures} ZIP entry/entries failed; output may be incomplete`,
            });
          } else {
            console.log('[ZIP] ZIP extraction complete. Extracted', sevenZipArchives.length, '7z archives');
          }
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
   * Extract a 7z archive, restricted to the supplied internal paths.
   *
   * Paths are passed via `-i@listfile` (written to a temp file) rather than
   * `$cherryPick`. The listfile sidesteps ARG_MAX (a worst-case archive could
   * push tens of thousands of paths through argv) and turns an empty include
   * into a loud 7z error rather than `$cherryPick`'s silent extract-all.
   */
  private extract7zArchive(
    sevenZipPath: string,
    outputDir: string,
    includePaths: string[]
  ): Promise<void> {
    const listfilePath = path.join(
      outputDir,
      `.cherrypick-${path.basename(sevenZipPath)}.txt`
    );
    fs.writeFileSync(listfilePath, includePaths.join('\n') + '\n');

    return new Promise((resolve, reject) => {
      const extractStream = Seven.extractFull(sevenZipPath, outputDir, {
        $progress: true,
        recursive: true,
        $raw: [`-i@${listfilePath}`],
      });

      const cleanup = () => {
        try { fs.unlinkSync(listfilePath); } catch { /* best-effort */ }
      };

      extractStream.on('progress', (progress: { percent?: number }) => {
        this.updateProgress({
          currentArchiveProgress: progress.percent || 0,
        });
      });

      extractStream.on('end', () => {
        cleanup();
        resolve();
      });

      extractStream.on('error', (err: Error) => {
        cleanup();
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
