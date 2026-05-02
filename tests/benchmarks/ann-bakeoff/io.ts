// Shared IO for the bake-off. Formats are deliberately simple so any
// candidate (Node + USearch, Node + libsql, future ad-hoc tools) can read
// them without per-format glue.
//
// vectors.bin   : packed f32[DIM] records, no headers. Record N == seq id N.
// chunk_ids.txt : one chunk_id per line; line N == seq id N.
// queries.bin   : u32 count, then per query: u32 label_len + label_bytes + f32[DIM].
// ground_truth.json : { queries: [{ label, topK: [{ seq, distance }, ...] }, ...] }

import * as fs from 'fs';
import * as path from 'path';
import { Buffer } from 'buffer';

export const DIM = 768;
export const VEC_BYTES = DIM * 4;

export function scratchDir(): string {
  // Repo root is two levels above this file (tests/benchmarks/ann-bakeoff -> repo).
  // Co-locate scratch with the repo so docker-compose can mount it later if needed.
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const dir = path.join(repoRoot, 'scratch', 'ann');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------- vectors.bin ----------

export class VectorsWriter {
  private fd: number;
  private count = 0;
  constructor(private readonly file: string) {
    this.fd = fs.openSync(file, 'w');
  }
  append(vec: Float32Array): void {
    if (vec.length !== DIM) throw new Error(`expected ${DIM}-d vector, got ${vec.length}`);
    const buf = Buffer.from(vec.buffer, vec.byteOffset, VEC_BYTES);
    fs.writeSync(this.fd, buf, 0, VEC_BYTES);
    this.count++;
  }
  close(): number {
    fs.closeSync(this.fd);
    return this.count;
  }
}

export function vectorsCount(file: string): number {
  const sz = fs.statSync(file).size;
  if (sz % VEC_BYTES !== 0) throw new Error(`vectors.bin size ${sz} not aligned to ${VEC_BYTES}`);
  return sz / VEC_BYTES;
}

// Reads vector at sequential index `seq`. Allocates a new Float32Array each call.
// For build loops, use streamVectors() instead — it reuses a buffer.
export function readVector(file: string, seq: number): Float32Array {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(VEC_BYTES);
  fs.readSync(fd, buf, 0, VEC_BYTES, seq * VEC_BYTES);
  fs.closeSync(fd);
  return bufferToVec(buf);
}

// Stream all vectors. Yields the same Float32Array each iteration — copy if
// you need to keep one. Stops after `limit` if provided.
export function* streamVectors(file: string, limit?: number): Generator<Float32Array> {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(VEC_BYTES);
  const total = vectorsCount(file);
  const upTo = limit !== undefined ? Math.min(total, limit) : total;
  try {
    for (let i = 0; i < upTo; i++) {
      const n = fs.readSync(fd, buf, 0, VEC_BYTES, i * VEC_BYTES);
      if (n !== VEC_BYTES) throw new Error(`short read at seq ${i}: got ${n}`);
      yield bufferToVec(buf);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function bufferToVec(buf: Buffer): Float32Array {
  // Buffer.from on a Float32Array.buffer doesn't copy; we need a stable view
  // that survives the buf being reused next iteration. Allocate fresh.
  const out = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

// ---------- chunk_ids.txt ----------

// Sync writer with a Buffer batch — we're inside a tight per-row loop and
// fs.WriteStream's async drain semantics complicate "close means flushed."
export class ChunkIdsWriter {
  private fd: number;
  private buf: Buffer;
  private offset = 0;
  private count = 0;
  private static FLUSH_BYTES = 1 << 20; // 1 MiB
  constructor(file: string) {
    this.fd = fs.openSync(file, 'w');
    this.buf = Buffer.allocUnsafe(ChunkIdsWriter.FLUSH_BYTES);
  }
  append(id: string): void {
    if (id.includes('\n')) throw new Error(`chunk_id contains newline: ${id}`);
    const need = Buffer.byteLength(id, 'utf-8') + 1;
    if (this.offset + need > this.buf.length) this.flush();
    this.offset += this.buf.write(id, this.offset, 'utf-8');
    this.buf[this.offset++] = 0x0a; // \n
    this.count++;
  }
  private flush(): void {
    if (this.offset > 0) {
      fs.writeSync(this.fd, this.buf, 0, this.offset);
      this.offset = 0;
    }
  }
  close(): number {
    this.flush();
    fs.closeSync(this.fd);
    return this.count;
  }
}

export function readChunkIds(file: string): string[] {
  // ~80 MB at 3.7M × 22 bytes/line. Keep in memory.
  const text = fs.readFileSync(file, 'utf-8');
  // trailing newline produces an empty last entry; drop it
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function chunkIdToSeqMap(ids: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < ids.length; i++) m.set(ids[i], i);
  return m;
}

// ---------- queries.bin ----------

export interface Query {
  label: string;
  vec: Float32Array;
}

export function writeQueries(file: string, queries: Query[]): void {
  const fd = fs.openSync(file, 'w');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(queries.length, 0);
  fs.writeSync(fd, header, 0, 4);
  for (const q of queries) {
    if (q.vec.length !== DIM) throw new Error(`query "${q.label}" wrong dim ${q.vec.length}`);
    const labelBytes = Buffer.from(q.label, 'utf-8');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(labelBytes.length, 0);
    fs.writeSync(fd, lenBuf, 0, 4);
    if (labelBytes.length > 0) fs.writeSync(fd, labelBytes, 0, labelBytes.length);
    const vecBuf = Buffer.from(q.vec.buffer, q.vec.byteOffset, VEC_BYTES);
    fs.writeSync(fd, vecBuf, 0, VEC_BYTES);
  }
  fs.closeSync(fd);
}

export function readQueries(file: string): Query[] {
  const buf = fs.readFileSync(file);
  const count = buf.readUInt32LE(0);
  const queries: Query[] = [];
  let off = 4;
  for (let i = 0; i < count; i++) {
    const labelLen = buf.readUInt32LE(off); off += 4;
    const label = buf.slice(off, off + labelLen).toString('utf-8'); off += labelLen;
    const vec = new Float32Array(DIM);
    for (let j = 0; j < DIM; j++) {
      vec[j] = buf.readFloatLE(off + j * 4);
    }
    off += VEC_BYTES;
    queries.push({ label, vec });
  }
  return queries;
}

// ---------- ground_truth.json ----------

export interface GroundTruthHit {
  seq: number;
  distance: number;
}

export interface GroundTruthEntry {
  label: string;
  topK: GroundTruthHit[];
}

export interface GroundTruthFile {
  k: number;
  queries: GroundTruthEntry[];
}

export function writeGroundTruth(file: string, gt: GroundTruthFile): void {
  fs.writeFileSync(file, JSON.stringify(gt, null, 2));
}

export function readGroundTruth(file: string): GroundTruthFile {
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as GroundTruthFile;
}

// ---------- candidate result format ----------

export interface CandidateHit {
  seq: number;
  distance: number;
}

export interface CandidateRunQuery {
  label: string;
  topK: CandidateHit[];
  latencyMs: number;
}

export interface CandidateRun {
  candidate: string;
  capped: boolean;
  buildMs?: number;
  diskBytes?: number;
  rssBytesAfterLoad?: number;
  rssBytesAfterQueries?: number;
  queries: CandidateRunQuery[];
}

export function candidateResultPath(name: string, capped: boolean): string {
  return path.join(scratchDir(), `result_${name}${capped ? '_capped' : ''}.json`);
}

export function writeCandidateRun(run: CandidateRun): void {
  fs.writeFileSync(candidateResultPath(run.candidate, run.capped), JSON.stringify(run, null, 2));
}

export function readCandidateRun(file: string): CandidateRun {
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as CandidateRun;
}
