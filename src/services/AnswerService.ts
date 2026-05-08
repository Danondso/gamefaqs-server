// Composes RetrievalService + SynthesisService and reports stage timings.
//
// Short-circuit: if retrieval returns no citations there is nothing for the
// model to ground on, so we skip the synthesis call entirely and return the
// canonical "no answer" sentinel. Saves several seconds per nonsense question.

import { performance } from 'perf_hooks';
import { RetrievalService, type Citation, type RetrievalFilters } from './RetrievalService';
import { SynthesisService } from './SynthesisService';
import { GameExtractionService, type ExtractionContext, type ExtractionOutcome } from './GameExtractionService';
import { ProductiveRefusalService } from './ProductiveRefusalService';

export interface AnswerServiceDeps {
  retrievalService: RetrievalService;
  synthesisService: SynthesisService;
  extractionService: GameExtractionService;
  refusalService: ProductiveRefusalService;
}

export interface AnswerResult {
  answer: string;
  no_answer: boolean;
  citations: Citation[];
  extraction: ExtractionOutcome;
  needs_disambiguation?: boolean;
  disambiguation_candidates?: Array<{ game_id: string; title: string }>;
  timing_ms: {
    embed: number;
    retrieve: number;
    synthesize: number;
    total: number;
  };
}

export class AnswerService {
  private readonly retrieval: RetrievalService;
  private readonly synthesis: SynthesisService;
  private readonly extraction: GameExtractionService;
  private readonly refusals: ProductiveRefusalService;

  constructor(deps: AnswerServiceDeps) {
    this.retrieval = deps.retrievalService;
    this.synthesis = deps.synthesisService;
    this.extraction = deps.extractionService;
    this.refusals = deps.refusalService;
  }

  async answer(question: string, filters: RetrievalFilters, topK: number, context: ExtractionContext = {}): Promise<AnswerResult> {
    const startedAt = performance.now();
    const extraction = this.extraction.extract(question, context);

    if (this.extraction.isOutOfScope(question)) {
      return {
        answer: this.refusals.build('out_of_scope', question),
        no_answer: true,
        citations: [],
        extraction,
        timing_ms: { embed: 0, retrieve: 0, synthesize: 0, total: round(performance.now() - startedAt) },
      };
    }

    if (extraction.status === 'ambiguous') {
      const candidates = this.lookupGameTitles(extraction.gameIds);
      // Multiple game IDs can share the same display title (platform variants
      // catalogued separately, e.g. OoT Master Quest with platform=null and
      // platform=GameCube both titled "...Ocarina of Time Master Quest"). Dedup
      // for the user-facing prose, but keep all ids in disambiguation_candidates
      // so a downstream resolver can still pick a specific variant.
      const distinctTitles = Array.from(new Set(candidates.map(c => c.title)));
      const ask = distinctTitles.length >= 2 && distinctTitles.length <= 3
        ? `I found multiple likely games: ${distinctTitles.join(', ')}. Which one are you playing?`
        : 'I found several possible games. Which game and platform do you mean?';
      return {
        answer: ask,
        no_answer: true,
        citations: [],
        extraction,
        needs_disambiguation: true,
        disambiguation_candidates: candidates.slice(0, 3),
        timing_ms: { embed: 0, retrieve: 0, synthesize: 0, total: round(performance.now() - startedAt) },
      };
    }

    let effectiveFilters: RetrievalFilters = { ...filters };

    if (extraction.status === 'unclear') {
      if (!filters.gameId) {
        // No game was extracted and the caller didn't supply one. Asking the user
        // to name the game is more helpful than corpus-wide retrieval, which would
        // almost always return a retrieval_thin refusal anyway.
        return {
          answer: this.refusals.build('extraction_failure', question),
          no_answer: true,
          citations: [],
          extraction,
          needs_disambiguation: true,
          timing_ms: { embed: 0, retrieve: 0, synthesize: 0, total: round(performance.now() - startedAt) },
        };
      }
      // Caller supplied an explicit game_id — use it even though extraction was unclear.
      effectiveFilters = { ...filters };
    } else {
      effectiveFilters = {
        ...filters,
        gameId: filters.gameId ?? extraction.gameId,
      };
    }

    let { citations, embedMs, retrieveMs } = await this.retrieval.retrieveWithTimings(
      question,
      effectiveFilters,
      topK
    );

    // Fallback: if the hard game-filter returned nothing, check whether the
    // extracted game_id has platform variants (e.g., "Final Fantasy VII (PS1)")
    // whose guides ARE indexed. This handles the case where games_fts picks a
    // "base" title entry with no linked guides while the actual guides sit under
    // platform-specific siblings. We try each sibling in turn and use the first
    // that returns results. The game-id filter is preserved (no contamination).
    if (citations.length === 0 && effectiveFilters.gameId) {
      const siblings = this.retrieval.findGameIdVariants(effectiveFilters.gameId);
      for (const sibId of siblings) {
        const sibling = await this.retrieval.retrieveWithTimings(
          question,
          { ...effectiveFilters, gameId: sibId },
          topK
        );
        embedMs += sibling.embedMs;
        retrieveMs += sibling.retrieveMs;
        if (sibling.citations.length > 0) {
          citations = sibling.citations;
          break;
        }
      }
    }

    // Resolve a display title to enrich refusal messages when extraction
    // identified the game. Pulled from extraction.gameId (when confident) or
    // the caller-supplied filter so a downstream "I have guides for X but…"
    // message has something concrete to say.
    const resolvedGameId = extraction.status === 'confident'
      ? extraction.gameId
      : (filters.gameId ?? undefined);
    const refusalCtx = resolvedGameId
      ? { gameTitle: this.lookupGameTitles([resolvedGameId])[0]?.title }
      : {};

    if (citations.length === 0) {
      return {
        answer: this.refusals.build('retrieval_thin', question, refusalCtx),
        no_answer: true,
        citations: [],
        extraction,
        timing_ms: {
          embed: round(embedMs),
          retrieve: round(retrieveMs),
          synthesize: 0,
          total: round(performance.now() - startedAt),
        },
      };
    }

    const synthStart = performance.now();
    const { answer, no_answer } = await this.synthesis.synthesize(question, citations);
    const synthMs = performance.now() - synthStart;
    const finalAnswer = no_answer ? this.refusals.build('synthesis_cant_ground', question, refusalCtx) : answer;

    return {
      answer: finalAnswer,
      no_answer,
      citations,
      extraction,
      timing_ms: {
        embed: round(embedMs),
        retrieve: round(retrieveMs),
        synthesize: round(synthMs),
        total: round(performance.now() - startedAt),
      },
    };
  }

  private lookupGameTitles(gameIds: string[]): Array<{ game_id: string; title: string }> {
    if (gameIds.length === 0) return [];
    const placeholders = gameIds.map(() => '?').join(',');
    const rows = this.retrieval.getDb().query<{ id: string; title: string }>(
      `SELECT id, title FROM games WHERE id IN (${placeholders}) LIMIT 3`,
      gameIds
    );
    return rows.map(r => ({ game_id: r.id, title: r.title }));
  }
}

function round(ms: number): number {
  return Math.round(ms);
}
