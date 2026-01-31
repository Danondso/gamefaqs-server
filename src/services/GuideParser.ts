import * as fs from 'fs';
import * as path from 'path';
import type { GuideMetadata, ParsedGuide } from '../types';

class GuideParser {
  /** Max chars to scan for metadata/tags (avoids scanning huge guides) */
  private static readonly METADATA_SCAN_LENGTH = 8000;

  /**
   * Parse a guide file and extract content and metadata (sync for fast bulk import)
   */
  parseGuide(filePath: string): ParsedGuide {
    const format = this.detectFormat(filePath);

    switch (format) {
      case 'txt':
        return this.parseTxtGuide(filePath);
      case 'html':
        return this.parseHtmlGuide(filePath);
      case 'md':
        return this.parseMarkdownGuide(filePath);
      case 'pdf':
        return this.parsePdfGuide(filePath);
      default:
        throw new Error(`Unsupported file format: ${format}`);
    }
  }

  /**
   * Detect file format from extension
   */
  private detectFormat(filePath: string): 'txt' | 'html' | 'md' | 'pdf' {
    const extension = filePath.toLowerCase().split('.').pop();

    switch (extension) {
      case 'txt':
        return 'txt';
      case 'html':
      case 'htm':
        return 'html';
      case 'md':
      case 'markdown':
        return 'md';
      case 'pdf':
        return 'pdf';
      default:
        return 'txt';
    }
  }

  /**
   * Parse plain text guide - preserves ASCII art and formatting
   */
  private parseTxtGuide(filePath: string): ParsedGuide {
    const content = fs.readFileSync(filePath, 'utf-8');

    const trimmedContent = content.trim();
    if (trimmedContent.length === 0) {
      const filenameTitle = this.extractTitleFromFilename(filePath);
      return {
        title: `${filenameTitle} (Empty Guide)`,
        content: '[This guide appears to be empty or contains no readable content]',
        format: 'txt',
        metadata: {},
      };
    }

    const metadata = this.extractMetadataFromContent(content, GuideParser.METADATA_SCAN_LENGTH);
    const title = this.extractTitleFromContent(content) || this.extractTitleFromFilename(filePath);

    return {
      title,
      content,
      format: 'txt',
      metadata,
    };
  }

  /**
   * Parse HTML guide - strips HTML tags and preserves text content
   */
  private parseHtmlGuide(filePath: string): ParsedGuide {
    const htmlContent = fs.readFileSync(filePath, 'utf-8');

    let title = this.extractHtmlTitle(htmlContent) || this.extractTitleFromFilename(filePath);

    // Remove script and style tags completely
    let content = htmlContent.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    content = content.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');

    // Convert common HTML elements to text equivalents
    content = content.replace(/<br\s*\/?>/gi, '\n');
    content = content.replace(/<\/p>/gi, '\n\n');
    content = content.replace(/<\/div>/gi, '\n');
    content = content.replace(/<\/h[1-6]>/gi, '\n');

    // Remove all remaining HTML tags
    content = content.replace(/<[^>]+>/g, '');

    // Decode HTML entities
    content = this.decodeHtmlEntities(content);

    // Normalize whitespace
    content = content.split('\n').map(line => line.trim()).join('\n');
    content = content.replace(/\n{3,}/g, '\n\n');

    const metadata = this.extractMetadataFromContent(content, GuideParser.METADATA_SCAN_LENGTH);

    return {
      title,
      content,
      format: 'html',
      metadata,
    };
  }

  /**
   * Parse Markdown guide
   */
  private parseMarkdownGuide(filePath: string): ParsedGuide {
    const content = fs.readFileSync(filePath, 'utf-8');

    const titleMatch = content.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : this.extractTitleFromFilename(filePath);

    const metadata = this.extractMetadataFromContent(content, GuideParser.METADATA_SCAN_LENGTH);

    return {
      title,
      content,
      format: 'md',
      metadata,
    };
  }

  /**
   * Parse PDF guide - placeholder implementation
   */
  private parsePdfGuide(filePath: string): ParsedGuide {
    const title = this.extractTitleFromFilename(filePath);

    return {
      title,
      content: '[PDF content - PDF parsing not yet implemented]\n\nFilename: ' + path.basename(filePath),
      format: 'pdf',
      metadata: {},
    };
  }

  /**
   * Extract title from guide content
   */
  private extractTitleFromContent(content: string): string | null {
    const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    if (lines.length === 0) return null;

    // Look for common title patterns in first 30 lines
    for (let i = 0; i < Math.min(30, lines.length); i++) {
      const line = lines[i];

      if (/^[=\-*_#]+$/.test(line)) continue;
      if (line.length > 120) continue;
      if (line.length < 3) continue;
      if (line.startsWith('http')) continue;

      if (line.match(/^(.*?)(guide|walkthrough|faq)/i)) {
        return this.cleanTitle(line);
      }

      const leadingSpaces = content.split('\n')[i].match(/^\s*/)?.[0].length || 0;
      if (leadingSpaces > 10 && line.length < 80 && line.length > 5) {
        return this.cleanTitle(line);
      }
    }

    for (const line of lines.slice(0, 10)) {
      if (line.length >= 10 && line.length < 100 && !line.startsWith('http') && !/^[=\-*_#]+$/.test(line)) {
        return this.cleanTitle(line);
      }
    }

    return null;
  }

  /**
   * Clean up extracted title
   */
  private cleanTitle(title: string): string {
    let cleaned = title;
    cleaned = cleaned.replace(/\s+v?\d+\.\d+(\.\d+)?\s*$/i, '');
    cleaned = cleaned.replace(/\s+by\s+.+$/i, '');
    cleaned = cleaned.replace(/[*_=\-]{3,}/g, '');
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    return cleaned;
  }

  /**
   * Extract title from HTML content
   */
  private extractHtmlTitle(html: string): string | null {
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) return titleMatch[1].trim();

    const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
    if (h1Match) return h1Match[1].trim();

    return null;
  }

  /**
   * Extract title from filename
   */
  private extractTitleFromFilename(filePath: string): string {
    const filename = path.basename(filePath);
    const nameWithoutExt = filename.replace(/\.[^.]+$/, '');

    let cleaned = nameWithoutExt.replace(/^\d+-/, '');
    cleaned = cleaned.replace(/-(faqs?|guides?|walkthroughs?|maps?|cheats?)-?\d*$/i, '');
    cleaned = cleaned.replace(/[_-]/g, ' ');
    cleaned = cleaned.replace(/\s+/g, ' ').trim();

    return cleaned
      .split(' ')
      .map(word => {
        const lowerWord = word.toLowerCase();
        if (['of', 'the', 'and', 'a', 'an', 'in', 'on', 'at', 'to', 'for'].includes(lowerWord)) {
          return lowerWord;
        }
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      })
      .map((word, index) => {
        if (index === 0) {
          return word.charAt(0).toUpperCase() + word.slice(1);
        }
        return word;
      })
      .join(' ');
  }

  /**
   * Extract metadata from guide content (only scans first maxChars for performance)
   */
  private extractMetadataFromContent(content: string, maxChars = 8000): GuideMetadata {
    const metadata: GuideMetadata = {};
    const slice = content.length > maxChars ? content.slice(0, maxChars) : content;

    const authorPatterns = [
      /(?:by|author|written by|created by)[:\s]+([^\n]+)/i,
      /(?:^|\n)([A-Z][a-z]+ [A-Z][a-z]+)\s*$/m,
    ];

    for (const pattern of authorPatterns) {
      const match = slice.match(pattern);
      if (match) {
        metadata.author = match[1].trim();
        break;
      }
    }

    const versionMatch = slice.match(/version[:\s]+([0-9.]+)/i);
    if (versionMatch) {
      metadata.version = versionMatch[1];
    }

    const platforms = ['NES', 'SNES', 'N64', 'GameCube', 'Wii', 'Switch',
                       'Genesis', 'Saturn', 'Dreamcast',
                       'PS1', 'PS2', 'PS3', 'PS4', 'PS5', 'PSP', 'Vita',
                       'Xbox', 'Xbox 360', 'Xbox One',
                       'Game Boy', 'GBA', 'DS', '3DS',
                       'PC', 'Steam'];

    for (const platform of platforms) {
      const regex = new RegExp(`\\b${platform}\\b`, 'i');
      if (regex.test(slice.slice(0, 1000))) {
        metadata.platform = platform;
        break;
      }
    }

    return metadata;
  }

  /**
   * Generate auto-tags from guide content (only scans first N chars for performance)
   */
  generateAutoTags(content: string, filename: string, maxContentChars = 8000): string[] {
    const tags = new Set<string>();
    const scanContent = content.length > maxContentChars ? content.slice(0, maxContentChars) : content;
    const lowerContent = scanContent.toLowerCase();
    const lowerFilename = filename.toLowerCase();

    if (lowerFilename.includes('faq')) tags.add('FAQ');
    if (lowerFilename.includes('walkthrough')) tags.add('Walkthrough');
    if (lowerFilename.includes('guide')) tags.add('Guide');
    if (lowerFilename.includes('maps')) tags.add('Maps');
    if (lowerFilename.includes('cheats')) tags.add('Cheats');

    if (lowerContent.includes('walkthrough')) tags.add('Walkthrough');
    if (lowerContent.includes('achievement')) tags.add('Achievements');
    if (lowerContent.includes('trophy')) tags.add('Trophies');
    if (lowerContent.includes('secret')) tags.add('Secrets');
    if (lowerContent.includes('boss')) tags.add('Boss Guide');
    if (lowerContent.includes('character')) tags.add('Characters');
    if (lowerContent.includes('item list') || lowerContent.includes('items:')) tags.add('Items');
    if (lowerContent.includes('weapon')) tags.add('Weapons');
    if (lowerContent.includes('collectible')) tags.add('Collectibles');
    if (lowerContent.includes('unlock')) tags.add('Unlockables');

    if (lowerContent.match(/rpg|role.playing/)) tags.add('RPG');
    if (lowerContent.match(/fps|first.person.shooter/)) tags.add('FPS');
    if (lowerContent.match(/platformer|platform game/)) tags.add('Platformer');
    if (lowerContent.match(/fighting game|fighter/)) tags.add('Fighting');
    if (lowerContent.match(/racing/)) tags.add('Racing');
    if (lowerContent.match(/puzzle/)) tags.add('Puzzle');
    if (lowerContent.match(/strategy|rts|turn.based/)) tags.add('Strategy');
    if (lowerContent.match(/adventure/)) tags.add('Adventure');
    if (lowerContent.match(/action/)) tags.add('Action');
    if (lowerContent.match(/simulation|sim/)) tags.add('Simulation');
    if (lowerContent.match(/sports/)) tags.add('Sports');

    if (lowerContent.includes('100%') || lowerContent.includes('complete')) tags.add('Complete Guide');
    if (lowerContent.includes('beginner')) tags.add('Beginner Friendly');
    if (lowerContent.includes('advanced') || lowerContent.includes('expert')) tags.add('Advanced');
    if (lowerContent.includes('speedrun')) tags.add('Speedrun');

    if (lowerContent.includes('ascii art') || this.detectAsciiArt(content)) tags.add('ASCII Art');
    if (lowerContent.includes('table of contents') || lowerContent.includes('toc')) tags.add('Table of Contents');

    return Array.from(tags);
  }

  /**
   * Detect ASCII art in content
   */
  private detectAsciiArt(content: string): boolean {
    const lines = content.split('\n').slice(0, 100);
    let artLineCount = 0;

    for (const line of lines) {
      const specialChars = line.match(/[^\w\s]/g) || [];
      if (specialChars.length > line.length * 0.3 && line.length > 10) {
        artLineCount++;
      }
    }

    return artLineCount > 5;
  }

  /**
   * Decode HTML entities
   */
  private decodeHtmlEntities(text: string): string {
    const entities: Record<string, string> = {
      '&nbsp;': ' ',
      '&lt;': '<',
      '&gt;': '>',
      '&amp;': '&',
      '&quot;': '"',
      '&#39;': "'",
      '&apos;': "'",
    };

    let decoded = text;
    for (const [entity, char] of Object.entries(entities)) {
      decoded = decoded.replace(new RegExp(entity, 'g'), char);
    }

    return decoded;
  }

  /**
   * Extract game info from filename
   */
  extractGameInfoFromFilename(filePath: string): { gameId: string | null; gameName: string } {
    const filename = path.basename(filePath);
    const nameWithoutExt = filename.replace(/\.[^.]+$/, '');

    const idMatch = nameWithoutExt.match(/^(\d+)-(.+)$/);

    if (idMatch) {
      const gameId = idMatch[1];
      const restOfName = idMatch[2];

      const gameNameParts: string[] = [];
      const parts = restOfName.split('-');

      for (const part of parts) {
        if (['faqs', 'guides', 'walkthrough', 'walkthroughs', 'maps', 'cheats'].includes(part.toLowerCase())) {
          break;
        }
        gameNameParts.push(part);
      }

      const gameName = gameNameParts
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');

      return { gameId, gameName: gameName || 'Unknown Game' };
    }

    return {
      gameId: null,
      gameName: this.extractTitleFromFilename(filePath),
    };
  }

  /**
   * Extract game info from full path including directory structure
   */
  extractGameInfoFromPath(filePath: string): { gameId: string | null; gameName: string; platform: string | null } {
    const parts = filePath.split(path.sep);

    const faqsIndex = parts.findIndex(p => p.toLowerCase() === 'faqs');

    if (faqsIndex > 0) {
      const gameFolder = parts[faqsIndex - 1];
      const platform = faqsIndex >= 2 ? this.normalizePlatform(parts[faqsIndex - 2]) : null;

      const gameFolderMatch = gameFolder.match(/^(\d+)-(.+)$/);

      if (gameFolderMatch) {
        const gameId = gameFolderMatch[1];
        const gameNameSlug = gameFolderMatch[2];

        const gameName = gameNameSlug
          .split('-')
          .map(word => word.charAt(0).toUpperCase() + word.slice(1))
          .join(' ');

        return { gameId, gameName, platform };
      }
    }

    const fileInfo = this.extractGameInfoFromFilename(filePath);
    return { ...fileInfo, platform: null };
  }

  /**
   * Normalize platform names
   */
  private normalizePlatform(dirName: string): string | null {
    const platformMap: Record<string, string> = {
      'nes': 'NES',
      'snes': 'SNES',
      'n64': 'N64',
      'gamecube': 'GameCube',
      'wii': 'Wii',
      'switch': 'Switch',
      'genesis': 'Genesis',
      'saturn': 'Saturn',
      'dreamcast': 'Dreamcast',
      'ps1': 'PS1',
      'ps2': 'PS2',
      'ps3': 'PS3',
      'ps4': 'PS4',
      'ps5': 'PS5',
      'psp': 'PSP',
      'vita': 'Vita',
      'xbox': 'Xbox',
      'xbox360': 'Xbox 360',
      'xboxone': 'Xbox One',
      'gameboy': 'Game Boy',
      'gba': 'GBA',
      'gbc': 'GBC',
      'ds': 'DS',
      '3ds': '3DS',
      'pc': 'PC',
      'sms': 'SMS',
      'x1': 'X1',
      '3rd': '3DO',
    };

    const normalized = dirName.toLowerCase().replace(/[^a-z0-9]/g, '');
    return platformMap[normalized] || null;
  }
}

export default new GuideParser();
