import { config } from './config';
import Database from './database/database';
import { GuideModel } from './models/Guide';
import { GameModel } from './models/Game';
import { EmbeddingService } from './services/EmbeddingService';
import { SynthesisService } from './services/SynthesisService';
import { RetrievalService } from './services/RetrievalService';
import { GameExtractionService } from './services/GameExtractionService';
import { ProductiveRefusalService } from './services/ProductiveRefusalService';
import { AnswerService, type AnswerResult } from './services/AnswerService';
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

// AnswerService stack — only constructed in local mode. In remote mode, the
// REST server owns these and we proxy through HTTP.
const answerService = useRemote ? null : (() => {
  const embeddings = new EmbeddingService({
    host: config.embeddingHost,
    model: config.embeddingModel,
    dim: config.embeddingDim,
  });
  const synthesis = new SynthesisService({
    host: config.synthesisHost,
    model: config.synthesisModel,
  });
  const retrieval = new RetrievalService({ db: Database, embeddingService: embeddings });
  const extractionService = new GameExtractionService(Database, retrieval);
  const refusalService = new ProductiveRefusalService();
  return new AnswerService({
    retrievalService: retrieval,
    synthesisService: synthesis,
    extractionService,
    refusalService,
  });
})();

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

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${apiUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`API ${res.status} ${path}: ${text.slice(0, 200)}`);
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

async function dsAnswerQuestion(
  question: string,
  filters: { gameId?: string; platform?: string; genre?: string; tags?: string[]; tagMatch?: 'any' | 'all' },
  topK: number
): Promise<AnswerResult> {
  if (useRemote) {
    const body: Record<string, unknown> = { question, top_k: topK };
    if (filters.gameId) body.game_id = filters.gameId;
    if (filters.platform) body.platform = filters.platform;
    if (filters.genre) body.genre = filters.genre;
    if (filters.tags && filters.tags.length > 0) body.tags = filters.tags;
    if (filters.tagMatch) body.tag_match = filters.tagMatch;
    return apiPost<AnswerResult>('/api/guides/answer', body);
  }
  return answerService!.answer(question, filters, topK);
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
    'Search game guides and FAQs by keyword (FTS5 over titles, tags, and full content). Returns guide summaries — NOT full guide text. Each result includes an opaque random-string `id` field; to read a guide, pass that exact `id` value to read_guide as `guide_id`. IDs are only ever obtained from a previous tool response — never invent, guess, modify, shorten, or copy them from documentation or examples. Fabricated IDs will 404.',
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
    'Search games by title (partial match). Returns matching games with metadata. Each result includes an opaque random-string `id` field; to fetch full details and the list of guides for that game, pass that exact `id` value to get_game as `game_id`. IDs are only ever obtained from a previous tool response — never invent, guess, or copy them from documentation or examples. Do not pass the title or any human-readable name as the ID. Fabricated IDs will 404.',
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
    'Read the content of one specific guide. Guides can be very large; content is returned in chunks (use `offset` to paginate, start with offset=0). Requires the exact `id` of a guide from a prior search_guides, browse_guides, or get_game response. IDs are opaque random strings — do NOT invent them from titles, filenames, platforms, any human-readable convention, or any example shown in documentation. If you do not already have a real ID from a prior tool response in this conversation, call search_guides first. Do NOT pass the `length` parameter — let it default to 8000. Smaller chunks force many round trips and slow the conversation dramatically.',
    {
      guide_id: z.string().describe('Exact opaque random-string `id` value copied verbatim from a previous search_guides, browse_guides, or get_game tool response in this conversation. Never fabricate; never copy from documentation or examples.'),
      offset: z.number().min(0).default(0).describe('Character offset to start reading from. Use 0 on the first call, then pass the `next_offset` value from the previous response.'),
      length: z.number().min(4000).max(50000).default(8000).describe('Number of characters to return. Leave unset to use the default of 8000 — do not pass small values, they only multiply the number of round trips needed.'),
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
    'Get detailed information about a specific game and the list of guides associated with it. Requires the exact `id` of a game from a prior search_games response. IDs are opaque random strings — do NOT pass the title, platform, any human-readable name, or any example shown in documentation. If you do not already have a real ID from a prior tool response in this conversation, call search_games first.',
    {
      game_id: z.string().describe('Exact opaque random-string `id` value copied verbatim from a previous search_games tool response in this conversation. Never fabricate from titles or filenames; never copy from documentation or examples.'),
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
    'Browse guides with optional filters by platform or tags. Returns paginated guide summaries (NOT full content). Each result includes an opaque `id` field; pass it verbatim to read_guide as `guide_id` to read the actual guide text. Prefer search_guides for keyword/topic queries; use browse_guides only when the user wants to enumerate by platform or tag.',
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

  // --- Tool: answer_question ---
  server.tool(
    'answer_question',
    'Answer a natural-language question ("how do I beat the Lich?", "where is the master sword?", "what platforms is FF7 on?") by retrieving relevant chunks from across the GameFAQs archive and synthesizing a cited answer. Returns `{ answer, no_answer, citations, timing_ms }`. Each citation includes a real opaque `guide_id` and `chunk_id`; the `guide_id` can be passed verbatim to read_guide for the full source. CRITICAL RULES: (1) If `no_answer` is true OR the answer equals "I don\'t have that information in the available guides.", the archive does not contain the answer — DO NOT fabricate one from your own training data; tell the user the archive lacks coverage and suggest they try search_guides with different keywords. Do not retry the same question with the same filters. (2) Always preserve the bracketed citation markers ([1], [2], etc.) when relaying the answer — they map to the citations array by 1-based index. (3) Use this tool for question-style queries; use search_guides for keyword exploration and browse_guides for filter-based enumeration. (4) OMIT `game_id` entirely unless you have a real one from a prior search_games response in this conversation — passing a fabricated game_id filters retrieval down to nothing and wastes 20+ seconds returning no_answer. NEVER copy IDs from documentation or examples.',
    {
      question: z.string().min(1).max(1000).describe('The natural-language question to answer. Max 1000 characters. Phrase it as a question or instruction ("how do I X", "where is Y") — keyword strings work poorly here; use search_guides for those.'),
      game_id: z.string().optional().describe('Optional: restrict retrieval to chunks from guides linked to this game. MUST be an opaque random-string `id` from a prior search_games response in this conversation. OMIT this field entirely if you do not have such an ID — do not pass titles, names, or example values from documentation. A fabricated game_id will return no_answer after a slow filtered retrieval.'),
      platform: z.string().optional().describe('Optional: restrict retrieval to chunks from guides whose metadata.platform matches this string exactly (e.g. "PlayStation 2", "Game Boy Advance"). Use the values returned by get_archive_stats.guide_platforms.'),
      genre: z.string().optional().describe('Optional: restrict retrieval to guides whose metadata.genre matches this string exactly (e.g. "JRPG", "FPS"). Sourced from AI analysis; not all guides have it set.'),
      tags: z.array(z.string()).optional().describe('Optional: restrict retrieval to guides tagged with these values. Use values returned by get_archive_stats.tags.'),
      tag_match: z.enum(['any', 'all']).optional().describe("How to combine multiple `tags` (default 'any'). 'all' requires every tag to be present on the guide."),
      top_k: z.number().int().min(1).max(20).default(8).describe('Number of citations to retrieve and ground the answer on. Default 8 is right for most questions; raise only if the question spans many sources.'),
    },
    async ({ question, game_id, platform, genre, tags, tag_match, top_k }) => {
      try {
        const result = await dsAnswerQuestion(question, { gameId: game_id, platform, genre, tags, tagMatch: tag_match }, top_k);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              answer: result.answer,
              no_answer: result.no_answer,
              citations: result.citations.map((c, i) => ({
                index: i + 1,
                guide_id: c.guide_id,
                guide_title: c.guide_title,
                chunk_id: c.chunk_id,
                chunk_index: c.chunk_index,
                excerpt: c.excerpt,
                score: c.score,
              })),
              timing_ms: result.timing_ms,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        // Surface 503s from the REST layer (and equivalent local errors) with
        // the upstream message intact so the caller LLM can react sensibly.
        const message = err?.message ?? 'Unknown error';
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: 'answer_question failed',
              detail: message,
              hint: 'The embedding or synthesis service may be unavailable. Try again, or fall back to search_guides + read_guide.',
            }),
          }],
          isError: true,
        };
      }
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
