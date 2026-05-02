// Step 2 / Step 3 orchestrator. Reads ground_truth.json + every result_*.json
// in scratch/ann/, computes recall + latency, prints a verdict table.
//
//   run.ts query             list candidates + run any whose result file is missing
//   run.ts query --capped    same but mark results as capped runs (RSS measured)
//   run.ts table             just print the table from existing result files
//   run.ts table --capped    table from result_*_capped.json files

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { scratchDir, readGroundTruth, readCandidateRun, candidateResultPath } from './io';
import { verdict, formatVerdictTable, type Verdict } from './metrics';

const RECALL_FLOOR = parseFloat(process.env.BAKEOFF_RECALL_FLOOR ?? '0.90');
const P95_CEILING_MS = parseInt(process.env.BAKEOFF_P95_CEILING_MS ?? '500', 10);

interface Candidate {
  name: string;
  script: string;
  args: string[]; // for `query`
  // Existence check before running. If the underlying index file isn't built,
  // skip the candidate quietly — bake-off runs in tiers (USearch + f8 first;
  // f16 is a fallback we may or may not build).
  indexFile: string;
}

const CANDIDATES: Candidate[] = [
  { name: 'usearch_i8', script: 'usearch.ts', args: ['query'], indexFile: 'usearch_i8.bin' },
  { name: 'libsql_f8',  script: 'libsql.ts',  args: ['query', 'f8'],  indexFile: 'libsql_f8.db' },
  { name: 'libsql_f16', script: 'libsql.ts',  args: ['query', 'f16'], indexFile: 'libsql_f16.db' },
];

function runCandidate(c: Candidate, capped: boolean): boolean {
  const args = [...c.args];
  if (capped) args.push('--capped');
  const tsNode = path.resolve(process.cwd(), 'node_modules/.bin/ts-node');
  const script = path.resolve(process.cwd(), 'tests/benchmarks/ann-bakeoff', c.script);
  console.log(`[run] ${c.name}: ts-node ${c.script} ${args.join(' ')}`);
  const r = spawnSync(tsNode, [script, ...args], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`[run] ${c.name} failed (exit ${r.status})`);
    return false;
  }
  return true;
}

function table(capped: boolean): void {
  const dir = scratchDir();
  const gt = readGroundTruth(path.join(dir, 'ground_truth.json'));
  const verdicts: Verdict[] = [];
  for (const c of CANDIDATES) {
    const file = candidateResultPath(c.name, capped);
    if (!fs.existsSync(file)) continue;
    const run = readCandidateRun(file);
    verdicts.push(verdict(run, gt, RECALL_FLOOR, P95_CEILING_MS));
  }
  // Also include candidates whose name has a suffix (e.g. usearch_i8_view).
  const all = fs.readdirSync(dir).filter((f) => f.startsWith('result_') && f.endsWith(capped ? '_capped.json' : '.json') && (capped || !f.includes('_capped.json')));
  for (const f of all) {
    if (verdicts.some((v) => candidateResultPath(v.candidate, v.capped) === path.join(dir, f))) continue;
    const run = readCandidateRun(path.join(dir, f));
    verdicts.push(verdict(run, gt, RECALL_FLOOR, P95_CEILING_MS));
  }

  if (verdicts.length === 0) {
    console.log(`(no result files found in ${dir})`);
    return;
  }

  console.log(`\nGate: recall@${gt.k} >= ${RECALL_FLOOR}, p95 <= ${P95_CEILING_MS}ms`);
  console.log(formatVerdictTable(verdicts));
  console.log('');

  const winners = verdicts.filter((v) => v.passes);
  if (winners.length > 0) {
    winners.sort((a, b) => a.p95LatencyMs - b.p95LatencyMs || (a.diskMb ?? 0) - (b.diskMb ?? 0));
    console.log(`WINNER: ${winners[0].candidate} (p95=${winners[0].p95LatencyMs.toFixed(0)}ms, recall=${winners[0].meanRecallAt20.toFixed(3)})`);
  } else {
    console.log('No candidate passed the gate. Consider escalating to f16 / f32 fallback or reviewing the gate.');
  }
}

function main(): void {
  const cmd = process.argv[2];
  const capped = process.argv.includes('--capped');
  if (cmd === 'query') {
    for (const c of CANDIDATES) {
      const idx = path.join(scratchDir(), c.indexFile);
      if (!fs.existsSync(idx)) {
        console.log(`[run] ${c.name}: ${c.indexFile} not built, skipping`);
        continue;
      }
      const file = candidateResultPath(c.name, capped);
      if (fs.existsSync(file)) {
        console.log(`[run] ${c.name}: ${file} exists, skipping (delete to re-run)`);
        continue;
      }
      runCandidate(c, capped);
    }
    table(capped);
    return;
  }
  if (cmd === 'table') return table(capped);
  console.error('usage: run.ts <query|table> [--capped]');
  process.exit(64);
}

main();
