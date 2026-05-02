// End-to-end RAG quality test with USearch i8 swapped in as the vector source.
// Uses the production RetrievalService (vec + chunk-FTS + title-FTS RRF) — only
// the vec source is overridden to query USearch instead of vec0.
//
// Metric matches tests/benchmarks/rag-accuracy.test.ts:
//   For each question, retrieve top-K citations; recall hit iff any citation's
//   guide_title contains any expected substring (case-insensitive).
//
// Runs read-only against the live DB. Outputs a markdown table.

import * as fs from 'fs';
import * as path from 'path';
import BetterSqlite3 from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { Index, MetricKind, ScalarKind } from 'usearch';
import { scratchDir, readChunkIds, DIM } from './io';
import { RetrievalService, type VectorHit } from '../../../src/services/RetrievalService';
import { EmbeddingService } from '../../../src/services/EmbeddingService';

interface BenchQuestion {
  question: string;
  expectedTitleSubstrings: string[];
}

const QUESTIONS: BenchQuestion[] = [
  { question: 'How do I beat Sephiroth in Final Fantasy VII?', expectedTitleSubstrings: ['Final Fantasy VII', 'final fantasy 7', 'ff7'] },
  { question: 'What is the password for Otacon in Metal Gear Solid 2?', expectedTitleSubstrings: ['Metal Gear Solid 2', 'Sons of Liberty', 'mgs2'] },
  { question: 'How do I get the Master Sword in Ocarina of Time?', expectedTitleSubstrings: ['Ocarina of Time', 'Zelda'] },
  { question: 'How do I beat the Elite Four in Pokemon Red?', expectedTitleSubstrings: ['Pokemon Red', 'Pokemon Blue', 'Pokémon Red'] },
  { question: 'How do I beat Krauser in Resident Evil 4?', expectedTitleSubstrings: ['Resident Evil 4', 'biohazard 4'] },
  { question: 'How do I get all 120 stars in Super Mario 64?', expectedTitleSubstrings: ['Super Mario 64', 'mario 64'] },
  { question: 'How do I beat Lavos in Chrono Trigger?', expectedTitleSubstrings: ['Chrono Trigger'] },
  { question: 'How do I beat Kefka in Final Fantasy VI?', expectedTitleSubstrings: ['Final Fantasy VI', 'final fantasy 6', 'final fantasy iii', 'ff6'] },
  { question: 'How do I find the inverted castle in Castlevania Symphony of the Night?', expectedTitleSubstrings: ['Symphony of the Night', 'Castlevania'] },
  { question: 'How do I get to the secret cow level in Diablo 2?', expectedTitleSubstrings: ['Diablo 2', 'Diablo II'] },
  { question: "Who's the first enemy I fight in Final Fantasy X?", expectedTitleSubstrings: ['Final Fantasy X', 'FFX'] },
  { question: 'What weapon does Cloud start with?', expectedTitleSubstrings: ['Final Fantasy VII', 'FF7'] },
  { question: 'How do I solve the first puzzle in Portal?', expectedTitleSubstrings: ['Portal'] },
  { question: 'How do I solve the church window puzzle in Resident Evil 4?', expectedTitleSubstrings: ['Resident Evil 4'] },
  // ----- vague / niche prompts: no expected match (informational) -----
  { question: 'How do I beat the second boss?', expectedTitleSubstrings: [] },
  { question: 'Where do I find the Master Key?', expectedTitleSubstrings: [] },
  { question: 'What is the best starter Pokemon?', expectedTitleSubstrings: ['Pokemon', 'Pokémon'] },
  { question: 'How do I learn Ultima?', expectedTitleSubstrings: ['Final Fantasy'] },
  { question: "Where's the Triforce in Ocarina of Time?", expectedTitleSubstrings: ['Ocarina of Time', 'Zelda'] },
  { question: 'How do I beat the final boss in Tetris?', expectedTitleSubstrings: ['Tetris'] },
  { question: 'How do I use the secret combo to one-shot Ganon in Breath of the Wild?', expectedTitleSubstrings: ['Breath of the Wild', 'BotW', 'Zelda'] },
  { question: 'How do I beat the final boss in Resident Evil?', expectedTitleSubstrings: ['Resident Evil'] },
  { question: "What's the best class in Diablo?", expectedTitleSubstrings: ['Diablo'] },
  { question: 'How do I solve the temple puzzle in Zelda?', expectedTitleSubstrings: ['Zelda'] },
  { question: 'How many stars are in Super Mario 64?', expectedTitleSubstrings: ['Super Mario 64', 'mario 64'] },
  { question: 'What is the max level in Diablo 2?', expectedTitleSubstrings: ['Diablo 2', 'Diablo II'] },
  { question: 'How many Triforce shards are in Wind Waker?', expectedTitleSubstrings: ['Wind Waker', 'Zelda'] },
  { question: 'Why did Sephiroth burn down Nibelheim?', expectedTitleSubstrings: ['Final Fantasy VII', 'FF7'] },
  { question: "Who is Solid Snake's father?", expectedTitleSubstrings: ['Metal Gear', 'mgs'] },
  { question: "What's Aerith's last name?", expectedTitleSubstrings: ['Final Fantasy VII', 'FF7'] },
  { question: "What's the missingno glitch in Pokemon Red?", expectedTitleSubstrings: ['Pokemon Red', 'Pokémon Red'] },
  { question: 'How do I do the W-Item duplication trick in Final Fantasy 7?', expectedTitleSubstrings: ['Final Fantasy VII', 'FF7'] },
  { question: 'How does the duplicate item glitch work in Diablo 2?', expectedTitleSubstrings: ['Diablo 2', 'Diablo II'] },
];

const TOP_K = parseInt(process.env.RAG_TOP_K ?? '8', 10);

interface IDbShim {
  query<T>(sql: string, params?: any[]): T[];
  get<T>(sql: string, params?: any[]): T | undefined;
  run(sql: string, params?: any[]): { changes: number; lastInsertRowid: number | bigint };
  transaction<T>(fn: () => T): T;
  close(): void;
  getDb(): BetterSqlite3.Database;
  vectorSearchAvailable: boolean;
  initialize(_p: string): void;
  initializeInMemory(): void;
}

function wrapReadonlyDb(db: BetterSqlite3.Database): IDbShim {
  return {
    query: <T>(sql: string, params: any[] = []) => db.prepare(sql).all(...params) as T[],
    get: <T>(sql: string, params: any[] = []) => db.prepare(sql).get(...params) as T | undefined,
    run: (sql: string, params: any[] = []) => {
      const r = db.prepare(sql).run(...params);
      return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
    },
    transaction: <T>(fn: () => T) => db.transaction(fn)(),
    close: () => db.close(),
    getDb: () => db,
    vectorSearchAvailable: true,
    initialize: () => { /* no-op for tests */ },
    initializeInMemory: () => { /* no-op for tests */ },
  };
}

function loadUSearch(file: string): Index {
  const idx = new Index({
    dimensions: DIM,
    metric: MetricKind.Cos,
    quantization: ScalarKind.I8,
    connectivity: 16,
    expansion_add: 200,
    expansion_search: parseInt(process.env.USEARCH_EF_SEARCH ?? '256', 10),
    multi: false,
  });
  idx.load(file);
  return idx;
}

function checkRecall(citations: { guide_title: string }[], expected: string[]): { hit: boolean; matched: string | null } {
  for (const c of citations) {
    const t = (c.guide_title ?? '').toLowerCase();
    for (const e of expected) {
      if (t.includes(e.toLowerCase())) return { hit: true, matched: c.guide_title };
    }
  }
  return { hit: false, matched: null };
}

async function main(): Promise<void> {
  const dbPath = process.env.DB_PATH ?? '/data/db/gamefaqs.db';
  const ollamaHost = process.env.EMBEDDING_OLLAMA_HOST ?? process.env.OLLAMA_HOST ?? 'http://localhost:11434';
  const dir = scratchDir();
  const indexFile = path.join(dir, 'usearch_i8.bin');
  const idsFile = path.join(dir, 'chunk_ids.txt');

  console.log(`[e2e] db=${dbPath} ollama=${ollamaHost} top_k=${TOP_K}`);

  if (!fs.existsSync(indexFile)) throw new Error(`missing ${indexFile}; run "usearch build" first`);
  if (!fs.existsSync(idsFile)) throw new Error(`missing ${idsFile}; run "snapshot" first`);

  const db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
  db.pragma('temp_store = MEMORY');
  sqliteVec.load(db);

  const ids = readChunkIds(idsFile);
  console.log(`[e2e] loaded ${ids.length.toLocaleString()} chunk ids`);

  const idx = loadUSearch(indexFile);
  console.log(`[e2e] loaded usearch index (size=${idx.size().toLocaleString()})`);

  const embeddings = new EmbeddingService({
    host: ollamaHost,
    model: process.env.EMBEDDING_MODEL ?? 'nomic-embed-text',
    dim: DIM,
  });

  const dbShim = wrapReadonlyDb(db);

  // Per-source timing accumulators (last call wins, per question).
  const timings = { vec: 0, fts: 0, title: 0 };
  const usearchVec = (qv: Float32Array, k: number): VectorHit[] => {
    const r = idx.search(qv, k, 0);
    const hits: VectorHit[] = [];
    for (let i = 0; i < r.keys.length; i++) {
      const seq = Number(r.keys[i]);
      const chunkId = ids[seq];
      if (chunkId === undefined) continue;
      hits.push({ chunk_id: chunkId, distance: r.distances[i] });
    }
    return hits;
  };
  const wrapTimed = <Args extends any[], R>(label: keyof typeof timings, fn: (...a: Args) => R): ((...a: Args) => R) =>
    (...args) => {
      const t = Date.now();
      try { return fn(...args); } finally { timings[label] += Date.now() - t; }
    };

  // Default chunk-FTS / title-FTS implementations from RetrievalService (we
  // re-implement them here to attach the timing wrapper without forking the
  // production code).
  const defaultFts = (q: string, limit: number) =>
    dbShim.query<{ chunk_id: string; rank: number }>(
      `SELECT chunk_id, rank FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?`,
      [q, limit]
    );
  const defaultTitle = (q: string, limit: number) =>
    dbShim.query<{ guide_id: string; rank: number }>(
      `SELECT guide_id, rank FROM guides_fts_meta WHERE guides_fts_meta MATCH ? ORDER BY rank LIMIT ?`,
      [q, limit]
    );

  const retrieval = new RetrievalService({
    db: dbShim as any,
    embeddingService: embeddings,
    vectorSearch: wrapTimed('vec', usearchVec),
    ftsSearch: wrapTimed('fts', defaultFts),
    titleSearch: wrapTimed('title', defaultTitle),
  });

  type Row = {
    question: string; hit: boolean; matched: string | null; topTitles: string[];
    embedMs: number; retrieveMs: number; vecMs: number; ftsMs: number; titleMs: number; otherMs: number;
  };
  const rows: Row[] = [];

  console.log(`\n[e2e] running ${QUESTIONS.length} questions through hybrid retrieval (USearch + chunk-FTS + title-FTS RRF)...`);
  for (const q of QUESTIONS) {
    timings.vec = 0; timings.fts = 0; timings.title = 0;
    const { citations, embedMs, retrieveMs } = await retrieval.retrieveWithTimings(q.question, {}, TOP_K);
    const recall = checkRecall(citations, q.expectedTitleSubstrings);
    const topTitles = citations.map((c) => c.guide_title);
    const status = q.expectedTitleSubstrings.length === 0 ? 'INFO' : recall.hit ? 'HIT ' : 'MISS';
    const top = recall.matched
      ? `→ "${recall.matched.slice(0, 60)}"`
      : `top: "${(topTitles[0] ?? '').slice(0, 60)}"`;
    const otherMs = Math.max(0, retrieveMs - timings.vec - timings.fts - timings.title);
    console.log(`  ${status}  ${q.question.slice(0, 60).padEnd(60)} r=${retrieveMs.toFixed(0)}ms (vec=${timings.vec} fts=${timings.fts} title=${timings.title} other=${otherMs.toFixed(0)})`);
    rows.push({ question: q.question, hit: recall.hit, matched: recall.matched, topTitles, embedMs, retrieveMs, vecMs: timings.vec, ftsMs: timings.fts, titleMs: timings.title, otherMs });
  }

  const scored = rows.filter((r, i) => QUESTIONS[i].expectedTitleSubstrings.length > 0);
  const hits = scored.filter((r) => r.hit).length;
  const totalEmbed = rows.reduce((s, r) => s + r.embedMs, 0);
  const totalRetrieve = rows.reduce((s, r) => s + r.retrieveMs, 0);
  const avgEmbed = totalEmbed / rows.length;
  const avgRetrieve = totalRetrieve / rows.length;
  const lats = rows.map((r) => r.retrieveMs).sort((a, b) => a - b);
  const p50 = lats[Math.floor(lats.length * 0.5)];
  const p95 = lats[Math.floor(lats.length * 0.95)];

  const sumVec = rows.reduce((s, r) => s + r.vecMs, 0);
  const sumFts = rows.reduce((s, r) => s + r.ftsMs, 0);
  const sumTitle = rows.reduce((s, r) => s + r.titleMs, 0);
  const sumOther = rows.reduce((s, r) => s + r.otherMs, 0);
  const ftsP95 = [...rows].map((r) => r.ftsMs).sort((a, b) => a - b)[Math.floor(rows.length * 0.95)];
  const titleP95 = [...rows].map((r) => r.titleMs).sort((a, b) => a - b)[Math.floor(rows.length * 0.95)];
  const vecP95 = [...rows].map((r) => r.vecMs).sort((a, b) => a - b)[Math.floor(rows.length * 0.95)];

  console.log('\n=========== USearch i8 e2e summary ===========');
  console.log(`scored questions: ${scored.length}`);
  console.log(`recall@${TOP_K}: ${hits}/${scored.length} (${((hits / scored.length) * 100).toFixed(0)}%)`);
  console.log(`avg embed: ${avgEmbed.toFixed(0)}ms; avg retrieve: ${avgRetrieve.toFixed(0)}ms`);
  console.log(`retrieve p50: ${p50.toFixed(0)}ms; p95: ${p95.toFixed(0)}ms`);
  console.log('---- per-source totals over the run ----');
  console.log(`  vec   total ${sumVec}ms   p95 ${vecP95}ms`);
  console.log(`  fts   total ${sumFts}ms   p95 ${ftsP95}ms`);
  console.log(`  title total ${sumTitle}ms   p95 ${titleP95}ms`);
  console.log(`  other total ${sumOther.toFixed(0)}ms (filter / fuse / hydrate / DF queries)`);
  console.log('================================================\n');

  fs.writeFileSync(path.join(dir, 'e2e_usearch_i8.json'), JSON.stringify({ rows, hits, scored: scored.length, avgEmbed, avgRetrieve, p50, p95 }, null, 2));
  db.close();
}

main().catch((err) => {
  console.error('[e2e] FAILED:', err);
  process.exit(1);
});
