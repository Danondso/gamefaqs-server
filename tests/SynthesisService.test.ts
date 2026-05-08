// Layer 4 synthesis tests — controlled citation fixtures, no live Ollama.
//
// Strategy (per SYNTH_DEBUG discipline): pass a fixed `buildPrompt` result or
// mock the fetch to return a canned Ollama response, then verify the
// post-processing (citation stripping, contradiction guard, grounding check)
// operates correctly. Synthesis correctness is independent of retrieval quality,
// so each test provides its own citations array.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SynthesisService, NO_ANSWER_SENTENCE } from '../src/services/SynthesisService';
import type { Citation } from '../src/services/RetrievalService';

const HOST = 'http://localhost:11434';
const MODEL = 'qwen3:1.7b';

function makeCitations(titles: string[]): Citation[] {
  return titles.map((t, i) => {
    const excerpt = `Excerpt from ${t}. Content about gameplay mechanics.`;
    return {
      guide_id: `g${i}`,
      guide_title: t,
      chunk_id: `c${i}`,
      chunk_index: 0,
      gamefaqs_id: null,
      content: excerpt,
      excerpt,
      score: 1 - i * 0.1,
    };
  });
}

function makeSvc(): SynthesisService {
  return new SynthesisService({ host: HOST, model: MODEL });
}

function stubFetch(response: string) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
    ok: true,
    json: async () => ({ response }),
  } as unknown as Response));
}

describe('SynthesisService.buildPrompt', () => {
  it('includes all excerpt titles and the question', () => {
    const svc = makeSvc();
    const cits = makeCitations(['FF7 Walkthrough', 'Diablo 2 FAQ']);
    const prompt = svc.buildPrompt('How do I beat the boss?', cits);
    expect(prompt).toContain('[1] (from "FF7 Walkthrough")');
    expect(prompt).toContain('[2] (from "Diablo 2 FAQ")');
    expect(prompt).toContain('How do I beat the boss?');
  });

  it('strips author attribution from guide titles in the prompt', () => {
    const svc = makeSvc();
    // Use citations with author-free excerpt content so we can assert that
    // author names are stripped from the (from "…") display title, not merely
    // absent because they never appeared in the excerpts.
    const cits: Citation[] = [
      {
        guide_id: 'g0',
        guide_title: 'Final Fantasy VII — KoritheMan',
        chunk_id: 'c0',
        chunk_index: 0,
        gamefaqs_id: null,
        excerpt: 'Cloud starts with the Buster Sword.',
        content: 'Cloud starts with the Buster Sword.',
        score: 1.0,
      },
      {
        guide_id: 'g1',
        guide_title: 'Chrono Trigger — AdrenalineSL',
        chunk_id: 'c1',
        chunk_index: 0,
        gamefaqs_id: null,
        excerpt: 'Crono uses Luminaire as his strongest tech.',
        content: 'Crono uses Luminaire as his strongest tech.',
        score: 0.9,
      },
    ];
    const prompt = svc.buildPrompt('Who is Cloud?', cits);
    // Author names must NOT appear in the (from "…") display title.
    expect(prompt).not.toContain('KoritheMan');
    expect(prompt).not.toContain('AdrenalineSL');
    // Game titles must still be present.
    expect(prompt).toContain('[1] (from "Final Fantasy VII")');
    expect(prompt).toContain('[2] (from "Chrono Trigger")');
    // Excerpt content must be preserved.
    expect(prompt).toContain('Cloud starts with the Buster Sword');
  });

  it('leaves titles without " — " unchanged', () => {
    const svc = makeSvc();
    const cits = makeCitations(['Super Mario 64', 'Diablo II']);
    const prompt = svc.buildPrompt('q', cits);
    expect(prompt).toContain('[1] (from "Super Mario 64")');
    expect(prompt).toContain('[2] (from "Diablo II")');
  });

  it('numbers citations starting at 1', () => {
    const svc = makeSvc();
    const cits = makeCitations(['A', 'B', 'C']);
    const prompt = svc.buildPrompt('q', cits);
    expect(prompt).toContain('[1]');
    expect(prompt).toContain('[2]');
    expect(prompt).toContain('[3]');
    expect(prompt).not.toContain('[0]');
    expect(prompt).not.toContain('[4]');
  });

  it('includes the no-answer instruction', () => {
    const svc = makeSvc();
    const prompt = svc.buildPrompt('q', makeCitations(['A']));
    expect(prompt).toContain(NO_ANSWER_SENTENCE);
  });

  it('includes rules about author names and citation-index semantics', () => {
    const svc = makeSvc();
    const prompt = svc.buildPrompt('q', makeCitations(['A']));
    // Rule 10 — author metadata guard
    expect(prompt).toMatch(/author/i);
    // Rule 11 — citation indices are not values
    expect(prompt).toMatch(/reference indices/i);
  });

  it('includes rules about guide taxonomy markers (encounter IDs, section numbers)', () => {
    const svc = makeSvc();
    const prompt = svc.buildPrompt('q', makeCitations(['A']));
    // Rule 12 — formation/encounter ID guard
    expect(prompt).toMatch(/formation IDs?/i);
    // Rule 13 — section marker guard
    expect(prompt).toMatch(/guide navigation/i);
    // Rule 14 — structural identifier grounding guard
    expect(prompt).toMatch(/structural identifier/i);
  });

  it('uses full chunk content for synthesis when present (not the truncated excerpt)', () => {
    const svc = makeSvc();
    const cits: Citation[] = [
      {
        guide_id: 'g',
        guide_title: 'Pokemon Red',
        chunk_id: 'c',
        chunk_index: 0,
        gamefaqs_id: null,
        excerpt: 'Early unrelated preamble'.repeat(20),
        content:
          'Early unrelated preamble...\nElite Four: Lorelei, Bruno, Agatha, Lance.\nDetailed boss strategies follow.',
        score: 1,
      },
    ];
    const prompt = svc.buildPrompt('Who are the Elite Four?', cits);
    expect(prompt).toContain('Elite Four: Lorelei, Bruno, Agatha, Lance');
    // Would not appear if only `excerpt` (prefix of chunk) were used
    expect(prompt).toContain('Detailed boss strategies follow.');
  });
});

describe('SynthesisService.synthesize — grounded answers', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns no_answer=false when model cites at least one valid source', async () => {
    stubFetch('Use a save point near the town. [1]');
    const svc = makeSvc();
    const result = await svc.synthesize('how do i save', makeCitations(['FF7 Guide']));
    expect(result.no_answer).toBe(false);
    expect(result.answer).toContain('[1]');
  });

  it('preserves multi-citation references like [1,2]', async () => {
    // Use shared distinctive tokens (Equip, sword) in both chunk contents so
    // the post-synth citation verifier accepts both [1] and [2] as supporting.
    stubFetch('Equip the sword first [1,2], then fight the boss.');
    const svc = makeSvc();
    const cits = makeCitations(['A', 'B']);
    cits[0].content = 'Equip the sword from your inventory before approaching the boss room.';
    cits[1].content = 'The starter sword is the most reliable weapon to equip early on.';
    const result = await svc.synthesize('q', cits);
    expect(result.no_answer).toBe(false);
    expect(result.answer).toContain('[1,2]');
  });

  it('passes the model response through as-is when all cites are valid', async () => {
    stubFetch('The materia is in the Shinra building. [2]');
    const svc = makeSvc();
    const result = await svc.synthesize('q', makeCitations(['A', 'B', 'C']));
    expect(result.answer).toBe('The materia is in the Shinra building. [2]');
  });
});

describe('SynthesisService.synthesize — no-answer detection', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns no_answer=true when model emits the exact sentinel', async () => {
    stubFetch(NO_ANSWER_SENTENCE);
    const svc = makeSvc();
    const result = await svc.synthesize('trick question', makeCitations(['X']));
    expect(result.no_answer).toBe(true);
  });

  it('returns no_answer=true when model starts with the sentinel then continues', async () => {
    stubFetch(`${NO_ANSWER_SENTENCE} (but maybe try looking harder)`);
    const svc = makeSvc();
    const result = await svc.synthesize('q', makeCitations(['X']));
    expect(result.no_answer).toBe(true);
  });

  it('returns no_answer=true when answer has numeric claims but zero valid citations', async () => {
    // Model returned a number without any citation ref → ungrounded.
    stubFetch('There are 120 stars to collect.');
    const svc = makeSvc();
    const result = await svc.synthesize('how many stars', makeCitations(['SM64 Guide']));
    expect(result.no_answer).toBe(true);
  });

  it('ignores markdown-style line numbering for grounding so roster prose can pass without stray list indices', async () => {
    // Only structural "1. / 2." digits — substantive text has no other numerals → early pass-through.
    stubFetch(`1. Defeat Lorelei: Ice roster here.
2. Defeat Bruno: Fighting roster here.`);
    const svc = makeSvc();
    const result = await svc.synthesize('q', makeCitations(['Pokemon Red']));
    expect(result.no_answer).toBe(false);
  });

  it('ignores list markers without a space after the dot', async () => {
    stubFetch(`1.Defeat Lorelei using Fire.\n2.Defeat Bruno using Flying.`);
    const svc = makeSvc();
    const result = await svc.synthesize('q', makeCitations(['Pokemon Red']));
    expect(result.no_answer).toBe(false);
  });

  it('ignores markdown-bold list indices at line start', async () => {
    stubFetch(`**1.** Defeat Lorelei.\n**2.** Defeat Bruno.`);
    const svc = makeSvc();
    const result = await svc.synthesize('q', makeCitations(['Pokemon Red']));
    expect(result.no_answer).toBe(false);
  });

  it('ignores list markers after a lead-in paragraph (numbered steps not at answer start)', async () => {
    stubFetch(
      'To beat the Elite Four in Pokemon Red, defeat each trainer in order.\n\n1. Defeat Lorelei using Fire types.\n2. Defeat Bruno using Flying types.'
    );
    const svc = makeSvc();
    const result = await svc.synthesize('q', makeCitations(['Pokemon Red']));
    expect(result.no_answer).toBe(false);
  });

  it('still requires citations when substantive numerals remain after stripping list markers', async () => {
    stubFetch('1. Lorelei: Dewgong L54.');
    const svc = makeSvc();
    const result = await svc.synthesize('q', makeCitations(['Pokemon Red']));
    expect(result.no_answer).toBe(true);
  });
});

describe('SynthesisService — stripInvalidCitations', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('removes citation refs that exceed the number of supplied citations', async () => {
    // Model hallucinates [5] when only 2 citations supplied.
    stubFetch('See the map [5] for details, then the boss [1].');
    const svc = makeSvc();
    const result = await svc.synthesize('q', makeCitations(['A', 'B']));
    expect(result.answer).not.toContain('[5]');
    expect(result.answer).toContain('[1]');
  });

  it('keeps valid subset of a mixed citation like [1,9] → [1]', async () => {
    stubFetch('Use the potion [1,9] to heal.');
    const svc = makeSvc();
    const result = await svc.synthesize('q', makeCitations(['A', 'B']));
    // [9] out of range; [1] valid — should reduce to [1]
    expect(result.answer).toContain('[1]');
    expect(result.answer).not.toContain('9');
  });

  it('removes the entire bracket when all refs in it are out of range', async () => {
    stubFetch('The answer is obvious [99,100].');
    const svc = makeSvc();
    const result = await svc.synthesize('q', makeCitations(['A']));
    expect(result.answer).not.toContain('[99');
    expect(result.answer).not.toContain('100]');
  });
});

describe('SynthesisService — preventSelfContradiction', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('strips trailing no-answer hedge when cited content precedes it', async () => {
    const hedged = `Cloud starts with a Buster Sword. [1]\n${NO_ANSWER_SENTENCE}`;
    stubFetch(hedged);
    const svc = makeSvc();
    const result = await svc.synthesize('q', makeCitations(['FF7']));
    // Grounded claim with valid citation [1] + trailing hedge → keep the grounded claim.
    expect(result.answer).toBe('Cloud starts with a Buster Sword. [1]');
    expect(result.no_answer).toBe(false);
  });

  it('collapses to sentinel when trailing no-answer follows uncited content', async () => {
    const uncited = `Cloud starts with a Buster Sword.\n${NO_ANSWER_SENTENCE}`;
    stubFetch(uncited);
    const svc = makeSvc();
    const result = await svc.synthesize('q', makeCitations(['FF7']));
    // No citation bracket before the hedge → cannot trust the claim; sentinel wins.
    expect(result.answer).toBe(NO_ANSWER_SENTENCE);
    expect(result.no_answer).toBe(true);
  });

  it('collapses to sentinel when no-answer phrase appears at the start', async () => {
    const startRefusal = `${NO_ANSWER_SENTENCE}\nCloud starts with a Buster Sword. [1]`;
    stubFetch(startRefusal);
    const svc = makeSvc();
    const result = await svc.synthesize('q', makeCitations(['FF7']));
    // No-answer at the start signals a genuine refusal; content after it is ignored.
    expect(result.answer).toBe(NO_ANSWER_SENTENCE);
    expect(result.no_answer).toBe(true);
  });

  it('leaves a single-line grounded answer that happens to lack "I don\'t" unchanged', async () => {
    stubFetch('Equip the Buster Sword before the fight. [1]');
    const svc = makeSvc();
    const result = await svc.synthesize('q', makeCitations(['FF7']));
    expect(result.answer).toBe('Equip the Buster Sword before the fight. [1]');
    expect(result.no_answer).toBe(false);
  });
});

describe('SynthesisService — error handling', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('throws a labeled error when Ollama returns non-OK status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      text: async () => 'model overloaded',
    } as unknown as Response));
    const svc = makeSvc();
    await expect(svc.synthesize('q', makeCitations(['A'])))
      .rejects.toThrow(/Synthesis API error: 503/);
  });

  it('throws TIMEOUT when fetch is aborted', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(
      Object.assign(new Error('aborted'), { name: 'AbortError' })
    ));
    const svc = new SynthesisService({ host: HOST, model: MODEL, timeoutMs: 1 });
    await expect(svc.synthesize('q', makeCitations(['A']))).rejects.toThrow('TIMEOUT');
  });
});
