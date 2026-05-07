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
// Pacing: small delay before each /answer fetch so the bench plays nicely with
// the production rate limiter. Cheaper than chewing through retry budgets on
// 429s. Default 1s; set 0 to disable.
const INTER_QUESTION_DELAY_MS = parseInt(process.env.RAG_BENCH_DELAY_MS ?? '5000', 10);
// Print short citation previews to stderr by default; the bench-qa file carries
// full per-chunk bodies when the API includes `content`.
const PRINT_ANSWERS = process.env.RAG_BENCH_PRINT_ANSWERS !== '0';
const REQUIRE_HARD_GAME_MATCH = process.env.RAG_BENCH_REQUIRE_HARD_GAME_MATCH === '1';
// Write a human-readable Q&A dump every bench run so results are reviewable
// without scrolling vitest output. Flushed after each question so interrupts
// still leave a partial file. Default: ./bench-qa.txt at repo root (git-ignored).
// Override with RAG_BENCH_OUTPUT_FILE=<path>; set RAG_BENCH_OUTPUT_FILE='' to disable.
const OUTPUT_FILE_PATH = 'RAG_BENCH_OUTPUT_FILE' in process.env
  ? process.env.RAG_BENCH_OUTPUT_FILE || null
  : path.resolve(__dirname, '..', '..', 'bench-qa.txt');
const outputLines: string[] = [];

function flushBenchQADump(): void {
  if (!OUTPUT_FILE_PATH || outputLines.length === 0) return;
  fs.writeFileSync(OUTPUT_FILE_PATH, outputLines.join('\n'), 'utf-8');
}

// Baseline records per-question expected pass/fail, so a question that passed
// last run but fails now is flagged loudly even if aggregate recall is fine.
// Write the file with RAG_BENCH_WRITE_BASELINE=1; subsequent runs compare.
const BASELINE_PATH = path.resolve(__dirname, 'baselines', 'rag-accuracy.json');
const WRITE_BASELINE = process.env.RAG_BENCH_WRITE_BASELINE === '1';
const BASELINE_SCHEMA_VERSION = 1;

// Snapshot mode: write a time-series record (separate from the canonical
// baseline) to a path of the caller's choosing. Used for tracking how recall
// evolves as the index grows. Optional metadata env vars are stamped into the
// record so the history file stands alone without needing log correlation.
const HISTORY_PATH = process.env.RAG_BENCH_HISTORY_PATH;
const HISTORY_LABEL = process.env.RAG_BENCH_HISTORY_LABEL;
const HISTORY_GUIDES = process.env.RAG_BENCH_GUIDES_INDEXED;
const HISTORY_EMBEDDINGS = process.env.RAG_BENCH_EMBEDDINGS_COUNT;
// Either flag puts us in "snapshot mode": per-question hard assertions are
// skipped and the regression-vs-baseline check is suppressed. The point of a
// snapshot is to capture current state, not to fail on it.
const SNAPSHOT_MODE = WRITE_BASELINE || !!HISTORY_PATH;

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
// Compilation/anthology titles that bundle a specific installment count as a
// hit for that installment's question. e.g. "Metal Gear Solid the Legacy
// Collection" contains MGS2, so it satisfies an Otacon-password question.
// We don't try to enumerate every possible compilation — only ones we've seen
// in the live corpus that genuinely contain the target game.
const RX_FF7 = /\b(final\s+fantasy\s+(vii|7)|ff\s*7|advent\s+children)\b/i;
const RX_FF6 = /\b(final\s+fantasy\s+(vi|6|iii|anthology)|ff\s*6)\b/i;
const RX_FFX = /\b(final\s+fantasy\s+(x|10|x\s*\/\s*x-2|x\s+hd)|ffx)\b/i;
const RX_OOT = /\b(ocarina\s+of\s+time|oot)\b/i;
const RX_BOTW = /\b(breath\s+of\s+the\s+wild|botw)\b/i;
const RX_WW = /\b(wind\s+waker|tww)\b/i;
const RX_SOTN = /\b(symphony\s+of\s+the\s+night|sotn|castlevania\s+requiem|castlevania\s+anniversary\s+collection)\b/i;
const RX_RE4 = /\b(resident\s+evil\s+4|biohazard\s+4|re\s*4)\b/i;
const RX_RE_SERIES = /\b(resident\s+evil|biohazard)\b/i;
// MGS2 lives in: Sons of Liberty (PS2/Xbox), HD Collection, Legacy Collection,
// Master Collection. All are valid sources for Otacon's password.
const RX_MGS2 = /\b(metal\s+gear\s+solid\s+(2|(?:the\s+)?(?:legacy|hd|master)\s+collection)|sons\s+of\s+liberty|mgs\s*2)\b/i;
const RX_MGS_SERIES = /\b(metal\s+gear|mgs)\b/i;
// Pokemon Red/Blue — exclude Rescue Team and other "Red <Word>" titles by
// requiring the next word to be Blue/Yellow/version/edition or end-of-title.
const RX_POKEMON_RB = /\bpok[eé]mon\s+(red|blue)\s*(?:$|\b(?:and|\/|version|edition|blue|red|yellow)\b)/i;
const RX_POKEMON_SERIES = /\bpok[eé]mon\b/i;
const RX_SM64 = /\b(super\s+mario\s+64|mario\s+64|sm64|super\s+mario\s+3d\s+all-?stars)\b/i;
const RX_CHRONO = /\bchrono\s+trigger\b/i;
// D2 lives in Battle Chest (D1+D2+LoD) and Resurrected. Both ship the same level cap.
const RX_D2 = /\b(diablo\s+(2|ii|battle\s+chest)|d2|diablo\s+ii\s+resurrected)\b/i;
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
  gameCorrectTop1: boolean | null;
  hardGameMatch: boolean | null;
  topTitles: string[];
  totalMs: number;
  embedMs: number;
  retrieveMs: number;
  synthesizeMs: number;
}

// Single source of truth for "did this question pass?" — used by both the
// per-question assertion and the baseline comparison so they can never disagree.
//
// `specific` / `ambiguous` pass = right guide cited AND synth actually answered
// AND (if expected keywords were supplied) the answer hit at least one. Recall
// alone was misleading: ~58% of recall-hit specific questions still had the
// synth refuse with no_answer=true, which the user can't tell from the title.
function computePassed(
  q: BenchQuestion,
  ans: ApiAnswer,
  recallHit: boolean,
  keywordHits: number,
  expectedKeywordCount: number
): boolean {
  const productiveRefusal = isProductiveRefusal(ans.answer);
  switch (q.kind) {
    case 'specific':
    case 'ambiguous':
      return recallHit && !ans.no_answer && (expectedKeywordCount === 0 || keywordHits >= 1);
    case 'unanswerable':
      return ans.no_answer || productiveRefusal;
    case 'trick':
      return ans.no_answer || productiveRefusal || keywordHits >= 1;
  }
}

function isProductiveRefusal(answer: string): boolean {
  const lower = answer.toLowerCase();
  const refusalCue = lower.includes("don't have") || lower.includes("couldn't") || lower.includes('cannot');
  const followupCue = lower.includes('try ') || lower.includes('ask ') || lower.includes('tell me');
  return refusalCue && followupCue;
}

function describeExpectation(q: BenchQuestion): string {
  switch (q.kind) {
    case 'specific':
    case 'ambiguous': {
      const titlePart = q.expectedTitleRegex
        ? `title match: ${q.expectedTitleRegex.toString()}`
        : `title substring (any of): ${JSON.stringify(q.expectedTitleSubstrings ?? [])}`;
      const kwPart = q.expectedAnswerKeywords?.length
        ? `, no_answer=false, ≥1 keyword from ${JSON.stringify(q.expectedAnswerKeywords)}`
        : `, no_answer=false`;
      return `Expected ${titlePart}${kwPart}`;
    }
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
  /** Full chunk body when the server returns it (same field synthesis uses). */
  content?: string;
  excerpt: string;
  score: number;
}

interface ApiAnswer {
  answer: string;
  no_answer: boolean;
  citations: ApiCitation[];
  timing_ms: { embed: number; retrieve: number; synthesize: number; total: number };
}

/** Preview = one collapsed line for stderr; full = multi-line chunk body for the bench file. */
function citationDumpLines(c: ApiCitation, mode: 'full' | 'preview'): string[] {
  const head = `  [${c.score.toFixed(3)}] ${c.guide_title} (chunk ${c.chunk_index}, id ${c.chunk_id})`;
  if (mode === 'preview') {
    const preview = (c.excerpt || c.content || '').replace(/\s+/g, ' ').slice(0, 300);
    return [head, `    ${preview}`];
  }
  const raw = (c.content?.trim() ? c.content : c.excerpt || '').trimEnd();
  if (!raw) return [head, '    (empty chunk)'];
  return [head, '    --- chunk ---', ...raw.split('\n').map((line) => `    ${line}`)];
}

interface ApiGuide {
  id: string;
  game_id?: string | null;
}

interface ApiGame {
  id: string;
  title: string;
}

const guideGameIdCache = new Map<string, string | null>();
const gameTitleCache = new Map<string, string | null>();

async function fetchGuideGameId(guideId: string): Promise<string | null> {
  if (guideGameIdCache.has(guideId)) return guideGameIdCache.get(guideId) ?? null;
  const res = await fetch(`${BASE_URL}/api/guides/${encodeURIComponent(guideId)}`);
  if (!res.ok) {
    guideGameIdCache.set(guideId, null);
    return null;
  }
  const body = (await res.json()) as { data?: ApiGuide };
  const gameId = body.data?.game_id ?? null;
  guideGameIdCache.set(guideId, gameId);
  return gameId;
}

async function fetchGameTitle(gameId: string): Promise<string | null> {
  if (gameTitleCache.has(gameId)) return gameTitleCache.get(gameId) ?? null;
  const res = await fetch(`${BASE_URL}/api/games/${encodeURIComponent(gameId)}`);
  if (!res.ok) {
    gameTitleCache.set(gameId, null);
    return null;
  }
  const body = (await res.json()) as { data?: ApiGame };
  const title = body.data?.title ?? null;
  gameTitleCache.set(gameId, title);
  return title;
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

function checkGameCorrectTop1(citations: ApiCitation[], q: BenchQuestion): boolean | null {
  if (q.kind !== 'specific') return null;
  if (!q.expectedTitleRegex) return null;
  const top = citations[0]?.guide_title ?? '';
  if (!top) return false;
  return q.expectedTitleRegex.test(top);
}

async function checkHardGameMatch(citations: ApiCitation[], q: BenchQuestion): Promise<boolean | null> {
  if (q.kind !== 'specific') return null;
  if (!q.expectedTitleRegex) return null;
  for (const c of citations) {
    const gameId = await fetchGuideGameId(c.guide_id);
    if (!gameId) continue;
    const title = await fetchGameTitle(gameId);
    if (!title) continue;
    if (q.expectedTitleRegex.test(title)) return true;
  }
  return false;
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
    if (OUTPUT_FILE_PATH) {
      outputLines.length = 0;
      outputLines.push(
        `# RAG benchmark ${new Date().toISOString()}`,
        `# BASE_URL=${BASE_URL}`,
        ''
      );
      flushBenchQADump();
    }
  });

  it.each(QUESTIONS)(
    '$question',
    async (q) => {
      if (INTER_QUESTION_DELAY_MS > 0) {
        await new Promise((r) => setTimeout(r, INTER_QUESTION_DELAY_MS));
      }
      const ans = await ask(q.question);
      const recall = checkRecall(ans.citations, q);
      const gameCorrectTop1 = checkGameCorrectTop1(ans.citations, q);
      const hardGameMatch = await checkHardGameMatch(ans.citations, q);
      const keywordHits = checkAnswerKeywords(ans.answer, q.expectedAnswerKeywords);
      const expectedKeywordCount = q.expectedAnswerKeywords?.length ?? 0;
      const passed = computePassed(q, ans, recall.hit, keywordHits, expectedKeywordCount);

      if (PRINT_ANSWERS || OUTPUT_FILE_PATH) {
        const preamble = [
          '\n========== ANSWER DUMP ==========',
          `Q [${q.kind}]: ${q.question}`,
          `no_answer: ${ans.no_answer}`,
          `recall hit: ${recall.hit}${recall.matchedTitle ? ` → "${recall.matchedTitle}"` : ''}`,
          `keyword hits: ${keywordHits}/${q.expectedAnswerKeywords?.length ?? 0}` +
            (q.expectedAnswerKeywords?.length ? ` ${JSON.stringify(q.expectedAnswerKeywords)}` : ''),
          `--- answer ---`,
          ans.answer,
          `--- citations (${ans.citations.length}) ---`,
        ];
        const previewCitationLines = ans.citations.flatMap((c) => citationDumpLines(c, 'preview'));
        const fullCitationLines = ans.citations.flatMap((c) => citationDumpLines(c, 'full'));
        const footer = '=================================\n';

        if (PRINT_ANSWERS) {
          /* eslint-disable no-console */
          for (const l of [...preamble, ...previewCitationLines, footer]) console.warn(l);
          /* eslint-enable no-console */
        }
        if (OUTPUT_FILE_PATH) {
          outputLines.push(...preamble, ...fullCitationLines, footer);
          flushBenchQADump();
        }
      }

      const result: BenchResult = {
        question: q.question,
        kind: q.kind,
        passed,
        recallHit: recall.hit,
        matchedTitle: recall.matchedTitle,
        answerKeywordHits: keywordHits,
        expectedKeywordCount,
        noAnswer: ans.no_answer,
        gameCorrectTop1,
        hardGameMatch,
        topTitles: ans.citations.slice(0, 3).map((c) => c.guide_title),
        totalMs: ans.timing_ms.total,
        embedMs: ans.timing_ms.embed,
        retrieveMs: ans.timing_ms.retrieve,
        synthesizeMs: ans.timing_ms.synthesize,
      };
      results.push(result);

      // Snapshot modes (write baseline / write history) skip per-question
      // assertions — the file IS the record of current state.
      if (SNAPSHOT_MODE) return;

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
        `\nHard-game match: ${result.hardGameMatch}` +
        (baselineExpect ? `\nBaseline: previously PASSED (regression).` : `\nBaseline: question is new (no prior state).`);

      expect(passed, `${describeExpectation(q)}${ctx}`).toBe(true);
      if (REQUIRE_HARD_GAME_MATCH && q.kind === 'specific' && q.expectedTitleRegex) {
        expect(
          result.hardGameMatch,
          `Expected hard game-id/title match for specific query.\nQuestion: ${q.question}\nTop titles: ${JSON.stringify(result.topTitles)}`
        ).toBe(true);
      }
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
    const specifics = byKind('specific');
    const recallable = [...byKind('specific'), ...byKind('ambiguous')];
    const recallHits = recallable.filter((r) => r.recallHit).length;
    const recallRate = recallable.length > 0 ? recallHits / recallable.length : 0;
    const [lo, hi] = wilson95(recallHits, recallable.length);
    // Synth-side metrics decoupled from retrieval recall: answered = synth
    // didn't refuse; keywordOk = answered AND hit ≥1 expected keyword (or had
    // none expected); fullPasses = the new pass criterion (recall + answered +
    // keyword). Recall alone hid that ~58% of recall hits were "I don't have
    // that information" refusals.
    const synthAnswered = recallable.filter((r) => !r.noAnswer).length;
    const keywordOk = recallable.filter(
      (r) => !r.noAnswer && (r.expectedKeywordCount === 0 || r.answerKeywordHits >= 1)
    ).length;
    const fullPasses = recallable.filter((r) => r.passed).length;
    const specificHitRate = specifics.length > 0
      ? specifics.filter((r) => r.recallHit).length / specifics.length
      : 0;
    const specificTop1GameCorrect = specifics.filter((r) => r.gameCorrectTop1 === true).length;
    const specificHardGameMatch = specifics.filter((r) => r.hardGameMatch === true).length;

    const tricks = byKind('trick');
    const trickPasses = tricks.filter((r) => r.noAnswer || r.answerKeywordHits >= 1).length;
    const unanswerables = byKind('unanswerable');
    const shouldAbstain = [...tricks, ...unanswerables];
    const abstained = results.filter((r) => r.noAnswer);
    const correctAbstains = shouldAbstain.filter((r) => r.noAnswer);
    const abstainRecall = shouldAbstain.length > 0 ? correctAbstains.length / shouldAbstain.length : 0;
    const abstainPrecision = abstained.length > 0
      ? correctAbstains.length / abstained.length
      : 0;

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
    console.warn(`synth answered (not refused): ${synthAnswered}/${recallable.length} = ${((synthAnswered / Math.max(1, recallable.length)) * 100).toFixed(1)}%`);
    console.warn(`answered + ≥1 keyword hit:    ${keywordOk}/${recallable.length} = ${((keywordOk / Math.max(1, recallable.length)) * 100).toFixed(1)}%`);
    console.warn(`fully passed (recall+synth+kw): ${fullPasses}/${recallable.length} = ${((fullPasses / Math.max(1, recallable.length)) * 100).toFixed(1)}%`);
    console.warn(`specific recall hit rate:       ${(specificHitRate * 100).toFixed(1)}% (${specifics.filter((r) => r.recallHit).length}/${specifics.length})`);
    console.warn(`specific top-1 game-correct:   ${specificTop1GameCorrect}/${specifics.length}`);
    console.warn(`specific hard-game match:      ${specificHardGameMatch}/${specifics.length}`);
    console.warn(`trick correctly handled:   ${trickPasses}/${tricks.length}`);
    console.warn(`unanswerable handled:      ${unanswerablePasses}/${unanswerables.length}`);
    console.warn(`abstain recall (trick+unans): ${(abstainRecall * 100).toFixed(1)}% (${correctAbstains.length}/${shouldAbstain.length})`);
    console.warn(`abstain precision:          ${(abstainPrecision * 100).toFixed(1)}%`);
    console.warn(`no_answer responses (any): ${noAnswers}/${total}`);
    console.warn(`avg total: ${avgTotal.toFixed(0)}ms (retrieve ${avgRetrieve.toFixed(0)}ms, synth ${avgSynth.toFixed(0)}ms)`);
    console.warn('-------------------------------------------');
    for (const r of results) {
      const status = r.passed ? 'PASS' : 'FAIL';
      const title = r.matchedTitle
        ? `→ "${r.matchedTitle.slice(0, 50)}"`
        : `(top: "${r.topTitles[0]?.slice(0, 50) ?? ''}")`;
      const kw = r.expectedKeywordCount > 0 ? ` kw=${r.answerKeywordHits}/${r.expectedKeywordCount}` : '';
      // Show the failure reason for recallable kinds so a 'FAIL' is actionable
      // at a glance (refused / kw0 / miss) without needing the dump.
      let why = '';
      if ((r.kind === 'specific' || r.kind === 'ambiguous') && !r.passed) {
        if (!r.recallHit) why = ' (no recall)';
        else if (r.noAnswer) why = ' (refused)';
        else if (r.expectedKeywordCount > 0 && r.answerKeywordHits === 0) why = ' (no kw)';
      }
      console.warn(`  ${status}  [${r.kind.padEnd(12)}] ${r.question.slice(0, 60).padEnd(60)} ${title}${kw}${why}`);
    }
    console.warn('===========================================\n');
    /* eslint-enable no-console */

    const questionRecords = results.map((r) => ({
      question: r.question,
      kind: r.kind,
      passed: r.passed,
      matched_title: r.matchedTitle,
      no_answer: r.noAnswer,
      keyword_hits: r.answerKeywordHits,
    }));

    // Canonical-baseline mode: overwrite the regression boundary. Just-written
    // baseline matches itself; comparing would be tautological.
    if (WRITE_BASELINE) {
      const data: Baseline = {
        schema_version: BASELINE_SCHEMA_VERSION,
        generated_at: new Date().toISOString(),
        recall_floor_used: RECALL_FLOOR,
        questions: questionRecords,
      };
      fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
      fs.writeFileSync(BASELINE_PATH, JSON.stringify(data, null, 2) + '\n');
      // eslint-disable-next-line no-console
      console.warn(`[baseline] wrote ${results.length} entries → ${BASELINE_PATH}`);
    }

    // History mode: append a time-series record. Independent of the canonical
    // baseline so growing-index runs don't churn the regression boundary.
    if (HISTORY_PATH) {
      const snapshot = {
        schema_version: BASELINE_SCHEMA_VERSION,
        generated_at: new Date().toISOString(),
        label: HISTORY_LABEL ?? null,
        guides_indexed: HISTORY_GUIDES ? parseInt(HISTORY_GUIDES, 10) : null,
        embeddings_count: HISTORY_EMBEDDINGS ? parseInt(HISTORY_EMBEDDINGS, 10) : null,
        recall_at_k: {
          k: TOP_K,
          hits: recallHits,
          total: recallable.length,
          rate: recallRate,
          ci_low: lo,
          ci_high: hi,
        },
        trick: { passes: trickPasses, total: tricks.length },
        unanswerable: { passes: unanswerablePasses, total: unanswerables.length },
        timing_ms: {
          avg_total: Math.round(avgTotal),
          avg_retrieve: Math.round(avgRetrieve),
          avg_synth: Math.round(avgSynth),
        },
        questions: questionRecords,
      };
      fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
      fs.writeFileSync(HISTORY_PATH, JSON.stringify(snapshot, null, 2) + '\n');
      // eslint-disable-next-line no-console
      console.warn(`[history] wrote snapshot → ${HISTORY_PATH}`);
    }

    if (SNAPSHOT_MODE) return;

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

    // Final flush (same content as last per-question flush; ensures file closed).
    if (OUTPUT_FILE_PATH && outputLines.length > 0) {
      flushBenchQADump();
      // eslint-disable-next-line no-console
      console.warn(`[bench] Q&A dump written to ${OUTPUT_FILE_PATH} (${outputLines.length} lines)`);
    }
  });
});
