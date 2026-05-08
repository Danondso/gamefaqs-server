// Synthesizes an answer from retrieved citations via Ollama.
//
// The prompt is intentionally rigid: the model is told to use ONLY the supplied
// excerpts and to emit the exact "I don't have that information..." sentence
// when it can't. We detect that sentinel in the response and surface
// `no_answer: true` so callers can short-circuit UI without parsing prose.

import type { Citation } from './RetrievalService';

export interface SynthesisServiceOpts {
  host: string;
  model: string;
  timeoutMs?: number;
}

export interface SynthesisResult {
  answer: string;
  no_answer: boolean;
}

const DEFAULT_TIMEOUT_MS = 60_000;
export const NO_ANSWER_SENTENCE = "I don't have that information in the available guides.";

const PROMPT_HEADER =
  `You are a video game guide assistant. Answer the user's question using ONLY the provided excerpts. Rules:
1. Use only information from the excerpts. Do not use your training data or general knowledge.
2. Cite each fact with the excerpt number in brackets: [1], [2], or [1,3].
3. Before refusing, scan every excerpt in full—answers may appear after tables or in a lower-ranked passage. If no excerpt contains substantive content that answers what was asked, reply EXACTLY this sentence and nothing else: ${NO_ANSWER_SENTENCE}
4. When the question is procedural ("how do I…"), give every step the excerpts contain — exact item names, locations, level numbers, button inputs, prerequisites, stat thresholds, and named characters. Do not omit detail to be brief; a thorough answer is better than a short one.
5. When the excerpts contain a labelled section (e.g. "Boss Strategies", "Walkthrough — Aquaria Towers"), name the section in your answer so the reader can find it in the source guide.
6. If the excerpts answer the core request (trainer rosters for the correct league with named Pokémon and any printed Strategy lines, puzzle rotation text, glitch button sequences, walkthrough prose, or an explicitly stated cap/total), give that answer even when other excerpts are junk or numeric dumps. For Pokémon Elite Four questions, if any excerpt contains multiple "Elite Four:" / "Elite #" entries listing trainers and Pokémon, your answer must cover each of those entries—refusal is wrong when they exist. If the core request is not present anywhere, use the no-answer sentence—do not substitute generic advice (e.g. early-game gym teams when the question is the Elite Four).
7. For a question that asks for one numeric fact (max level, star total, etc.), output a number only if an excerpt ties that exact digit to the question with words like maximum, max, cap, total, or stars; unrelated level ranges or version numbers do not count. Otherwise use the no-answer sentence.
8. Do not add any qualifiers, locations, affiliations, or details to names unless those exact details appear verbatim in the excerpts. Never augment retrieved facts with background knowledge.
9. Every specific claim (numbers, names, locations, requirements) must have at least one citation.
10. Do not end with "I don't have that information" after giving specific facts.
11. Source names shown as (from "X") are guide titles. Any text after " — " in a source name is the guide author's name — NOT a game character or location. Never reference guide author names as in-game entities.
12. Numbers in brackets [1], [2], [3], etc. are source reference indices. They are never in-game values, item counts, star counts, or statistics. Do not interpret them as numerical game data.
13. Encounter IDs, formation IDs, AI script entries, and similar guide-internal taxonomy labels are not game mechanics. Do not present them as instructions or actionable steps.
14. Section markers like "#936", "[3.10]", or "Chapter 4-1" are guide navigation references, not in-game data or reference numbers. Do not include them in answers as if they were game facts.
15. If a claim's only support in the excerpts is a numeric label or structural identifier (encounter ID, formation ID, section number, AI script name), it is not grounded evidence — do not state it as a fact. If no usable mechanic or narrative (not just tables/IDs) exists in the excerpts for a strategy question, reply with the no-answer sentence.
16. For boss-strategy questions: do not invent spells, items, steal routes, or damage values—only use plain prose that appears in the excerpts. Stat/ID tables alone are not a strategy. If there is no such prose (or only a few sentences about scripted outcomes), summarize just those sentences or use the no-answer sentence—never pad with tactics not written in the excerpts.
17. Any paragraph or bullet that contains numerals (levels, item counts, puzzle rotations) must include at least one valid [n] source marker in that same paragraph—answers with bare numbers and no bracketed cite are rejected.
18. Cite ONE source per claim—the most directly supporting excerpt. Only stack [a,b] when the claim genuinely needs two sources together (e.g. one provides a number, the other provides the context). Do not chain redundant cites.
19. When several sentences in a row come from the same source, write a single [n] at the end of that paragraph or claim block. Do not repeat the same [n] on every sentence.
20. If excerpts describe DIFFERENT strategies for the same problem, pick ONE coherent strategy as the main answer. Prefer the strategy with the most complete coverage in a single excerpt; tiebreak on excerpt order (earlier = higher relevance). List any alternatives in a separate "Alternative approaches:" section at the END—never interleave mutually-exclusive starting actions in the main numbered steps. Steps must be executable in order as written.
21. If excerpts describe scenarios with DIFFERENT prerequisites (New Game+ only, secret/optional, missable, version-specific, hardcore-only), either (a) pick the canonical / most likely intended scenario based on the question and stick to it, or (b) explicitly section the answer ("Standard fight" vs "New Game+ secret fight"). Do NOT mix NG+ stat thresholds, secret-only items, or version-locked content into the canonical answer for a plain question. Treat scenario cues in the question (words like "secret", "early", "NG+", "missable") as the signal that the user wants the gated scenario.

Excerpts:
`;

export class SynthesisService {
  private readonly host: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(opts: SynthesisServiceOpts) {
    this.host = opts.host;
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  getHost(): string {
    return this.host;
  }

  getModel(): string {
    return this.model;
  }

  buildPrompt(question: string, citations: Citation[]): string {
    const excerpts = citations
      .map((c, i) => {
        // Strip the " — AuthorName" portion from the displayed title so the
        // model cannot mistake guide authors for in-game characters. The full
        // title (with author) is retained in the Citation object for callers
        // that need it; only the synthesis prompt sees the stripped version.
        const displayTitle = c.guide_title.replace(/ — .+$/, '').trim() || c.guide_title;
        // Retrieval ranks whole chunks; `excerpt` is a short preview (see
        // RetrievalService). Synthesis must see the full chunk text or answers
        // often miss the relevant passage (it appears after the 300-char head).
        const passage = (c.content && c.content.trim().length > 0) ? c.content : c.excerpt;
        return `[${i + 1}] (from "${displayTitle}"): ${passage}`;
      })
      .join('\n\n');
    return `${PROMPT_HEADER}${excerpts}\n\nQuestion: ${question}\n\nAnswer:`;
  }

  async synthesize(question: string, citations: Citation[]): Promise<SynthesisResult> {
    const prompt = this.buildPrompt(question, citations);

    const res = await this.fetchWithTimeout(
      `${this.host}/api/generate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          prompt,
          stream: false,
          options: { temperature: 0, seed: 42, num_predict: 1500 },
        }),
      },
      this.timeoutMs
    );

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Synthesis API error: ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as { response?: string; thinking?: string };

    // qwen3 and other thinking models put chain-of-thought in `thinking` and
    // the final answer in `response`. When thinking exhausts num_predict,
    // `response` is empty even though the model did reason. Fall back to
    // `thinking` so callers at least get a grounded refusal rather than a
    // silent empty answer — the thinking content usually includes the
    // no-answer sentence or useful reasoning the refusal service can detect.
    const raw = ((data.response ?? '').trim() || (data.thinking ?? '').trim());
    let cleaned = this.stripInvalidCitations(raw, citations.length);
    cleaned = this.verifyCitations(cleaned, citations);
    cleaned = this.preventSelfContradiction(cleaned);
    const noAnswer = this.isNoAnswer(cleaned) || !this.hasGroundedClaims(cleaned, citations.length);

    return { answer: cleaned, no_answer: noAnswer };
  }

  private isNoAnswer(text: string): boolean {
    const t = text.trim();
    return t === NO_ANSWER_SENTENCE || t.startsWith(NO_ANSWER_SENTENCE);
  }

  private stripInvalidCitations(text: string, maxIndex: number): string {
    // Match [1], [3,4], [2, 5] — drop refs that fall outside 1..maxIndex.
    return text.replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (full, inner: string) => {
      const nums = inner.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !Number.isNaN(n));
      const valid = nums.filter(n => n >= 1 && n <= maxIndex);
      if (valid.length === 0) return '';
      if (valid.length === nums.length) return full;
      return `[${valid.join(',')}]`;
    });
  }

  // Post-synth verification: for each [N] (or [N,M]) in the answer, check that
  // the cited chunk's text actually contains distinctive tokens from the
  // surrounding claim. If it doesn't, re-route to the best-supporting chunk
  // or strip the cite. Cheap: pure string ops, no LLM call.
  //
  // Distinctive tokens = integer literals, capitalized multi-letter words
  // (≥4 chars), hyphenated compounds, quoted item names. Stopwords filtered.
  private verifyCitations(text: string, citations: Citation[]): string {
    if (citations.length === 0) return text;
    const chunks = citations.map(c => (c.content || c.excerpt || '').toLowerCase());
    return text.replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (full, inner: string, offset: number) => {
      const ids = inner.split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isInteger(n));
      if (ids.length === 0) return full;
      const claim = extractClaimWindow(text, offset);
      const tokens = extractDistinctiveTokens(claim);
      if (tokens.length === 0) return full; // nothing distinctive to verify against
      const supports = (idx: number) => countSupport(chunks[idx - 1], tokens);
      const newIds: number[] = [];
      for (const id of ids) {
        if (id < 1 || id > citations.length) continue;
        const score = supports(id);
        if (score >= 1) {
          newIds.push(id);
          continue;
        }
        // Try to re-route to the best other citation.
        let bestIdx = -1;
        let bestScore = 0;
        for (let i = 1; i <= citations.length; i++) {
          if (i === id) continue;
          const s = supports(i);
          if (s > bestScore) { bestScore = s; bestIdx = i; }
        }
        if (bestIdx > 0) {
          if (!newIds.includes(bestIdx)) newIds.push(bestIdx);
          console.warn('[Synthesis] citation verify:', JSON.stringify({
            action: 'rerouted',
            original_index: id,
            new_index: bestIdx,
            claim_preview: claim.slice(-80),
          }));
        } else {
          console.warn('[Synthesis] citation verify:', JSON.stringify({
            action: 'stripped',
            original_index: id,
            claim_preview: claim.slice(-80),
          }));
        }
      }
      return newIds.length === 0 ? '' : `[${newIds.join(',')}]`;
    });
  }

  /**
   * Remove structural list indices (e.g. "1. ", nested "- 2. ") before testing for
   * arabic digits in hasGroundedClaims. Line-start numbering is not substantive
   * game data — level numbers ("L54", "Lv 56") remain if not matched here.
   */
  private stripStructuralListMarkersForGrounding(body: string): string {
    // Models often omit the space after the marker ("1.Defeat…") or wrap it in
    // markdown ("**1.** …"). Allow optional blockquote / bullet prefix; require
    // whitespace after the marker OR an immediate letter so we do not eat "3.5"-style decimals.
    const lineDot = /^\s*(?:>\s*)?(?:[-*+]\s+)?(?:\*{1,2})?\d+\.(?:\*{1,2})?(?:\s+|(?=\p{L}))/gmu;
    const lineParen = /^\s*(?:>\s*)?(?:[-*+]\s+)?(?:\*{1,2})?\d+\)(?:\*{1,2})?(?:\s+|(?=\p{L}))/gmu;
    // Inline "…steps: 1. …" / "…follow:\n1." — same rules; avoid decimals after ':' (e.g. 3.14)
    // because the suffix must be space or a letter, not another digit.
    const afterBreak =
      /(?<=[\n\r:;])\s*(?:\*{1,2})?\d+\.(?:\*{1,2})?(?:\s+|(?=\p{L}))|(?<=[\n\r:;])\s*(?:\*{1,2})?\d+\)(?:\*{1,2})?(?:\s+|(?=\p{L}))/gu;

    let s = body;
    for (let i = 0; i < 6; i++) {
      const next = s.replace(lineDot, '').replace(lineParen, '').replace(afterBreak, '');
      if (next === s) break;
      s = next;
    }
    return s;
  }

  private hasGroundedClaims(text: string, maxIndex: number): boolean {
    if (!text.trim()) return false; // empty/whitespace = no grounded claims
    const forDigitCheck = this.stripStructuralListMarkersForGrounding(text);
    if (!/\d/.test(forDigitCheck) && !/\[[\d,\s]+\]/.test(text)) return true;
    const cites = text.match(/\[(\d+(?:\s*,\s*\d+)*)\]/g) ?? [];
    if (cites.length === 0) return false;
    for (const c of cites) {
      const ids = c
        .replace(/[\[\]\s]/g, '')
        .split(',')
        .map(n => parseInt(n, 10))
        .filter(n => Number.isInteger(n));
      if (ids.some(n => n < 1 || n > maxIndex)) return false;
    }
    return true;
  }

  private preventSelfContradiction(text: string): string {
    if (!/i don't have that information/i.test(text)) return text;
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length <= 1) return lines[0] ?? text;

    // If the no-answer phrase is only the final line, and the preceding content
    // contains valid citation brackets, the model grounded its answer and then
    // added an unnecessary hedge. Strip the hedge and keep the grounded part.
    const lastLine = lines[lines.length - 1];
    if (lastLine === NO_ANSWER_SENTENCE || lastLine.startsWith(NO_ANSWER_SENTENCE)) {
      const preceding = lines.slice(0, -1).join('\n');
      if (/\[\d/.test(preceding)) {
        return preceding;
      }
    }

    // No-answer phrase at the start or middle, or at the end without grounding —
    // the whole response is a refusal.
    return NO_ANSWER_SENTENCE;
  }

  private async fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (err: any) {
      if (err.name === 'AbortError') throw new Error('TIMEOUT');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

// Walk back from a [N] offset to the nearest sentence boundary so we can
// score the citation against the claim it sits at the end of. Stops at
// `.`/`?`/`!` followed by space, blank line, or list-marker boundary.
function extractClaimWindow(text: string, citeOffset: number): string {
  let start = citeOffset;
  for (let i = citeOffset - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === '\n' && text[i - 1] === '\n') { start = i + 1; break; }
    if ((ch === '.' || ch === '?' || ch === '!') && /\s/.test(text[i + 1] ?? '')) { start = i + 1; break; }
    if (ch === '\n' && /^\s*(?:[-*+]|\d+[.)])\s/.test(text.slice(i + 1, i + 8))) { start = i + 1; break; }
    start = i;
  }
  return text.slice(start, citeOffset);
}

// Pull tokens worth verifying. We aim for high-precision: integer literals,
// capitalized multi-letter words (proper-noun heuristic), hyphenated compounds,
// quoted item names. Stopword set kills the most common false positives that
// otherwise survive the capitalization check at sentence starts.
const VERIFY_STOPWORDS = new Set([
  'these', 'those', 'there', 'their', 'they', 'them', 'then', 'this', 'that',
  'after', 'before', 'once', 'when', 'while', 'where', 'which', 'with', 'will',
  'first', 'second', 'third', 'next', 'finally', 'also', 'however', 'note',
  'use', 'using', 'used', 'pick', 'take', 'get', 'go', 'goto',
  'step', 'steps', 'this', 'rule', 'item', 'items', 'enemy', 'enemies',
]);
function extractDistinctiveTokens(claim: string): string[] {
  const out = new Set<string>();
  // Integer literals (1-4 digits keeps us from grabbing IDs and addresses).
  for (const m of claim.matchAll(/\b\d{1,4}\b/g)) out.add(m[0].toLowerCase());
  // Quoted names — single or double quotes, ASCII or smart.
  for (const m of claim.matchAll(/[\"'“‘]([A-Za-z][\w\s'-]{1,40}?)[\"'”’]/g)) {
    const t = m[1].toLowerCase().trim();
    if (t.length >= 3 && !VERIFY_STOPWORDS.has(t)) out.add(t);
  }
  // Hyphenated compounds (e.g., "L+R", "Master-Sword", "TMP-ammo").
  for (const m of claim.matchAll(/\b[A-Za-z][A-Za-z0-9]+(?:[-+][A-Za-z0-9]+)+\b/g)) {
    out.add(m[0].toLowerCase());
  }
  // Capitalized multi-letter words ≥4 chars. Excludes sentence-starters via stopword set.
  for (const m of claim.matchAll(/\b[A-Z][a-zA-Z]{3,}\b/g)) {
    const t = m[0].toLowerCase();
    if (!VERIFY_STOPWORDS.has(t)) out.add(t);
  }
  return Array.from(out);
}

function countSupport(chunkLower: string, tokens: string[]): number {
  let n = 0;
  for (const t of tokens) {
    if (chunkLower.includes(t)) n++;
  }
  return n;
}
