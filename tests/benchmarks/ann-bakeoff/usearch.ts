// USearch HNSW i8 candidate. Two subcommands:
//   build   read vectors.bin → write usearch_i8.bin
//   query   load usearch_i8.bin → run queries.bin → write result_usearch_i8(_capped).json
//
// Quantization is hardcoded to i8 (cosine-safe; b1 is wrong metric per docs).
// HNSW knobs are env-overridable so the bake-off can sweep them if needed.

import * as fs from 'fs';
import * as path from 'path';
import { Index, MetricKind, ScalarKind } from 'usearch';
import {
  scratchDir,
  streamVectors,
  vectorsCount,
  readQueries,
  writeCandidateRun,
  type CandidateRun,
  type CandidateRunQuery,
  DIM,
} from './io';

const M = parseInt(process.env.USEARCH_M ?? '16', 10);
const EF_ADD = parseInt(process.env.USEARCH_EF_ADD ?? '200', 10);
const EF_SEARCH = parseInt(process.env.USEARCH_EF_SEARCH ?? '64', 10);
const TOP_K = 20;

function indexFile(): string {
  return path.join(scratchDir(), 'usearch_i8.bin');
}

function build(): void {
  const dir = scratchDir();
  const vectorsBin = path.join(dir, 'vectors.bin');
  const total = vectorsCount(vectorsBin);
  console.log(`[usearch:build] dim=${DIM} M=${M} ef_add=${EF_ADD} ef_search=${EF_SEARCH} count=${total}`);

  const idx = new Index({
    dimensions: DIM,
    metric: MetricKind.Cos,
    quantization: ScalarKind.I8,
    connectivity: M,
    expansion_add: EF_ADD,
    expansion_search: EF_SEARCH,
    multi: false,
  });

  const t0 = Date.now();
  let lastLog = t0;
  let seq = 0;
  for (const vec of streamVectors(vectorsBin)) {
    idx.add(BigInt(seq), vec);
    seq++;
    if (seq % 100_000 === 0 || Date.now() - lastLog > 5000) {
      const rate = (seq / ((Date.now() - t0) / 1000)).toFixed(0);
      console.log(`[usearch:build] added ${seq.toLocaleString()} / ${total.toLocaleString()} (${rate}/s)`);
      lastLog = Date.now();
    }
  }
  const buildMs = Date.now() - t0;
  console.log(`[usearch:build] all added in ${(buildMs / 1000).toFixed(1)}s; saving to ${indexFile()}`);

  const tSave = Date.now();
  idx.save(indexFile());
  console.log(`[usearch:build] saved in ${((Date.now() - tSave) / 1000).toFixed(1)}s, size=${(fs.statSync(indexFile()).size / 1024 / 1024).toFixed(0)} MB`);
}

function query(capped: boolean): void {
  const dir = scratchDir();
  const queriesBin = path.join(dir, 'queries.bin');
  const idxFile = indexFile();
  if (!fs.existsSync(idxFile)) throw new Error(`missing ${idxFile}; run "usearch build" first`);

  // Use full-RAM load. mmap "view" mode is a separate sweep candidate; keeping
  // this script focused on i8 full-RAM. View mode can be exercised by setting
  // USEARCH_VIEW=1.
  const idx = new Index({
    dimensions: DIM,
    metric: MetricKind.Cos,
    quantization: ScalarKind.I8,
    connectivity: M,
    expansion_add: EF_ADD,
    expansion_search: EF_SEARCH,
    multi: false,
  });
  const tLoad = Date.now();
  if (process.env.USEARCH_VIEW === '1') {
    idx.view(idxFile);
    console.log(`[usearch:query] view'd ${idxFile} in ${((Date.now() - tLoad) / 1000).toFixed(2)}s`);
  } else {
    idx.load(idxFile);
    console.log(`[usearch:query] loaded ${idxFile} in ${((Date.now() - tLoad) / 1000).toFixed(2)}s`);
  }
  if (process.env.USEARCH_EF_SEARCH) {
    // ef_search is settable post-load via the constructor option above; the
    // binding doesn't expose a setter, so this is a documentation hook only.
  }
  const rssAfterLoad = process.memoryUsage().rss;

  const queries = readQueries(queriesBin);
  console.log(`[usearch:query] running ${queries.length} queries (k=${TOP_K})`);

  const out: CandidateRunQuery[] = [];
  for (const q of queries) {
    const t = Date.now();
    // threads=0 → auto. Single-vector search is single-threaded internally.
    const r = idx.search(q.vec, TOP_K, 0);
    const latencyMs = Date.now() - t;
    const topK: { seq: number; distance: number }[] = [];
    for (let i = 0; i < r.keys.length; i++) {
      topK.push({ seq: Number(r.keys[i]), distance: r.distances[i] });
    }
    out.push({ label: q.label, topK, latencyMs });
  }
  const rssAfterQueries = process.memoryUsage().rss;

  const run: CandidateRun = {
    candidate: 'usearch_i8' + (process.env.USEARCH_VIEW === '1' ? '_view' : ''),
    capped,
    diskBytes: fs.statSync(idxFile).size,
    rssBytesAfterLoad: rssAfterLoad,
    rssBytesAfterQueries: rssAfterQueries,
    queries: out,
  };
  writeCandidateRun(run);
  console.log(`[usearch:query] wrote ${out.length} results; rss load=${(rssAfterLoad / 1024 / 1024).toFixed(0)} MB query=${(rssAfterQueries / 1024 / 1024).toFixed(0)} MB`);
}

function main(): void {
  const cmd = process.argv[2];
  const capped = process.argv.includes('--capped');
  if (cmd === 'build') return build();
  if (cmd === 'query') return query(capped);
  console.error('usage: usearch.ts <build|query> [--capped]');
  process.exit(64);
}

main();
