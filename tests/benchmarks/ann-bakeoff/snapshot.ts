// Step 0 of the ANN bake-off: produce vectors.bin, chunk_ids.txt, queries.bin,
// and ground_truth.json from the live database — read-only, no re-embedding.
//
// Designed to run inside a sidecar Docker container with the gamefaqs-server
// data volume mounted RO at /data/db. See sidecar.sh for the launcher.
//
//   --pilot      slice to first 5000 vectors and 5 queries; ground truth is
//                computed locally in JS instead of via the live DB. ~30 s.
//   --no-gt      skip ground-truth computation (just dump vectors+queries).

import * as fs from 'fs';
import * as path from 'path';
import BetterSqlite3 from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import {
  scratchDir,
  VectorsWriter,
  ChunkIdsWriter,
  readChunkIds,
  chunkIdToSeqMap,
  writeQueries,
  writeGroundTruth,
  DIM,
  VEC_BYTES,
  type Query,
  type GroundTruthEntry,
} from './io';
import { EmbeddingService } from '../../../src/services/EmbeddingService';

// 33 strings copied from tests/benchmarks/rag-accuracy.test.ts on 2026-05-02.
// Hardcoded so the bake-off doesn't pull in vitest at runtime.
const QUESTIONS: string[] = [
  'How do I beat Sephiroth in Final Fantasy VII?',
  'What is the password for Otacon in Metal Gear Solid 2?',
  'How do I get the Master Sword in Ocarina of Time?',
  'How do I beat the Elite Four in Pokemon Red?',
  'How do I beat Krauser in Resident Evil 4?',
  'How do I get all 120 stars in Super Mario 64?',
  'How do I beat Lavos in Chrono Trigger?',
  'How do I beat Kefka in Final Fantasy VI?',
  'How do I find the inverted castle in Castlevania Symphony of the Night?',
  'How do I get to the secret cow level in Diablo 2?',
  "Who's the first enemy I fight in Final Fantasy X?",
  'What weapon does Cloud start with?',
  'How do I solve the first puzzle in Portal?',
  'How do I solve the church window puzzle in Resident Evil 4?',
  'How do I beat the second boss?',
  'Where do I find the Master Key?',
  'What is the best starter Pokemon?',
  'How do I learn Ultima?',
  "Where's the Triforce in Ocarina of Time?",
  'How do I beat the final boss in Tetris?',
  'How do I use the secret combo to one-shot Ganon in Breath of the Wild?',
  'How do I beat the final boss in Resident Evil?',
  "What's the best class in Diablo?",
  'How do I solve the temple puzzle in Zelda?',
  'How many stars are in Super Mario 64?',
  'What is the max level in Diablo 2?',
  'How many Triforce shards are in Wind Waker?',
  'Why did Sephiroth burn down Nibelheim?',
  "Who is Solid Snake's father?",
  "What's Aerith's last name?",
  "What's the missingno glitch in Pokemon Red?",
  'How do I do the W-Item duplication trick in Final Fantasy 7?',
  'How does the duplicate item glitch work in Diablo 2?',
];

const GROUND_TRUTH_K = 20;
const PILOT_VECTORS = 5000;
const PILOT_QUERIES = 5;
const RANDOM_QUERY_COUNT = 17; // 33 questions + 17 random = 50 total

interface Args {
  pilot: boolean;
  noGt: boolean;
}

function parseArgs(argv: string[]): Args {
  return {
    pilot: argv.includes('--pilot'),
    noGt: argv.includes('--no-gt'),
  };
}

function openReadOnly(dbPath: string): BetterSqlite3.Database {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`DB not found at ${dbPath}. Set DB_PATH or run via sidecar.sh.`);
  }
  // readonly: true → opens with SQLITE_OPEN_READONLY. Even if our SQL tries an
  // INSERT/UPDATE/DELETE, SQLite returns SQLITE_READONLY. Belt-and-braces.
  const db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
  // Match production pragmas the read paths assume; readonly so write-only
  // pragmas (cache_size etc.) are mostly inert but harmless.
  db.pragma('temp_store = MEMORY');
  // Load sqlite-vec so the vec0 MATCH KNN works for ground truth.
  sqliteVec.load(db);
  // Sanity check: confirm we can read the vec table.
  const probe = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chunk_embeddings_v2'").get() as { name: string } | undefined;
  if (!probe) {
    throw new Error('chunk_embeddings_v2 table missing. Wrong DB?');
  }
  return db;
}

function dumpVectors(db: BetterSqlite3.Database, out: { vectors: string; ids: string }, limit?: number): { count: number } {
  // Natural row order (no ORDER BY). The vec0 virtual table's chunk_id PK
  // doesn't have a B-tree usable for ordered scans, and ORDER BY chunk_id is
  // ~6× slower (forces a TEMP sort over 3.7M rows). Determinism is preserved
  // by chunk_ids.txt: line N == seq id N regardless of source order.
  const sql = limit !== undefined
    ? 'SELECT chunk_id, embedding FROM chunk_embeddings_v2 LIMIT ?'
    : 'SELECT chunk_id, embedding FROM chunk_embeddings_v2';
  const stmt = db.prepare(sql);
  const iter = limit !== undefined ? stmt.iterate(limit) : stmt.iterate();
  const vw = new VectorsWriter(out.vectors);
  const iw = new ChunkIdsWriter(out.ids);
  let count = 0;
  let lastLog = Date.now();
  for (const row of iter as Iterable<{ chunk_id: string; embedding: Buffer }>) {
    if (row.embedding.length !== VEC_BYTES) {
      throw new Error(`row ${row.chunk_id}: embedding bytes ${row.embedding.length} != ${VEC_BYTES}`);
    }
    const vec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, DIM);
    vw.append(vec);
    iw.append(row.chunk_id);
    count++;
    if (count % 100_000 === 0 || Date.now() - lastLog > 5000) {
      console.log(`[snapshot] dumped ${count.toLocaleString()} vectors`);
      lastLog = Date.now();
    }
  }
  vw.close();
  iw.close();
  return { count };
}

async function buildQueries(
  embeddings: EmbeddingService,
  vectorsFile: string,
  totalCount: number,
  pilot: boolean
): Promise<Query[]> {
  const queries: Query[] = [];
  const questions = pilot ? QUESTIONS.slice(0, PILOT_QUERIES) : QUESTIONS;
  console.log(`[snapshot] embedding ${questions.length} questions via Ollama...`);
  for (const q of questions) {
    const vec = await embeddings.embed(q);
    queries.push({ label: `q: ${q}`, vec });
  }
  if (!pilot && RANDOM_QUERY_COUNT > 0) {
    console.log(`[snapshot] sampling ${RANDOM_QUERY_COUNT} random chunk vectors as queries...`);
    const fd = fs.openSync(vectorsFile, 'r');
    try {
      const seen = new Set<number>();
      while (seen.size < Math.min(RANDOM_QUERY_COUNT, totalCount)) {
        const seq = Math.floor(Math.random() * totalCount);
        if (seen.has(seq)) continue;
        seen.add(seq);
        const buf = Buffer.alloc(VEC_BYTES);
        fs.readSync(fd, buf, 0, VEC_BYTES, seq * VEC_BYTES);
        const vec = new Float32Array(DIM);
        for (let i = 0; i < DIM; i++) vec[i] = buf.readFloatLE(i * 4);
        queries.push({ label: `r: seq=${seq}`, vec });
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  return queries;
}

// Brute-force top-K via the existing vec0 KNN on the live DB.
function groundTruthFromDb(
  db: BetterSqlite3.Database,
  queries: Query[],
  chunkIdToSeq: Map<string, number>,
  k: number
): GroundTruthEntry[] {
  const stmt = db.prepare(
    'SELECT chunk_id, distance FROM chunk_embeddings_v2 WHERE embedding MATCH ? AND k = ? ORDER BY distance'
  );
  const out: GroundTruthEntry[] = [];
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    const t0 = Date.now();
    const buf = Buffer.from(q.vec.buffer, q.vec.byteOffset, q.vec.byteLength);
    const rows = stmt.all(buf, k) as { chunk_id: string; distance: number }[];
    const elapsed = Date.now() - t0;
    const topK = rows.map((r) => {
      const seq = chunkIdToSeq.get(r.chunk_id);
      if (seq === undefined) throw new Error(`chunk_id ${r.chunk_id} not in dump — out-of-sync index?`);
      return { seq, distance: r.distance };
    });
    out.push({ label: q.label, topK });
    console.log(`[gt ${i + 1}/${queries.length}] ${elapsed.toLocaleString()}ms  ${q.label.slice(0, 80)}`);
  }
  return out;
}

// In pilot mode, brute-force in JS over the dumped subset. Self-consistency
// check: candidate indexes built from the same dump should match this.
function groundTruthFromDump(
  vectorsFile: string,
  totalCount: number,
  queries: Query[],
  k: number
): GroundTruthEntry[] {
  console.log(`[gt-pilot] brute-forcing ${queries.length} queries over ${totalCount} vectors in JS...`);
  // Load all vectors into memory — pilot is small (5000 × 3072 = 15 MB).
  const all = new Float32Array(totalCount * DIM);
  const fd = fs.openSync(vectorsFile, 'r');
  try {
    const buf = Buffer.alloc(totalCount * VEC_BYTES);
    fs.readSync(fd, buf, 0, buf.length, 0);
    for (let n = 0; n < totalCount; n++) {
      for (let d = 0; d < DIM; d++) all[n * DIM + d] = buf.readFloatLE(n * VEC_BYTES + d * 4);
    }
  } finally {
    fs.closeSync(fd);
  }
  const out: GroundTruthEntry[] = [];
  for (const q of queries) {
    const dists: { seq: number; distance: number }[] = new Array(totalCount);
    for (let n = 0; n < totalCount; n++) {
      // Cosine distance = 1 - cos_sim. Match what sqlite-vec returns.
      let dot = 0, an = 0, bn = 0;
      const off = n * DIM;
      for (let d = 0; d < DIM; d++) {
        const x = q.vec[d], y = all[off + d];
        dot += x * y; an += x * x; bn += y * y;
      }
      const sim = dot / (Math.sqrt(an) * Math.sqrt(bn) + 1e-12);
      dists[n] = { seq: n, distance: 1 - sim };
    }
    dists.sort((a, b) => a.distance - b.distance);
    out.push({ label: q.label, topK: dists.slice(0, k) });
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = scratchDir();
  const vectorsFile = path.join(dir, 'vectors.bin');
  const idsFile = path.join(dir, 'chunk_ids.txt');
  const queriesFile = path.join(dir, 'queries.bin');
  const gtFile = path.join(dir, 'ground_truth.json');

  const dbPath = process.env.DB_PATH || '/data/db/gamefaqs.db';
  const ollamaHost = process.env.EMBEDDING_OLLAMA_HOST || process.env.OLLAMA_HOST || 'http://localhost:11434';
  console.log(`[snapshot] mode=${args.pilot ? 'pilot' : 'full'} db=${dbPath} ollama=${ollamaHost}`);
  console.log(`[snapshot] outputs in ${dir}`);

  const db = openReadOnly(dbPath);
  console.log('[snapshot] DB opened read-only');

  const limit = args.pilot ? PILOT_VECTORS : undefined;
  const tDump = Date.now();
  const { count } = dumpVectors(db, { vectors: vectorsFile, ids: idsFile }, limit);
  console.log(`[snapshot] dumped ${count.toLocaleString()} vectors in ${((Date.now() - tDump) / 1000).toFixed(1)}s`);

  const ids = readChunkIds(idsFile);
  if (ids.length !== count) {
    throw new Error(`chunk_ids.txt has ${ids.length} entries but vectors.bin has ${count}`);
  }
  const idToSeq = chunkIdToSeqMap(ids);

  const embeddings = new EmbeddingService({
    host: ollamaHost,
    model: process.env.EMBEDDING_MODEL || 'nomic-embed-text',
    dim: DIM,
  });
  const queries = await buildQueries(embeddings, vectorsFile, count, args.pilot);
  writeQueries(queriesFile, queries);
  console.log(`[snapshot] wrote ${queries.length} queries to ${queriesFile}`);

  if (args.noGt) {
    console.log('[snapshot] --no-gt: skipping ground truth.');
    db.close();
    return;
  }

  const tGt = Date.now();
  const gtEntries = args.pilot
    ? groundTruthFromDump(vectorsFile, count, queries, GROUND_TRUTH_K)
    : groundTruthFromDb(db, queries, idToSeq, GROUND_TRUTH_K);
  writeGroundTruth(gtFile, { k: GROUND_TRUTH_K, queries: gtEntries });
  console.log(`[snapshot] wrote ground truth (${gtEntries.length} queries × top-${GROUND_TRUTH_K}) in ${((Date.now() - tGt) / 1000).toFixed(1)}s`);

  db.close();
  console.log('[snapshot] done.');
}

main().catch((err) => {
  console.error('[snapshot] FAILED:', err);
  process.exit(1);
});
