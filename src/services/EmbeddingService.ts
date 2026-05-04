// Wraps a remote Ollama embedding endpoint.
//
// Two modes:
//   - embed(text):   single request, short timeout — used for ad-hoc questions.
//   - embedBatch:    slices texts into sub-batches of SUB_BATCH_SIZE and submits
//                    each as a single HTTP request (Ollama's /api/embed accepts
//                    array `input`). Sub-batches run with a small concurrency so
//                    Ollama can keep its GPU saturated without being overrun.
//                    Per-request timeout is generous so a slow batch doesn't
//                    kill the whole indexing run.

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
const BATCH_REQUEST_TIMEOUT_MS = 120_000;
const AVAILABILITY_TIMEOUT_MS = 3_000;
// 32 lets a typical 60-chunk guide split into 2 parallel sub-batches; combined
// with concurrency=4 this saturates Ollama assuming OLLAMA_NUM_PARALLEL>=4 on
// the server. Larger batch sizes (tested 64 and 128) didn't help in practice
// — Ollama serializes requests at NUM_PARALLEL=1 so per-call GPU latency
// dominates and bigger requests don't amortize.
const SUB_BATCH_SIZE = 32;

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
    const [vec] = await this.embedRequest([text], SINGLE_TIMEOUT_MS);
    return vec;
  }

  async embedBatch(texts: string[], concurrency = 4): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const out: Float32Array[] = new Array(texts.length);

    // Slice texts into sub-batches; each sub-batch is one HTTP request with
    // array `input`. Ollama batches these on the GPU, which is dramatically
    // faster than one HTTP round-trip per chunk.
    const subBatches: Array<{ start: number; texts: string[] }> = [];
    for (let i = 0; i < texts.length; i += SUB_BATCH_SIZE) {
      subBatches.push({ start: i, texts: texts.slice(i, i + SUB_BATCH_SIZE) });
    }

    let cursor = 0;
    let firstError: any = null;

    const worker = async () => {
      while (firstError === null) {
        const i = cursor++;
        if (i >= subBatches.length) return;
        try {
          const sb = subBatches[i];
          const vectors = await this.embedRequest(sb.texts, BATCH_REQUEST_TIMEOUT_MS);
          for (let j = 0; j < vectors.length; j++) {
            out[sb.start + j] = vectors[j];
          }
        } catch (err) {
          firstError = err;
          return;
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(concurrency, subBatches.length) },
      () => worker()
    );
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

  // Submits one HTTP request with array `input` and returns one Float32Array per
  // input. Always returns an array, even for a single input.
  private async embedRequest(inputs: string[], timeoutMs: number): Promise<Float32Array[]> {
    const res = await this.fetchWithTimeout(
      `${this.opts.host}/api/embed`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.opts.model, input: inputs }),
      },
      timeoutMs
    );

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Embedding API error: ${res.status} ${res.statusText} ${body}`);
    }

    const data = (await res.json()) as EmbedResponse;
    // Ollama returns { embeddings: [[...], ...] } for /api/embed; older
    // /api/embeddings returns { embedding: [...] } (single vector). Accept both.
    const vecs: number[][] | null =
      Array.isArray(data.embeddings) && data.embeddings.length > 0
        ? data.embeddings
        : data.embedding && Array.isArray(data.embedding)
          ? [data.embedding]
          : null;

    if (!vecs) {
      throw new Error('Embedding API returned no vectors');
    }
    if (vecs.length !== inputs.length) {
      throw new Error(`Embedding count mismatch: requested ${inputs.length}, got ${vecs.length}`);
    }

    const out: Float32Array[] = new Array(vecs.length);
    for (let i = 0; i < vecs.length; i++) {
      const v = vecs[i];
      if (!Array.isArray(v) || v.length !== this.opts.dim) {
        throw new Error(`Embedding dim mismatch at index ${i}: expected ${this.opts.dim}, got ${Array.isArray(v) ? v.length : 'non-array'}`);
      }
      out[i] = Float32Array.from(v);
    }
    return out;
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
