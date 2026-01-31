import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import type { DownloadProgress, DownloadProgressCallback } from '../types';

class ArchiveDownloadService {
  /**
   * Download archive from URL to destination path with progress tracking
   */
  async downloadArchive(
    url: string,
    destinationPath: string,
    onProgress?: DownloadProgressCallback
  ): Promise<void> {
    try {
      console.log('[Download] Starting download from:', url);
      console.log('[Download] Destination:', destinationPath);

      // Ensure directory exists
      const dir = path.dirname(destinationPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Try to get file size first (HEAD request) - but don't fail if it doesn't work
      let totalBytes = 0;
      try {
        const headResponse = await axios.head(url, { timeout: 10000 });
        totalBytes = parseInt(headResponse.headers['content-length'] || '0', 10);
        if (totalBytes > 0) {
          console.log('[Download] Total size:', (totalBytes / 1024 / 1024).toFixed(2), 'MB');
        } else {
          console.log('[Download] Could not determine file size, downloading without size info...');
        }
      } catch (headError: any) {
        console.warn('[Download] HEAD request failed (will proceed anyway):', headError.message);
        console.log('[Download] Proceeding with download without size information...');
      }

      // Download the file with streaming
      const response = await axios.get(url, {
        responseType: 'stream',
        timeout: 0, // No timeout for large downloads
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });

      // Create write stream
      const fileStream = fs.createWriteStream(destinationPath);

      // Track download progress
      let downloaded = 0;
      let lastProgressUpdate = Date.now();

      response.data.on('data', (chunk: Buffer) => {
        downloaded += chunk.length;

        // Update progress every 500ms to avoid too frequent updates
        const now = Date.now();
        if (now - lastProgressUpdate >= 500 || downloaded === totalBytes) {
          const percentage = totalBytes > 0 ? (downloaded / totalBytes) * 100 : 0;
          onProgress?.({ downloaded, total: totalBytes, percentage });
          lastProgressUpdate = now;
        }
      });

      // Pipe to file
      response.data.pipe(fileStream);

      return new Promise((resolve, reject) => {
        fileStream.on('finish', () => {
          fileStream.close();
          console.log('[Download] Download complete');
          resolve();
        });

        fileStream.on('error', (err) => {
          console.error('[Download] File write error:', err);
          // Clean up partial file
          fs.unlink(destinationPath, () => {});
          reject(err);
        });

        response.data.on('error', (err: Error) => {
          console.error('[Download] Download stream error:', err);
          fileStream.destroy();
          // Clean up partial file
          fs.unlink(destinationPath, () => {});
          reject(err);
        });
      });
    } catch (error: any) {
      console.error('[Download] Failed to download archive:', error.message);
      throw error;
    }
  }

  /**
   * Get file size from URL without downloading
   */
  async getFileSize(url: string): Promise<number> {
    const response = await axios.head(url);
    return parseInt(response.headers['content-length'] || '0', 10);
  }

  /**
   * Check if URL is accessible
   */
  async checkUrl(url: string): Promise<boolean> {
    try {
      const response = await axios.head(url, { timeout: 10000 });
      return response.status === 200;
    } catch {
      return false;
    }
  }
}

export default new ArchiveDownloadService();
