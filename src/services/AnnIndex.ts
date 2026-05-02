// USearch HNSW i8 wrapper. Holds the in-memory ANN index keyed by chunks.rowid
// and persists to a single file alongside the SQLite db (default
// `${dbPath}.ann`).
//
// Why chunks.rowid as the key:
// - USearch keys are uint64. SQLite gives every chunks row an INTEGER rowid
//   (the chunk PK is TEXT/nanoid; rowid is the implicit secondary key). Using
//   rowid lets us round-trip through the ANN with a single int instead of a
//   second mapping table.
// - At query time RetrievalService hydrates rowids → chunks via
//   `SELECT id, ... FROM chunks WHERE rowid IN (?,?,...)`.
//
// Saving:
// - Writes the full file every saveIfDirty() call. USearch save throughput on
//   x86_64 is ~1.4 GB/s, so a 3 GB index saves in ~2s. Periodic save during
//   indexing (every N guides) plus on-shutdown save is enough; we don't need
//   incremental persistence.
// - Saves atomically via `${file}.tmp` + rename so a crash mid-save can't
//   corrupt the live file.

import * as fs from 'fs';
import * as path from 'path';
import { Index, MetricKind, ScalarKind } from 'usearch';

export interface AnnIndexOpts {
  dim: number;
  file: string;
  // HNSW knobs. Defaults match the bake-off run that picked USearch i8.
  M?: number;
  efAdd?: number;
  efSearch?: number;
}

export interface AnnHit {
  rowid: number;
  distance: number;
}

export class AnnIndex {
  private idx: Index;
  private dirty = false;
  private readonly file: string;
  private readonly opts: Required<AnnIndexOpts>;

  constructor(opts: AnnIndexOpts) {
    this.opts = {
      dim: opts.dim,
      file: opts.file,
      M: opts.M ?? 16,
      efAdd: opts.efAdd ?? 200,
      efSearch: opts.efSearch ?? 256,
    };
    this.file = opts.file;
    this.idx = this.makeIndex();
  }

  private makeIndex(): Index {
    return new Index({
      dimensions: this.opts.dim,
      metric: MetricKind.Cos,
      quantization: ScalarKind.I8,
      connectivity: this.opts.M,
      expansion_add: this.opts.efAdd,
      expansion_search: this.opts.efSearch,
      multi: false,
    });
  }

  // Load from disk. Returns true if the file existed and loaded; false if
  // missing (caller starts with an empty index — fine, the indexer will
  // populate). Throws on a *corrupt* file — operators should delete it and
  // let the indexer re-embed any chunks lacking ANN entries on next run.
  load(): boolean {
    if (!fs.existsSync(this.file)) return false;
    this.idx.load(this.file);
    this.dirty = false;
    return true;
  }

  size(): number {
    return Number(this.idx.size());
  }

  add(rowid: number, vec: Float32Array): void {
    if (vec.length !== this.opts.dim) {
      throw new Error(`AnnIndex.add: vector dim ${vec.length} != ${this.opts.dim}`);
    }
    this.idx.add(BigInt(rowid), vec);
    this.dirty = true;
  }

  remove(rowid: number): void {
    this.idx.remove(BigInt(rowid));
    this.dirty = true;
  }

  search(vec: Float32Array, k: number): AnnHit[] {
    const r = this.idx.search(vec, k, 0);
    const out: AnnHit[] = new Array(r.keys.length);
    for (let i = 0; i < r.keys.length; i++) {
      out[i] = { rowid: Number(r.keys[i]), distance: r.distances[i] };
    }
    return out;
  }

  // Save the index to disk via atomic rename. No-op when nothing has changed
  // since the last save, so callers can call this on a heartbeat without
  // burning IO.
  saveIfDirty(): boolean {
    if (!this.dirty) return false;
    return this.saveNow();
  }

  saveNow(): boolean {
    const dir = path.dirname(this.file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = this.file + '.tmp';
    this.idx.save(tmp);
    fs.renameSync(tmp, this.file);
    this.dirty = false;
    return true;
  }
}
