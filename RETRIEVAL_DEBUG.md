# RETRIEVAL_DEBUG

Working notes on retrieval failures surfaced by `tests/benchmarks/rag-accuracy.test.ts`. Synth-side findings live in [SYNTH_DEBUG.md](SYNTH_DEBUG.md).

**Why this file exists:** synth quality cannot be measured while retrieval is wrong. If the right guide isn't in the 8 cited chunks, even a perfect synthesizer can only refuse or hallucinate. Fix retrieval first, then evaluate synth on a clean retrieval baseline.

## Status (2026-05-05)

| Step | Owner | Status |
|---|---|---|
| 1. Title-FTS rebuilt from `games.title` (migration v6) | shipped | ✅ |
| 2. Game-match rescue lane K=3 → K=1 | shipped | ✅ |
| 3. Title-boundary filter on game-match phrase results | shipped | ✅ |
| 4. Hard-filter retrieval via `filters.gameId` (Layer 3 rebuild) | shipped | ✅ |
| 5. Embedder upgrade to `bge-m3` | deferred | see "Deferred work" below |
| 6. Section-aware chunker | deferred | tracked in `synth_followups.md` |
| 7. Standalone validation pipeline (spec Addition 1) | deferred | see "Deferred work" |

## Pipeline (verified 2026-05-05)

### Chunking — `src/services/Chunker.ts`

- Paragraph-aware fixed-window. Default `CHUNK_SIZE_TOKENS=400`, `CHUNK_OVERLAP_TOKENS=50` (env-overridable in `src/config.ts`). Token estimate is `chars / 4`; no real tokenizer.
- Drops paragraphs that are >80% non-alphanumeric (ASCII art / banners), but **does not** drop tables of contents, character lists, encounter tables — those have plenty of alphanumerics. This matters for the flood pathology below.
- No section-heading metadata is captured. The chunker has no concept of "Boss Strategies" vs "Walkthrough" vs "Item List" — they're all just paragraphs.

### Embedding — `src/services/EmbeddingService.ts`

- Calls Ollama `/api/embed` with `EMBEDDING_MODEL=nomic-embed-text`, `EMBEDDING_DIM=768`. Single-question requests have a 5s timeout; batch indexing requests have 120s and run with concurrency=4.
- ANN: USearch HNSW i8 in a single file at `${dbPath}.ann`, keyed by `chunks.rowid`. ~3.7M-vector run hit recall@8 of 84–87% per CLAUDE.md.

### Retrieval — `src/services/RetrievalService.ts`

Hybrid fusion of three sources, scored via reciprocal-rank fusion with k=60. When a `gameId` filter is active (set by `GameExtractionService` or the caller), all three sources are hard-filtered to that game's chunks **before fusion** via `filterChunkIds(candidateIds, filters)`.

1. **Vector KNN** (`vecLimit=20`): top-20 chunks by cosine via the ANN index. Contributes `1/(60+i)` per hit.
2. **BM25 over `chunks_fts`** (`ftsLimit=20`): tokens passed through `filterToRareChunkTokens` — drops tokens with df > max(5000, 5% of corpus), keeps the rarest 5. The original observed reason: chunk-FTS used to dominate retrieval p95 (94% of wall time) before this filter.
3. **Title-FTS over `guides_fts_meta`** (`titleLimit=10`): rare-token-filtered (top 3 by ascending DF), then every chunk of each title-matched guide enters at the guide's rank.

Game-match (`defaultGameMatch` via `games_fts`) is now used exclusively by `GameExtractionService` / Layer 1 extraction to set `filters.gameId` before retrieval, not as a fusion source. This eliminates the flood pathology — matched-game chunks no longer swamp vec/FTS results.

There is **no reranking** after RRF. Top-K by score, hydrate via one SQL round trip, return.

### Citation generation

The synth model produces `[1]`, `[2]`, `[1,3]` markers in free text. `SynthesisService.stripInvalidCitations` removes citation indices outside `[1..N]` where N is the count of excerpts passed to the prompt. **There is no semantic check** that the cited chunk actually supports the surrounding sentence — see [SYNTH_DEBUG.md](SYNTH_DEBUG.md).

### Corpus snapshot (2026-05-05)

```
guides:           50,545
games:            16,159
chunks:        2,605,155
ANN vectors:   2,605,155   (matches chunks count → all guides indexed)
```

All five "suspicious refusal" games verified present with abundant guides:

| Game | Guides indexed |
|---|---|
| Pokemon Red Version | 44 |
| Chrono Trigger | 48 |
| Resident Evil 4 (GameCube) | 52 |
| Grand Theft Auto San Andreas (PS2) | 64 |
| Final Fantasy X (PS2) | 119 |

So the corpus is fine. Refusals are NOT "no guide for that game".

## Live-data diagnosis (2026-05-05, 50k corpus)

Pulled per-source debug for three failing bench questions to triage whether the
remaining failures are flood pathology, contamination, or something else. Used
`POST /api/guides/_debug_retrieve` (no fusion, raw per-source results).

### Sephiroth / FF7 — multi-causal contamination

Final top-8 citations: Capcom Fighting Evolution, FF Advent Children, FF5,
FF Advent Children, Tekken Tag, FF7 (DynamixDJ ASCII tables), FF Advent
Children, FF7 (DynamixDJ ASCII tables). Synth refused.

| Source | Top-8 contents |
|---|---|
| Game-match | 8 FF7 variants matched (FF7, Crisis Core, Advent Children, Dirge of Cerberus, Snowboarding, FF7+FF8 Double Pack, Before Crisis). 19,342 chunks in matched set. |
| Vec | **Zero FF7 chunks** — Capcom Fighting Evolution, FF5, Tekken, Mario Galaxy, Mike Tyson Punchout, FF4. The embedder is matching boss-strategy semantics across games. |
| Chunk-FTS | Mostly FF Advent Children + DynamixDJ — but Advent Children is the *movie* spinoff, not the PSX game. |
| Title-FTS | Phantasy Star Online — Sephiroth, Samurai Shodown 64 — Rurouni Sephiroth, WWF Smackdown — Sephiroth X. **Title-FTS poisoned by author bylines** after the v5 title relabel. |

### SM64 stars — phrase-substring overmatching

Game-match returned both "Super Mario 64" *and* "Super Mario 64 DS" because the
FTS5 phrase `"super mario 64"` is a contiguous substring of "super mario 64 ds".
Vec then preferred SM64 DS chunks (more guides in that title → embedder bias).
Cited title was "Super Mario 64 Ds — TheFrigz" — different game with different
star count (150 vs 120).

### Cloud's starting weapon — ambiguous question

Game-match returned empty (question doesn't say "FF7"; "Cloud" alone too short).
Vec top-5: Atelier Iris, Monster Hunter, Biohazard Triple Pack, Dragon Age II,
Kingdom Hearts. Chunk-FTS rescued FF7 — but the cited FF7 chunks didn't mention
"Buster Sword".

## Five distinct failure modes (rank-ordered impact)

1. **Vec embeddings are functionally useless on these questions.** Vec top-N
   for "Sephiroth in FF7" and "Cloud's weapon" both contain zero right-game
   chunks. nomic-embed-text doesn't separate game-specific content. → Step 4.
2. **Title-FTS poisoned by author bylines.** v5 relabel made `guides.title`
   = `${game} — ${author}`, indexed into `guides_fts_meta`. Authors named
   Sephiroth / Cloud / Diablo surface unrelated guides. → Step 1.
3. **Game-match phrase expansion too coarse.** "super mario 64" ⊂ "super
   mario 64 ds"; "final fantasy vii" ⊂ "Crisis Core Final Fantasy VII".
   → Step 3.
4. **Rescue lane K=3 lets vec garbage through.** When (1) is bad, K=3 exports
   that badness into final top-K. → Step 2.
5. **Right-game chunks are stats tables / banners, not strategy.** → Step 5.

## Step 1 (shipped) — Title-FTS indexes `games.title`, not `guides.title`

**Migration v6** drops the v1 `guides_fts_meta_insert/_update` triggers and
recreates them to read title from `games.title` via FK lookup, with a
`COALESCE(games.title, guides.title)` fallback for orphan guides. Adds a
`games_title_propagate_to_guides_fts` trigger so renaming a game (rare —
typically only on import correction) refreshes all linked FTS rows. Rebuilds
the FTS index from the canonical join inside one transaction.

`guides.title` keeps the `${game} — ${author}` form for display purposes —
citations show the disambiguated title. Only the title-FTS index changes.

Eliminates author-token leaks like the "Sephiroth" → Phantasy Star Online
matches.

## Step 2 (shipped) — Rescue lane K=3 → K=1

`GAME_MATCH_RESCUE_TOP_K` dropped from 3 to 1 in `RetrievalService.ts`. When
game-match fires, vec/FTS hits *not* in matched-game chunks now pass through
unconditionally only at rank 1 per source instead of ranks 1-3. Caps the
per-source garbage at one chunk if vec/FTS top hits are wrong-game.

## Step 3 (shipped) — Title-boundary filter on game-match phrase results

`queryGamesFtsPhrase` now post-filters FTS5 phrase matches: the matched title,
minus the phrase tokens, must consist only of "decoration" tokens (connectives
`the/of/and`, series-brand `legend/zelda/tales`, edition suffixes
`hd/remake/edition/version/...`). Rejects "Crisis Core Final Fantasy VII",
"Final Fantasy VII Advent Children", "Super Mario 64 DS", "Diablo II: Lord of
Destruction" when the phrase is shorter than the full title and the leftover
tokens are installment / spinoff identifiers.

`TITLE_DECORATION_TOKENS` and `passesTitleBoundaryFilter` are exported and
unit-tested in `tests/RetrievalService.gameMatch.test.ts`. The decoration list
is intentionally conservative; loosen by adding tokens as live mis-rejections
surface.

## Deferred work (parked until steps 1-3 stabilize)

### Step 4 — Embedder upgrade `nomic-embed-text` (768d) → `bge-m3` (1024d)

The dominant remaining failure mode is "vec returns zero right-game chunks".
The embedder is the single largest lever left. `bge-m3` is already pulled per
`ollama list`, the side-ANN re-embed script exists at
`scripts/rag-reembed-bge-m3.sh`, and the dim guard in `AnnIndex.load()`
(commit `2da5239`) catches mismatches loudly.

Costs: ~33% larger ANN file (3 GB → 4 GB), ~25-30% slower vec query, multi-hour
one-time re-embed. Worth running once steps 1-3 prove insufficient on the
remaining failures, or as a precondition for further precision work that
depends on tighter semantic separation.

Full notes in `BENCHMARKING.md` "Open work → Larger embedder for the
ambiguous-question ceiling".

### Step 5 — Section-aware chunker + parent-document retrieval

Right-game chunks that DO surface are stats tables, character lists, ASCII
banners — not strategy. The chunker treats `===`, `---`, `[Boss Strategies]`,
numbered sections as plain paragraphs; chunks have no `section_heading`
metadata for the synth to ground answers in. Procedural answers (W-Item dupe,
cow level recipe) span multiple chunks; synth gets fragments.

Detailed plan in memory `synth_followups.md` (Chunker rework — section-aware
chunks + parent-doc retrieval). Requires a SCHEMA_VERSION bump for a new
`chunks.section_heading` column and a full re-index. Multi-hour cost.

### Step 6 — Standalone chunk validation pipeline (spec Addition 1)

The original spec asked for an LLM-based validation pass that checks chunk
content against assigned `gamefaqs_id` / `game_title` and writes
`review_status` back. Deferred until steps 1-4 stabilize the index — running
validation against a known-noisy retrieval surface conflates "chunk
mistagged" with "retrieval surfaced wrong chunk", and the report would be
hard to act on.

When unblocked, target shape:

- CLI tool taking sampling strategy (random / stratified-by-franchise /
  stratified-by-console / targeted-by-guide / targeted-by-query-failure),
  sample size, and optional filter.
- Use the local Ollama `qwen3:1.7b` for the cheap classifier (NOT the synth
  model — different concern, want independent judgment). Cost is local GPU
  time; no API budget required.
- Output: per-run JSON + CLI summary, diffable across runs ("2026-05-15: 2.3%
  mismatch; 2026-06-01: 1.8% after fix X").
- Persistence: `chunks.review_status` column ('auto_passed' / 'auto_flagged'
  / 'excluded'). Add `RetrievalFilters.reviewStatus` so callers can opt-in
  to filtering flagged chunks; don't auto-exclude (preserves recall while
  flagging is iterating).
- Schema: bump SCHEMA_VERSION to 7, add `review_status` column with default
  'auto_passed', backfill all existing chunks to that default.

## Diagnosed retrieval bugs (history)

### Bug 1 — Game-match flood pathology (most critical)

**Symptom:** top 8 citations for "How do I beat the Elite Four in Pokemon Red?" are chunks 0–7 of one Pokemon Red guide ("Scott Walker", a trainers/encounters list), all tied at score 0.0909. Same shape for "How do I beat Lavos in Chrono Trigger?" — top 8 are chunks 0–7 of one Spanish-language Chrono Trigger guide, tied at 0.1073.

**Root cause:** when game-match phrase-matches a game name like `pokemon red`, `defaultGameMatch()` returns all matched game_ids and `expandGameMatchToChunks()` returns **every chunk_id of every guide for those games**. For Pokemon Red that's 44 guides × hundreds of chunks each ≈ thousands of chunks all entering RRF tied at the same `1/(gameMatchRrfK + 1) = 1/11 = 0.0909` boost.

Vec and chunk-FTS contribute additional `1/61 ≈ 0.0164`-class boosts to *specific* chunks they hit, but those small contributions can't lift a single Lavos-strategy chunk above the flood of game-match-only chunks. Title-FTS gives every chunk of every title-matched guide the same `1/(60+title_rank+1)` boost, so it adds another constant ≈0.0164 to all chunks of matched-title guides — explains the 0.1073 ceiling on Lavos.

Result: thousands of chunks tied at the same score. `Array.sort` with equal scores preserves Map insertion order, so the first 8 inserted win — typically chunks 0–7 of the lexicographic-first guide, which are typically TOC, character lists, or banner content. Boss strategy chunks deeper in the guide never make top-K.

**Affected questions in the bench (refused on suspicious-refusal pattern):**
- Elite Four Pokémon Red
- Lavos Chrono Trigger
- Krauser RE4
- GTA SA weapon cheats
- FFX first enemy
- Otacon password MGS2
- Solid Snake's father (also produced the George Washington hallucination — see SYNTH_DEBUG.md)
- Aerith's last name
- Sephiroth burning Nibelheim

All of these are questions where game-match correctly identifies the game but then floods the result pool with that game's structural chunks instead of letting vec/FTS surface the strategy chunks.

**Resolution (shipped):** Game-match is now delegated entirely to `GameExtractionService` (Layer 1 extraction). When extraction is confident, `AnswerService` passes `filters.gameId` to `RetrievalService.retrieveWithTimings`. All three sources (vec/FTS/title) are hard-filtered to that game before RRF fusion via `filterChunkIds`. The old `applyGameMatchSoftFilter` rescue-lane code has been removed — hard filtering with no rescue is cleaner and contamination-free.

### Bug 2 — Single-token game names not matched (RESOLVED in step 3)

**Symptom:** "What's the best class in Diablo?" → no Diablo guides retrieved. "How do I solve the temple puzzle in Zelda?" → no mainline Zelda guides retrieved.

**Root cause:** `GAME_MATCH_NGRAM_MIN = 2`. Single-token game names (Diablo, Zelda, Tetris, Portal, Doom, Halo, Skyrim, Pokemon) are never tried as a phrase query alone. Every 2-gram ending in such a name has either a stopword endpoint (`in diablo`) or doesn't form a real title.

**Experiment:** lowered `NGRAM_MIN` to 1. Result: Diablo III hits for the class question, Tetris DS hits for the boss question — but **collateral damage**: 1-grams matching common English words against obscure titles. "burn" matched "Burn Zombie Burn" for the Sephiroth/Nibelheim question; "cloud" matched "Start Up 2000" for the Cloud weapon question. Net recall went from 90% → 80%.

**Resolution (shipped):** `NGRAM_MIN=1` is now safe because the title-boundary
filter (step 3) rejects 1-gram phrase matches whose tail contains installment
identifiers. "diablo" matches "Diablo" (kept) but not "Diablo II" (tail=`ii`
rejected); "burn" matches "Burn" only if such a title exists (no decoration
tail keeps it; "Burn Zombie Burn" has tail=`zombie burn` → rejected).

### Bug 3 — Title-FTS rare-token filter does similar damage (PARTIALLY MITIGATED in step 1)

**Symptom (less acute):** the rare-token filter at `filterToRareTitleTokens` keeps only the 3 rarest tokens (by DF in `guides_fts_meta_vocab`) under threshold `max(50, 5% of indexed titles)`. For "How do I beat the final boss in Resident Evil?", rare-token filtering may drop "resident" and "evil" (both common as full title tokens since RE has many guides) and pick "beat", "final", "boss" instead — pulling in "Beat Down Fists of Vengeance", "Kingdom Hearts II Final Mix", etc.

In the bench, `top: "Devil May Cry 2"` for "second boss" question, `top: "Kingdom Hearts II Final Mix"` for "Tetris final boss" — these are title-FTS surfacing common-word matches. Game-match should compensate (and does, when it fires), but where game-match doesn't fire, title-FTS often fires on the wrong games.

**Partial mitigation (step 1, shipped):** Title-FTS now indexes `games.title`,
not `guides.title`, so author-byline poisoning ("Sephiroth", "Cloud", "Diablo"
as author tokens) is gone. The rare-token filter behavior on legitimate
content tokens (beat / final / boss) is unchanged — that one is genuinely
hard to disentangle from valid recall and remains as-is.

When extraction fires a `confident` game match, all sources (including title-FTS) are hard-filtered to that game before fusion, so the rare-token pathology can only surface when extraction is unclear and no `gameId` filter is active (corpus-wide fallback is gone — unclear extraction now returns `extraction_failure` immediately, so even that path is clean).

## Test methodology

Run with:
```bash
RAG_BENCH_PRINT_ANSWERS=1 npm run rag:bench

# Write Q&A dump to a file for offline review:
RAG_BENCH=1 RAG_BENCH_OUTPUT_FILE=./bench-qa.txt npm run rag:bench

# Validate hard game-match on all specific questions:
RAG_BENCH=1 RAG_BENCH_REQUIRE_HARD_GAME_MATCH=1 npm run rag:bench

# Quick dump without Vitest (live server required, writes bench-qa.txt):
OUTPUT_FILE=./bench-qa.txt node scripts/rag-bench-dump.mjs
```

Bench results in `tests/benchmarks/baselines/rag-accuracy.json`. Per-question citation list in the log under `--- answer ---` is the ground truth for what the synth saw.

## Bench history

| Date | Recall@8 (specific+ambig) | Synth answered | Notes |
|---|---|---|---|
| 2026-05-05 (original prompt, num_predict=500) | 27/30 = 90.0% | 33.3% | Baseline. Top-K dominated by game-match flood — many recall hits are TOC chunks. |
| 2026-05-05 (new prompt, num_predict=1500) | 27/30 = 90.0% | 63.3% | Synth fix only. Refusals halved but answers grounded on TOC chunks → vague / shallow. |
| 2026-05-05 (1-gram experiment) | 24/30 = 80.0% ↓ | 53.3% ↓ | NGRAM_MIN=1. Diablo + Tetris recovered but 3 FF7 questions regressed via false-positive 1-gram matches. **Reverted.** |
| 2026-05-06 (Layer 1–3 rebuild: hard-filter + extraction pipeline) | TBD (needs live server run) | TBD | Game-match flood replaced by hard `gameId` filter via `GameExtractionService`. Expect recall rate maintained or improved. Run with `RAG_BENCH_REQUIRE_HARD_GAME_MATCH=1` to validate citation-game alignment. |
| 2026-05-06 (BM25 rare-token fixes + supplementary game-scoped BM25) | TBD | TBD | Three fixes: (1) zero-token fallback when all tokens are too common, (2) Porter stem mismatch detection via suffix-stripped vocab lookup (e.g. "stars" df=0 but stem "star" df=190k — now correctly treated as common), (3) game-scoped supplementary BM25 pass for the single least-rare dropped token when a gameId filter is active. All three are in `filterToRareChunkTokens` + `retrieveWithTimings`. Supplementary pass gated on `SUPP_MIN_GAME_CHUNKS=100` to prevent wrong-game noise when extraction is flaky. |

Flood pathology (Bug 1) is resolved. Primary remaining concern is extraction confidence for questions where the game name is ambiguous or absent.

## Bug 4 — Porter stem mismatch in BM25 rare-token filter (RESOLVED 2026-05-06)

**Symptom:** "How many stars are in Super Mario 64?" → the token `stars` has df=0 in `chunks_fts_vocab` (vocab stores Porter stems, not surface forms). The filter sees df=0 as "ultra-rare" and includes `stars` in the BM25 query. But FTS5 applies Porter stemming at query time, so `MATCH '"stars"'` actually searches for stem `star` (df=190k, above threshold). The token looks rare to the filter but matches ~190k chunks, diluting BM25 signal.

**Root cause:** `chunks_fts_vocab` indexes Porter-stemmed terms. When we look up a surface form like `stars`, we get df=0 (not found as-is) because the stem `star` is stored instead. This affects any token whose surface form differs from its Porter stem — plurals (`stars→star`, `levels→level`), inflected forms, etc.

**Fix:** In `filterToRareChunkTokens`, when the vocab returns df=0, call `lookupStemDf(token)` which strips common English suffixes (`-s`, `-es`, `-ed`, `-ing`, `-ly`, `-er`) and looks up each candidate in the vocab. If any candidate has df > threshold, treat the original token as common and drop it. This correctly identifies `stars` (via `star`, df=190k) as common.

**Remaining limitation:** The `-y→i` Porter rule (e.g., `many→mani`) is NOT covered by suffix stripping. The token `many` shows df=1 in the vocab (surface form) but maps to stem `mani` which appears in virtually every guide. This means `many` incorrectly passes the filter as "ultra-rare" and enters the BM25 query, where it matches many chunks. In practice this adds noise but doesn't prevent relevant chunks from ranking — `many` has near-zero IDF within any game's content set, so it doesn't artificially boost specific chunks.

## Bug 5 — Simple factual queries where answer token not in question (DIAGNOSED, no fix)

**Symptom:** "How many stars are in Super Mario 64?" (answer: 120) and "What is the max level in Diablo 2?" (answer: 99) both return 8 correct-game citations but synthesis refuses on all of them. The answer token ("120" or "99") is absent from the question, and the chunks in top-8 don't state the answer explicitly.

**Root cause:** BM25 can't bridge the lexical gap between "how many stars" and "120". Vector search semantically maps "how many stars" to SM64 guide content generally, but the specific chunk saying "collect 120 stars" ranks below generic SM64 chunks that score well on BM25 (`mario`, `64`) + title-FTS expansion. The supplementary game-scoped pass adds star-related SM64 chunks but they compete for the top-8 positions against title-FTS-boosted chunks from other SM64 guides.

**Analysis of supplementary pass effectiveness for Q15:**
- Supplementary `"stars"` scoped to SM64 adds the "Star #X/120" chunks (SilentMJay guide) to ftsHits
- BUT: title-FTS expands the Evrain 2002 guide (13 chunks, Italian language) to filteredTitle because it ranks at title-FTS rank 0
- Evrain chunks score 1/(60+1)=0.016 from title alone
- SilentMJay chunks score 1/(60+13)≈0.014 from supplementary FTS (low position because they come after 20 global ftsHits)
- Title contribution for SilentMJay guide is uncertain (depends on whether it's in title top-10)
- Result: Evrain Italian chunks outcompete or tie the SilentMJay "120 stars" chunks

**What would fix this:**
1. Shorter chunks (100–200 tokens) so factual statements are isolated and easier to retrieve
2. Q&A extraction layer at index time: extract (question, answer) pairs from guides and embed the questions
3. Better embedding model with stronger semantic bridging
4. Title-FTS limit reduced (currently 10 guides) so fewer non-English guides crowd the expansion pool

These are architectural changes deferred until the retrieval pipeline stabilizes.
