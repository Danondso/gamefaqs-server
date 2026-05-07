# Chunker rework: validation plan

**Phases 4 and 5 of the chunker rework.** Phase 3 (the implementation) shipped
`chunkGuideV2`, schema v11 (`chunks.content_type`, `chunks.section_heading`),
and the `CHUNKER_VERSION` env-var dispatch in `IndexingService`. Nothing
downstream consumes the new tags yet — retrieval scoring is unchanged. What
the next two phases do is *measure whether cleaner chunk boundaries alone
move the bench*, and decide whether to flip the default.

## 0. Pre-conditions

Before starting Phase 4:

- [ ] `SCHEMA_VERSION === 11` and migration v11 has run (`schema_version`
      table contains row 11).
- [ ] All chunker unit tests pass: `npx vitest run tests/Chunker.test.ts
      tests/ChunkerV2.test.ts`.
- [ ] A clean baseline bench exists at
      `tests/benchmarks/baselines/rag-accuracy.json`. If the baseline is
      stale (older corpus, older retrieval logic), capture a fresh one
      under `CHUNKER_VERSION=v1` *first* — Phase 5's compare needs an
      apples-to-apples reference.
- [ ] Back up `${DB_PATH}` and `${DB_PATH}.ann` before re-indexing.
      v11 is reversible, but the ANN file isn't — re-embedding the full
      corpus takes hours of Ollama time, so the backup is what makes a
      bad cutover cheap to undo.

## Phase 4 — small-corpus eyeball

**Goal:** confirm the new chunker's output looks correct on the ~10 guides
that drove the failing bench queries, *before* paying for a full re-index.
Spend an afternoon, not a week.

### 4.1 Re-index a small slice under v2

Pick a guide subset that exercises every content shape from
`CHUNKER_INVESTIGATION.md` §2:

- Final Fantasy VII — DynamixDJ (B2 pipe-grids + A2 bordered prose; Q1)
- Chrono Trigger — KoritheMan (B1 boxed stat blocks + A1 prose; Q7)
- Chrono Trigger — AdrenalineSL (B3 list-of-entries; Q7)
- Resident Evil 4 — Lord_Pignea (C1 TOC + C2 changelog; Q5)
- Resident Evil 4 — Joe Zakutny (C1 dot-leader TOC; Q5)
- Resident Evil 4 — Adnan Javed (A1 plain prose, control case; Q14)
- Pokemon Red — Mike Meevasin (D banners; Q4)
- Final Fantasy VII — main FAQ (Q22 W-Item Q&A)

Force-re-index just those guides under v2:

```bash
# Wipe their existing chunks + ANN entries so v2 emits fresh ones.
# Use the admin re-index endpoint with a guide-id list, or run the
# indexer with `force=true` and a limit covering the slice.
CHUNKER_VERSION=v2 npm run dev
# Then in another shell, hit the admin endpoint to re-index the slice
# (or just delete those guides' indexed_at and let the loop pick them up).
```

Confirm v2 actually ran by tailing the indexer log — the loop prints
`[Indexing] using chunker v2 (type-aware)` once at start.

### 4.2 SQL spot-checks

After the slice indexes, inspect with:

```sql
-- Distribution: what fraction of new chunks landed in each type?
SELECT content_type, COUNT(*)
FROM chunks
WHERE guide_id IN ('<slice-guide-ids>')
GROUP BY content_type;

-- Headers actually attached to something:
SELECT chunk_index, content_type, section_heading, substr(content, 1, 80)
FROM chunks
WHERE guide_id = '<one-guide-id>'
  AND section_heading IS NOT NULL
ORDER BY chunk_index
LIMIT 20;

-- Spot the load-bearing chunks from the failing queries:
-- Q1: the Sephiroth bordered-prose chunk should be content_type='prose'
SELECT chunk_index, content_type, substr(content, 1, 200)
FROM chunks
WHERE guide_id = '<DynamixDJ guide id>'
  AND content LIKE '%Cloud can remain idle%';

-- Q7: the KoritheMan chunk that used to mix prose + boss block should now
-- be split — find adjacent (prose, reference) chunks near the Lavos boss
SELECT chunk_index, content_type, substr(content, 1, 150)
FROM chunks
WHERE guide_id = '<KoritheMan guide id>'
  AND content LIKE '%Lavos%'
ORDER BY chunk_index;

-- Q5: Lord_Pignea chunks 0-2 should be reference (toc / changelog)
SELECT chunk_index, content_type, substr(content, 1, 80)
FROM chunks
WHERE guide_id = '<Lord_Pignea guide id>'
ORDER BY chunk_index
LIMIT 5;
```

### 4.3 Eyeball checks against the failure cases

Walk the chunk output for each failing query in
`CHUNKER_INVESTIGATION.md` §3 and confirm:

- **Q1 Sephiroth.** The DynamixDJ chunk that contains "Cloud can remain
  idle..." (formerly chunk 2085 in v1) is tagged `content_type='prose'`
  with `subtype='bordered'` — i.e. the frame strip recognised the inner
  sentences and didn't roll the whole bordered block into `reference`.
  Adjacent pipe-grid chunks (1939, 1948, 1976, ...) are all
  `content_type='reference'` and don't share a chunk with the prose.
- **Q5 Krauser.** Lord_Pignea chunks 0–2 are tagged `reference/toc` and
  `reference/changelog`. Joe Zakutny's dot-leader TOC chunks are
  `reference/toc`.
- **Q7 Lavos.** KoritheMan's old chunk 264 (mixed prose + boss block) is
  now at least two chunks: one prose chunk with the "final battle with
  Lavos will commence" sentence, one `reference/kv` chunk with the boss
  stats. The Charm-FAQ entries from AdrenalineSL pack as `reference/list`.
- **Q14 RE4 church.** Adnan Javed chunk 59 (control case — pure prose)
  stays `content_type='prose'` and unchanged in content. Type-shift logic
  shouldn't have split this.
- **Q22 W-Item.** The Q&A chunk (formerly chunk 152) is `prose/plain`.
  The Q line and A paragraph stay packed together (both classify as
  prose, no type shift between them).

If any of these mis-tag, look at the failing paragraph's line tags —
`__testing.classifyLine` from `Chunker.ts` is exported for ad-hoc REPL
use. Adjust the threshold or regex in the design doc, then re-run the
slice. Don't proceed to Phase 5 until the load-bearing chunks tag the way
the design doc predicts.

### 4.4 Chunk-count delta

Capture the per-guide chunk count under v1 vs v2 across the slice:

```sql
-- Before (v1): captured from the pre-re-index baseline
-- After (v2):
SELECT guide_id, COUNT(*) AS v2_chunks
FROM chunks
WHERE guide_id IN ('<slice>')
GROUP BY guide_id;
```

Budget per the design doc (§11): **+30% acceptable, +50% triggers a
threshold revisit**. The biggest contributor will be type-shift flushes
splitting previously-mixed chunks; if a guide blew past +50%, look for
the noisiest paragraph (probably a series of 1-paragraph banners or
short alternating prose/kv blocks) and decide whether to merge same-type
across small interleaved blocks.

### 4.5 Exit criteria → proceed to Phase 5

- [ ] All five spot-checks above tag the way the design predicts.
- [ ] Chunk-count delta is in budget on every slice guide.
- [ ] No regressions: chunks that were correctly typed under v1's
      implicit-prose default (i.e. plain prose chunks like Q14) still emit
      as `prose` and contain the same source text as before.

If any of these fail, fix the chunker (or revisit the threshold table
in `CHUNKER_DESIGN.md` §8), redo Phase 4, *then* go to Phase 5.

## Phase 5 — full re-index + bench

**Goal:** measure whether v2's cleaner chunk boundaries move the RAG
accuracy bench. If yes, flip the default. If no, document why and roll
back.

### 5.1 Snapshot v1 baseline

If the canonical baseline at
`tests/benchmarks/baselines/rag-accuracy.json` was captured before
Phase 3 went in, it's already a valid v1 reference and step 5.1 can be
skipped. Otherwise, regenerate it:

```bash
CHUNKER_VERSION=v1 npm run rag:bench
# Inspect tests/benchmarks/history/<latest>.json, copy to baselines if
# it represents the corpus + retrieval state we want as the v2-vs-v1 floor.
```

Also stash the dump:

```bash
cp bench-qa.txt bench-qa.v1.txt
```

The per-question top-8 chunk dump in `bench-qa.txt` is what makes
"why did this query regress" tractable later.

### 5.2 Back up DB + ANN before re-indexing

```bash
cp ${DB_PATH} ${DB_PATH}.v1.bak
cp ${DB_PATH}.ann ${DB_PATH}.ann.v1.bak
```

Yes, both files. The SQLite DB is recoverable from migration rollback +
re-import; the ANN file is *not* — losing it costs hours of Ollama time
to rebuild.

### 5.3 Full re-index under v2

```bash
CHUNKER_VERSION=v2 npm run dev
# Then trigger a force re-index of the full corpus via /api/admin
# (admin token gated). Or run the indexer directly with force=true.
```

The indexer will:

1. Drop existing chunks + ANN entries per guide.
2. Re-chunk under v2, persisting `content_type` / `section_heading`.
3. Re-embed via Ollama (the wall-clock cost driver — ~3.7M chunks).

Periodic ANN saves happen every `ANN_SAVE_EVERY_GUIDES` (default 100),
so a crash mid-run loses at most that many guides — restart and the
loop picks up where `indexed_at IS NULL` left off.

### 5.4 Run the bench under v2

```bash
CHUNKER_VERSION=v2 npm run rag:bench
mv bench-qa.txt bench-qa.v2.txt
```

Compare:

```bash
# Side-by-side on the question-level pass/fail
diff <(jq '.cases[] | {question, status}' tests/benchmarks/history/<v1>.json) \
     <(jq '.cases[] | {question, status}' tests/benchmarks/history/<v2>.json)

# Side-by-side on the top-8 chunks per question
diff bench-qa.v1.txt bench-qa.v2.txt | less
```

### 5.5 Decision matrix

| Outcome | Action |
|---|---|
| v2 strictly improves (more passes, no new fails) | Flip default in `config.ts` (`chunkerVersion: 'v2'`). Update baseline JSON. Document the win. |
| v2 mixes wins + losses, net positive | Keep `CHUNKER_VERSION=v2` opt-in. Investigate the regressions: are they classifier mis-fires (fixable) or retrieval-side issues that surface only with cleaner chunks (defer to a retrieval-scoring phase)? |
| v2 mixes wins + losses, net neutral | Keep v1 default. The chunk tags are still useful for a future retrieval-scoring phase even without a bench delta — the hypothesis was "cleaner boundaries alone help"; if they don't, the next phase wires `content_type` into scoring. |
| v2 strictly regresses | Roll back (§5.6). Re-open `CHUNKER_DESIGN.md` §8 thresholds. |

### 5.6 Rollback procedure

If Phase 5 calls for it:

```bash
# 1. Stop the server.
# 2. Restore DB + ANN.
mv ${DB_PATH}.v1.bak ${DB_PATH}
mv ${DB_PATH}.ann.v1.bak ${DB_PATH}.ann

# 3. The DB is at v11; chunks rows still have content_type/section_heading
#    columns. That's fine — v1 just leaves them at default 'prose'/NULL.
#    Optionally roll the schema back to v10 if you want a clean slate:
#      node -e "require('./dist/database/migrations').rollbackTo(db, 10)"
#    But there's no need to — leaving v11 in place keeps the option to
#    flip CHUNKER_VERSION=v2 again later without re-migrating.

# 4. Restart with the old default.
CHUNKER_VERSION=v1 npm start  # or just `npm start` once the default is v1
```

The migration v11 down-path is reversible (`ALTER TABLE chunks DROP
COLUMN`), but only on SQLite ≥ 3.35. The migrations file logs a warning
and continues if `DROP COLUMN` isn't supported — leaving the columns in
place with their default values is harmless.

## What's explicitly out of scope here

Phase 4/5 measure the chunker change in isolation. The following are *not*
part of this validation pass:

- **Retrieval scoring.** `RetrievalService` does not yet consume
  `content_type`. A `reference` chunk and a `prose` chunk get the same
  fusion weight in v2 as they did in v1. The hypothesis under test in
  Phase 5 is "cleaner chunk boundaries alone move the bench" — *not*
  "type-aware demotion fixes the bench." If Phase 5 is neutral, the
  natural follow-up is a retrieval-side phase that adds a
  `content_type`-aware boost/demote (e.g. demote `reference` for
  "how do I beat" queries, leave `prose` neutral).
- **Synthesis prompt changes.** `SynthesisService` does not see
  `content_type` either. The existing prompt should ground better simply
  because chunks are less contaminated, but no prompt tuning is on the
  Phase 4/5 scope.
- **Header text in retrieval signal.** `section_heading` is persisted
  but not yet indexed (FTS) or used for citation enrichment. Retrieving
  on heading text is a future phase.

## Open follow-ups after Phase 5

Regardless of how Phase 5 lands, these are the natural next moves:

1. **Wire `content_type` into RetrievalService.** Demote `reference`
   chunks for question shapes that read prose-shaped ("how do I beat",
   "how do I solve", "where is", "what happens when"). Promote nothing
   — neutral baseline keeps mixed-content queries (e.g. "what's the
   max HP of X") honest.
2. **Surface `section_heading` in citations.** When a chunk has a
   non-NULL `section_heading`, include it in the citation block returned
   to the user. Useful for "the chunk that answered this question came
   from the *Final Battle* section of the guide" UX.
3. **Index `section_heading` in chunks_fts.** Today FTS searches over
   chunk content only; adding the heading as a second FTS column gives
   queries like "elite four" a path to the right chunk even when the
   chunk body never says "elite four" verbatim (only the section header
   does).

These are scoped separately. Don't bundle them into the Phase 5 cutover.
