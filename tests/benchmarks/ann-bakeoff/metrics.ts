import type { CandidateRun, GroundTruthFile } from './io';

export function recallAtK(predicted: number[], truth: number[], k: number): number {
  if (k === 0) return 1;
  const truthSet = new Set(truth.slice(0, k));
  let hit = 0;
  for (const seq of predicted.slice(0, k)) if (truthSet.has(seq)) hit++;
  return hit / Math.min(k, truthSet.size);
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
  return sorted[idx];
}

export interface Verdict {
  candidate: string;
  capped: boolean;
  meanRecallAt20: number;
  minRecallAt20: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  rssAfterLoadMb?: number;
  rssAfterQueriesMb?: number;
  diskMb?: number;
  buildSec?: number;
  passes: boolean;
  reason?: string;
}

export function verdict(
  run: CandidateRun,
  gt: GroundTruthFile,
  recallFloor: number,
  p95CeilingMs: number
): Verdict {
  const recalls: number[] = [];
  for (const q of run.queries) {
    const truthEntry = gt.queries.find((g) => g.label === q.label);
    if (!truthEntry) {
      // Unmatched query — skip silently; surfaced via diff later if it matters.
      continue;
    }
    const predSeqs = q.topK.map((h) => h.seq);
    const truthSeqs = truthEntry.topK.map((h) => h.seq);
    recalls.push(recallAtK(predSeqs, truthSeqs, gt.k));
  }
  const lats = run.queries.map((q) => q.latencyMs);
  const meanRecall = recalls.length > 0 ? recalls.reduce((a, b) => a + b, 0) / recalls.length : 0;
  const minRecall = recalls.length > 0 ? Math.min(...recalls) : 0;
  const p50 = percentile(lats, 0.5);
  const p95 = percentile(lats, 0.95);
  const passes = meanRecall >= recallFloor && p95 <= p95CeilingMs;
  let reason: string | undefined;
  if (!passes) {
    const fails = [];
    if (meanRecall < recallFloor) fails.push(`mean recall@${gt.k} ${meanRecall.toFixed(3)} < ${recallFloor}`);
    if (p95 > p95CeilingMs) fails.push(`p95 ${p95.toFixed(0)}ms > ${p95CeilingMs}ms`);
    reason = fails.join('; ');
  }
  return {
    candidate: run.candidate,
    capped: run.capped,
    meanRecallAt20: meanRecall,
    minRecallAt20: minRecall,
    p50LatencyMs: p50,
    p95LatencyMs: p95,
    rssAfterLoadMb: run.rssBytesAfterLoad ? run.rssBytesAfterLoad / 1024 / 1024 : undefined,
    rssAfterQueriesMb: run.rssBytesAfterQueries ? run.rssBytesAfterQueries / 1024 / 1024 : undefined,
    diskMb: run.diskBytes ? run.diskBytes / 1024 / 1024 : undefined,
    buildSec: run.buildMs ? run.buildMs / 1000 : undefined,
    passes,
    reason,
  };
}

export function formatVerdictTable(verdicts: Verdict[]): string {
  const headers = [
    'candidate', 'capped', 'recall@20', 'min recall', 'p50 ms', 'p95 ms',
    'RSS load MB', 'RSS query MB', 'disk MB', 'build s', 'pass'
  ];
  const rows = verdicts.map((v) => [
    v.candidate,
    String(v.capped),
    v.meanRecallAt20.toFixed(3),
    v.minRecallAt20.toFixed(3),
    v.p50LatencyMs.toFixed(0),
    v.p95LatencyMs.toFixed(0),
    v.rssAfterLoadMb !== undefined ? v.rssAfterLoadMb.toFixed(0) : '-',
    v.rssAfterQueriesMb !== undefined ? v.rssAfterQueriesMb.toFixed(0) : '-',
    v.diskMb !== undefined ? v.diskMb.toFixed(0) : '-',
    v.buildSec !== undefined ? v.buildSec.toFixed(1) : '-',
    v.passes ? 'YES' : `NO (${v.reason})`,
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmtRow = (cells: string[]) => '| ' + cells.map((c, i) => c.padEnd(widths[i])).join(' | ') + ' |';
  const sep = '|' + widths.map((w) => '-'.repeat(w + 2)).join('|') + '|';
  return [fmtRow(headers), sep, ...rows.map(fmtRow)].join('\n');
}
