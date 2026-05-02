import * as fs from 'fs';
import * as path from 'path';
import GuideParser from './GuideParser';
import GuideModel from '../models/Guide';
import GameModel from '../models/Game';
import Database from '../database/database';
import type { Guide, ImportProgress, ImportProgressCallback } from '../types';

const BATCH_SIZE = 100;

/**
 * Build the canonical guide title: `${gameName}` or `${gameName} — ${author}`.
 * Falls back to the parsed title when no clean game name is available. The
 * author check filters obvious junk (the upstream regex sometimes grabs whole
 * sentences) — must stay in sync with the SQL CASE in migration v7.
 */
export function composeGuideTitle(
  gameName: string | undefined,
  fallback: string,
  author: string | undefined
): string {
  const game = gameName?.trim();
  if (!game || game.toLowerCase() === 'unknown game') return fallback;
  const cleaned = cleanAuthor(author);
  if (!cleaned) return game;
  return `${game} — ${cleaned}`;
}

function cleanAuthor(author: string | undefined): string | null {
  if (!author) return null;
  // Strip trailing runs of separator chars (the parser regex sometimes pulls in
  // ASCII-banner dashes/asterisks/equals after the actual author name).
  const a = author
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s\-*=_~.]{2,}$/, '')
    .trim();
  if (a.length < 2 || a.length > 60) return null;
  if (/[|=>]/.test(a)) return null;
  // ≤ 5 spaces ≈ ≤ 6 words — sentences slip past the regex extractor.
  if ((a.match(/ /g)?.length ?? 0) > 5) return null;
  return a;
}

class GuideImporter {
  private isImporting = false;
  /** Cache game external_id -> db id to avoid repeated DB lookups during import */
  private gameIdCache = new Map<string, string>();

  /**
   * Import guides from a directory (bulk import)
   */
  async importFromDirectory(
    directoryPath: string,
    onProgress?: ImportProgressCallback
  ): Promise<{ imported: number; skipped: number; errors: number }> {
    if (this.isImporting) {
      throw new Error('Import already in progress');
    }

    this.isImporting = true;

    try {
      const stats = { imported: 0, skipped: 0, errors: 0 };

      // Scan directory for guide files
      onProgress?.({
        total: 0,
        current: 0,
        currentFile: 'Scanning directory...',
        status: 'scanning',
      });

      console.log('[Import] Scanning directory:', directoryPath);
      const guideFiles = this.scanDirectory(directoryPath);
      console.log('[Import] Found', guideFiles.length, 'guide files');

      // Import each guide
      onProgress?.({
        total: guideFiles.length,
        current: 0,
        currentFile: '',
        status: 'importing',
      });

      // Process in batches: parse batch (sync), insert in one transaction, then delete files (reduces DB overhead)
      for (let i = 0; i < guideFiles.length; i += BATCH_SIZE) {
        const batch = guideFiles.slice(i, i + BATCH_SIZE);

        onProgress?.({
          total: guideFiles.length,
          current: i,
          currentFile: path.basename(batch[0] ?? ''),
          status: 'importing',
        });

        const importedPaths: string[] = [];
        try {
          Database.transaction(() => {
            for (const filePath of batch) {
              try {
                this.importSingleGuideSync(filePath);
                stats.imported++;
                importedPaths.push(filePath);
              } catch (error) {
                console.error(`[Import] Failed to import ${path.basename(filePath)}:`, error);
                stats.errors++;
              }
            }
          });
          for (const filePath of importedPaths) {
            try {
              fs.unlinkSync(filePath);
            } catch {
              /* ignore */
            }
          }
        } catch (batchError) {
          // Transaction failed (e.g. disk full); retry batch one-by-one
          for (const filePath of batch) {
            try {
              this.importSingleGuideSync(filePath);
              stats.imported++;
              try {
                fs.unlinkSync(filePath);
              } catch {
                /* ignore */
              }
            } catch (error) {
              console.error(`[Import] Failed to import ${path.basename(filePath)}:`, error);
              stats.errors++;
            }
          }
        }

        if (stats.imported % 500 === 0 || i + BATCH_SIZE >= guideFiles.length) {
          console.log(`[Import] Progress: ${stats.imported}/${guideFiles.length} guides imported`);
        }

        // Yield to event loop between batches to allow HTTP requests to be processed
        await new Promise(resolve => setImmediate(resolve));
      }

      // Indexing complete (FTS5 handles this automatically via triggers)
      onProgress?.({
        total: guideFiles.length,
        current: guideFiles.length,
        currentFile: '',
        status: 'complete',
      });

      console.log('[Import] Import complete:', stats);
      return stats;
    } finally {
      this.isImporting = false;
    }
  }

  /**
   * Import a single guide file (sync; used inside batched transaction)
   */
  private importSingleGuideSync(filePath: string): Guide {
    const parsed = GuideParser.parseGuide(filePath);
    const { gameId, gameName, platform } = GuideParser.extractGameInfoFromPath(filePath);
    const filename = path.basename(filePath);
    const tags = GuideParser.generateAutoTags(parsed.content, filename);

    let dbGameId: string | undefined;

    if (gameId) {
      const cached = this.gameIdCache.get(gameId);
      if (cached !== undefined) {
        dbGameId = cached;
      } else {
        const existingGame = GameModel.findByExternalId(gameId);
        if (existingGame) {
          dbGameId = existingGame.id;
          this.gameIdCache.set(gameId, existingGame.id);
        } else {
          const newGame = GameModel.create({
            title: gameName,
            platform: platform || undefined,
            metadata: JSON.stringify({
              external_id: gameId,
            }),
          });
          dbGameId = newGame.id;
          this.gameIdCache.set(gameId, newGame.id);
        }
      }
    }

    const metadata = {
      ...parsed.metadata,
      tags,
      platform: platform || parsed.metadata.platform,
      original_title: parsed.title,
    };

    // Prefer the linked game's name as the guide title — the content-extraction
    // heuristic frequently picks up ASCII-art banners or stray bylines. Compose
    // with author when present so multiple guides for the same game stay
    // distinguishable in citations. The original parsed title lives on in
    // metadata.original_title for later cleanup passes.
    const title = composeGuideTitle(gameName, parsed.title, parsed.metadata.author);

    return GuideModel.create({
      title,
      content: parsed.content,
      format: parsed.format,
      file_path: filePath,
      game_id: dbGameId,
      metadata: JSON.stringify(metadata),
    });
  }

  /**
   * Import a single guide file (async wrapper for external callers)
   */
  async importSingleGuide(filePath: string): Promise<Guide> {
    return Promise.resolve(this.importSingleGuideSync(filePath));
  }

  /**
   * Scan directory recursively for guide files
   */
  private scanDirectory(directoryPath: string): string[] {
    const guideFiles: string[] = [];
    const supportedExtensions = ['.txt', '.html', '.htm', '.md', '.markdown', '.pdf'];

    const scanRecursive = (dir: string) => {
      try {
        const items = fs.readdirSync(dir, { withFileTypes: true });

        for (const item of items) {
          const fullPath = path.join(dir, item.name);

          if (item.isDirectory()) {
            scanRecursive(fullPath);
          } else if (item.isFile()) {
            const ext = path.extname(item.name).toLowerCase();
            if (supportedExtensions.includes(ext)) {
              guideFiles.push(fullPath);
            }
          }
        }
      } catch (error) {
        console.error(`[Import] Failed to scan directory ${dir}:`, error);
      }
    };

    scanRecursive(directoryPath);
    return guideFiles;
  }

  /**
   * Get import statistics
   */
  getImportStats(): {
    totalGuides: number;
    totalGames: number;
    guidesWithGames: number;
    guidesWithoutGames: number;
  } {
    const totalGuides = GuideModel.getTotalCount();
    const totalGames = GameModel.getTotalCount();

    const allGuides = GuideModel.findAll(100000);
    const guidesWithGames = allGuides.filter(g => g.game_id).length;
    const guidesWithoutGames = allGuides.filter(g => !g.game_id).length;

    return {
      totalGuides,
      totalGames,
      guidesWithGames,
      guidesWithoutGames,
    };
  }

  /**
   * Check if import is in progress
   */
  isImportInProgress(): boolean {
    return this.isImporting;
  }
}

export default new GuideImporter();
