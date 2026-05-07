#!/usr/bin/env node
/**
 * Posts each RAG benchmark question to /api/guides/answer and prints Q + response JSON.
 * Usage (inside container): BASE_URL=http://127.0.0.1:3000 node scripts/rag-bench-dump.mjs
 * From host: docker compose cp scripts/rag-bench-dump.mjs gamefaqs-server:/tmp/ && \
 *   docker compose exec -T gamefaqs-server node /tmp/rag-bench-dump.mjs
 *
 * Set OUTPUT_FILE=./bench-results.txt to write all output to a file in addition to stdout.
 * Set OUTPUT_FILE_ONLY=1 to suppress stdout and write only to OUTPUT_FILE.
 */
import { createWriteStream } from 'fs';

const BASE_URL = (process.env.BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const TOP_K = parseInt(process.env.RAG_BENCH_TOP_K ?? '8', 10);
// 5s matches the bench test default — stays well inside the rate limiter's
// sliding window. Lower with DELAY_MS=0 for local runs without a rate limiter.
const DELAY_MS = parseInt(process.env.RAG_BENCH_DELAY_MS ?? '5000', 10);
// Default output file lives in the repo root for easy git-ignored review.
// Override with OUTPUT_FILE=<path>; set OUTPUT_FILE='' to disable.
const OUTPUT_FILE = 'OUTPUT_FILE' in process.env ? process.env.OUTPUT_FILE : 'bench-qa.txt';
const OUTPUT_FILE_ONLY = process.env.OUTPUT_FILE_ONLY === '1';
const fileStream = OUTPUT_FILE ? createWriteStream(OUTPUT_FILE, { flags: 'w' }) : null;

const QUESTIONS = [
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
  'How many stars are in Super Mario 64?',
  'What is the max level in Diablo 2?',
  'How many Triforce shards are in Wind Waker?',
  'Why did Sephiroth burn down Nibelheim?',
  "Who is Solid Snake's father?",
  "What's Aerith's last name?",
  "What's the missingno glitch in Pokemon Red?",
  'How do I do the W-Item duplication trick in Final Fantasy 7?',
  'How does the duplicate item glitch work in Diablo 2?',
  'What are the cheats for the weapon sets in GTA San Andreas?',
  'Where do I find the Master Key?',
  'What is the best starter Pokemon?',
  'How do I learn Ultima?',
  'How do I beat the final boss in Resident Evil?',
  "What's the best class in Diablo?",
  'How do I solve the temple puzzle in Zelda?',
  "Where's the Triforce in Ocarina of Time?",
  'How do I beat the final boss in Tetris?',
  'How do I use the secret combo to one-shot Ganon in Breath of the Wild?',
  'How do I beat the second boss?',
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function emit(text) {
  if (!OUTPUT_FILE_ONLY) process.stdout.write(text);
  if (fileStream) fileStream.write(text);
}

/**
 * Waits for the server's /api/health/ready endpoint to return 200.
 * Polls up to maxAttempts times with intervalMs between each attempt.
 * Exits the process if the server does not become ready in time.
 */
async function waitForReady(maxAttempts = 20, intervalMs = 3000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}/api/health/ready`);
      if (res.ok) {
        process.stdout.write(`[bench] server ready (attempt ${attempt})\n`);
        return;
      }
      process.stdout.write(`[bench] /api/health/ready returned ${res.status}, waiting...\n`);
    } catch (err) {
      process.stdout.write(`[bench] server not reachable (${err.message}), waiting... (${attempt}/${maxAttempts})\n`);
    }
    await sleep(intervalMs);
  }
  process.stderr.write(`[bench] server did not become ready after ${maxAttempts} attempts — aborting\n`);
  process.exit(1);
}

async function main() {
  // Wait for the server to be fully ready before starting the bench loop.
  // Without this, a cold start (e.g. after docker compose up --build) causes
  // the first N questions to fail with "fetch failed" before the server is
  // listening, skewing results.
  await waitForReady();

  const header = `BASE_URL=${BASE_URL} TOP_K=${TOP_K} DELAY_MS=${DELAY_MS}${OUTPUT_FILE ? ` OUTPUT_FILE=${OUTPUT_FILE}` : ''}\n\n`;
  emit(header);

  for (let i = 0; i < QUESTIONS.length; i++) {
    const question = QUESTIONS[i];
    emit(`${'='.repeat(72)}\n`);
    emit(`[${i + 1}/${QUESTIONS.length}] QUESTION\n`);
    emit(`${question}\n\n`);

    const t0 = Date.now();
    let body;
    try {
      let res;
      for (let attempt = 0; ; attempt++) {
        res = await fetch(`${BASE_URL}/api/guides/answer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question, top_k: TOP_K }),
        });
        if (res.status === 429 && attempt < 5) {
          let waitSec = 10;
          try {
            const rb = await res.json();
            waitSec = Math.min(rb.retryAfter ?? 10, 60);
          } catch { /* ignore */ }
          emit(`[429] rate limited — waiting ${waitSec}s…\n`);
          await sleep(waitSec * 1000);
          continue;
        }
        break;
      }
      const text = await res.text();
      try {
        body = JSON.parse(text);
      } catch {
        body = { _raw: text, _status: res.status };
      }
      if (!res.ok) {
        body._httpStatus = res.status;
      }
    } catch (err) {
      body = { error: String(err.message ?? err) };
    }
    const ms = Date.now() - t0;

    const extraction = body.extraction
      ? `\nEXTRACTION status=${body.extraction.status}` +
        (body.extraction.gameId ? ` gameId=${body.extraction.gameId}` : '') +
        (body.extraction.reason ? ` reason=${body.extraction.reason}` : '') + '\n'
      : '';
    const citationTitles = Array.isArray(body.citations) && body.citations.length > 0
      ? `\nCITATIONS (${body.citations.length})\n${body.citations.map((c, j) => `  [${j + 1}] ${c.guide_title}`).join('\n')}\n`
      : '';
    const chunksSection = Array.isArray(body.citations) && body.citations.length > 0
      ? '\nCHUNKS\n' + body.citations.map((c, j) => {
          const text = c.content ?? c.excerpt ?? '';
          const length = text.length;
          const score = typeof c.score === 'number' ? c.score.toFixed(6) : String(c.score ?? '');
          const id = c.gamefaqs_id ?? c.chunk_id ?? '?';
          const lines = text.split('\n').map(l => `│ ${l}`).join('\n');
          return (
            `[${j + 1}] gamefaqs_id=${id} score=${score} length=${length}\n` +
            `source: ${c.guide_title}\n` +
            `text:\n` +
            `┌${'─'.repeat(40)}\n` +
            `${lines}\n` +
            `└${'─'.repeat(40)}`
          );
        }).join('\n') + '\n'
      : '';

    emit(`RESPONSE (${ms}ms)${extraction}${citationTitles}${chunksSection}\n`);

    if (body.answer !== undefined) {
      emit(`ANSWER\n${body.answer}\n\n`);
    } else if (body.error !== undefined) {
      emit(`ERROR\n${JSON.stringify(body, null, 2)}\n\n`);
    }

    if (DELAY_MS > 0 && i < QUESTIONS.length - 1) await sleep(DELAY_MS);
  }

  emit(`${'='.repeat(72)}\nDONE (${QUESTIONS.length} questions)\n`);
  if (fileStream) {
    await new Promise((res) => fileStream.end(res));
    process.stdout.write(`\nOutput written to ${OUTPUT_FILE}\n`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
