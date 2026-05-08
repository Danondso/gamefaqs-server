// Seeds canonical_game_groups, game_aliases, and game_entities from the
// imported `games` table. Runs post-import (from InitService) and as a boot
// safety-net (from server.ts) — NOT as a migration. Migrations run before
// the archive import populates `games`, so any seeding done at migration
// time would always insert zero rows.
//
// Idempotent: every INSERT uses OR IGNORE; the canonical_group_id UPDATE
// is gated on `IS NULL`. Re-running on a fully-seeded DB is a fast no-op.
//
// Migration history note: this code is the surviving end-state of what was
// migrations v8 (alias seed), v9 (entity seed), and v10 (entity-confidence
// recompute). The v9 regex bug — `/final fantasy vii/i` falsely matching
// "Final Fantasy VIII" because "vii" is a substring of "viii" — is fixed
// at the source here by anchoring with `\bvii\b`, so v10's cleanup
// (DELETE then UPDATE-confidence-from-FTS-share) is collapsed into a
// single forward seed pass.

import type Database from 'better-sqlite3';

export interface SeedCounts {
  canonicalGroups: number;
  aliasesInserted: number;
  entitiesInserted: number;
  entityConfidenceUpdated: number;
}

type EntitySpec = [entity: string, type: string, isUnique: 0 | 1, confidence: number];

interface FranchiseSeed {
  include: RegExp;
  exclude?: RegExp;
  entities: EntitySpec[];
}

// Curated character / location / mechanic → game mappings for the major
// franchises in the bench corpus. Same lists that lived in migration v9,
// with the regexes hardened (word-boundary anchors) so substring overlaps
// like VII/VIII can't bleed across installments.
const FRANCHISE_SEEDS: FranchiseSeed[] = [
  {
    // FF7 — exclude spinoffs/remakes/compilations whose mechanics differ
    // OR which would split the canonical-group count over the entity
    // over-seeded guard in GameExtractionService.matchEntity. After the
    // FTS recompute zeroes confidence on any of these the matchEntity
    // filter drops them anyway, but tighter includes keep raw row counts
    // small.
    include: /\bfinal fantasy vii\b/i,
    exclude: /crisis core|advent children|dirge of cerberus|remake|rebirth|intergrade|before crisis|snowboarding|double pack|compilation/i,
    entities: [
      ['cloud',         'character', 1, 0.92],
      ['sephiroth',     'character', 1, 0.97],
      ['tifa',          'character', 1, 0.95],
      ['aerith',        'character', 1, 0.95],
      ['aeris',         'character', 1, 0.92],
      ['barret',        'character', 1, 0.90],
      ['yuffie',        'character', 1, 0.95],
      ['vincent',       'character', 1, 0.88],
      ['cait sith',     'character', 1, 0.97],
      ['red xiii',      'character', 1, 0.97],
      ['nanaki',        'character', 1, 0.97],
      ['jenova',        'character', 1, 0.97],
      ['zack',          'character', 1, 0.85],
      ['rufus',         'character', 1, 0.82],
      ['midgar',        'location',  1, 0.97],
      ['nibelheim',     'location',  1, 0.99],
      ['sector 7',      'location',  1, 0.97],
      ['cosmo canyon',  'location',  1, 0.97],
      ['gold saucer',   'location',  1, 0.95],
      ['junon',         'location',  1, 0.88],
      ['mideel',        'location',  1, 0.97],
      ['rocket town',   'location',  1, 0.97],
      ['northern crater','location', 1, 0.97],
      ['wutai',         'location',  1, 0.92],
      ['shinra',        'lore',      1, 0.90],
      ['materia',       'mechanic',  1, 0.92],
      ['w-item',        'mechanic',  1, 0.99],
      ['w-magic',       'mechanic',  1, 0.99],
      ['w-summon',      'mechanic',  1, 0.99],
      ['buster sword',  'item',      1, 0.92],
      ['lifestream',    'lore',      1, 0.97],
    ],
  },
  {
    include: /\bfinal fantasy viii\b/i,
    exclude: /remake|remaster/i,
    entities: [
      ['squall',           'character', 1, 0.95],
      ['rinoa',            'character', 1, 0.97],
      ['quistis',          'character', 1, 0.99],
      ['zell',             'character', 1, 0.97],
      ['selphie',          'character', 1, 0.97],
      ['irvine',           'character', 1, 0.95],
      ['seifer',           'character', 1, 0.95],
      ['edea',             'character', 1, 0.95],
      ['ultimecia',        'character', 1, 0.99],
      ['laguna',           'character', 1, 0.97],
      ['junctioning',      'mechanic',  1, 0.99],
      ['junction',         'mechanic',  1, 0.90],
      ['sorceress',        'lore',      1, 0.85],
      ['balamb garden',    'location',  1, 0.99],
      ['galbadia',         'location',  1, 0.95],
      ['time compression', 'mechanic',  1, 0.97],
      ['dollet',           'location',  1, 0.95],
    ],
  },
  {
    include: /\bfinal fantasy vi\b/i,
    exclude: /advance|pixel/i,
    entities: [
      ['kefka',       'character', 1, 0.99],
      ['terra',       'character', 1, 0.95],
      ['celes',       'character', 1, 0.95],
      ['locke',       'character', 1, 0.92],
      ['edgar',       'character', 1, 0.92],
      ['sabin',       'character', 1, 0.97],
      ['cyan',        'character', 1, 0.92],
      ['gau',         'character', 1, 0.97],
      ['setzer',      'character', 1, 0.97],
      ['strago',      'character', 1, 0.97],
      ['relm',        'character', 1, 0.97],
      ['umaro',       'character', 1, 0.97],
      ['espers',      'mechanic',  1, 0.88],
      ['magitek',     'lore',      1, 0.97],
      ['narshe',      'location',  1, 0.99],
      ['figaro',      'location',  1, 0.97],
      ['thamasa',     'location',  1, 0.99],
      ['opera house', 'location',  1, 0.92],
    ],
  },
  {
    // FFX — word-boundary `\bx\b` excludes XI/XII/XIII/X-2 cleanly.
    include: /\bfinal fantasy x\b/i,
    exclude: /x-?2/i,
    entities: [
      ['tidus',       'character', 1, 0.99],
      ['yuna',        'character', 1, 0.92],
      ['auron',       'character', 1, 0.99],
      ['lulu',        'character', 1, 0.92],
      ['wakka',       'character', 1, 0.99],
      ['kimahri',     'character', 1, 0.99],
      ['rikku',       'character', 1, 0.90],
      ['jecht',       'character', 1, 0.99],
      ['zanarkand',   'location',  1, 0.99],
      ['spira',       'location',  1, 0.99],
      ['besaid',      'location',  1, 0.99],
      ['kilika',      'location',  1, 0.97],
      ['sphere grid', 'mechanic',  1, 0.99],
      ['blitzball',   'mechanic',  1, 0.99],
    ],
  },
  {
    include: /chrono trigger/i,
    entities: [
      ['crono',       'character', 1, 0.99],
      ['marle',       'character', 1, 0.99],
      ['lucca',       'character', 1, 0.95],
      ['frog',        'character', 1, 0.88],
      ['robo',        'character', 1, 0.92],
      ['ayla',        'character', 1, 0.97],
      ['magus',       'character', 1, 0.97],
      ['schala',      'character', 1, 0.99],
      ['lavos',       'character', 1, 0.99],
      ['dalton',      'character', 1, 0.97],
      ['zeal',        'location',  1, 0.95],
      ['guardia',     'location',  1, 0.92],
      ['black omen',  'location',  1, 0.99],
      ['epoch',       'item',      1, 0.99],
      ['dual tech',   'mechanic',  1, 0.97],
      ['triple tech', 'mechanic',  1, 0.97],
    ],
  },
  {
    include: /kingdom hearts/i,
    exclude: /chain of memories|358|dream drop|birth by sleep|coded|re:/i,
    entities: [
      ['sora',             'character', 1, 0.92],
      ['riku',             'character', 1, 0.92],
      ['kairi',            'character', 1, 0.92],
      ['xemnas',           'character', 1, 0.95],
      ['axel',             'character', 1, 0.90],
      ['roxas',            'character', 1, 0.90],
      ['namine',           'character', 1, 0.90],
      ['organization xiii','lore',      1, 0.97],
      ['keyblade',         'item',      1, 0.88],
      ['traverse town',    'location',  1, 0.95],
      ['hollow bastion',   'location',  1, 0.95],
      ['destiny islands',  'location',  1, 0.95],
    ],
  },
  {
    // Original Portal — exclude Portal 2 and spinoffs.
    include: /\bportal\b/i,
    exclude: /portal 2|stories|mel|still alive|portal runner/i,
    entities: [
      ['glados',            'character', 1, 0.99],
      ['chell',             'character', 1, 0.97],
      ['companion cube',    'item',      1, 0.99],
      ['portal gun',        'item',      1, 0.90],
      ['aperture science',  'lore',      1, 0.99],
      ['aperture',          'lore',      1, 0.90],
      ['neurotoxin',        'mechanic',  1, 0.97],
    ],
  },
  {
    include: /metal gear solid 2|metal gear solid two/i,
    exclude: /legacy|substance/i,
    entities: [
      ['raiden',       'character', 1, 0.97],
      ['solidus',      'character', 1, 0.97],
      ['vamp',         'character', 1, 0.92],
      ['fortune',      'character', 1, 0.90],
      ['arsenal gear', 'location',  1, 0.99],
      ['emma',         'character', 1, 0.80],
    ],
  },
  {
    // MGS1 — Solid Snake's home franchise. Narrow to the EXACT base title
    // (no Integral, no Twin Snakes, no compilations) so that "solid snake"
    // and other lore entities resolve to a single canonical_group_id.
    // Without this, matchEntity returns ambiguous over MGS / MGS Integral /
    // Twin Snakes — they're the same story but sit in distinct canonical
    // groups under the normalized-title bucketing scheme. Twin Snakes
    // questions still resolve via the games_fts_title path because the
    // full phrase "metal gear solid the twin snakes" is in the question.
    include: /^metal gear solid$/i,
    entities: [
      ['solid snake',  'character', 1, 0.95],
      ['big boss',     'character', 1, 0.92],
      ['naked snake',  'character', 1, 0.92],
      ['otacon',       'character', 1, 0.97],
      ['hal emmerich', 'character', 1, 0.97],
      ['liquid snake', 'character', 1, 0.97],
      ['meryl',        'character', 1, 0.85],
      ['psycho mantis','character', 1, 0.99],
      ['revolver ocelot','character',1, 0.95],
      ['shadow moses', 'location',  1, 0.99],
      ['foxdie',       'mechanic',  1, 0.99],
      ['codec',        'mechanic',  1, 0.85],
    ],
  },
  {
    include: /symphony of the night/i,
    entities: [
      ['alucard',         'character', 1, 0.95],
      ['richter',         'character', 1, 0.85],
      ['shaft',           'character', 1, 0.90],
      ['inverted castle', 'location',  1, 0.99],
      ['soul of bat',     'item',      1, 0.99],
      ['luck mode',       'mechanic',  1, 0.97],
      ['holy glasses',    'item',      1, 0.97],
    ],
  },
  {
    include: /\bdiablo ii\b|\bdiablo 2\b/i,
    entities: [
      ['mephisto',       'character', 1, 0.92],
      ['baal',           'character', 1, 0.90],
      ['andariel',       'character', 1, 0.97],
      ['duriel',         'character', 1, 0.97],
      ['stone of jordan','item',      1, 0.95],
      ['horadric cube',  'item',      1, 0.95],
      ['cow level',      'location',  1, 0.97],
    ],
  },
  {
    include: /grand theft auto.*san andreas|gta.*san andreas/i,
    entities: [
      ['cj',           'character', 1, 0.92],
      ['big smoke',    'character', 1, 0.97],
      ['ryder',        'character', 1, 0.88],
      ['grove street', 'location',  1, 0.97],
      ['san fierro',   'location',  1, 0.97],
      ['las venturas', 'location',  1, 0.97],
    ],
  },
  {
    include: /ocarina of time/i,
    entities: [
      ['navi',          'character', 1, 0.90],
      ['lon lon ranch', 'location',  1, 0.95],
      ['kokiri forest', 'location',  1, 0.92],
      ['zoras domain',  'location',  1, 0.90],
      // Lake Hylia appears across multiple Zelda titles.
      ['lake hylia',    'location',  0, 0.70],
      ['shadow temple', 'location',  1, 0.88],
      ['gerudo valley', 'location',  1, 0.92],
    ],
  },
];

/**
 * Whether the seed step needs to run. Returns true when `games` is populated
 * but `game_aliases` is empty (post-import or after a migration re-stamp).
 * Server boot calls `seedAll` only when this is true.
 */
export function needsSeed(db: Database.Database): boolean {
  const gameCount = (db.prepare('SELECT COUNT(*) c FROM games').get() as { c: number }).c;
  if (gameCount === 0) return false;
  const aliasCount = (db.prepare('SELECT COUNT(*) c FROM game_aliases').get() as { c: number }).c;
  return aliasCount === 0;
}

/**
 * Seed canonical_game_groups + games.canonical_group_id.
 * Idempotent via INSERT OR IGNORE on the groups, and `WHERE canonical_group_id IS NULL`
 * on the games update.
 */
function seedCanonicalGroups(db: Database.Database): number {
  const ts = Date.now();
  const before = (db.prepare('SELECT COUNT(*) c FROM canonical_game_groups').get() as { c: number }).c;

  // Normalized title bucket: lowercase, trim, strip ":-" punctuation and
  // common edition suffixes ("hd", "remaster"). Matches the old v8 logic.
  db.prepare(`
    INSERT OR IGNORE INTO canonical_game_groups (id, normalized_title, display_title, created_at, updated_at)
    SELECT
      lower(trim(replace(replace(replace(replace(replace(title, ':', ' '), '-', ' '), 'hd', ''), 'remaster', ''), 'remastered', ''))) AS id,
      lower(trim(replace(replace(replace(replace(replace(title, ':', ' '), '-', ' '), 'hd', ''), 'remaster', ''), 'remastered', ''))) AS normalized_title,
      title AS display_title,
      ?,
      ?
    FROM games
    WHERE trim(title) != ''
  `).run(ts, ts);

  db.prepare(`
    UPDATE games
    SET canonical_group_id = lower(trim(replace(replace(replace(replace(replace(title, ':', ' '), '-', ' '), 'hd', ''), 'remaster', ''), 'remastered', '')))
    WHERE canonical_group_id IS NULL
      AND trim(title) != ''
  `).run();

  const after = (db.prepare('SELECT COUNT(*) c FROM canonical_game_groups').get() as { c: number }).c;
  return after - before;
}

/**
 * Seed game_aliases from `games.title` in three forms:
 *   - lowercase title (1.0 confidence)
 *   - lowercase compact (no spaces) (0.9)
 *   - simple roman→arabic VII/VI substitution for series titles (0.8)
 */
function seedAliases(db: Database.Database): number {
  const ts = Date.now();
  const before = (db.prepare('SELECT COUNT(*) c FROM game_aliases').get() as { c: number }).c;

  db.prepare(`
    INSERT OR IGNORE INTO game_aliases (alias, game_id, alias_type, confidence, created_at, updated_at)
    SELECT lower(title), id, 'title', 1.0, ?, ?
    FROM games
    WHERE trim(title) != ''
  `).run(ts, ts);

  db.prepare(`
    INSERT OR IGNORE INTO game_aliases (alias, game_id, alias_type, confidence, created_at, updated_at)
    SELECT lower(replace(title, ' ', '')), id, 'title_compact', 0.9, ?, ?
    FROM games
    WHERE trim(title) != ''
  `).run(ts, ts);

  db.prepare(`
    INSERT OR IGNORE INTO game_aliases (alias, game_id, alias_type, confidence, created_at, updated_at)
    SELECT lower(replace(replace(title, ' vii', ' 7'), ' vi', ' 6')), id, 'roman_arabic', 0.8, ?, ?
    FROM games
    WHERE title LIKE '% VI%' OR title LIKE '% VII%'
  `).run(ts, ts);

  const after = (db.prepare('SELECT COUNT(*) c FROM game_aliases').get() as { c: number }).c;
  return after - before;
}

/**
 * Seed game_entities by matching each FRANCHISE_SEEDS entry's `include`/`exclude`
 * regexes against `games.title`, then inserting one row per (entity, game_id)
 * pair. Idempotent via INSERT OR IGNORE.
 */
function seedEntities(db: Database.Database): number {
  const ts = Date.now();
  const before = (db.prepare('SELECT COUNT(*) c FROM game_entities').get() as { c: number }).c;

  const allGames = db.prepare(`SELECT id, title FROM games`).all() as { id: string; title: string }[];

  const insert = db.prepare(
    `INSERT OR IGNORE INTO game_entities
       (entity, game_id, is_unique, entity_type, confidence, created_at, updated_at)
     VALUES (lower(?), ?, ?, ?, ?, ?, ?)`
  );

  const txn = db.transaction(() => {
    for (const seed of FRANCHISE_SEEDS) {
      const matchedIds = allGames
        .filter(r => seed.include.test(r.title) && (!seed.exclude || !seed.exclude.test(r.title)))
        .map(r => r.id);
      if (matchedIds.length === 0) continue;
      for (const id of matchedIds) {
        for (const [entity, type, isUnique, conf] of seed.entities) {
          insert.run(entity, id, isUnique, type, conf, ts, ts);
        }
      }
    }
  });
  txn();

  const after = (db.prepare('SELECT COUNT(*) c FROM game_entities').get() as { c: number }).c;
  return after - before;
}

/**
 * Recompute entity confidence as chunk-frequency share. Replaces v10's pass.
 *
 * For each distinct entity name, count how many indexed chunks per game match
 * the entity (FTS phrase for multi-word, single-token otherwise). Confidence
 * becomes `cnt / total` capped at 0.99. Games linked to the entity but with
 * zero FTS hits get zeroed — their seeded confidence would otherwise dominate
 * the gap filter in GameExtractionService against properly-indexed games.
 *
 * If the corpus has no indexed chunks yet (fresh install pre-indexing), this
 * is a no-op and the seeded confidences stand. Once indexing populates
 * chunks_fts, the next boot's seedAll re-runs this pass and tightens the
 * scores to actual evidence.
 */
function recomputeEntityConfidence(db: Database.Database): number {
  const ts = Date.now();

  // Skip the pass entirely on empty FTS corpora (fresh install).
  const ftsRows = (db.prepare('SELECT COUNT(*) c FROM chunks_fts').get() as { c: number }).c;
  if (ftsRows === 0) return 0;

  const chunkCountQuery = db.prepare(`
    SELECT g.game_id, COUNT(*) AS cnt
    FROM chunks_fts cf
    JOIN chunks c ON c.rowid = cf.rowid
    JOIN guides g ON g.id = c.guide_id
    WHERE cf.content MATCH ?
      AND g.game_id IS NOT NULL
    GROUP BY g.game_id
  `);
  const updateConf = db.prepare(
    `UPDATE game_entities SET confidence = ?, updated_at = ?
     WHERE entity = ? AND game_id = ?`
  );
  const zeroConf = db.prepare(
    `UPDATE game_entities SET confidence = 0, updated_at = ?
     WHERE entity = ? AND game_id = ?`
  );
  const entityGameIds = db.prepare(
    `SELECT game_id FROM game_entities WHERE entity = ?`
  );
  const entities = (db.prepare(
    `SELECT DISTINCT entity FROM game_entities`
  ).all() as { entity: string }[]).map(r => r.entity);

  let touched = 0;
  const txn = db.transaction(() => {
    for (const entity of entities) {
      const matchTerm = entity.includes(' ') ? `"${entity}"` : entity;
      let rows: { game_id: string; cnt: number }[];
      try {
        rows = chunkCountQuery.all(matchTerm) as { game_id: string; cnt: number }[];
      } catch {
        // FTS syntax error (rare — entity contains special chars). Leave as-is.
        continue;
      }
      if (rows.length === 0) continue;
      const total = rows.reduce((s, r) => s + r.cnt, 0);
      if (total === 0) continue;

      const hitGameIds = new Set(rows.map(r => r.game_id));
      for (const { game_id, cnt } of rows) {
        updateConf.run(Math.min(0.99, cnt / total), ts, entity, game_id);
        touched++;
      }
      for (const { game_id } of entityGameIds.all(entity) as { game_id: string }[]) {
        if (!hitGameIds.has(game_id)) {
          zeroConf.run(ts, entity, game_id);
          touched++;
        }
      }
    }
  });
  txn();
  return touched;
}

/**
 * Run the full post-import seed pipeline. Safe to call repeatedly — every
 * step is idempotent. Logs counts (canonical groups added, aliases inserted,
 * entities inserted, confidence rows updated) so re-runs print all zeros.
 */
export function seedAll(db: Database.Database): SeedCounts {
  const startedAt = Date.now();
  console.log('[EntitySeed] starting seed pass...');

  const counts: SeedCounts = {
    canonicalGroups: seedCanonicalGroups(db),
    aliasesInserted: seedAliases(db),
    entitiesInserted: seedEntities(db),
    entityConfidenceUpdated: recomputeEntityConfidence(db),
  };

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[EntitySeed] done in ${elapsedMs}ms — `
    + `canonical_groups=+${counts.canonicalGroups}, `
    + `aliases=+${counts.aliasesInserted}, `
    + `entities=+${counts.entitiesInserted}, `
    + `confidence_updated=${counts.entityConfidenceUpdated}`
  );
  return counts;
}
