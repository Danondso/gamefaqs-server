import { describe, it, expect } from 'vitest';
import { AnswerService } from '../src/services/AnswerService';
import { ProductiveRefusalService } from '../src/services/ProductiveRefusalService';
import type { RetrievalService } from '../src/services/RetrievalService';
import type { SynthesisService } from '../src/services/SynthesisService';
import type { GameExtractionService } from '../src/services/GameExtractionService';

function makeAnswerService(extraction: any, citations: any[] = [], synthText = 'ok [1]', titleRows?: Array<{ id: string; title: string }>) {
  const retrieval = {
    retrieveWithTimings: async () => ({ citations, embedMs: 10, retrieveMs: 20 }),
    getDb: () => ({ query: () => titleRows ?? [{ id: 'g1', title: 'Final Fantasy VII' }] }),
  } as unknown as RetrievalService;
  const synthesis = {
    synthesize: async () => ({ answer: synthText, no_answer: false }),
  } as unknown as SynthesisService;
  const extractor = {
    extract: () => extraction,
    isOutOfScope: () => false,
  } as unknown as GameExtractionService;
  return new AnswerService({
    retrievalService: retrieval,
    synthesisService: synthesis,
    extractionService: extractor,
    refusalService: new ProductiveRefusalService(),
  });
}

describe('AnswerService layered flow', () => {
  it('returns disambiguation prompt for ambiguous extraction', async () => {
    const svc = makeAnswerService({ status: 'ambiguous', gameIds: ['g1', 'g2'], reason: 'multi' });
    const out = await svc.answer('where is the sword', {}, 8);
    expect(out.needs_disambiguation).toBe(true);
    expect(out.no_answer).toBe(true);
  });

  it('dedupes ambiguous candidates with shared display titles in the user-facing prose', async () => {
    const svc = makeAnswerService(
      { status: 'ambiguous', gameIds: ['oot', 'mq_a', 'mq_b'], reason: 'multi' },
      [],
      'ok',
      [
        { id: 'oot', title: 'The Legend of Zelda Ocarina of Time' },
        { id: 'mq_a', title: 'The Legend of Zelda Ocarina of Time Master Quest' },
        { id: 'mq_b', title: 'The Legend of Zelda Ocarina of Time Master Quest' },
      ]
    );
    const out = await svc.answer('how do i get the master sword', {}, 8);
    expect(out.needs_disambiguation).toBe(true);
    // Title appears once in prose despite two distinct IDs sharing it.
    const occurrences = out.answer.split('Master Quest').length - 1;
    expect(occurrences).toBe(1);
    // Both ambiguous IDs are still present internally.
    expect(out.disambiguation_candidates?.length).toBe(3);
  });

  it('returns productive refusal for unclear extraction', async () => {
    const svc = makeAnswerService({ status: 'unclear', reason: 'none' });
    const out = await svc.answer('how do i beat second boss', {}, 8);
    expect(out.no_answer).toBe(true);
    expect(out.answer.toLowerCase()).toContain('which game');
  });

  it('retrieves and synthesizes with confident extraction', async () => {
    const svc = makeAnswerService(
      { status: 'confident', gameId: 'g1', confidence: 1, reason: 'alias' },
      [{ guide_id: 'g', guide_title: 't', chunk_id: 'c', chunk_index: 0, gamefaqs_id: null, content: 'x', excerpt: 'x', score: 1 }],
      'Use a save point [1]'
    );
    const out = await svc.answer('how do i save', {}, 8);
    expect(out.no_answer).toBe(false);
    expect(out.answer).toContain('[1]');
  });
});
