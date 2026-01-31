import { Router, Request, Response, NextFunction } from 'express';
import DefaultNoteModel from '../models/Note';
import DefaultGuideModel from '../models/Guide';
import type { INoteModel } from '../models/Note';
import type { IGuideModel } from '../interfaces/IGuideModel';

export interface NotesRouterDeps {
  noteModel: INoteModel;
  guideModel: IGuideModel;
}

export function createNotesRouter(deps: NotesRouterDeps): Router {
  const router = Router({ mergeParams: true });
  const { noteModel, guideModel } = deps;

  // GET /api/guides/:guideId/notes - List notes for a guide
  router.get('/', (req: Request<{ guideId: string }>, res: Response, next: NextFunction) => {
    try {
      const { guideId } = req.params;

      const guide = guideModel.findById(guideId);
      if (!guide) {
        res.status(404).json({ error: 'Guide not found' });
        return;
      }

      const notes = noteModel.findByGuideId(guideId);
      res.json({ data: notes });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/guides/:guideId/notes - Create note
  router.post('/', (req: Request<{ guideId: string }>, res: Response, next: NextFunction) => {
    try {
      const { guideId } = req.params;
      const { position, content } = req.body;

      const guide = guideModel.findById(guideId);
      if (!guide) {
        res.status(404).json({ error: 'Guide not found' });
        return;
      }

      if (typeof content !== 'string' || content.trim().length === 0) {
        res.status(400).json({ error: 'Invalid content: must be a non-empty string' });
        return;
      }

      if (position !== undefined && position !== null && (typeof position !== 'number' || position < 0)) {
        res.status(400).json({ error: 'Invalid position: must be a non-negative number or null' });
        return;
      }

      const note = noteModel.create({
        guide_id: guideId,
        position: position ?? null,
        content: content.trim(),
      });

      res.status(201).json({ data: note });
    } catch (error) {
      next(error);
    }
  });

  // PUT /api/guides/:guideId/notes/:id - Update note
  router.put('/:id', (req: Request<{ guideId: string; id: string }>, res: Response, next: NextFunction) => {
    try {
      const { guideId, id } = req.params;
      const { position, content } = req.body;

      const guide = guideModel.findById(guideId);
      if (!guide) {
        res.status(404).json({ error: 'Guide not found' });
        return;
      }

      const note = noteModel.findById(id);
      if (!note) {
        res.status(404).json({ error: 'Note not found' });
        return;
      }

      if (note.guide_id !== guideId) {
        res.status(404).json({ error: 'Note not found in this guide' });
        return;
      }

      const updates: { position?: number | null; content?: string } = {};

      if (content !== undefined) {
        if (typeof content !== 'string' || content.trim().length === 0) {
          res.status(400).json({ error: 'Invalid content: must be a non-empty string' });
          return;
        }
        updates.content = content.trim();
      }

      if (position !== undefined) {
        if (position !== null && (typeof position !== 'number' || position < 0)) {
          res.status(400).json({ error: 'Invalid position: must be a non-negative number or null' });
          return;
        }
        updates.position = position;
      }

      if (Object.keys(updates).length === 0) {
        res.status(400).json({ error: 'No valid fields to update' });
        return;
      }

      const success = noteModel.update(id, updates);
      if (!success) {
        res.status(404).json({ error: 'Note not found' });
        return;
      }

      const updatedNote = noteModel.findById(id);
      res.json({ data: updatedNote });
    } catch (error) {
      next(error);
    }
  });

  // DELETE /api/guides/:guideId/notes/:id - Delete note
  router.delete('/:id', (req: Request<{ guideId: string; id: string }>, res: Response, next: NextFunction) => {
    try {
      const { guideId, id } = req.params;

      const guide = guideModel.findById(guideId);
      if (!guide) {
        res.status(404).json({ error: 'Guide not found' });
        return;
      }

      const note = noteModel.findById(id);
      if (!note) {
        res.status(404).json({ error: 'Note not found' });
        return;
      }

      if (note.guide_id !== guideId) {
        res.status(404).json({ error: 'Note not found in this guide' });
        return;
      }

      const success = noteModel.delete(id);
      if (!success) {
        res.status(404).json({ error: 'Note not found' });
        return;
      }

      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export default createNotesRouter({
  noteModel: DefaultNoteModel,
  guideModel: DefaultGuideModel,
});
