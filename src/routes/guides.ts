import { Router, Request, Response, NextFunction } from 'express';
import DefaultGuideModel from '../models/Guide';
import { config } from '../config';
import type { IGuideModel, GuideFilters } from '../interfaces/IGuideModel';
import type { AnswerService } from '../services/AnswerService';
import { createSlidingWindowRateLimiter } from '../middleware/rateLimit';

export interface GuidesRouterDeps {
  guideModel: IGuideModel;
  // Optional: tests and the legacy default export can omit this. When omitted,
  // POST /answer responds with 503 ("answer service not configured").
  answerService?: AnswerService;
}

/**
 * Sanitize a string for use in Content-Disposition filename to prevent
 * header injection (CRLF, quotes, backslash).
 */
function sanitizeContentDispositionFilename(filename: string): string {
  return filename
    .replace(/\\/g, '_')
    .replace(/"/g, "'")
    .replace(/\r/g, '')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'download';
}

export function createGuidesRouter(deps: GuidesRouterDeps): Router {
  const router = Router();
  const { guideModel, answerService } = deps;

  // Sliding-window rate limiter, scoped to /answer only (other guide endpoints
  // are unaffected). Per-router instance so each test app gets its own store.
  const answerRateLimiter = createSlidingWindowRateLimiter({
    windowMs: 60_000,
    max: config.answerRateLimitPerMin,
  });

  // POST /api/guides/answer — RAG question answering over the indexed guides.
  // Defined before /:id so Express doesn't route the literal "answer" through
  // the :id handler.
  router.post('/answer', answerRateLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { question, game_id, platform, genre, tags, tag_match, top_k } = req.body ?? {};

      if (typeof question !== 'string' || question.trim().length === 0) {
        res.status(400).json({ error: 'question is required' });
        return;
      }
      if (question.length > 1000) {
        res.status(400).json({ error: 'question must be 1000 characters or fewer' });
        return;
      }
      if (game_id !== undefined && typeof game_id !== 'string') {
        res.status(400).json({ error: 'game_id must be a string' });
        return;
      }
      if (platform !== undefined && typeof platform !== 'string') {
        res.status(400).json({ error: 'platform must be a string' });
        return;
      }
      if (genre !== undefined && typeof genre !== 'string') {
        res.status(400).json({ error: 'genre must be a string' });
        return;
      }
      if (tags !== undefined && (!Array.isArray(tags) || !tags.every(t => typeof t === 'string'))) {
        res.status(400).json({ error: 'tags must be an array of strings' });
        return;
      }
      if (tag_match !== undefined && tag_match !== 'any' && tag_match !== 'all') {
        res.status(400).json({ error: "tag_match must be 'any' or 'all'" });
        return;
      }
      let topK = config.ragTopK;
      if (top_k !== undefined) {
        if (typeof top_k !== 'number' || !Number.isInteger(top_k) || top_k < 1 || top_k > 20) {
          res.status(400).json({ error: 'top_k must be an integer between 1 and 20' });
          return;
        }
        topK = top_k;
      }

      if (!answerService) {
        res.status(503).json({ error: 'Answer service not configured' });
        return;
      }

      try {
        const result = await answerService.answer(
          question.trim(),
          { gameId: game_id, platform, genre, tags, tagMatch: tag_match },
          topK
        );
        res.json(result);
      } catch (err: any) {
        // Distinguish embedding-host failures from synthesis-host failures so
        // operators can tell which Ollama is down.
        const message = err?.message ?? '';
        if (message.startsWith('Embedding API error') || message.includes('Embedding dim mismatch') || message === 'TIMEOUT') {
          res.status(503).json({ error: 'Embedding service unavailable' });
          return;
        }
        if (message.startsWith('Synthesis API error')) {
          res.status(503).json({ error: 'Synthesis service unavailable' });
          return;
        }
        next(err);
      }
    } catch (error) {
      next(error);
    }
  });

  // GET /api/guides - List all guides (paginated, with optional filters)
  router.get('/', (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(
        config.maxPageSize,
        Math.max(1, parseInt(req.query.limit as string) || config.defaultPageSize)
      );
      const offset = (page - 1) * limit;

      // Parse filter parameters
      const platform = req.query.platform as string | undefined;
      const tagsParam = req.query.tags as string | undefined;
      const tagMatch = req.query.tagMatch === 'all' ? 'all' : 'any';
      const tags = tagsParam ? tagsParam.split(',').map(t => t.trim()).filter(Boolean) : undefined;

      const hasFilters = platform || (tags && tags.length > 0);
      const filters: GuideFilters = { platform, tags, tagMatch };

      // Use filtered or unfiltered query based on presence of filters
      const guides = hasFilters
        ? guideModel.findAllSummaryFiltered(filters, limit, offset)
        : guideModel.findAllSummary(limit, offset);
      const total = hasFilters
        ? guideModel.getFilteredCount(filters)
        : guideModel.getTotalCount();

      res.json({
        data: guides,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
        ...(hasFilters && { filters: { platform, tags, tagMatch } }),
      });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/guides/filters - Get available filter options
  router.get('/filters', (req: Request, res: Response, next: NextFunction) => {
    try {
      const platforms = guideModel.getDistinctPlatforms();
      const tags = guideModel.getDistinctTags();

      res.json({
        platforms,
        tags,
      });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/guides/search - Search guides
  // Returns results separated by match type: guides (title/tags) vs content
  router.get('/search', (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = req.query.q as string;

      if (!query || query.trim().length === 0) {
        res.status(400).json({ error: 'Search query is required' });
        return;
      }

      const limit = Math.min(
        config.maxPageSize,
        Math.max(1, parseInt(req.query.limit as string) || 50)
      );

      const results = guideModel.search(query.trim(), limit);

      // Strip content from results
      const stripContent = (guide: any) => ({
        id: guide.id,
        title: guide.title,
        format: guide.format,
        file_path: guide.file_path,
        game_id: guide.game_id,
        metadata: guide.metadata,
        created_at: guide.created_at,
        updated_at: guide.updated_at,
      });

      res.json({
        // Matches on title/tags
        guides: results.guides.map(stripContent),
        // Matches on content only (not already in guides)
        content: results.content.map(stripContent),
        query,
        total: results.guides.length + results.content.length,
      });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/guides/:id - Get single guide by ID (with full content)
  router.get('/:id', (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
    try {
      const guide = guideModel.findById(req.params.id);

      if (!guide) {
        res.status(404).json({ error: 'Guide not found' });
        return;
      }

      res.json({ data: guide });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/guides/:id/content - Get only guide content (for downloading)
  router.get('/:id/content', (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
    try {
      const guide = guideModel.findById(req.params.id);

      if (!guide) {
        res.status(404).json({ error: 'Guide not found' });
        return;
      }

      // Set appropriate content type based on format
      const contentTypes: Record<string, string> = {
        txt: 'text/plain; charset=utf-8',
        html: 'text/html; charset=utf-8',
        md: 'text/markdown; charset=utf-8',
        pdf: 'application/pdf',
      };

      res.set('Content-Type', contentTypes[guide.format] || 'text/plain; charset=utf-8');
      // Sanitize filename to prevent header injection (strip ", \r, \n, \)
      const safeFilename = sanitizeContentDispositionFilename(`${guide.title}.${guide.format}`);
      res.set('Content-Disposition', `inline; filename="${safeFilename}"`);
      res.send(guide.content);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/guides/:id/metadata - Get guide metadata
  router.get('/:id/metadata', (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
    try {
      const guide = guideModel.findById(req.params.id);

      if (!guide) {
        res.status(404).json({ error: 'Guide not found' });
        return;
      }

      const metadata = guideModel.getMetadata(req.params.id);

      res.json({
        data: {
          id: guide.id,
          title: guide.title,
          format: guide.format,
          file_path: guide.file_path,
          game_id: guide.game_id,
          metadata,
          created_at: guide.created_at,
          updated_at: guide.updated_at,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  // PUT /api/guides/:id/position - Update last read position
  router.put('/:id/position', (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
    try {
      const { position } = req.body;

      if (typeof position !== 'number' || position < 0) {
        res.status(400).json({ error: 'Invalid position' });
        return;
      }

      const success = guideModel.updateLastReadPosition(req.params.id, position);

      if (!success) {
        res.status(404).json({ error: 'Guide not found' });
        return;
      }

      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

// Default router using singleton for backward compatibility
export default createGuidesRouter({ guideModel: DefaultGuideModel });
