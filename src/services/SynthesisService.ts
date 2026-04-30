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
1. Use only information from the excerpts. Do not use your training data.
2. Cite each fact with the excerpt number in brackets: [1], [2], or [1,3].
3. If the excerpts do not contain the answer, reply EXACTLY this sentence and nothing else: ${NO_ANSWER_SENTENCE}
4. Be concise. Do not invent details.

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
      .map((c, i) => `[${i + 1}] (from "${c.guide_title}"): ${c.excerpt}`)
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
          options: { temperature: 0.2, num_predict: 500 },
        }),
      },
      this.timeoutMs
    );

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Synthesis API error: ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as { response?: string };
    const raw = (data.response ?? '').trim();
    const cleaned = this.stripInvalidCitations(raw, citations.length);
    const noAnswer = this.isNoAnswer(cleaned);

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
