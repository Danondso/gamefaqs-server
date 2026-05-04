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
