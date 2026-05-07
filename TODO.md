# TODO

## Split admin panel out of `src/routes/admin.ts`

`src/routes/admin.ts` is ~1,950 LOC; ~1,300 of those are inline HTML/CSS/JS
strings for the admin panel (the panel `<script>` block alone is ~900 LOC of
JS in a TS string with no syntax highlighting, lint, or source maps).

Extract:

- `public/admin/index.html` (panel markup)
- `public/admin/panel.js`   (the SPA logic currently inlined as a string)
- `public/admin/panel.css`  (the two `<style>` blocks)

Serve via `express.static`. Keep the small login page inline (it gates on
`ADMIN_TOKEN_REQUIRED` and is small enough to stay readable). Pass any
templated values via `data-*` attrs or a tiny `/admin/config.json`.

Net branch LOC ≈ unchanged (content moves rather than shrinks). Win is
linting / formatting / IDE support / cacheability — defer to its own PR
so the diff stays reviewable.

## Harmonize cleanAuthor vs migration v5 SQL CASE

`tests/cleanAuthorParity.test.ts` documents four pre-existing divergences
between `cleanAuthor()` in `src/services/GuideImporter.ts` and the SQL CASE
in migration v5 (`TITLE_RELABEL_CASE_SQL` in `src/database/migrations.ts`).
The same author string can produce one title from the migration and another
from a fresh import — silent corruption that's hard to spot without a bench.

Divergent inputs (asserted in `DIVERGENT_CASES`):

| Author input | JS (`cleanAuthor`) | SQL CASE |
|---|---|---|
| `'CMaster ---'` | strips trailing dashes → accepts `'CMaster'` | keeps as-is |
| `'CMaster ==='` | strips trailing run → accepts `'CMaster'` | rejects (contains `=`) |
| `'name\nwith newline'` | collapses `\s+` to single space → accepts `'name with newline'` | rejects (instr char(10) ≠ 0) |
| `'A    B'` | collapses to `'A B'` | preserves `'A    B'` |

Decision needed: which side is canonical? Two options:

1. **Tighten JS to match SQL** (drop the `replace(/\s+/g, ' ')` and the
   trailing-separator strip; reject inputs SQL rejects). Conservative — the
   migration was written more recently and represents the more deliberate
   filter. Risk: live-import accepts strictly fewer authors, so titles for
   freshly-imported guides revert to bare game names where they used to
   include an author.
2. **Loosen SQL to match JS** (do the whitespace normalization + trailing
   strip in SQL using `REPLACE` / regex via a UDF). Risk: rewriting the
   migration after it's shipped is ugly; SQLite has no native regex.

Once a direction is picked, move the resolved cases from `DIVERGENT_CASES`
into `CASES` in the parity test.

## Known issues (RAG)

These are tracked-but-deferred quality issues from the post-chunker-rework
bench. None block correctness on the questions where they appear; they
degrade either prose quality or citation noise.

### Synthesis over-extracts enumerated content from chunks on high-level questions

Bench Q9 (SM64 "how do I get all 120 stars") returns a verbose answer that
lists dozens of individual stars by name when the right answer is the
high-level recipe ("collect across the 15 worlds, then visit the cannon in
the courtyard for Yoshi + 100 lives"). The synthesis is dumping chunk
content rather than extracting the key answer.

Future synthesis-prompt tuning should encourage summarization over
enumeration when the chunks contain long lists. Lower priority than
extraction correctness — the answer is correct, just too long.

### Retrieval does not filter chunks by language

Several games have mixed-language guides under one game ID (e.g. MGS has
English + Spanish; Zelda 1 has an Italian guide; SM64 has Italian and
Portuguese guides). For an English question, retrieval can surface
non-English chunks, which adds noise to the citation list even when
synthesis correctly ignores them.

A future enhancement could detect chunk language at index time (cheap
n-gram language ID is fine) and demote language-mismatched chunks at
retrieval time. Not breaking answers — just noisy in citations.

### Original / remaster game IDs are disambiguated when the user likely intends either

Some game-ID disambiguations distinguish between original and remaster
(Wind Waker / Wind Waker HD) where the user almost certainly wants
either. Technically correct — the IDs are distinct and have distinct
guides — but the prompt-the-user-to-pick interaction is unhelpful in
this shape.

Future work: detect the original/remaster relationship (probably via a
new `games.canonical_group_id` link or a title-similarity heuristic) and
collapse them into one logical game with an optional release-version
sub-filter at retrieval time.
