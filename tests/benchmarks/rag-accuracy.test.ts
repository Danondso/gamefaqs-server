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
//
// TODO: substring matching has a known false-positive: "Final Fantasy VII"
// is a substring of "Final Fantasy VIII", so a citation for FF8 satisfies
// an FF7 expectation. The vague-questions block below explicitly relies on
// this kind of fuzziness (multiple plausible games), but the FF7/FF8 case
// is unintentional. Fix by accepting an `expectedTitleRegex` field so each
// question can specify word boundaries (`\bVII\b`) when needed.

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

  // ---- Vague / niche / under-specified questions ---------------------------
  // Goal: see how the system handles imprecise prompts where the "right"
  // answer is fuzzy. Recall here means "did we find SOME relevant guide";
  // the answer-keyword check is a softer signal of synthesis quality.
  {
    question: "Who's the first enemy I fight in Final Fantasy X?",
    expectedTitleSubstrings: ['Final Fantasy X', 'FFX'],
    expectedAnswerKeywords: ['Sin', 'Sinscale', 'Klikk', 'Geosgaeno'],
    notes: 'Multiple plausible "first enemies" (prologue Sin spawn, Klikk on the boat, Sinscale tutorial). Synth should name at least one.',
  },
  {
    question: 'What weapon does Cloud start with?',
    expectedTitleSubstrings: ['Final Fantasy VII', 'FF7'],
    expectedAnswerKeywords: ['Buster Sword', 'Buster'],
    notes: 'Character-specific question with no game name. Tests whether the embedding can latch onto FF7 from "Cloud" alone.',
  },
  {
    question: 'How do I solve the first puzzle in Portal?',
    expectedTitleSubstrings: ['Portal'],
    expectedAnswerKeywords: ['cube', 'button', 'companion'],
    notes: '"Portal" is also a generic word — tests whether the embedding disambiguates the game from generic "portal" content.',
  },
  {
    question: 'How do I solve the church window puzzle in Resident Evil 4?',
    expectedTitleSubstrings: ['Resident Evil 4', 'biohazard 4'],
    expectedAnswerKeywords: ['rotate', 'panel', 'symbol', 'altar'],
    notes: 'Niche specific puzzle (the rotating colored panels above the altar). Hard for retrieval to find the right chunk.',
  },
  {
    question: 'How do I beat the second boss?',
    expectedTitleSubstrings: [],
    expectedAnswerKeywords: [],
    notes: 'Intentionally unanswerable: no game named, no boss named. Should ideally return no_answer rather than confidently invent one. Recall hit will always be false (no expected substrings) — read the synthesized answer manually.',
  },
  {
    question: 'Where do I find the Master Key?',
    expectedTitleSubstrings: ['Resident Evil', 'Silent Hill', 'Zelda'],
    expectedAnswerKeywords: ['key'],
    notes: '"Master Key" appears in many survival-horror and adventure games. Tests how the system handles legitimate ambiguity.',
  },
  {
    question: 'What is the best starter Pokemon?',
    expectedTitleSubstrings: ['Pokemon', 'Pokémon'],
    expectedAnswerKeywords: ['Bulbasaur', 'Charmander', 'Squirtle', 'Chikorita', 'Cyndaquil', 'Totodile', 'Treecko', 'Torchic', 'Mudkip'],
    notes: 'No specific game named. System should retrieve some Pokemon guide; ideally the answer mentions starters from at least one generation.',
  },
  {
    question: 'How do I learn Ultima?',
    expectedTitleSubstrings: ['Final Fantasy'],
    expectedAnswerKeywords: ['Ultima'],
    notes: 'Ultima is a recurring spell across the FF series. Any FF guide that explains how to learn it counts.',
  },

  // ---- Adversarial / trick questions ---------------------------------------
  // Premise of each is false. Recall may still hit (a Zelda guide for the
  // Triforce question), but the interesting signal is the synthesized answer:
  // does the system invent a fake walkthrough, or does it correct the premise
  // / return no_answer? Read the answers by hand.
  {
    question: "Where's the Triforce in Ocarina of Time?",
    expectedTitleSubstrings: ['Ocarina of Time', 'Zelda'],
    expectedAnswerKeywords: ['not', "don't", 'cannot'],
    notes: "TRICK: you don't actually obtain the Triforce in OoT — Link only touches the pedestal. A faithful answer should say so; an unfaithful one will hallucinate a location.",
  },
  {
    question: 'How do I beat the final boss in Tetris?',
    expectedTitleSubstrings: [],
    expectedAnswerKeywords: ['no boss', 'no final', 'endless'],
    notes: 'TRICK: classic Tetris has no final boss. Empty expected substrings — informational. Watch for invented bosses in the answer.',
  },
  {
    question: 'How do I use the secret combo to one-shot Ganon in Breath of the Wild?',
    expectedTitleSubstrings: ['Breath of the Wild', 'Zelda'],
    expectedAnswerKeywords: [],
    notes: 'TRICK: there is no "secret combo" — the question presupposes one. Watch for the system inventing button inputs.',
  },

  // ---- Sequel disambiguation -----------------------------------------------
  // Series name only, no installment specified. There IS no single right
  // answer; we accept any installment in the series and watch the synthesis
  // for whether it acknowledges the ambiguity or just picks one silently.
  {
    question: 'How do I beat the final boss in Resident Evil?',
    expectedTitleSubstrings: ['Resident Evil', 'biohazard'],
    expectedAnswerKeywords: ['boss'],
    notes: 'AMBIGUOUS series name. Any RE installment in the citation counts as recall hit; ideal synthesis names which game it picked.',
  },
  {
    question: "What's the best class in Diablo?",
    expectedTitleSubstrings: ['Diablo'],
    expectedAnswerKeywords: ['Sorceress', 'Barbarian', 'Necromancer', 'Paladin', 'Witch Doctor', 'Demon Hunter', 'Crusader', 'Wizard', 'Monk'],
    notes: 'AMBIGUOUS series name. Class names differ across D1/D2/D3/D4. Any class from any installment counts.',
  },
  {
    question: 'How do I solve the temple puzzle in Zelda?',
    expectedTitleSubstrings: ['Zelda', 'Hyrule', 'Ocarina', 'Majora', 'Wind Waker', 'Twilight Princess', 'Skyward', 'Breath', 'Tears'],
    expectedAnswerKeywords: ['temple'],
    notes: 'AMBIGUOUS series name. Most 3D Zeldas have temples. Any one counts as recall.',
  },

  // ---- Numeric / quantitative facts ----------------------------------------
  // RAG should excel here: the exact number lives in a guide and just needs
  // to be retrieved. Soft check via answer keyword (the actual digit).
  {
    question: 'How many stars are in Super Mario 64?',
    expectedTitleSubstrings: ['Super Mario 64', 'mario 64'],
    expectedAnswerKeywords: ['120'],
    notes: 'Exact number test. Should retrieve SM64 guide and answer "120".',
  },
  {
    question: 'What is the max level in Diablo 2?',
    expectedTitleSubstrings: ['Diablo 2', 'Diablo II'],
    expectedAnswerKeywords: ['99'],
    notes: 'Exact number test. Max character level in D2 is 99.',
  },
  {
    question: 'How many Triforce shards are in Wind Waker?',
    expectedTitleSubstrings: ['Wind Waker', 'Zelda'],
    expectedAnswerKeywords: ['8', 'eight'],
    notes: 'Exact number test. WW has 8 Triforce shards to collect.',
  },

  // ---- Story / lore (vs. gameplay) -----------------------------------------
  // Walkthroughs sometimes summarize plot, sometimes don't. Tests whether
  // narrative content is being chunked + retrieved alongside game-mechanic
  // content.
  {
    question: 'Why did Sephiroth burn down Nibelheim?',
    expectedTitleSubstrings: ['Final Fantasy VII', 'FF7'],
    expectedAnswerKeywords: ['Jenova', 'mother', 'Shinra', 'experiment'],
    notes: 'Story question. Answer involves Sephiroth discovering his Jenova/Shinra-experiment origins in the mansion.',
  },
  {
    question: "Who is Solid Snake's father?",
    expectedTitleSubstrings: ['Metal Gear', 'mgs'],
    expectedAnswerKeywords: ['Big Boss', 'Naked Snake'],
    notes: 'Lore question. Big Boss / Naked Snake is the genetic father (cloned from).',
  },
  {
    question: "What's Aerith's last name?",
    expectedTitleSubstrings: ['Final Fantasy VII', 'FF7'],
    expectedAnswerKeywords: ['Gainsborough'],
    notes: 'Lore question. Aerith Gainsborough — niche enough that not every FF7 guide says it.',
  },

  // ---- Glitches / exploits -------------------------------------------------
  // Well-documented across guide types but live in dedicated glitch FAQs more
  // than walkthroughs. Tests retrieval breadth.
  {
    question: "What's the missingno glitch in Pokemon Red?",
    expectedTitleSubstrings: ['Pokemon Red', 'Pokemon Blue', 'Pokémon'],
    expectedAnswerKeywords: ['Cinnabar', 'old man', 'item'],
    notes: 'Famous Gen 1 glitch (talk to the old man, fly to Cinnabar, surf the east coast). Item-duplication side effect.',
  },
  {
    question: 'How do I do the W-Item duplication trick in Final Fantasy 7?',
    expectedTitleSubstrings: ['Final Fantasy VII', 'FF7'],
    expectedAnswerKeywords: ['W-Item', 'duplicate', 'cancel'],
    notes: 'Classic FF7 exploit (use W-Item, select item, swap target with cancel to dupe).',
  },
  {
    question: 'How does the duplicate item glitch work in Diablo 2?',
    expectedTitleSubstrings: ['Diablo 2', 'Diablo II'],
    expectedAnswerKeywords: ['dupe', 'duplicate', 'mule'],
    notes: 'Several dupes existed across patches; any documented one counts.',
  },
  {
    question: 'What are the cheats for the weapon sets in GTA San Andreas?',
    expectedTitleSubstrings: ['San Andreas', 'GTA'],
    expectedAnswerKeywords: ['LXGIWYL', 'KJKSZPJ', 'UZUMYMW', 'weapon', 'set'],
    notes: 'PC cheats are LXGIWYL/KJKSZPJ/UZUMYMW for sets 1/2/3; PS2/Xbox use button sequences. Any of those (or the d-pad sequences) counts.',
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
    // The /answer endpoint is rate-limited; honor 429 retryAfter (capped) so
    // larger benchmark suites don't fail mid-run.
    const MAX_429_RETRIES = 4;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${BASE_URL}/api/guides/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, top_k: TOP_K }),
        signal: controller.signal,
      });
      if (res.status === 429 && attempt < MAX_429_RETRIES) {
        const body = await res.json().catch(() => ({ retryAfter: 3 })) as { retryAfter?: number };
        const waitSec = Math.min(body.retryAfter ?? 3, 10);
        await new Promise(r => setTimeout(r, waitSec * 1000));
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`API ${res.status}: ${body.slice(0, 200)}`);
      }
      return (await res.json()) as ApiAnswer;
    }
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
      // When expectedTitleSubstrings is empty, the question is informational
      // (e.g. an intentionally unanswerable prompt to read by hand) — record
      // the result and skip the assertion.
      if (q.expectedTitleSubstrings.length === 0) return;
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
