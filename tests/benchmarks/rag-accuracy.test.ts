// RAG accuracy benchmark — hits the live API and checks whether the right
// guide(s) appear in the top citations for a known set of questions.
//
// This is NOT a normal test, even though the file ends in .test.ts: it's
// gated behind RAG_BENCH=1 so it doesn't run during `npm test`. Run with:
//
//   npm run rag:bench
//   # or directly:
//   RAG_BENCH=1 npx vitest run tests/benchmarks/rag-accuracy.test.ts --reporter=verbose
//
// Failures in this suite mean retrieval-quality regressed, NOT that code is
// broken. Treat it as a quality dashboard, not a CI gate.
//
// Adding questions: pick a question whose answer should clearly come from a
// specific game's guide. Expected matches are case-insensitive substrings;
// at least one citation in the top-K must match at least one expected pattern
// for the question to count as "recall hit."

import { describe, it, expect } from 'vitest';

const BASE_URL = process.env.RAG_BENCH_BASE_URL ?? 'http://localhost:3000';
const TOP_K = parseInt(process.env.RAG_BENCH_TOP_K ?? '8', 10);
const TIMEOUT_MS = parseInt(process.env.RAG_BENCH_TIMEOUT_MS ?? '180000', 10);

interface BenchQuestion {
  question: string;
  // Any citation guide_title containing one of these strings (case-insensitive)
  // counts as a hit. Use both the canonical name and the file-path-derived
  // form ("Final Fantasy VII" vs "final-fantasy-vii"), since either could end
  // up in the title field depending on what the parser extracted.
  expectedTitleSubstrings: string[];
  // Optional: keywords we expect the synthesized answer to contain when
  // retrieval works. Soft check — failures here are worth noticing but don't
  // count toward recall.
  expectedAnswerKeywords?: string[];
  // Optional comment for humans.
  notes?: string;
}

const QUESTIONS: BenchQuestion[] = [
  {
    question: 'How do I beat Sephiroth in Final Fantasy VII?',
    expectedTitleSubstrings: ['Final Fantasy VII', 'final fantasy 7', 'ff7'],
    expectedAnswerKeywords: ['Sephiroth'],
  },
  {
    question: 'What is the password for Otacon in Metal Gear Solid 2?',
    expectedTitleSubstrings: ['Metal Gear Solid 2', 'Sons of Liberty', 'mgs2'],
    expectedAnswerKeywords: ['Otacon'],
  },
  {
    question: 'How do I get the Master Sword in Ocarina of Time?',
    expectedTitleSubstrings: ['Ocarina of Time', 'Zelda'],
    expectedAnswerKeywords: ['Master Sword'],
  },
  {
    question: 'How do I beat the Elite Four in Pokemon Red?',
    expectedTitleSubstrings: ['Pokemon Red', 'Pokemon Blue', 'Pokémon Red'],
    expectedAnswerKeywords: ['Elite Four'],
  },
  {
    question: 'How do I beat Krauser in Resident Evil 4?',
    expectedTitleSubstrings: ['Resident Evil 4', 'biohazard 4'],
    expectedAnswerKeywords: ['Krauser'],
  },
  {
    question: 'How do I get all 120 stars in Super Mario 64?',
    expectedTitleSubstrings: ['Super Mario 64', 'mario 64'],
    expectedAnswerKeywords: ['stars'],
  },
  {
    question: 'How do I beat Lavos in Chrono Trigger?',
    expectedTitleSubstrings: ['Chrono Trigger'],
    expectedAnswerKeywords: ['Lavos'],
  },
  {
    question: 'How do I beat Kefka in Final Fantasy VI?',
    expectedTitleSubstrings: ['Final Fantasy VI', 'final fantasy 6', 'final fantasy iii', 'ff6'],
    expectedAnswerKeywords: ['Kefka'],
    notes: 'FF6 was released as Final Fantasy III in the US — accept either',
  },
  {
    question: 'How do I find the inverted castle in Castlevania Symphony of the Night?',
    expectedTitleSubstrings: ['Symphony of the Night', 'Castlevania'],
    expectedAnswerKeywords: ['inverted castle'],
  },
  {
    question: 'How do I get to the secret cow level in Diablo 2?',
    expectedTitleSubstrings: ['Diablo 2', 'Diablo II'],
    expectedAnswerKeywords: ['cow'],
  },
];

interface BenchResult {
  question: string;
  recallHit: boolean;
  matchedTitle: string | null;
  answerKeywordHits: number;
  expectedKeywordCount: number;
  noAnswer: boolean;
  topTitles: string[];
  totalMs: number;
  embedMs: number;
  retrieveMs: number;
  synthesizeMs: number;
}

interface ApiCitation {
  guide_id: string;
  guide_title: string;
  chunk_id: string;
  chunk_index: number;
  excerpt: string;
  score: number;
}

interface ApiAnswer {
  answer: string;
  no_answer: boolean;
  citations: ApiCitation[];
  timing_ms: { embed: number; retrieve: number; synthesize: number; total: number };
}

async function ask(question: string): Promise<ApiAnswer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}/api/guides/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, top_k: TOP_K }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`API ${res.status}: ${body.slice(0, 200)}`);
    }
    return (await res.json()) as ApiAnswer;
  } finally {
    clearTimeout(timer);
  }
}

function checkRecall(citations: ApiCitation[], expected: string[]): { hit: boolean; matchedTitle: string | null } {
  for (const c of citations) {
    const titleLower = (c.guide_title ?? '').toLowerCase();
    for (const exp of expected) {
      if (titleLower.includes(exp.toLowerCase())) {
        return { hit: true, matchedTitle: c.guide_title };
      }
    }
  }
  return { hit: false, matchedTitle: null };
}

function checkAnswerKeywords(answer: string, expected: string[] | undefined): number {
  if (!expected || expected.length === 0) return 0;
  const lower = answer.toLowerCase();
  return expected.reduce((n, k) => (lower.includes(k.toLowerCase()) ? n + 1 : n), 0);
}

const results: BenchResult[] = [];

// Skip the entire suite unless explicitly opted in. The intent is that this
// runs only when the developer wants a quality reading — it makes real HTTP
// calls and depends on a populated index.
const RUN = process.env.RAG_BENCH === '1';

describe.skipIf(!RUN)('RAG accuracy benchmark', () => {
  it.each(QUESTIONS)(
    '$question',
    async (q) => {
      const ans = await ask(q.question);
      const recall = checkRecall(ans.citations, q.expectedTitleSubstrings);
      const keywordHits = checkAnswerKeywords(ans.answer, q.expectedAnswerKeywords);

      const result: BenchResult = {
        question: q.question,
        recallHit: recall.hit,
        matchedTitle: recall.matchedTitle,
        answerKeywordHits: keywordHits,
        expectedKeywordCount: q.expectedAnswerKeywords?.length ?? 0,
        noAnswer: ans.no_answer,
        topTitles: ans.citations.slice(0, 3).map(c => c.guide_title),
        totalMs: ans.timing_ms.total,
        embedMs: ans.timing_ms.embed,
        retrieveMs: ans.timing_ms.retrieve,
        synthesizeMs: ans.timing_ms.synthesize,
      };
      results.push(result);

      // The "test" assertion: we expected at least one citation to match.
      // Failure here means retrieval missed — that's the signal we want.
      expect(
        recall.hit,
        `\nQuestion: ${q.question}` +
          `\nExpected title substring (any): ${JSON.stringify(q.expectedTitleSubstrings)}` +
          `\nTop citation titles returned: ${JSON.stringify(result.topTitles)}` +
          `\nNo-answer flag: ${ans.no_answer}` +
          `\nAnswer (truncated): ${ans.answer.slice(0, 200)}`
      ).toBe(true);
    },
    TIMEOUT_MS
  );

  it('summary', () => {
    const total = results.length;
    const hits = results.filter(r => r.recallHit).length;
    const noAnswers = results.filter(r => r.noAnswer).length;
    const avgTotal = total > 0 ? results.reduce((s, r) => s + r.totalMs, 0) / total : 0;
    const avgRetrieve = total > 0 ? results.reduce((s, r) => s + r.retrieveMs, 0) / total : 0;
    const avgSynth = total > 0 ? results.reduce((s, r) => s + r.synthesizeMs, 0) / total : 0;

    // Use console.warn so it always prints (setup.ts silences console.log).
    /* eslint-disable no-console */
    console.warn('\n========== RAG benchmark summary ==========');
    console.warn(`recall@${TOP_K}: ${hits}/${total} (${total > 0 ? ((hits / total) * 100).toFixed(0) : 0}%)`);
    console.warn(`no_answer responses: ${noAnswers}/${total}`);
    console.warn(`avg total: ${avgTotal.toFixed(0)}ms (retrieve ${avgRetrieve.toFixed(0)}ms, synth ${avgSynth.toFixed(0)}ms)`);
    console.warn('-------------------------------------------');
    for (const r of results) {
      const status = r.recallHit ? 'HIT ' : 'MISS';
      const title = r.matchedTitle ? `→ "${r.matchedTitle.slice(0, 50)}"` : `(top: "${r.topTitles[0]?.slice(0, 50) ?? ''}")`;
      console.warn(`  ${status}  ${r.question.slice(0, 70).padEnd(70)}  ${title}`);
    }
    console.warn('===========================================\n');
    /* eslint-enable no-console */

    // This isn't a hard assertion — the per-question tests are. We just want
    // the summary to print at the end. Keep this trivially passing so a
    // partial recall isn't reported as a separate test failure.
    expect(total).toBeGreaterThan(0);
  });
});
