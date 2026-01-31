import { Router, Request, Response, NextFunction } from 'express';
import DefaultBookmarkModel from '../models/Bookmark';
import DefaultGuideModel from '../models/Guide';
import type { IBookmarkModel } from '../models/Bookmark';
import type { IGuideModel } from '../interfaces/IGuideModel';

export interface BookmarksRouterDeps {
  bookmarkModel: IBookmarkModel;
  guideModel: IGuideModel;
}

export function createBookmarksRouter(deps: BookmarksRouterDeps): Router {
  const router = Router({ mergeParams: true });
  const { bookmarkModel, guideModel } = deps;

  // GET /api/guides/:guideId/bookmarks - List bookmarks for a guide
  router.get('/', (req: Request<{ guideId: string }>, res: Response, next: NextFunction) => {
    try {
      const { guideId } = req.params;

      const guide = guideModel.findById(guideId);
      if (!guide) {
        res.status(404).json({ error: 'Guide not found' });
        return;
      }

      const bookmarks = bookmarkModel.findByGuideId(guideId);
      res.json({ data: bookmarks });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/guides/:guideId/bookmarks - Create bookmark
  router.post('/', (req: Request<{ guideId: string }>, res: Response, next: NextFunction) => {
    try {
      const { guideId } = req.params;
      const { position, name, page_reference, is_last_read } = req.body;

      const guide = guideModel.findById(guideId);
      if (!guide) {
        res.status(404).json({ error: 'Guide not found' });
        return;
      }

      if (typeof position !== 'number' || position < 0) {
        res.status(400).json({ error: 'Invalid position: must be a non-negative number' });
        return;
      }

      const bookmark = bookmarkModel.create({
        guide_id: guideId,
        position,
        name: name ?? null,
        page_reference: page_reference ?? null,
        is_last_read: Boolean(is_last_read),
      });

      res.status(201).json({ data: bookmark });
    } catch (error) {
      next(error);
    }
  });

  // DELETE /api/guides/:guideId/bookmarks/:id - Delete bookmark
  router.delete('/:id', (req: Request<{ guideId: string; id: string }>, res: Response, next: NextFunction) => {
    try {
      const { guideId, id } = req.params;

      const guide = guideModel.findById(guideId);
      if (!guide) {
        res.status(404).json({ error: 'Guide not found' });
        return;
      }

      const bookmark = bookmarkModel.findById(id);
      if (!bookmark) {
        res.status(404).json({ error: 'Bookmark not found' });
        return;
      }

      if (bookmark.guide_id !== guideId) {
        res.status(404).json({ error: 'Bookmark not found in this guide' });
        return;
      }

      const success = bookmarkModel.delete(id);
      if (!success) {
        res.status(404).json({ error: 'Bookmark not found' });
        return;
      }

      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export default createBookmarksRouter({
  bookmarkModel: DefaultBookmarkModel,
  guideModel: DefaultGuideModel,
});
