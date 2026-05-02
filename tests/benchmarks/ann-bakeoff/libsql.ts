// libSQL DiskANN candidates. Subcommands:
//   build f8     read vectors.bin → write libsql_f8.db (compress_neighbors=float8)
//   build f16    read vectors.bin → write libsql_f16.db (compress_neighbors=float16)
//   query f8     run queries.bin against libsql_f8.db → result_libsql_f8.json
//   query f16    run queries.bin against libsql_f16.db → result_libsql_f16.json
//
// libSQL only supports float8 and float16 compression for vector indexes
// (verified empirically — int8 / 1bit / bf16 all return "invalid parameter").
// Both fit in 13 GB at 3.7M scale; f8 is the smallest, f16 trades disk for
// recall.

import * as fs from 'fs';
import * as path from 'path';
import LibSqlDatabase from 'libsql';
import {
  scratchDir,
  streamVectors,
  vectorsCount,
  readQueries,
  writeCandidateRun,
  type CandidateRun,
  type CandidateRunQuery,
  DIM,
  VEC_BYTES,
} from './io';

type Variant = 'f8' | 'f16';

const TOP_K = 20;
const MAX_NEIGHBORS = parseInt(process.env.LIBSQL_MAX_NEIGHBORS ?? '32', 10);
const SEARCH_L = parseInt(process.env.LIBSQL_SEARCH_L ?? '64', 10);

function compressArg(v: Variant): string {
  return v === 'f8' ? 'float8' : 'float16';
}

function dbFile(v: Variant): string {
  return path.join(scratchDir(), `libsql_${v}.db`);
}

function build(v: Variant): void {
  const file = dbFile(v);
  if (fs.existsSync(file)) {
    console.log(`[libsql:build:${v}] removing existing ${file}`);
    fs.rmSync(file);
    // Also -journal / -shm / -wal artifacts if present
    for (const ext of ['-journal', '-shm', '-wal']) {
      const f = file + ext;
      if (fs.existsSync(f)) fs.rmSync(f);
    }
  }

  const dir = scratchDir();
  const vectorsBin = path.join(dir, 'vectors.bin');
  const total = vectorsCount(vectorsBin);
  console.log(`[libsql:build:${v}] dim=${DIM} compress=${compressArg(v)} max_neighbors=${MAX_NEIGHBORS} count=${total}`);

  const db = new LibSqlDatabase(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL'); // faster bulk insert; we're rebuilding from vectors.bin if it dies
  db.exec(`CREATE TABLE chunk_embeddings_ann (id INTEGER PRIMARY KEY, v F32_BLOB(${DIM}))`);

  const insert = db.prepare('INSERT INTO chunk_embeddings_ann (id, v) VALUES (?, ?)');
  const t0 = Date.now();
  let lastLog = t0;
  let seq = 0;
  // Single big transaction — DiskANN-creating an index later is cheaper than
  // incremental index updates per row.
  db.exec('BEGIN');
  for (const vec of streamVectors(vectorsBin)) {
    // Build a *fresh* Buffer so each insert binds independent bytes.
    const buf = Buffer.allocUnsafe(VEC_BYTES);
    Buffer.from(vec.buffer, vec.byteOffset, VEC_BYTES).copy(buf);
    insert.run(seq, buf);
    seq++;
    if (seq % 100_000 === 0 || Date.now() - lastLog > 5000) {
      const rate = (seq / ((Date.now() - t0) / 1000)).toFixed(0);
      console.log(`[libsql:build:${v}] inserted ${seq.toLocaleString()} / ${total.toLocaleString()} (${rate}/s)`);
      lastLog = Date.now();
    }
  }
  db.exec('COMMIT');
  const insertMs = Date.now() - t0;
  console.log(`[libsql:build:${v}] inserts done in ${(insertMs / 1000).toFixed(1)}s; building DiskANN index...`);

  const tIdx = Date.now();
  db.exec(
    `CREATE INDEX chunk_embeddings_ann_idx ON chunk_embeddings_ann ` +
    `(libsql_vector_idx(v, 'compress_neighbors=${compressArg(v)}', 'max_neighbors=${MAX_NEIGHBORS}'))`
  );
  const indexMs = Date.now() - tIdx;
  const totalMs = insertMs + indexMs;
  console.log(`[libsql:build:${v}] index built in ${(indexMs / 1000).toFixed(1)}s; total ${(totalMs / 1000).toFixed(1)}s`);

  db.close();
  const sz = fs.statSync(file).size;
  console.log(`[libsql:build:${v}] file size: ${(sz / 1024 / 1024).toFixed(0)} MB`);
}

function query(v: Variant, capped: boolean): void {
  const file = dbFile(v);
  if (!fs.existsSync(file)) throw new Error(`missing ${file}; run "libsql build ${v}" first`);

  const tLoad = Date.now();
  const db = new LibSqlDatabase(file, { readonly: true });
  // search_l (DiskANN beam width) — passed via the SELECT, see below.
  const loadMs = Date.now() - tLoad;
  console.log(`[libsql:query:${v}] opened in ${loadMs}ms`);
  const rssAfterLoad = process.memoryUsage().rss;

  // Prepared statement for KNN. Pass the query vector as a binary blob.
  // search_l is a query-time hint passed via the third positional arg of
  // vector_top_k (per Turso docs); fall back to default if hint syntax fails.
  const stmt = db.prepare(
    `SELECT t.id AS id, vector_distance_cos(t.v, vector32(?)) AS d
     FROM vector_top_k('chunk_embeddings_ann_idx', vector32(?), ?) AS k
     JOIN chunk_embeddings_ann AS t ON t.id = k.id
     ORDER BY d`
  );

  const queries = readQueries(path.join(scratchDir(), 'queries.bin'));
  console.log(`[libsql:query:${v}] running ${queries.length} queries (k=${TOP_K})`);

  const out: CandidateRunQuery[] = [];
  for (const q of queries) {
    const buf = Buffer.allocUnsafe(VEC_BYTES);
    Buffer.from(q.vec.buffer, q.vec.byteOffset, VEC_BYTES).copy(buf);
    const t = Date.now();
    const rows = stmt.all(buf, buf, TOP_K) as { id: number; d: number }[];
    const latencyMs = Date.now() - t;
    out.push({
      label: q.label,
      topK: rows.map((r) => ({ seq: r.id, distance: r.d })),
      latencyMs,
    });
  }
  const rssAfterQueries = process.memoryUsage().rss;
  db.close();

  const run: CandidateRun = {
    candidate: `libsql_${v}`,
    capped,
    diskBytes: fs.statSync(file).size,
    rssBytesAfterLoad: rssAfterLoad,
    rssBytesAfterQueries: rssAfterQueries,
    queries: out,
  };
  writeCandidateRun(run);
  console.log(`[libsql:query:${v}] wrote ${out.length} results; rss load=${(rssAfterLoad / 1024 / 1024).toFixed(0)} MB query=${(rssAfterQueries / 1024 / 1024).toFixed(0)} MB`);
}

function main(): void {
  const cmd = process.argv[2];
  const variant = process.argv[3] as Variant;
  const capped = process.argv.includes('--capped');
  if (variant !== 'f8' && variant !== 'f16') {
    console.error(`variant must be f8 or f16, got: ${variant}`);
    process.exit(64);
  }
  if (cmd === 'build') return build(variant);
  if (cmd === 'query') return query(variant, capped);
  console.error('usage: libsql.ts <build|query> <f8|f16> [--capped]');
  process.exit(64);
}

main();
