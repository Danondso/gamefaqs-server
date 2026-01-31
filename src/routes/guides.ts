import { Router, Request, Response, NextFunction } from 'express';
import DefaultGuideModel from '../models/Guide';
import { config } from '../config';
import type { IGuideModel } from '../interfaces/IGuideModel';

export interface GuidesRouterDeps {
  guideModel: IGuideModel;
}

export function createGuidesRouter(deps: GuidesRouterDeps): Router {
  const router = Router();
  const { guideModel } = deps;

  // GET /api/guides - List all guides (paginated)
  router.get('/', (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(
        config.maxPageSize,
        Math.max(1, parseInt(req.query.limit as string) || config.defaultPageSize)
      );
      const offset = (page - 1) * limit;

      // Use summary view (without full content) for listings
      const guides = guideModel.findAllSummary(limit, offset);
      const total = guideModel.getTotalCount();

      res.json({
        data: guides,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
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
      res.set('Content-Disposition', `inline; filename="${guide.title}.${guide.format}"`);
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
