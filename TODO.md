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
