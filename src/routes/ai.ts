import { Router, Request, Response, NextFunction } from 'express';
import OllamaService from '../services/OllamaService';
import GuideModel from '../models/Guide';
import type { GuideMetadata } from '../types';

const router = Router();

// GET /api/ai/status - Check Ollama availability and list models
router.get('/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = await OllamaService.checkAvailability();
    res.json(status);
  } catch (error) {
    next(error);
  }
});

// POST /api/ai/analyze/:id - Analyze a single guide (metadata + summary)
// Use ?preview=true to get analysis without saving
router.post('/analyze/:id', async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const preview = req.query.preview === 'true';

    // Check Ollama availability first
    const status = await OllamaService.checkAvailability();
    if (!status.available) {
      res.status(503).json({
        error: 'Ollama service unavailable',
        details: status.error,
      });
      return;
    }

    // Get the guide
    const guide = GuideModel.findById(id);
    if (!guide) {
      res.status(404).json({ error: 'Guide not found' });
      return;
    }

    // Parse existing metadata
    let existingMetadata: GuideMetadata = {};
    if (guide.metadata) {
      try {
        existingMetadata = JSON.parse(guide.metadata);
      } catch {
        // Ignore parse errors
      }
    }

    // Analyze the guide
    console.log(`[AI] Analyzing guide: ${guide.title}`);
    const analysis = await OllamaService.analyzeGuide(
      guide.content,
      guide.title,
      existingMetadata
    );

    // If preview mode, return without saving
    if (preview) {
      res.json({
        success: true,
        guideId: id,
        analysis,
        existing: existingMetadata,
      });
      return;
    }

    // Merge with existing metadata and save
    const newMetadata: GuideMetadata = {
      ...existingMetadata,
      ...analysis,
      aiAnalyzedAt: Date.now(),
    };

    GuideModel.setMetadata(id, newMetadata);
    console.log(`[AI] Analysis complete for guide: ${guide.title}`);

    res.json({
      success: true,
      guideId: id,
      analysis,
      metadata: newMetadata,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/ai/analyze/:id/save - Save selected fields from analysis
router.post('/analyze/:id/save', async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { fields } = req.body;

    if (!fields || typeof fields !== 'object') {
      res.status(400).json({ error: 'fields object is required' });
      return;
    }

    // Get the guide
    const guide = GuideModel.findById(id);
    if (!guide) {
      res.status(404).json({ error: 'Guide not found' });
      return;
    }

    // Parse existing metadata
    let existingMetadata: GuideMetadata = {};
    if (guide.metadata) {
      try {
        existingMetadata = JSON.parse(guide.metadata);
      } catch {
        // Ignore parse errors
      }
    }

    // Merge only selected fields
    const allowedFields = ['gameName', 'platform', 'author', 'tags', 'summary'];
    const newMetadata: GuideMetadata = { ...existingMetadata };

    for (const field of allowedFields) {
      if (fields[field] !== undefined) {
        (newMetadata as any)[field] = fields[field];
      }
    }
    newMetadata.aiAnalyzedAt = Date.now();

    // If gameName is being saved, also update the guide's title
    if (fields.gameName) {
      GuideModel.update(id, {
        title: fields.gameName,
        metadata: JSON.stringify(newMetadata)
      });
      console.log(`[AI] Updated title and metadata for guide: ${fields.gameName}`);
    } else {
      GuideModel.setMetadata(id, newMetadata);
      console.log(`[AI] Saved metadata for guide: ${guide.title}`);
    }

    res.json({
      success: true,
      guideId: id,
      savedFields: Object.keys(fields),
      metadata: newMetadata,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/ai/summarize/:id - Generate summary only for a guide
router.post('/summarize/:id', async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    // Check Ollama availability first
    const status = await OllamaService.checkAvailability();
    if (!status.available) {
      res.status(503).json({
        error: 'Ollama service unavailable',
        details: status.error,
      });
      return;
    }

    // Get the guide
    const guide = GuideModel.findById(id);
    if (!guide) {
      res.status(404).json({ error: 'Guide not found' });
      return;
    }

    // Generate summary
    console.log(`[AI] Generating summary for: ${guide.title}`);
    const summary = await OllamaService.generateSummary(guide.content, guide.title);

    if (!summary) {
      res.status(500).json({ error: 'Failed to generate summary' });
      return;
    }

    // Parse existing metadata and add summary
    let existingMetadata: GuideMetadata = {};
    if (guide.metadata) {
      try {
        existingMetadata = JSON.parse(guide.metadata);
      } catch {
        // Ignore parse errors
      }
    }

    const newMetadata: GuideMetadata = {
      ...existingMetadata,
      summary,
      aiAnalyzedAt: Date.now(),
    };

    GuideModel.setMetadata(id, newMetadata);
    console.log(`[AI] Summary generated for guide: ${guide.title}`);

    res.json({
      success: true,
      guideId: id,
      summary,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
