import * as path from 'path';
import Seven from 'node-7z';

export interface DedupeStats {
  totalFiles: number;
  uniqueGuides: number;
  passthrough: number;
  dropped: number;
  bytesKept: number;
  bytesDropped: number;
}

export interface DedupePlan {
  cherryPicks: Map<string, string[]>;
  stats: DedupeStats;
}

interface Candidate {
  archivePath: string;
  internalPath: string;
  size: number;
  gen: number;
}

interface ListEvent {
  attributes?: string;
  file?: string;
  size?: number;
}

const GEN_RE = /faqs\.(\d+)\.gen\.7z$/i;
const GUIDE_ID_RE = /-faqs-(\d+)\.txt$/i;

export function parseGen(archivePath: string): number {
  const m = path.basename(archivePath).match(GEN_RE);
  if (!m) throw new Error(`Cannot parse gen number from archive name: ${archivePath}`);
  return Number(m[1]);
}

export function parseGuideId(internalPath: string): number | null {
  const m = internalPath.match(GUIDE_ID_RE);
  return m ? Number(m[1]) : null;
}

function listArchiveEntries(archivePath: string): Promise<Candidate[]> {
  const gen = parseGen(archivePath);
  return new Promise((resolve, reject) => {
    const out: Candidate[] = [];
    const stream = Seven.list(archivePath);
    stream.on('data', (d: ListEvent) => {
      if (!d.file || !d.attributes || d.attributes.startsWith('D')) return;
      out.push({
        archivePath,
        internalPath: d.file,
        size: typeof d.size === 'number' ? d.size : 0,
        gen,
      });
    });
    stream.on('end', () => resolve(out));
    stream.on('error', (err: Error) => reject(err));
  });
}

export function pickWinner(a: Candidate, b: Candidate): Candidate {
  if (a.size !== b.size) return a.size > b.size ? a : b;
  if (a.gen !== b.gen) return a.gen < b.gen ? a : b;
  return a.internalPath < b.internalPath ? a : b;
}

export function planFromCandidates(candidates: Candidate[]): DedupePlan {
  const winners = new Map<number, Candidate>();
  const passthrough: Candidate[] = [];
  let totalFiles = 0;
  let totalBytes = 0;

  for (const c of candidates) {
    totalFiles++;
    totalBytes += c.size;
    const guideId = parseGuideId(c.internalPath);
    if (guideId === null) {
      passthrough.push(c);
      continue;
    }
    const prev = winners.get(guideId);
    winners.set(guideId, prev ? pickWinner(prev, c) : c);
  }

  const cherryPicks = new Map<string, string[]>();
  let bytesKept = 0;

  const add = (c: Candidate) => {
    bytesKept += c.size;
    const list = cherryPicks.get(c.archivePath);
    if (list) list.push(c.internalPath);
    else cherryPicks.set(c.archivePath, [c.internalPath]);
  };

  for (const c of winners.values()) add(c);
  for (const c of passthrough) add(c);

  return {
    cherryPicks,
    stats: {
      totalFiles,
      uniqueGuides: winners.size,
      passthrough: passthrough.length,
      dropped: totalFiles - winners.size - passthrough.length,
      bytesKept,
      bytesDropped: totalBytes - bytesKept,
    },
  };
}

export async function buildDedupePlan(archivePaths: string[]): Promise<DedupePlan> {
  const all: Candidate[] = [];
  for (const archivePath of archivePaths) {
    const entries = await listArchiveEntries(archivePath);
    if (entries.length === 0) {
      throw new Error(`Archive listed zero entries: ${archivePath}`);
    }
    all.push(...entries);
  }
  return planFromCandidates(all);
}
