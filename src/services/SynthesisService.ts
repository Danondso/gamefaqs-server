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

  private hasGroundedClaims(text: string, maxIndex: number): boolean {
    if (!text.trim()) return false; // empty/whitespace = no grounded claims
    if (!/\d/.test(text) && !/\[[\d,\s]+\]/.test(text)) return true;
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
