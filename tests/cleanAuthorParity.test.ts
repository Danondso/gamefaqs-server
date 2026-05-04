import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { TITLE_RELABEL_CASE_SQL } from '../src/database/migrations';
import { cleanAuthor, composeGuideTitle } from '../src/services/GuideImporter';

// Parity test for the migration v5 title-relabel CASE.
//
// The migration evaluates a SQL CASE on `metadata.author` to decide whether to
// append " — <author>" to the game title. The same decision is made in JS by
// cleanAuthor() / composeGuideTitle() during live ingest. If the two ever
// disagree, the migration relabels existing rows differently from how new
// rows get labeled — silent corruption that's hard to spot without running the
// bench.
//
// This test runs both implementations against a parameter table of author
// strings and asserts they pick the same final title.

interface Case {
  label: string;
  author: string | null | undefined;
}

const CASES: Case[] = [
  // --- happy path: clean authors ---
  { label: 'plain name', author: 'CMaster' },
  { label: 'two-word name', author: 'A Backdated Future' },
  { label: 'name with hyphen', author: 'Mark Smith-Jones' },
  { label: 'minimum 2-char author', author: 'AB' },

  // --- length boundaries ---
  { label: 'single-char author (rejected)', author: 'A' },
  { label: 'exactly 60 chars', author: 'a'.repeat(60) },
  { label: '61 chars (rejected)', author: 'a'.repeat(61) },

  // --- forbidden chars ---
  { label: 'contains pipe', author: 'foo | bar' },
  { label: 'contains equals', author: 'name=value' },
  { label: 'contains gt', author: 'banner >>>' },

  // --- whitespace handling ---
  { label: 'trims leading/trailing spaces', author: '  CMaster  ' },

  // --- space count limit (≤ 5 spaces ≈ ≤ 6 words) ---
  { label: 'exactly 5 spaces', author: 'one two three four five six' },
  { label: '6 spaces (sentence — rejected)', author: 'one two three four five six seven' },

  // --- empty / null ---
  { label: 'empty string', author: '' },
  { label: 'whitespace only', author: '   ' },
  { label: 'null', author: null },
  { label: 'undefined', author: undefined },

  // --- trailing-junk stripping (JS-only behavior; SQL keeps the string) ---
  // These cases probe a known divergence: JS strips trailing separator runs
  // before its length/space checks, SQL only TRIMs whitespace. We expect
  // disagreement on inputs where stripping decides eligibility, so they
  // appear in DIVERGENT_CASES below instead of CASES.
];

// Documented pre-existing divergences. JS does whitespace normalization +
// trailing-separator stripping; SQL only TRIMs leading/trailing whitespace
// and explicitly rejects internal newlines via instr(..., char(10)). The
// asymmetry produces silent title-corruption risks where a guide imported
// fresh gets one title and the same guide labeled by the migration gets
// another. Captured here as a known issue rather than silently fixed —
// harmonizing requires a product decision (loosen SQL? tighten JS?).
//
// These are asserted to diverge so a future code change is forced to consider
// them: if SQL ever adds cleanup or JS ever rejects newlines, this test will
// flip and the divergence record needs updating.
const DIVERGENT_CASES: Case[] = [
  { label: 'trailing dashes (JS strips, SQL keeps)', author: 'CMaster ---' },
  { label: 'trailing equals run (JS strips, SQL rejects on `=`)', author: 'CMaster ===' },
  { label: 'internal newline (JS collapses, SQL rejects)', author: 'name\nwith newline' },
  { label: 'multi-space internal whitespace (JS collapses, SQL keeps)', author: 'A    B' },
];

const GAME_TITLE = 'Final Fantasy VII';
const FALLBACK_TITLE = 'PARSED_FALLBACK_TITLE';

describe('cleanAuthor / SQL CASE parity (migration v5 title relabel)', () => {
  let db: Database.Database;
  let evalSqlCase: (author: string | null | undefined) => string;

  beforeAll(() => {
    db = new Database(':memory:');
    // Evaluate the CASE expression against synthetic g.metadata + gm.title rows.
    // The CTE form lets us reuse the exact CASE string from the migration
    // without seeding any actual guides/games tables (those are migrated under
    // the hood and would re-run the relabel SQL on their own data).
    const stmt = db.prepare(`
      WITH g(metadata) AS (VALUES (?)),
           gm(title)   AS (VALUES (?))
      SELECT ${TITLE_RELABEL_CASE_SQL} AS relabeled
      FROM g, gm
    `);
    evalSqlCase = (author) => {
      const metaJson = author === undefined
        ? null
        : JSON.stringify({ author });
      const row = stmt.get(metaJson, GAME_TITLE) as { relabeled: string };
      return row.relabeled;
    };
  });

  afterAll(() => {
    db.close();
  });

  it.each(CASES)('agrees on: $label', ({ author }) => {
    const sqlResult = evalSqlCase(author);
    const jsResult = composeGuideTitle(GAME_TITLE, FALLBACK_TITLE, author ?? undefined);

    // composeGuideTitle returns the bare game title when the author is
    // rejected, OR `${game} — ${cleanedAuthor}` when accepted. The SQL CASE
    // does the same; comparing relabel results catches both decision drift
    // (accept vs reject) and formatting drift (separator, whitespace).
    expect(jsResult).toBe(sqlResult);
  });

  // Sanity check: the documented divergent cases really do diverge. If a
  // future SQL change accidentally adds the trailing-separator cleanup, this
  // test starts passing and is what tells you to either move the case to
  // CASES (and update the JS to match if needed) or update the divergence
  // documentation.
  it.each(DIVERGENT_CASES)('diverges as documented on: $label', ({ author }) => {
    const sqlResult = evalSqlCase(author);
    const jsResult = composeGuideTitle(GAME_TITLE, FALLBACK_TITLE, author ?? undefined);
    expect(jsResult).not.toBe(sqlResult);
  });

  it('cleanAuthor and composeGuideTitle agree on rejection', () => {
    // composeGuideTitle returns the game name unchanged when cleanAuthor
    // returns null. Light internal-consistency guard.
    for (const c of CASES) {
      const cleaned = cleanAuthor(c.author ?? undefined);
      const composed = composeGuideTitle(GAME_TITLE, FALLBACK_TITLE, c.author ?? undefined);
      if (cleaned === null) {
        expect(composed).toBe(GAME_TITLE);
      } else {
        expect(composed).toBe(`${GAME_TITLE} — ${cleaned}`);
      }
    }
  });
});
