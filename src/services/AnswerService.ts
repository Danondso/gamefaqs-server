// Composes RetrievalService + SynthesisService and reports stage timings.
//
// Short-circuit: if retrieval returns no citations there is nothing for the
// model to ground on, so we skip the synthesis call entirely and return the
// canonical "no answer" sentinel. Saves several seconds per nonsense question.

import { performance } from 'perf_hooks';
import {
  RetrievalService,
  type Citation,
  type RetrievalFilters,
} from './RetrievalService';
import { SynthesisService, NO_ANSWER_SENTENCE } from './SynthesisService';

export interface AnswerServiceDeps {
  retrievalService: RetrievalService;
  synthesisService: SynthesisService;
}

export interface AnswerResult {
  answer: string;
  no_answer: boolean;
  citations: Citation[];
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

  constructor(deps: AnswerServiceDeps) {
    this.retrieval = deps.retrievalService;
    this.synthesis = deps.synthesisService;
  }

  async answer(question: string, filters: RetrievalFilters, topK: number): Promise<AnswerResult> {
    const startedAt = performance.now();

    const { citations, embedMs, retrieveMs } = await this.retrieval.retrieveWithTimings(
      question,
      filters,
      topK
    );

    if (citations.length === 0) {
      return {
        answer: NO_ANSWER_SENTENCE,
        no_answer: true,
        citations: [],
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

    return {
      answer,
      no_answer,
      citations,
      timing_ms: {
        embed: round(embedMs),
        retrieve: round(retrieveMs),
        synthesize: round(synthMs),
        total: round(performance.now() - startedAt),
      },
    };
  }
}

function round(ms: number): number {
  return Math.round(ms);
}
