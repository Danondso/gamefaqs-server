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
// What this file does (and does not) assert:
//   - Per-question: a focused expectation based on `kind`. `specific` and
//     `ambiguous` questions assert recall; `unanswerable` asserts no_answer;
//     `trick` asserts no_answer-OR-correction. A single regression here is
//     loud — that's the point.
//   - Aggregate: at the end, asserts recall over `specific`+`ambiguous`
//     questions stays above RAG_BENCH_RECALL_FLOOR (default 0.7). Wilson 95%
//     CI is printed for context.
//
// Adding questions:
//   1. Pick a `kind`:
//        specific      — exact installment matters. Use `expectedTitleRegex`.
//        ambiguous     — series name or no game named. Substrings OK.
//        trick         — false premise. Watch the answer, not the citation.
//        unanswerable  — model should refuse / return no_answer.
//   2. For `specific`, prefer regex with \b boundaries over bare substrings —
//      a substring like `Final Fantasy VII` will satisfy `Final Fantasy VIII`
//      and a substring like `Pokemon Red` will satisfy `Pokemon Red Rescue
//      Team`. Substrings are still allowed but only run when no regex is set.

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const BASE_URL = process.env.RAG_BENCH_BASE_URL ?? 'http://localhost:3000';
const TOP_K = parseInt(process.env.RAG_BENCH_TOP_K ?? '8', 10);
const FETCH_TIMEOUT_MS = parseInt(process.env.RAG_BENCH_FETCH_TIMEOUT_MS ?? '180000', 10);
const TEST_TIMEOUT_MS = parseInt(process.env.RAG_BENCH_TEST_TIMEOUT_MS ?? String(FETCH_TIMEOUT_MS + 30_000), 10);
// Coarse aggregate-recall drift catch; baseline file is the precise per-question
// regression signal. Default 0.55 is "current state minus a few points of
// expected per-run noise" — tighten or loosen via env.
const RECALL_FLOOR = parseFloat(process.env.RAG_BENCH_RECALL_FLOOR ?? '0.55');

// Baseline records per-question expected pass/fail, so a question that passed
// last run but fails now is flagged loudly even if aggregate recall is fine.
// Write the file with RAG_BENCH_WRITE_BASELINE=1; subsequent runs compare.
const BASELINE_PATH = path.resolve(__dirname, 'baselines', 'rag-accuracy.json');
const WRITE_BASELINE = process.env.RAG_BENCH_WRITE_BASELINE === '1';
const BASELINE_SCHEMA_VERSION = 1;

interface BaselineQuestion {
  question: string;
  kind: QuestionKind;
  passed: boolean;
  matched_title: string | null;
  no_answer: boolean;
  keyword_hits: number;
}
interface Baseline {
  schema_version: number;
  generated_at: string;
  recall_floor_used: number;
  questions: BaselineQuestion[];
}

type QuestionKind = 'specific' | 'ambiguous' | 'trick' | 'unanswerable';

interface BenchQuestion {
  question: string;
  kind: QuestionKind;
  // Match priority: regex if present, else substrings (case-insensitive).
  // For `specific`, prefer regex with \b boundaries.
  expectedTitleRegex?: RegExp;
  expectedTitleSubstrings?: string[];
  // Soft signal for `specific`/`ambiguous`: which keywords we expect in the
  // synthesized answer. Hard signal for `trick`: at least one keyword present
  // OR no_answer=true counts as "premise corrected."
  expectedAnswerKeywords?: string[];
  notes?: string;
}

// Reusable regexes for series with multiple installments. \b in JS handles the
// common case (word boundaries around alphanumerics); roman-numeral matches
// like \bvii\b correctly do NOT match \bviii\b because the trailing I is a
// word char.
const RX_FF7 = /\b(final\s+fantasy\s+(vii|7)|ff\s*7)\b/i;
const RX_FF6 = /\b(final\s+fantasy\s+(vi|6|iii)|ff\s*6)\b/i;
const RX_FFX = /\b(final\s+fantasy\s+(x|10)|ffx)\b/i;
const RX_OOT = /\b(ocarina\s+of\s+time|oot)\b/i;
const RX_BOTW = /\b(breath\s+of\s+the\s+wild|botw)\b/i;
const RX_WW = /\b(wind\s+waker|tww)\b/i;
const RX_SOTN = /\b(symphony\s+of\s+the\s+night|sotn)\b/i;
const RX_RE4 = /\b(resident\s+evil\s+4|biohazard\s+4|re\s*4)\b/i;
const RX_RE_SERIES = /\b(resident\s+evil|biohazard)\b/i;
const RX_MGS2 = /\b(metal\s+gear\s+solid\s+2|sons\s+of\s+liberty|mgs\s*2)\b/i;
const RX_MGS_SERIES = /\b(metal\s+gear|mgs)\b/i;
// Pokemon Red/Blue — exclude Rescue Team and other "Red <Word>" titles by
// requiring the next word to be Blue/Yellow/version/edition or end-of-title.
const RX_POKEMON_RB = /\bpok[eé]mon\s+(red|blue)\s*(?:$|\b(?:and|\/|version|edition|blue|red|yellow)\b)/i;
const RX_POKEMON_SERIES = /\bpok[eé]mon\b/i;
const RX_SM64 = /\b(super\s+mario\s+64|mario\s+64|sm64)\b/i;
const RX_CHRONO = /\bchrono\s+trigger\b/i;
const RX_D2 = /\b(diablo\s+(2|ii)|d2)\b/i;
const RX_DIABLO_SERIES = /\bdiablo\b/i;
const RX_GTA_SA = /\b(san\s+andreas|gta\s*:?\s*sa)\b/i;
const RX_PORTAL = /\bportal\b/i;
const RX_TETRIS = /\btetris\b/i;
const RX_ZELDA_3D = /\b(ocarina|majora|wind\s+waker|twilight\s+princess|skyward\s+sword|breath\s+of\s+the\s+wild|tears\s+of\s+the\s+kingdom|botw|totk)\b/i;

const QUESTIONS: BenchQuestion[] = [
  // ---- Specific: installment matters --------------------------------------
  {
    question: 'How do I beat Sephiroth in Final Fantasy VII?',
    kind: 'specific',
    expectedTitleRegex: RX_FF7,
    expectedAnswerKeywords: ['Sephiroth'],
  },
  {
    question: 'What is the password for Otacon in Metal Gear Solid 2?',
    kind: 'specific',
    expectedTitleRegex: RX_MGS2,
    expectedAnswerKeywords: ['Otacon'],
  },
  {
    question: 'How do I get the Master Sword in Ocarina of Time?',
    kind: 'specific',
    expectedTitleRegex: RX_OOT,
    expectedAnswerKeywords: ['Master Sword'],
    notes: 'Was previously accepting any Zelda guide as a hit; tightened.',
  },
  {
    question: 'How do I beat the Elite Four in Pokemon Red?',
    kind: 'specific',
    expectedTitleRegex: RX_POKEMON_RB,
    expectedAnswerKeywords: ['Elite Four'],
  },
  {
    question: 'How do I beat Krauser in Resident Evil 4?',
    kind: 'specific',
    expectedTitleRegex: RX_RE4,
    expectedAnswerKeywords: ['Krauser'],
  },
  {
    question: 'How do I get all 120 stars in Super Mario 64?',
    kind: 'specific',
    expectedTitleRegex: RX_SM64,
    expectedAnswerKeywords: ['stars'],
  },
  {
    question: 'How do I beat Lavos in Chrono Trigger?',
    kind: 'specific',
    expectedTitleRegex: RX_CHRONO,
    expectedAnswerKeywords: ['Lavos'],
  },
  {
    question: 'How do I beat Kefka in Final Fantasy VI?',
    kind: 'specific',
    expectedTitleRegex: RX_FF6,
    expectedAnswerKeywords: ['Kefka'],
    notes: 'FF6 was released as Final Fantasy III in the US — the regex accepts both. Note this still matches JP/DS FF3 (a different game); rely on the answer keyword to disambiguate.',
  },
  {
    question: 'How do I find the inverted castle in Castlevania Symphony of the Night?',
    kind: 'specific',
    expectedTitleRegex: RX_SOTN,
    expectedAnswerKeywords: ['inverted castle'],
    notes: 'Was previously accepting any Castlevania guide as a hit; tightened.',
  },
  {
    question: 'How do I get to the secret cow level in Diablo 2?',
    kind: 'specific',
    expectedTitleRegex: RX_D2,
    expectedAnswerKeywords: ['cow'],
  },
  {
    question: "Who's the first enemy I fight in Final Fantasy X?",
    kind: 'specific',
    expectedTitleRegex: RX_FFX,
    expectedAnswerKeywords: ['Sin', 'Sinscale', 'Klikk', 'Geosgaeno'],
    notes: 'Multiple plausible "first enemies"; synth should name at least one.',
  },
  {
    question: 'What weapon does Cloud start with?',
    kind: 'specific',
    expectedTitleRegex: RX_FF7,
    expectedAnswerKeywords: ['Buster Sword', 'Buster'],
    notes: 'No game name. Tests embedding-only disambiguation from "Cloud".',
  },
  {
    question: 'How do I solve the first puzzle in Portal?',
    kind: 'specific',
    expectedTitleRegex: RX_PORTAL,
    expectedAnswerKeywords: ['cube', 'button', 'companion'],
    notes: '"Portal" is a generic word — tests whether the embedding picks the game.',
  },
  {
    question: 'How do I solve the church window puzzle in Resident Evil 4?',
    kind: 'specific',
    expectedTitleRegex: RX_RE4,
    expectedAnswerKeywords: ['rotate', 'panel', 'symbol', 'altar'],
  },
  {
    question: 'How many stars are in Super Mario 64?',
    kind: 'specific',
    expectedTitleRegex: RX_SM64,
    expectedAnswerKeywords: ['120'],
  },
  {
    question: 'What is the max level in Diablo 2?',
    kind: 'specific',
    expectedTitleRegex: RX_D2,
    expectedAnswerKeywords: ['99'],
  },
  {
    question: 'How many Triforce shards are in Wind Waker?',
    kind: 'specific',
    expectedTitleRegex: RX_WW,
    expectedAnswerKeywords: ['8', 'eight'],
  },
  {
    question: 'Why did Sephiroth burn down Nibelheim?',
    kind: 'specific',
    expectedTitleRegex: RX_FF7,
    expectedAnswerKeywords: ['Jenova', 'mother', 'Shinra', 'experiment'],
  },
  {
    question: "Who is Solid Snake's father?",
    kind: 'specific',
    expectedTitleRegex: RX_MGS_SERIES,
    expectedAnswerKeywords: ['Big Boss', 'Naked Snake'],
    notes: 'Lore lives across the MG series; any installment is fine here.',
  },
  {
    question: "What's Aerith's last name?",
    kind: 'specific',
    expectedTitleRegex: RX_FF7,
    expectedAnswerKeywords: ['Gainsborough'],
  },
  {
    question: "What's the missingno glitch in Pokemon Red?",
    kind: 'specific',
    expectedTitleRegex: RX_POKEMON_RB,
    expectedAnswerKeywords: ['Cinnabar', 'old man', 'item'],
  },
  {
    question: 'How do I do the W-Item duplication trick in Final Fantasy 7?',
    kind: 'specific',
    expectedTitleRegex: RX_FF7,
    expectedAnswerKeywords: ['W-Item', 'duplicate', 'cancel'],
  },
  {
    question: 'How does the duplicate item glitch work in Diablo 2?',
    kind: 'specific',
    expectedTitleRegex: RX_D2,
    expectedAnswerKeywords: ['dupe', 'duplicate', 'mule'],
  },
  {
    question: 'What are the cheats for the weapon sets in GTA San Andreas?',
    kind: 'specific',
    expectedTitleRegex: RX_GTA_SA,
    expectedAnswerKeywords: ['LXGIWYL', 'KJKSZPJ', 'UZUMYMW', 'weapon', 'set'],
  },

  // ---- Ambiguous: series-only or no-game-named, broad match acceptable ----
  {
    question: 'Where do I find the Master Key?',
    kind: 'ambiguous',
    expectedTitleSubstrings: ['Resident Evil', 'Silent Hill', 'Zelda'],
    expectedAnswerKeywords: ['key'],
    notes: '"Master Key" appears in many survival-horror and adventure games.',
  },
  {
    question: 'What is the best starter Pokemon?',
    kind: 'ambiguous',
    expectedTitleRegex: RX_POKEMON_SERIES,
    expectedAnswerKeywords: ['Bulbasaur', 'Charmander', 'Squirtle', 'Chikorita', 'Cyndaquil', 'Totodile', 'Treecko', 'Torchic', 'Mudkip'],
  },
  {
    question: 'How do I learn Ultima?',
    kind: 'ambiguous',
    expectedTitleSubstrings: ['Final Fantasy'],
    expectedAnswerKeywords: ['Ultima'],
    notes: 'Recurring spell across the FF series.',
  },
  {
    question: 'How do I beat the final boss in Resident Evil?',
    kind: 'ambiguous',
    expectedTitleRegex: RX_RE_SERIES,
    expectedAnswerKeywords: ['boss'],
  },
  {
    question: "What's the best class in Diablo?",
    kind: 'ambiguous',
    expectedTitleRegex: RX_DIABLO_SERIES,
    expectedAnswerKeywords: ['Sorceress', 'Barbarian', 'Necromancer', 'Paladin', 'Witch Doctor', 'Demon Hunter', 'Crusader', 'Wizard', 'Monk'],
  },
  {
    question: 'How do I solve the temple puzzle in Zelda?',
    kind: 'ambiguous',
    expectedTitleRegex: RX_ZELDA_3D,
    expectedAnswerKeywords: ['temple'],
  },

  // ---- Trick: false premise. Pass = no_answer OR a corrective keyword. ----
  {
    question: "Where's the Triforce in Ocarina of Time?",
    kind: 'trick',
    expectedAnswerKeywords: ['not', "don't", 'cannot', 'pedestal'],
    notes: "Link only touches the pedestal — there is no Triforce to obtain in OoT.",
  },
  {
    question: 'How do I beat the final boss in Tetris?',
    kind: 'trick',
    expectedAnswerKeywords: ['no boss', 'no final', 'endless', 'no such'],
    notes: 'Classic Tetris has no final boss.',
  },
  {
    question: 'How do I use the secret combo to one-shot Ganon in Breath of the Wild?',
    kind: 'trick',
    expectedTitleRegex: RX_BOTW,
    expectedAnswerKeywords: ['no', 'not', 'no such', 'does not'],
    notes: 'There is no "secret combo" — premise is fabricated.',
  },

  // ---- Unanswerable: should be no_answer ---------------------------------
  {
    question: 'How do I beat the second boss?',
    kind: 'unanswerable',
    notes: 'No game named, no boss named. Must return no_answer to pass.',
  },
];

interface BenchResult {
  question: string;
  kind: QuestionKind;
  passed: boolean;
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

// Single source of truth for "did this question pass?" — used by both the
// per-question assertion and the baseline comparison so they can never disagree.
function computePassed(
  q: BenchQuestion,
  ans: ApiAnswer,
  recallHit: boolean,
  keywordHits: number
): boolean {
  switch (q.kind) {
    case 'specific':
    case 'ambiguous':
      return recallHit;
    case 'unanswerable':
      return ans.no_answer;
    case 'trick':
      return ans.no_answer || keywordHits >= 1;
  }
}

function describeExpectation(q: BenchQuestion): string {
  switch (q.kind) {
    case 'specific':
    case 'ambiguous':
      return q.expectedTitleRegex
        ? `Expected title match: ${q.expectedTitleRegex.toString()}`
        : `Expected title substring (any of): ${JSON.stringify(q.expectedTitleSubstrings ?? [])}`;
    case 'unanswerable':
      return 'Unanswerable question; expected no_answer=true';
    case 'trick':
      return 'Trick question; expected no_answer=true OR a corrective keyword in the answer';
  }
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

// Abort-aware sleep: resolves on either timeout or signal abort. Without this,
// the rate-limit retry below would block the AbortController for up to 10s.
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'));
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function ask(question: string): Promise<ApiAnswer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // 8 retries × up to 30s wait covers a sustained-saturation window without
    // exceeding FETCH_TIMEOUT_MS. Bumped from 4×10s after the bench tripped
    // mid-run on a particularly slow synth question.
    const MAX_429_RETRIES = 8;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${BASE_URL}/api/guides/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, top_k: TOP_K }),
        signal: controller.signal,
      });
      if (res.status === 429 && attempt < MAX_429_RETRIES) {
        const body = (await res.json().catch(() => ({ retryAfter: 3 }))) as { retryAfter?: number };
        const waitSec = Math.min(body.retryAfter ?? 3, 30);
        await sleep(waitSec * 1000, controller.signal);
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

function checkRecall(citations: ApiCitation[], q: BenchQuestion): { hit: boolean; matchedTitle: string | null } {
  for (const c of citations) {
    const title = c.guide_title ?? '';
    if (q.expectedTitleRegex && q.expectedTitleRegex.test(title)) {
      return { hit: true, matchedTitle: title };
    }
    if (q.expectedTitleSubstrings && q.expectedTitleSubstrings.length > 0) {
      const lower = title.toLowerCase();
      for (const exp of q.expectedTitleSubstrings) {
        if (lower.includes(exp.toLowerCase())) return { hit: true, matchedTitle: title };
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

// Wilson 95% score interval for a binomial proportion. Stable for the small
// (n ≈ 25) sample sizes per kind we report. Returns [low, high] in [0, 1].
function wilson95(hits: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.96;
  const p = hits / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (center - margin) / denom), Math.min(1, (center + margin) / denom)];
}

const results: BenchResult[] = [];

// Load the baseline once at module scope. Per-question and summary-level
// regression checks both consult `baselineByQuestion`. Missing file is fine
// when WRITE_BASELINE=1 (we're about to create it); on a normal run, missing
// baseline degrades gracefully — per-question contracts still apply.
let baseline: Baseline | null = null;
const baselineByQuestion = new Map<string, BaselineQuestion>();
try {
  if (fs.existsSync(BASELINE_PATH)) {
    baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8')) as Baseline;
    if (baseline.schema_version !== BASELINE_SCHEMA_VERSION) {
      console.warn(
        `[baseline] schema_version ${baseline.schema_version} != expected ${BASELINE_SCHEMA_VERSION}; ignoring`
      );
      baseline = null;
    } else {
      for (const q of baseline.questions) baselineByQuestion.set(q.question, q);
    }
  }
} catch (e) {
  console.warn(`[baseline] failed to load ${BASELINE_PATH}: ${(e as Error).message}`);
}

const RUN = process.env.RAG_BENCH === '1';

describe.skipIf(!RUN)('RAG accuracy benchmark', () => {
  // Pre-flight: server up, /answer endpoint reachable. A failed health probe
  // here saves a 35× fetch-error fan-out below.
  beforeAll(async () => {
    const res = await fetch(`${BASE_URL}/api/health`).catch((e) => {
      throw new Error(`server not reachable at ${BASE_URL}: ${e.message}`);
    });
    if (!res.ok) throw new Error(`/api/health returned ${res.status}; aborting bench`);
  });

  it.each(QUESTIONS)(
    '$question',
    async (q) => {
      const ans = await ask(q.question);
      const recall = checkRecall(ans.citations, q);
      const keywordHits = checkAnswerKeywords(ans.answer, q.expectedAnswerKeywords);
      const passed = computePassed(q, ans, recall.hit, keywordHits);

      const result: BenchResult = {
        question: q.question,
        kind: q.kind,
        passed,
        recallHit: recall.hit,
        matchedTitle: recall.matchedTitle,
        answerKeywordHits: keywordHits,
        expectedKeywordCount: q.expectedAnswerKeywords?.length ?? 0,
        noAnswer: ans.no_answer,
        topTitles: ans.citations.slice(0, 3).map((c) => c.guide_title),
        totalMs: ans.timing_ms.total,
        embedMs: ans.timing_ms.embed,
        retrieveMs: ans.timing_ms.retrieve,
        synthesizeMs: ans.timing_ms.synthesize,
      };
      results.push(result);

      // When writing a fresh baseline, don't fail on individual misses — the
      // baseline IS the current state. Summary still writes the file.
      if (WRITE_BASELINE) return;

      // Regression-aware contract:
      //   - No baseline: enforce the kind contract on every question (strict).
      //   - Baseline says this question previously passed: enforce — regression.
      //   - Baseline says this question previously failed: don't fail; the
      //     summary block prints recoveries so progress is visible.
      const baselineExpect = baselineByQuestion.get(q.question);
      const enforce = baselineExpect === undefined || baselineExpect.passed === true;
      if (!enforce) return;

      const ctx =
        `\nKind: ${q.kind}` +
        `\nQuestion: ${q.question}` +
        `\nTop citation titles returned: ${JSON.stringify(result.topTitles)}` +
        `\nNo-answer flag: ${ans.no_answer}` +
        `\nAnswer (truncated): ${ans.answer.slice(0, 200)}` +
        `\nExpected keywords: ${JSON.stringify(q.expectedAnswerKeywords ?? [])}` +
        `\nKeyword hits: ${keywordHits}` +
        (baselineExpect ? `\nBaseline: previously PASSED (regression).` : `\nBaseline: question is new (no prior state).`);

      expect(passed, `${describeExpectation(q)}${ctx}`).toBe(true);
    },
    TEST_TIMEOUT_MS
  );

  it('summary', () => {
    const total = results.length;
    if (total === 0) {
      // Vitest could in principle skip the it.each above; bail out cleanly.
      expect(total).toBeGreaterThan(0);
      return;
    }

    const byKind = (k: QuestionKind) => results.filter((r) => r.kind === k);
    const recallable = [...byKind('specific'), ...byKind('ambiguous')];
    const recallHits = recallable.filter((r) => r.recallHit).length;
    const recallRate = recallable.length > 0 ? recallHits / recallable.length : 0;
    const [lo, hi] = wilson95(recallHits, recallable.length);

    const tricks = byKind('trick');
    const trickPasses = tricks.filter((r) => r.noAnswer || r.answerKeywordHits >= 1).length;
    const unanswerables = byKind('unanswerable');
    const unanswerablePasses = unanswerables.filter((r) => r.noAnswer).length;

    const noAnswers = results.filter((r) => r.noAnswer).length;
    const avgTotal = results.reduce((s, r) => s + r.totalMs, 0) / total;
    const avgRetrieve = results.reduce((s, r) => s + r.retrieveMs, 0) / total;
    const avgSynth = results.reduce((s, r) => s + r.synthesizeMs, 0) / total;

    /* eslint-disable no-console */
    console.warn('\n========== RAG benchmark summary ==========');
    console.warn(
      `recall@${TOP_K} (specific+ambiguous): ${recallHits}/${recallable.length} = ${(recallRate * 100).toFixed(1)}% ` +
        `(95% CI: ${(lo * 100).toFixed(1)}–${(hi * 100).toFixed(1)}%)`
    );
    console.warn(`trick correctly handled:   ${trickPasses}/${tricks.length}`);
    console.warn(`unanswerable handled:      ${unanswerablePasses}/${unanswerables.length}`);
    console.warn(`no_answer responses (any): ${noAnswers}/${total}`);
    console.warn(`avg total: ${avgTotal.toFixed(0)}ms (retrieve ${avgRetrieve.toFixed(0)}ms, synth ${avgSynth.toFixed(0)}ms)`);
    console.warn('-------------------------------------------');
    for (const r of results) {
      let status: string;
      if (r.kind === 'unanswerable') status = r.noAnswer ? 'PASS' : 'FAIL';
      else if (r.kind === 'trick') status = r.noAnswer || r.answerKeywordHits >= 1 ? 'PASS' : 'FAIL';
      else status = r.recallHit ? 'HIT ' : 'MISS';
      const title = r.matchedTitle
        ? `→ "${r.matchedTitle.slice(0, 50)}"`
        : `(top: "${r.topTitles[0]?.slice(0, 50) ?? ''}")`;
      const kw = r.expectedKeywordCount > 0 ? ` kw=${r.answerKeywordHits}/${r.expectedKeywordCount}` : '';
      console.warn(`  ${status}  [${r.kind.padEnd(12)}] ${r.question.slice(0, 60).padEnd(60)} ${title}${kw}`);
    }
    console.warn('===========================================\n');
    /* eslint-enable no-console */

    // Baseline mode: write the file and skip drift assertions. The just-written
    // baseline matches itself; comparing would be tautological.
    if (WRITE_BASELINE) {
      const data: Baseline = {
        schema_version: BASELINE_SCHEMA_VERSION,
        generated_at: new Date().toISOString(),
        recall_floor_used: RECALL_FLOOR,
        questions: results.map((r) => ({
          question: r.question,
          kind: r.kind,
          passed: r.passed,
          matched_title: r.matchedTitle,
          no_answer: r.noAnswer,
          keyword_hits: r.answerKeywordHits,
        })),
      };
      fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
      fs.writeFileSync(BASELINE_PATH, JSON.stringify(data, null, 2) + '\n');
      // eslint-disable-next-line no-console
      console.warn(`[baseline] wrote ${results.length} entries → ${BASELINE_PATH}`);
      return;
    }

    // Compare current run to baseline. Regressions = was passing, now failing.
    if (baseline) {
      const regressions: BenchResult[] = [];
      const recoveries: BenchResult[] = [];
      const newQs: BenchResult[] = [];
      const droppedQs: string[] = [];
      const seen = new Set(results.map((r) => r.question));

      for (const r of results) {
        const b = baselineByQuestion.get(r.question);
        if (!b) {
          newQs.push(r);
          continue;
        }
        if (b.passed && !r.passed) regressions.push(r);
        else if (!b.passed && r.passed) recoveries.push(r);
      }
      for (const q of baseline.questions) {
        if (!seen.has(q.question)) droppedQs.push(q.question);
      }

      /* eslint-disable no-console */
      console.warn('---------- baseline diff ----------');
      console.warn(`baseline: ${baseline.questions.length} questions, generated ${baseline.generated_at}`);
      console.warn(`regressions (was pass, now fail): ${regressions.length}`);
      for (const r of regressions) console.warn(`  - [${r.kind}] ${r.question}`);
      console.warn(`recoveries (was fail, now pass): ${recoveries.length}`);
      for (const r of recoveries) console.warn(`  + [${r.kind}] ${r.question}`);
      if (newQs.length > 0) {
        console.warn(`new questions (not in baseline): ${newQs.length}`);
        for (const r of newQs) console.warn(`  ? [${r.kind}] ${r.question} (passed=${r.passed})`);
      }
      if (droppedQs.length > 0) {
        console.warn(`baseline questions absent from current run: ${droppedQs.length}`);
        for (const q of droppedQs) console.warn(`  ! ${q}`);
      }
      console.warn('-----------------------------------\n');
      /* eslint-enable no-console */

      expect(
        regressions.length,
        `${regressions.length} question(s) regressed vs baseline:\n` +
          regressions.map((r) => `  - [${r.kind}] ${r.question}`).join('\n') +
          `\nIf intentional (corpus changed, regex tightened, etc.), update with RAG_BENCH_WRITE_BASELINE=1.`
      ).toBe(0);
    } else {
      // eslint-disable-next-line no-console
      console.warn(`[baseline] no baseline at ${BASELINE_PATH}; create one with RAG_BENCH_WRITE_BASELINE=1`);
    }

    // Aggregate floor on recallable questions. Coarse drift catch — the
    // baseline above is the precise per-question signal.
    expect(
      recallRate,
      `Aggregate recall ${(recallRate * 100).toFixed(1)}% < floor ${(RECALL_FLOOR * 100).toFixed(0)}% ` +
        `(${recallHits}/${recallable.length}). Tune RAG_BENCH_RECALL_FLOOR if intentional.`
    ).toBeGreaterThanOrEqual(RECALL_FLOOR);
  });
});
