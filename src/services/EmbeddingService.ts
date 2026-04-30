// Wraps a remote Ollama embedding endpoint.
//
// Two modes:
//   - embed(text):   single request, short timeout (5s) — used for ad-hoc questions.
//   - embedBatch:    parallelizes texts with a small p-limit (no extra dep) and a
//                    longer per-request timeout (60s) so a slow chunk doesn't kill
//                    the whole indexing run.

export interface EmbeddingServiceOpts {
  host: string;
  model: string;
  dim: number;
}

export interface EmbeddingAvailability {
  available: boolean;
  error?: string;
}

interface EmbedResponse {
  embeddings?: number[][];
  embedding?: number[];
}

const SINGLE_TIMEOUT_MS = 5_000;
const BATCH_SLOT_TIMEOUT_MS = 60_000;
const AVAILABILITY_TIMEOUT_MS = 3_000;

export class EmbeddingService {
  constructor(private readonly opts: EmbeddingServiceOpts) {}

  getHost(): string {
    return this.opts.host;
  }

  getModel(): string {
    return this.opts.model;
  }

  getDim(): number {
    return this.opts.dim;
  }

  async embed(text: string): Promise<Float32Array> {
    return this.embedOnce(text, SINGLE_TIMEOUT_MS);
  }

  async embedBatch(texts: string[], concurrency = 4): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const out: Float32Array[] = new Array(texts.length);
    let cursor = 0;
    let firstError: any = null;

    const worker = async () => {
      while (firstError === null) {
        const i = cursor++;
        if (i >= texts.length) return;
        try {
          out[i] = await this.embedOnce(texts[i], BATCH_SLOT_TIMEOUT_MS);
        } catch (err) {
          firstError = err;
          return;
        }
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, texts.length) }, () => worker());
    await Promise.all(workers);

    if (firstError) throw firstError;
    return out;
  }

  async checkAvailability(): Promise<EmbeddingAvailability> {
    try {
      const res = await this.fetchWithTimeout(
        `${this.opts.host}/api/tags`,
        { method: 'GET', headers: { 'Content-Type': 'application/json' } },
        AVAILABILITY_TIMEOUT_MS
      );
      if (!res.ok) {
        return { available: false, error: `HTTP ${res.status}: ${res.statusText}` };
      }
      return { available: true };
    } catch (err: any) {
      let message = err.message;
      if (message === 'TIMEOUT') message = 'Connection timeout';
      else if (err.code === 'ECONNREFUSED' || err.cause?.code === 'ECONNREFUSED') {
        message = 'Connection refused — is Ollama running?';
      }
      return { available: false, error: message };
    }
  }

  private async embedOnce(text: string, timeoutMs: number): Promise<Float32Array> {
    const res = await this.fetchWithTimeout(
      `${this.opts.host}/api/embed`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.opts.model, input: text }),
      },
      timeoutMs
    );

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Embedding API error: ${res.status} ${res.statusText} ${body}`);
    }

    const data = (await res.json()) as EmbedResponse;
    // Ollama returns { embeddings: [[...]] } for /api/embed; older /api/embeddings
    // returns { embedding: [...] }. Accept both.
    const vec = Array.isArray(data.embeddings) && data.embeddings.length > 0
      ? data.embeddings[0]
      : data.embedding;

    if (!vec || !Array.isArray(vec)) {
      throw new Error('Embedding API returned no vector');
    }
    if (vec.length !== this.opts.dim) {
      throw new Error(`Embedding dim mismatch: expected ${this.opts.dim}, got ${vec.length}`);
    }
    return Float32Array.from(vec);
  }

  private async fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      return res;
    } catch (err: any) {
      if (err.name === 'AbortError') throw new Error('TIMEOUT');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
