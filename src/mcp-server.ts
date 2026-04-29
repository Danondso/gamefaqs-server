import { config } from './config';
import Database from './database/database';
import { GuideModel } from './models/Guide';
import { GameModel } from './models/Game';
import type { Guide, GuideMetadata, Game } from './types';
import type { GuideFilters } from './interfaces/IGuideModel';

const apiUrl = config.mcpApiUrl?.replace(/\/$/, '');
const useRemote = !!apiUrl;

// Local mode: open the SQLite DB. Remote mode: skip DB init entirely.
if (!useRemote) {
  Database.initialize(config.dbPath);
}

const guideModel = useRemote ? null : new GuideModel();
const gameModel = useRemote ? null : new GameModel();

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${apiUrl}${path}`);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`API ${res.status} ${path}: ${body.slice(0, 200)}`);
    (err as any).status = res.status;
    throw err;
  }
  return res.json() as Promise<T>;
}

type GuideSummaryRow = Omit<Guide, 'content'> & { content_length: number };

// --- Data-source wrappers: identical return shapes whether reading local DB or remote API ---

async function dsSearchGuides(query: string, limit: number): Promise<{ guides: Guide[]; content: Guide[] }> {
  if (useRemote) {
    return api<{ guides: Guide[]; content: Guide[] }>(
      `/api/guides/search?q=${encodeURIComponent(query)}&limit=${limit}`
    );
  }
  return guideModel!.search(query, limit);
}

async function dsSearchGames(query: string): Promise<Game[]> {
  if (useRemote) {
    const r = await api<{ data: Game[] }>(`/api/games/search?q=${encodeURIComponent(query)}`);
    return r.data;
  }
  return gameModel!.searchByTitle(query);
}

async function dsGetGuide(id: string): Promise<Guide | null> {
  if (useRemote) {
    try {
      const r = await api<{ data: Guide }>(`/api/guides/${encodeURIComponent(id)}`);
      return r.data;
    } catch (err: any) {
      if (err.status === 404) return null;
      throw err;
    }
  }
  return guideModel!.findById(id);
}

async function dsGetGame(id: string): Promise<Game | null> {
  if (useRemote) {
    try {
      const r = await api<{ data: Game }>(`/api/games/${encodeURIComponent(id)}`);
      return r.data;
    } catch (err: any) {
      if (err.status === 404) return null;
      throw err;
    }
  }
  return gameModel!.findById(id);
}

async function dsGuidesByGame(gameId: string): Promise<Guide[]> {
  if (useRemote) {
    const r = await api<{ data: Guide[] }>(`/api/games/${encodeURIComponent(gameId)}/guides`);
    return r.data;
  }
  return guideModel!.findByGameId(gameId);
}

async function dsBrowseGuides(
  filters: GuideFilters,
  limit: number,
  offset: number
): Promise<{ guides: GuideSummaryRow[]; total: number }> {
  if (useRemote) {
    const params = new URLSearchParams();
    if (filters.platform) params.set('platform', filters.platform);
    if (filters.tags && filters.tags.length) {
      params.set('tags', filters.tags.join(','));
      params.set('tagMatch', filters.tagMatch ?? 'any');
    }
    const page = Math.floor(offset / limit) + 1;
    params.set('page', String(page));
    params.set('limit', String(limit));
    const r = await api<{ data: GuideSummaryRow[]; pagination: { total: number } }>(
      `/api/guides?${params.toString()}`
    );
    return { guides: r.data, total: r.pagination.total };
  }
  return {
    guides: guideModel!.findAllSummaryFiltered(filters, limit, offset),
    total: guideModel!.getFilteredCount(filters),
  };
}

async function dsGetStats() {
  if (useRemote) {
    const [guidesPage, gamesPage, guideFilters, gameFilters] = await Promise.all([
      api<{ pagination: { total: number } }>(`/api/guides?limit=1`),
      api<{ pagination: { total: number } }>(`/api/games?limit=1`),
      api<{ platforms: string[]; tags: string[] }>(`/api/guides/filters`),
      api<{ platforms: string[] }>(`/api/games/filters`),
    ]);
    return {
      totalGuides: guidesPage.pagination.total,
      totalGames: gamesPage.pagination.total,
      guidePlatforms: guideFilters.platforms,
      guideTags: guideFilters.tags,
      gamePlatforms: gameFilters.platforms,
    };
  }
  return {
    totalGuides: guideModel!.getTotalCount(),
    totalGames: gameModel!.getTotalCount(),
    guidePlatforms: guideModel!.getDistinctPlatforms(),
    guideTags: guideModel!.getDistinctTags(),
    gamePlatforms: gameModel!.getDistinctPlatforms(),
  };
}

// --- Helpers ---

function parseMetadata(guide: Guide): GuideMetadata | null {
  if (!guide.metadata) return null;
  try {
    return JSON.parse(guide.metadata);
  } catch {
    return null;
  }
}

function formatGuideSummary(guide: Guide | (Omit<Guide, 'content'> & { content_length?: number })) {
  const meta = 'metadata' in guide && guide.metadata ? (() => {
    try { return JSON.parse(guide.metadata as string); } catch { return null; }
  })() : null;

  return {
    id: guide.id,
    title: guide.title,
    format: guide.format,
    file_path: guide.file_path,
    game_id: guide.game_id ?? null,
    content_length: 'content_length' in guide
      ? (guide as any).content_length
      : 'content' in guide ? (guide as Guide).content.length : undefined,
    platform: meta?.platform ?? null,
    author: meta?.author ?? null,
    tags: meta?.tags ?? [],
    summary: meta?.summary ?? null,
    game_name: meta?.gameName ?? null,
  };
}

function snapToLineEnd(content: string, offset: number, length: number): { chunk: string; actualEnd: number } {
  const end = Math.min(offset + length, content.length);
  if (end >= content.length) {
    return { chunk: content.substring(offset), actualEnd: content.length };
  }
  // Find the nearest newline after the end position
  const nextNewline = content.indexOf('\n', end);
  const snapEnd = nextNewline === -1 ? end : nextNewline + 1;
  return { chunk: content.substring(offset, snapEnd), actualEnd: snapEnd };
}

// --- MCP Server Setup (dynamic import for ESM SDK) ---

async function main() {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { z } = await import('zod');

  const server = new McpServer({
    name: 'gamefaqs-archive',
    version: '1.0.0',
  });

  // --- Tool: search_guides ---
  server.tool(
    'search_guides',
    'Search for game guides and FAQs by keyword. Searches both titles/tags and full guide content using FTS5. Returns guide summaries (not full content). Use read_guide to get actual content.',
    {
      query: z.string().describe('Search query (supports FTS5 syntax: AND, OR, NOT, "phrase", prefix*)'),
      limit: z.number().min(1).max(50).default(20).describe('Max results to return'),
    },
    async ({ query, limit }) => {
      try {
        const results = await dsSearchGuides(query, limit);
        const titleMatches = results.guides.map(formatGuideSummary);
        const contentMatches = results.content.map(formatGuideSummary);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              title_matches: titleMatches,
              content_only_matches: contentMatches,
              total: titleMatches.length + contentMatches.length,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        // FTS5 syntax error — fall back to quoted phrase search.
        // Local mode throws an Error from sqlite; remote mode surfaces the same message via the 500 body.
        if (err.message?.includes('fts5')) {
          const safeQuery = `"${query.replace(/"/g, '')}"`;
          const results = await dsSearchGuides(safeQuery, limit);
          const titleMatches = results.guides.map(formatGuideSummary);
          const contentMatches = results.content.map(formatGuideSummary);

          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                title_matches: titleMatches,
                content_only_matches: contentMatches,
                total: titleMatches.length + contentMatches.length,
                note: 'Query was simplified for compatibility',
              }, null, 2),
            }],
          };
        }
        throw err;
      }
    }
  );

  // --- Tool: search_games ---
  server.tool(
    'search_games',
    'Search for games by title. Returns matching games with metadata. Use get_game to see full details and associated guides.',
    {
      query: z.string().describe('Game title to search for (partial match supported)'),
    },
    async ({ query }) => {
      const games = await dsSearchGames(query);
      const results = games.map(game => {
        let meta = null;
        if (game.metadata) {
          try { meta = JSON.parse(game.metadata); } catch {}
        }
        return {
          id: game.id,
          title: game.title,
          platform: game.platform ?? null,
          status: game.status,
          completion_percentage: game.completion_percentage,
          genre: meta?.genre ?? null,
          developer: meta?.developer ?? null,
        };
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ games: results, total: results.length }, null, 2),
        }],
      };
    }
  );

  // --- Tool: read_guide ---
  server.tool(
    'read_guide',
    'Read the content of a specific guide. Guides can be very large, so content is returned in chunks. Use offset to paginate through the content. Start with offset=0.',
    {
      guide_id: z.string().describe('The guide ID (from search_guides or get_game results)'),
      offset: z.number().min(0).default(0).describe('Character offset to start reading from'),
      length: z.number().min(100).max(50000).default(8000).describe('Number of characters to return'),
    },
    async ({ guide_id, offset, length }) => {
      const guide = await dsGetGuide(guide_id);
      if (!guide) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Guide not found' }) }],
          isError: true,
        };
      }

      const totalLength = guide.content.length;
      const { chunk, actualEnd } = snapToLineEnd(guide.content, offset, length);
      const meta = parseMetadata(guide);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            title: guide.title,
            format: guide.format,
            total_length: totalLength,
            offset,
            chunk_length: chunk.length,
            has_more: actualEnd < totalLength,
            next_offset: actualEnd < totalLength ? actualEnd : null,
            platform: meta?.platform ?? null,
            author: meta?.author ?? null,
            tags: meta?.tags ?? [],
          }, null, 2) + '\n\n--- GUIDE CONTENT ---\n\n' + chunk,
        }],
      };
    }
  );

  // --- Tool: get_game ---
  server.tool(
    'get_game',
    'Get detailed information about a specific game and list all its associated guides.',
    {
      game_id: z.string().describe('The game ID'),
    },
    async ({ game_id }) => {
      const game = await dsGetGame(game_id);
      if (!game) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Game not found' }) }],
          isError: true,
        };
      }

      const guides = await dsGuidesByGame(game_id);
      let meta = null;
      if (game.metadata) {
        try { meta = JSON.parse(game.metadata); } catch {}
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            game: {
              id: game.id,
              title: game.title,
              platform: game.platform ?? null,
              status: game.status,
              completion_percentage: game.completion_percentage,
              artwork_url: game.artwork_url ?? null,
              genre: meta?.genre ?? null,
              developer: meta?.developer ?? null,
              release_year: meta?.release_year ?? null,
            },
            guides: guides.map(formatGuideSummary),
            guide_count: guides.length,
          }, null, 2),
        }],
      };
    }
  );

  // --- Tool: browse_guides ---
  server.tool(
    'browse_guides',
    'Browse guides with optional filters by platform or tags. Returns paginated guide summaries without content.',
    {
      platform: z.string().optional().describe('Filter by platform (e.g., "PlayStation 2", "Game Boy Advance")'),
      tags: z.array(z.string()).optional().describe('Filter by tags (e.g., ["walkthrough", "boss guide"])'),
      tag_match: z.enum(['any', 'all']).default('any').describe('How to match multiple tags: "any" (OR) or "all" (AND)'),
      page: z.number().min(1).default(1).describe('Page number'),
      limit: z.number().min(1).max(50).default(20).describe('Results per page'),
    },
    async ({ platform, tags, tag_match, page, limit }) => {
      const offset = (page - 1) * limit;
      const filters = {
        platform,
        tags,
        tagMatch: tag_match as 'any' | 'all',
      };

      const { guides, total } = await dsBrowseGuides(filters, limit, offset);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            guides: guides.map(formatGuideSummary),
            pagination: {
              page,
              limit,
              total,
              total_pages: Math.ceil(total / limit),
            },
          }, null, 2),
        }],
      };
    }
  );

  // --- Tool: get_archive_stats ---
  server.tool(
    'get_archive_stats',
    'Get statistics about the GameFAQs guide archive: total guides, total games, available platforms, and available tags. Useful for understanding what is in the archive.',
    {},
    async () => {
      const stats = await dsGetStats();

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            total_guides: stats.totalGuides,
            total_games: stats.totalGames,
            guide_platforms: stats.guidePlatforms,
            game_platforms: stats.gamePlatforms,
            guide_tags: stats.guideTags,
          }, null, 2),
        }],
      };
    }
  );

  // Connect transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[MCP] GameFAQs archive server running on stdio (${useRemote ? `remote: ${apiUrl}` : 'local DB'})`
  );
}

main().catch((err) => {
  console.error('[MCP] Fatal error:', err);
  process.exit(1);
});

// Graceful shutdown
const shutdown = () => {
  if (!useRemote) Database.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
