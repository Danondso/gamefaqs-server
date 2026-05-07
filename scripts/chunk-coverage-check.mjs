#!/usr/bin/env node
/**
 * Index coverage diagnostic: checks whether specific answer tokens are present
 * in the indexed chunks for a given game, and probes the BM25 rare-token filter
 * to understand why retrieval may be returning weak results.
 *
 * Usage (inside container or with DB_PATH set):
 *   DB_PATH=/data/db/gamefaqs.db node scripts/chunk-coverage-check.mjs
 *
 * Or from host:
 *   docker compose exec -T gamefaqs-server node /app/scripts/chunk-coverage-check.mjs
 */

import Database from 'better-sqlite3';

const DB_PATH = process.env.DB_PATH ?? '/data/db/gamefaqs.db';

let db;
try {
  db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
} catch (e) {
  console.error(`Failed to open DB at ${DB_PATH}: ${e.message}`);
  process.exit(1);
}

function q(sql, params = []) {
  return db.prepare(sql).all(...params);
}

function header(title) {
  console.log('\n' + '='.repeat(72));
  console.log(title);
  console.log('='.repeat(72));
}

function subheader(title) {
  console.log('\n--- ' + title + ' ---');
}

// ── Corpus stats ─────────────────────────────────────────────────────────────

header('CORPUS STATS');
const totalChunks = q(`SELECT COUNT(*) AS n FROM chunks`)[0].n;
const totalGuides = q(`SELECT COUNT(*) AS n FROM guides`)[0].n;
const totalGames  = q(`SELECT COUNT(*) AS n FROM games`)[0].n;
console.log(`chunks: ${totalChunks.toLocaleString()}, guides: ${totalGuides.toLocaleString()}, games: ${totalGames.toLocaleString()}`);

const CHUNK_RARE_DF_FRACTION = 0.05;
const CHUNK_RARE_DF_MIN = 5000;
const rareThreshold = Math.max(CHUNK_RARE_DF_MIN, Math.floor(totalChunks * CHUNK_RARE_DF_FRACTION));
console.log(`BM25 rare-token DF threshold: ${rareThreshold.toLocaleString()} (max(${CHUNK_RARE_DF_MIN},${CHUNK_RARE_DF_FRACTION}*${totalChunks.toLocaleString()}))`);

// ── Helper: find game by title pattern ───────────────────────────────────────

function findGame(titlePattern) {
  return q(`SELECT id, title FROM games WHERE title LIKE ? LIMIT 5`, [titlePattern]);
}

// ── Helper: df lookup ────────────────────────────────────────────────────────

function chunkDf(token) {
  const row = q(`SELECT doc FROM chunks_fts_vocab WHERE term = ?`, [token.toLowerCase()])[0];
  return row?.doc ?? 0;
}

function isRare(token) {
  return chunkDf(token) <= rareThreshold;
}

// ── Helper: search chunks by content keyword(s) for a game ───────────────────

function chunksForGame(gameId, keywords) {
  const gameGuides = q(
    `SELECT id FROM guides WHERE game_id = ?`, [gameId]
  ).map(r => r.id);
  if (gameGuides.length === 0) return [];

  const ph = gameGuides.map(() => '?').join(',');
  // Search chunk content for any keyword using LIKE
  const likeConditions = keywords.map(() => `c.content LIKE ?`).join(' OR ');
  const likeParams = keywords.map(k => `%${k}%`);

  return q(
    `SELECT c.id, c.chunk_index, g.title AS guide_title,
            substr(c.content, 1, 400) AS snippet
     FROM chunks c JOIN guides g ON g.id = c.guide_id
     WHERE c.guide_id IN (${ph})
       AND (${likeConditions})
     ORDER BY c.guide_id, c.chunk_index
     LIMIT 10`,
    [...gameGuides, ...likeParams]
  );
}

// ── Helper: token rarity report ──────────────────────────────────────────────

function tokenRarityReport(question, stopwords) {
  const cleaned = question.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  const tokens = cleaned.split(/\s+/).filter(t => t).map(t => t.toLowerCase())
    .filter(t => !stopwords.has(t));

  const BUDGET = 5;
  const dfs = tokens.map(t => ({ token: t, df: chunkDf(t), rare: isRare(t) }));
  dfs.sort((a, b) => a.df - b.df);

  const rare = dfs.filter(d => d.rare);
  const dropped = dfs.filter(d => !d.rare);
  const surviving = rare.slice(0, BUDGET);

  return { tokens, dfs, surviving, dropped };
}

const STOPWORDS = new Set([
  'a','an','the','is','are','was','were','be','been','being','am','i','you','he','she','it','we','they','me','him','her','us','them','my','your','his','its','our','their',
  'and','or','but','if','then','else','when','while','as','of','at','by','for','with','about','against','between','into','through','during','before','after','above','below','to','from','up','down','in','out','on','off','over','under','again','further',
  'do','does','did','doing','have','has','had','having','can','could','should','would','will','shall','may','might','must',
  'this','that','these','those','what','which','who','whom','whose','why','how',
  'not','no','nor','so','than','too','very','just','also','only','own','same','such','any','some','all','each','every','few','more','most','other','another',
]);

// ── Q15: Super Mario 64 — 120 stars ──────────────────────────────────────────

header('Q15: "How many stars are in Super Mario 64?" (expected answer: 120)');

const sm64Games = findGame('Super Mario 64%');
console.log('Games found:', sm64Games.map(g => `${g.id}: ${g.title}`));

for (const game of sm64Games) {
  const guideCount = q(`SELECT COUNT(*) AS n FROM guides WHERE game_id = ?`, [game.id])[0].n;
  const chunkCount = q(
    `SELECT COUNT(*) AS n FROM chunks c JOIN guides g ON g.id = c.guide_id WHERE g.game_id = ?`,
    [game.id]
  )[0].n;
  console.log(`  ${game.title}: ${guideCount} guides, ${chunkCount} chunks indexed`);
}

if (sm64Games.length > 0) {
  const mainGame = sm64Games[0];
  subheader('Chunks containing "120" + "star"');
  const starChunks = chunksForGame(mainGame.id, ['120']);
  if (starChunks.length === 0) {
    console.log('  ❌ NO CHUNKS FOUND — answer chunk is missing from index');
  } else {
    for (const c of starChunks.slice(0, 3)) {
      console.log(`  [${c.guide_title}] chunk ${c.chunk_index}:`);
      console.log(`    ${c.snippet.replace(/\s+/g, ' ').slice(0, 300)}`);
    }
  }

  subheader('Token rarity for Q15 question');
  const { dfs, surviving, dropped } = tokenRarityReport(
    'How many stars are in Super Mario 64?', STOPWORDS
  );
  console.log('  All tokens + DFs:');
  for (const d of dfs) console.log(`    "${d.token}": df=${d.df.toLocaleString()} ${d.rare ? '✓ rare' : '✗ DROPPED (common)'}`);
  console.log(`  Surviving tokens (sent to BM25): ${surviving.map(d => d.token).join(', ') || '(none)'}`);
  console.log(`  Dropped tokens: ${dropped.map(d => d.token).join(', ') || '(none)'}`);
}

// ── Q16: Diablo 2 — max level 99 ─────────────────────────────────────────────

header('Q16: "What is the max level in Diablo 2?" (expected answer: 99)');

const d2Games = findGame('Diablo II%');
console.log('Games found:', d2Games.map(g => `${g.id}: ${g.title}`));

if (d2Games.length > 0) {
  const mainGame = d2Games[0];
  const guideCount = q(`SELECT COUNT(*) AS n FROM guides WHERE game_id = ?`, [mainGame.id])[0].n;
  const chunkCount = q(
    `SELECT COUNT(*) AS n FROM chunks c JOIN guides g ON g.id = c.guide_id WHERE g.game_id = ?`,
    [mainGame.id]
  )[0].n;
  console.log(`  ${mainGame.title}: ${guideCount} guides, ${chunkCount} chunks indexed`);

  subheader('Chunks containing "level 99" or "max level" or "level cap"');
  const lvlChunks = chunksForGame(mainGame.id, ['level 99', 'max level', 'level cap', '99']);
  if (lvlChunks.length === 0) {
    console.log('  ❌ NO CHUNKS FOUND — answer chunk is missing from index');
  } else {
    for (const c of lvlChunks.slice(0, 3)) {
      console.log(`  [${c.guide_title}] chunk ${c.chunk_index}:`);
      console.log(`    ${c.snippet.replace(/\s+/g, ' ').slice(0, 300)}`);
    }
  }

  subheader('Token rarity for Q16 question');
  const { dfs, surviving, dropped } = tokenRarityReport(
    'What is the max level in Diablo 2?', STOPWORDS
  );
  console.log('  All tokens + DFs:');
  for (const d of dfs) console.log(`    "${d.token}": df=${d.df.toLocaleString()} ${d.rare ? '✓ rare' : '✗ DROPPED (common)'}`);
  console.log(`  Surviving tokens (sent to BM25): ${surviving.map(d => d.token).join(', ') || '(none)'}`);
  console.log(`  Dropped tokens: ${dropped.map(d => d.token).join(', ') || '(none)'}`);
}

// ── Additional failing queries ────────────────────────────────────────────────

const additionalChecks = [
  {
    label: 'Q3: "How do I get the Master Sword in Ocarina of Time?"',
    question: 'How do I get the Master Sword in Ocarina of Time?',
    gameTitlePattern: 'Ocarina of Time%',
    keywords: ['master sword', 'temple of time', 'sacred'],
  },
  {
    label: 'Q8: "How do I beat Kefka in Final Fantasy VI?"',
    question: 'How do I beat Kefka in Final Fantasy VI?',
    gameTitlePattern: 'Final Fantasy VI%',
    keywords: ['kefka', 'Kefka'],
  },
  {
    label: 'Q11: "Who\'s the first enemy I fight in Final Fantasy X?"',
    question: "Who's the first enemy I fight in Final Fantasy X?",
    gameTitlePattern: 'Final Fantasy X%',
    keywords: ['sin', 'klikk', 'geosgaeno', 'sinscale', 'first'],
  },
  {
    label: 'Q20: "What\'s Aerith\'s last name?"',
    question: "What's Aerith's last name?",
    gameTitlePattern: 'Final Fantasy VII%',
    keywords: ['gainsborough', 'aerith', 'aeris'],
  },
  {
    label: 'Q31: "Where\'s the Triforce in Ocarina of Time?" (trick — should refuse)',
    question: "Where's the Triforce in Ocarina of Time?",
    gameTitlePattern: 'Ocarina of Time%',
    keywords: ['triforce', 'pedestal'],
  },
];

for (const check of additionalChecks) {
  header(check.label);

  const games = findGame(check.gameTitlePattern);
  if (games.length === 0) {
    console.log(`  ❌ No game found for pattern: ${check.gameTitlePattern}`);
    continue;
  }

  const mainGame = games[0];
  console.log(`  Game: ${mainGame.title} (${mainGame.id})`);
  const guideCount = q(`SELECT COUNT(*) AS n FROM guides WHERE game_id = ?`, [mainGame.id])[0].n;
  const chunkCount = q(
    `SELECT COUNT(*) AS n FROM chunks c JOIN guides g ON g.id = c.guide_id WHERE g.game_id = ?`,
    [mainGame.id]
  )[0].n;
  console.log(`  Guides: ${guideCount}, chunks: ${chunkCount}`);

  subheader(`Chunks containing keywords: ${JSON.stringify(check.keywords)}`);
  const found = chunksForGame(mainGame.id, check.keywords);
  if (found.length === 0) {
    console.log('  ❌ NO CHUNKS FOUND — answer chunk missing from index');
  } else {
    console.log(`  ✓ ${found.length} chunk(s) found`);
    for (const c of found.slice(0, 2)) {
      console.log(`  [${c.guide_title}] chunk ${c.chunk_index}:`);
      console.log(`    ${c.snippet.replace(/\s+/g, ' ').slice(0, 300)}`);
    }
  }

  subheader('Token rarity');
  const { dfs, surviving, dropped } = tokenRarityReport(check.question, STOPWORDS);
  console.log('  All tokens + DFs:');
  for (const d of dfs) console.log(`    "${d.token}": df=${d.df.toLocaleString()} ${d.rare ? '✓ rare' : '✗ DROPPED'}`);
  console.log(`  Surviving tokens: ${surviving.map(d => d.token).join(', ') || '(NONE — BM25 query empty!)'}`);
}

console.log('\n' + '='.repeat(72));
console.log('DONE');
db.close();
