import { Router, Request, Response, NextFunction } from 'express';
import DefaultGameModel from '../models/Game';
import DefaultGuideModel from '../models/Guide';
import { config } from '../config';
import type { IGameModel, GameFilters } from '../interfaces/IGameModel';
import type { IGuideModel } from '../interfaces/IGuideModel';
import type { Game } from '../types';

export interface GamesRouterDeps {
  gameModel: IGameModel;
  guideModel: IGuideModel;
}

export function createGamesRouter(deps: GamesRouterDeps): Router {
  const router = Router();
  const { gameModel, guideModel } = deps;

  // GET /api/games - List all games (paginated, with optional filters)
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
      const statusParam = req.query.status as string | undefined;
      const validStatuses: Game['status'][] = ['in_progress', 'completed', 'not_started'];
      const status = statusParam && validStatuses.includes(statusParam as Game['status'])
        ? (statusParam as Game['status'])
        : undefined;

      const hasFilters = platform || status;
      const filters: GameFilters = { platform, status };

      // Use filtered or unfiltered query based on presence of filters
      const games = hasFilters
        ? gameModel.findAllFiltered(filters, limit, offset)
        : gameModel.findAll(limit, offset);
      const total = hasFilters
        ? gameModel.getFilteredCount(filters)
        : gameModel.getTotalCount();

      res.json({
        data: games,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
        ...(hasFilters && { filters: { platform, status } }),
      });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/games/filters - Get available filter options
  router.get('/filters', (req: Request, res: Response, next: NextFunction) => {
    try {
      const platforms = gameModel.getDistinctPlatforms();
      const statuses = gameModel.getDistinctStatuses();

      res.json({
        platforms,
        statuses,
      });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/games/with-guides - List games with guide counts
  router.get('/with-guides', (req: Request, res: Response, next: NextFunction) => {
    try {
      const games = gameModel.getWithGuideCount();

      res.json({
        data: games,
        total: games.length,
      });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/games/search - Search games by title
  router.get('/search', (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = req.query.q as string;

      if (!query || query.trim().length === 0) {
        res.status(400).json({ error: 'Search query is required' });
        return;
      }

      const games = gameModel.searchByTitle(query.trim());

      res.json({
        data: games,
        query,
        total: games.length,
      });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/games/:id - Get single game by ID
  router.get('/:id', (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
    try {
      const game = gameModel.findById(req.params.id);

      if (!game) {
        res.status(404).json({ error: 'Game not found' });
        return;
      }

      res.json({ data: game });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/games/:id/guides - Get all guides for a game
  router.get('/:id/guides', (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
    try {
      const game = gameModel.findById(req.params.id);

      if (!game) {
        res.status(404).json({ error: 'Game not found' });
        return;
      }

      const guides = guideModel.findByGameId(req.params.id);

      // Return without full content
      const results = guides.map(guide => ({
        id: guide.id,
        title: guide.title,
        format: guide.format,
        file_path: guide.file_path,
        game_id: guide.game_id,
        metadata: guide.metadata,
        created_at: guide.created_at,
        updated_at: guide.updated_at,
      }));

      res.json({
        data: results,
        game,
        total: results.length,
      });
    } catch (error) {
      next(error);
    }
  });

  // PUT /api/games/:id/status - Update game status
  router.put('/:id/status', (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
    try {
      const { status } = req.body;

      if (!['in_progress', 'completed', 'not_started'].includes(status)) {
        res.status(400).json({ error: 'Invalid status' });
        return;
      }

      const success = gameModel.updateStatus(req.params.id, status);

      if (!success) {
        res.status(404).json({ error: 'Game not found' });
        return;
      }

      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  });

  // PUT /api/games/:id/completion - Update completion percentage
  router.put('/:id/completion', (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
    try {
      const { percentage } = req.body;

      if (typeof percentage !== 'number' || percentage < 0 || percentage > 100) {
        res.status(400).json({ error: 'Invalid percentage (must be 0-100)' });
        return;
      }

      const success = gameModel.updateCompletionPercentage(req.params.id, percentage);

      if (!success) {
        res.status(404).json({ error: 'Game not found' });
        return;
      }

      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

// Default router using singletons for backward compatibility
export default createGamesRouter({
  gameModel: DefaultGameModel,
  guideModel: DefaultGuideModel,
});
