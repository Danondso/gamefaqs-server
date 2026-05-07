import Database from '../database/database';
import { config } from '../config';

type SamplingMode = 'random' | 'franchise' | 'console' | 'gamefaqs_id';

interface Args {
  sample: number;
  mode: SamplingMode;
  target?: string;
  output: string;
  writeStatus: boolean;
}

interface ChunkRow {
  id: string;
  content: string;
  gamefaqs_id: string | null;
  franchise: string | null;
  review_status: string | null;
  platform: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { sample: 100, mode: 'random', output: 'chunk-validation.json', writeStatus: false };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--sample' && value) args.sample = Math.max(1, parseInt(value, 10));
    if (key === '--mode' && value) args.mode = value as SamplingMode;
    if (key === '--target' && value) args.target = value;
    if (key === '--output' && value) args.output = value;
    if (key === '--write-status') args.writeStatus = true;
  }
  return args;
}

function sampleChunks(args: Args): ChunkRow[] {
  if (args.mode === 'franchise' && args.target) {
    return Database.query<ChunkRow>(
      `SELECT c.id, c.content, c.gamefaqs_id, c.franchise, c.review_status, json_extract(g.metadata, '$.platform') as platform
       FROM chunks c JOIN guides g ON g.id = c.guide_id
       WHERE c.franchise = ? ORDER BY random() LIMIT ?`,
      [args.target, args.sample]
    );
  }
  if (args.mode === 'console' && args.target) {
    return Database.query<ChunkRow>(
      `SELECT c.id, c.content, c.gamefaqs_id, c.franchise, c.review_status, json_extract(g.metadata, '$.platform') as platform
       FROM chunks c JOIN guides g ON g.id = c.guide_id
       WHERE json_extract(g.metadata, '$.platform') = ? ORDER BY random() LIMIT ?`,
      [args.target, args.sample]
    );
  }
  if (args.mode === 'gamefaqs_id' && args.target) {
    return Database.query<ChunkRow>(
      `SELECT c.id, c.content, c.gamefaqs_id, c.franchise, c.review_status, json_extract(g.metadata, '$.platform') as platform
       FROM chunks c JOIN guides g ON g.id = c.guide_id
       WHERE c.gamefaqs_id = ? ORDER BY random() LIMIT ?`,
      [args.target, args.sample]
    );
  }
  return Database.query<ChunkRow>(
    `SELECT c.id, c.content, c.gamefaqs_id, c.franchise, c.review_status, json_extract(g.metadata, '$.platform') as platform
     FROM chunks c JOIN guides g ON g.id = c.guide_id
     ORDER BY random() LIMIT ?`,
    [args.sample]
  );
}

function validateChunkHeuristic(content: string): { flagged: boolean; reason: string } {
  const short = content.trim().length < 40;
  const noisy = (content.match(/[^\w\s]/g) ?? []).length > content.length * 0.2;
  if (short) return { flagged: true, reason: 'too_short' };
  if (noisy) return { flagged: true, reason: 'high_symbol_noise' };
  return { flagged: false, reason: 'ok' };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  Database.initialize(config.dbPath);
  const chunks = sampleChunks(args);
  const rows = chunks.map(c => {
    const verdict = validateChunkHeuristic(c.content);
    return {
      chunk_id: c.id,
      gamefaqs_id: c.gamefaqs_id,
      franchise: c.franchise,
      platform: c.platform,
      flagged: verdict.flagged,
      reason: verdict.reason,
    };
  });
  if (args.writeStatus) {
    const tx = Database.getDb().transaction((updates: typeof rows) => {
      for (const r of updates) {
        Database.run(`UPDATE chunks SET review_status = ? WHERE id = ?`, [r.flagged ? `flagged:${r.reason}` : 'ok', r.chunk_id]);
      }
    });
    tx(rows);
  }
  const franchiseBreakdown = rows.reduce<Record<string, { total: number; flagged: number }>>((acc, r) => {
    const key = r.franchise ?? 'unknown';
    const slot = acc[key] ?? { total: 0, flagged: 0 };
    slot.total += 1;
    if (r.flagged) slot.flagged += 1;
    acc[key] = slot;
    return acc;
  }, {});
  const consoleBreakdown = rows.reduce<Record<string, { total: number; flagged: number }>>((acc, r) => {
    const key = r.platform ?? 'unknown';
    const slot = acc[key] ?? { total: 0, flagged: 0 };
    slot.total += 1;
    if (r.flagged) slot.flagged += 1;
    acc[key] = slot;
    return acc;
  }, {});
  const report = {
    generated_at: new Date().toISOString(),
    mode: args.mode,
    sample_size: rows.length,
    flagged: rows.filter(r => r.flagged).length,
    franchise_breakdown: franchiseBreakdown,
    console_breakdown: consoleBreakdown,
    rows,
  };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  Database.close();
}

main();
