# RAG Benchmarking

How retrieval quality is measured, what to do when numbers move, and the
research log behind the May 2026 corpus rebuild that took specific-question
recall from 62.5% → 100%.

## Running the bench

```bash
# Compare current state vs the committed baseline (default)
npm run rag:bench

# Overwrite the canonical baseline (use after intentional changes)
RAG_BENCH=1 RAG_BENCH_WRITE_BASELINE=1 \
  npx vitest run tests/benchmarks/rag-accuracy.test.ts

# Capture a time-series snapshot (independent of canonical baseline)
RAG_BENCH=1 \
  RAG_BENCH_HISTORY_PATH=tests/benchmarks/history/rag-50k-guides.json \
  RAG_BENCH_HISTORY_LABEL="50k guides indexed" \
  RAG_BENCH_GUIDES_INDEXED=50000 \
  RAG_BENCH_EMBEDDINGS_COUNT=2600000 \
  npx vitest run tests/benchmarks/rag-accuracy.test.ts
```

The bench is gated behind `RAG_BENCH=1` so `npm test` skips it. It hits a
running server (default `http://localhost:3000`); a 5s pace between questions
keeps the production rate limiter happy.

## What gets measured

Each question is tagged with a `kind` that drives its assertion:

| Kind | Real-world shape | Pass criteria |
|---|---|---|
| `specific` | Names the exact game ("…in Pokemon Red?") | Citation title matches `expectedTitleRegex` (use `\b` boundaries) |
| `ambiguous` | Series only or no game named | Substring match against any of `expectedTitleSubstrings` |
| `trick` | False premise ("Where's the Triforce in OoT?") | `no_answer === true` OR a corrective keyword present in the answer |
| `unanswerable` | No game/boss named, recoverable refusal expected | `no_answer === true` |

`specific` and `ambiguous` are the meaningful signal. `trick` and
`unanswerable` are stress-tests of edge behavior — failures here matter less
than failures on representative usage, since real users name the game they're
playing.

Aggregate floor (`RAG_BENCH_RECALL_FLOOR`, default 0.55) is a coarse drift
catch on `specific + ambiguous` recall. Wilson 95% CI is printed alongside
the rate so single-run noise is visible. The baseline file is the precise
per-question regression signal.

## Files

| Path | Role |
|---|---|
| `tests/benchmarks/rag-accuracy.test.ts` | The bench itself |
| `tests/benchmarks/baselines/rag-accuracy.json` | Canonical regression boundary (committed). A question that was passing here but fails now is a hard test failure. |
| `tests/benchmarks/history/rag-*.json` | Time-series snapshots. Schema-compatible with the baseline plus indexing metadata (`guides_indexed`, `embeddings_count`, timing). Independent of the canonical file. |

Snapshot mode (`RAG_BENCH_WRITE_BASELINE=1` or `RAG_BENCH_HISTORY_PATH=...`)
disables the per-question hard assertions and the regression check — the
output file IS the record of current state.

## How questions are matched

Title regexes use word boundaries to exclude near-misses:

```ts
const RX_FF7 = /\b(final\s+fantasy\s+(vii|7)|ff\s*7|advent\s+children)\b/i;
const RX_MGS2 = /\b(metal\s+gear\s+solid\s+(2|(?:the\s+)?(?:legacy|hd|master)\s+collection)|sons\s+of\s+liberty|mgs\s*2)\b/i;
```

Compilations that bundle the target installment (MGS HD/Legacy/Master
Collection, Diablo Battle Chest, Castlevania Anniversary Collection, Final
Fantasy Anthology, Super Mario 3D All-Stars, etc.) count as valid hits and
are explicitly enumerated in the regex alternations.

`\b` does the right thing on Roman numerals: `\bvii\b` does NOT match
`\bviii\b` because the trailing `I` is a word char.

## Research log: dedupe + games_fts

Three findings drove most of the specific-recall improvement.

### 1. Dedupe alone moved recall +20pp

The original archive contained ~80k guides with substantial near-duplicate
content (multiple FAQs for the same game often share long passages). After
deduplication to 50,545 unique guides:

- Pre-dedupe (80k guides, 3.7M chunks): combined recall **60.0%**, specific **62.5%**
- Post-dedupe (50k guides, ~2.6M chunks), pre-game-match: combined **80.0%**, specific **83.3%**

The hypothesis: duplicate chunks were crowding out target chunks in top-K.
Confirmed by the fact that several previously-stuck questions recovered
without any code changes once the duplicates were gone.

### 2. Title-FTS rare-token filter was dropping game names

Before this work, title-FTS used a rare-token filter — drop tokens whose
document-frequency exceeded ~5% of indexed titles, keep the 3 rarest. The
intent was to drop common stop-words. The unintended effect: action verbs
turn out to be rarer in title space than canonical game-name tokens.

For "How do I beat the Elite Four in Pokemon Red?", token DFs in
`guides_fts_meta`:

| token | df |
|---|---|
| `beat` | 41 |
| `four` | 43 |
| `elite` | 49 |
| `first` | 69 |
| `enemy` | 101 |
| `red` | 301 |
| `pokemon` | 675 |

The rarest 3 were `beat / four / elite`. Title-FTS query became
`beat OR four OR elite`, which BM25-ranked **Elite Beat Agents** (DS rhythm
game) at the top — `pokemon` and `red` never made it into the query.

Same shape on FFX: the rarest 3 were `beat / first / enemy`; the query
matched "Beat Down Fists of Vengeance", "First Queen", etc.

### 3. Solution: games_fts virtual table + n-gram phrase matching

Migration v6 adds a `games_fts` FTS5 virtual table over `games.title` with
default `porter unicode61` tokenization. Default tokenizer's word boundaries
cleanly distinguish `final fantasy x` from `final fantasy xi` (token `x` ≠
token `xi`) — something plain `LIKE '%final fantasy x%'` can't do.

`RetrievalService.defaultGameMatch(question)` walks question n-grams (n=5..2)
right-to-left within each length, with two additional safeguards:

- **Numeral aliasing.** Each n-gram tries Roman ↔ Arabic substitutions: a
  question saying "Diablo 2" matches the games-table entry "Diablo II". Up
  to 8 variants per n-gram (caps the cartesian explosion at three numeric
  positions).
- **Stopword-endpoint filter.** N-grams whose first or last token is a
  stopword are skipped. Without this, phrases like `the best` and `the temple`
  phrase-match incidentally inside titles ("Best of the Best Championship
  Karate" contains `the best`; "Indiana Jones and the Temple of Doom"
  contains `the temple`), tanking ambiguous-question recall.

Matched game_ids expand to chunks via the `guides.game_id` FK and enter RRF
as a 4th source with `gameMatchRrfK = 10` (≈ 5× the title-FTS boost). Vec
and chunk-FTS still run unfiltered, so a wrong game extraction can be
rescued.

#### Why right-to-left n-gram walking

Question shape is "how do I X in `<Game Name>`?" — game names land at the
end. Walking right-to-left within each n-gram length means rightmost
positions are tried first. Without this, an incidental shorter match earlier
in the question can preempt the real game name.

#### Why stop-word endpoints break it

When the first attempt at game-match was implemented without the
stopword-endpoint filter, specific recall jumped to 23/24 (95.8%) but
ambiguous regressed 4/6 → 2/6:

| Ambiguous question | False-positive matched game |
|---|---|
| "What is the best starter Pokemon?" | "Best of the Best Championship Karate" (matched `the best`) |
| "What's the best class in Diablo?" | "Best of the Best Championship Karate" (matched `the best`) |
| "How do I solve the temple puzzle in Zelda?" | "Indiana Jones and the Temple of Doom" (matched `the temple`) |

Adding the stopword-endpoint filter restored ambiguous to 4/6 while keeping
specific at 24/24 (100%).

## Time series: 50k indexing run

Recall snapshots taken at 10k-guide milestones during the May 2026 corpus
rebuild. Each snapshot is `tests/benchmarks/history/rag-NNk-guides.json`.

| Milestone | combined | specific | ambig | trick | unanswer | retrieve p50 |
|---|---|---|---|---|---|---|
| Pre-dedupe (3.7M) | 60.0% | 62.5% | 3/6 | 3/3 | 1/1 | 1300ms |
| 5k guides | 66.7% | — | — | 3/3 | 0/1 | 36ms |
| 11k guides | 76.7% | — | — | 3/3 | 0/1 | 64ms |
| 20k guides | 80.0% | — | — | 3/3 | 1/1 | 103ms |
| 30k guides | 76.7% | 79.2% | 4/6 | 3/3 | 1/1 | 191ms |
| 40k guides | 80.0% | 83.3% | 4/6 | 3/3 | 1/1 | 266ms |
| 41k (post regex broadening) | 83.3% | 87.5% | 4/6 | 3/3 | 1/1 | 531ms |
| 50k full corpus (pre-game-match) | 80.0% | 83.3% | 4/6 | 3/3 | 1/1 | 472ms |
| 50k post-game-match (no stopword filter) | 83.3% | 95.8% | 2/6 ↓ | 3/3 | 1/1 | 582ms |
| **50k post-stopword-fix** | **93.3%** | **24/24 (100%)** | **4/6** | **3/3** | **1/1** | **240ms** |

The 100% specific result was reproduced byte-identically across three
consecutive runs — same 28 passing, same 2 failing (both ambiguous).

## Synthesis model: qwen3:8b → qwen3:1.7b

After retrieval was solved, response time was the next bottleneck (synth was
~75% of every request). Switched `SYNTHESIS_MODEL` from `qwen3:8b` to
`qwen3:1.7b`:

| Metric | qwen3:8b | qwen3:1.7b |
|---|---|---|
| Specific recall | 24/24 (100%) | 24/24 (100%) |
| Ambiguous recall | 4/6 | 4/6 |
| Trick handling | 3/3 | 2/3 |
| Unanswerable handling | 1/1 | 0/1 |
| `no_answer` issued (any) | 23/34 | 13/34 |
| avg synth | 1588ms | 971ms (-39%) |
| avg total | 1843ms | 1437ms (-22%) |

Trade-off: ~600ms faster per request, but the smaller model is less
disciplined about refusing — it answered confidently from an OoT chunk
instead of correcting the false-Triforce premise, and invented a Devil May
Cry 2 boss for the unanswerable case.

Decision: kept qwen3:1.7b. Real-world usage names games and wants direct
answers; the lost cases are exploratory probes, not representative load.
The retrieval layer (which is what this benchmark actually measures) is
unaffected by the model swap — recall numbers are identical.

## Adding new questions

1. Pick a `kind`. If a real user would name the game while asking,
   `specific`. If they'd ask without naming a game, `ambiguous`.
2. For `specific`, write `expectedTitleRegex` with `\b` boundaries on
   installment-discriminating tokens. Accept compilations explicitly.
3. Add `expectedAnswerKeywords` for the synth-side check. For `trick`
   questions these become the corrective phrases (`"not"`, `"don't"`,
   `"no boss"`).
4. Run with `RAG_BENCH_WRITE_BASELINE=1` to capture the new question's
   pass/fail state into the canonical baseline. Subsequent runs will then
   regression-check it.

## Updating the baseline

The canonical baseline at `tests/benchmarks/baselines/rag-accuracy.json` is
the regression boundary, not a snapshot. Update it only when:

- You intentionally changed retrieval, regex, or the question set.
- You're satisfied that recoveries (was-fail-now-pass) are real and
  regressions (was-pass-now-fail) are intentional.

```bash
RAG_BENCH=1 RAG_BENCH_WRITE_BASELINE=1 \
  npx vitest run tests/benchmarks/rag-accuracy.test.ts
```

After writing, eyeball the diff vs the previous baseline. Per-question
flips should match what you intended.

## Open work

### Answer streaming

The `/api/guides/answer` endpoint currently waits for the full synth output
before responding (~1s p50, up to ~3s on long answers). Switching to a
streaming response (Server-Sent Events or chunked transfer) would cut
perceived latency dramatically — first-token-time on qwen3:0.6b/1.7b is
~200-300ms, vs the ~1s a user waits today.

Implementation surface:
- `OllamaService.synthesize` (or wherever the chat call lives) → use the
  `stream: true` Ollama endpoint and yield tokens.
- `/api/guides/answer` route → hold the response open and write each token
  as an SSE event or a chunk.
- Client (mobile app + admin panel) → consume the stream incrementally.
- Bench: a streaming response changes `timing_ms.synthesize` semantics
  (TTFT vs total). Track both — TTFT is the user-perceived metric, total
  is the resource cost.

This is the largest perceived-latency win available without changing the
model.

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `RAG_BENCH` | (unset) | Must be `1` for the suite to run at all |
| `RAG_BENCH_BASE_URL` | `http://localhost:3000` | Server to bench against |
| `RAG_BENCH_TOP_K` | `8` | Citations to consider for recall |
| `RAG_BENCH_DELAY_MS` | `5000` | Inter-question pacing (rate-limit friendly) |
| `RAG_BENCH_FETCH_TIMEOUT_MS` | `180000` | Per-request timeout |
| `RAG_BENCH_TEST_TIMEOUT_MS` | fetch + 30s | Vitest deadline |
| `RAG_BENCH_RECALL_FLOOR` | `0.55` | Aggregate-recall drift catch |
| `RAG_BENCH_WRITE_BASELINE` | (unset) | `1` to overwrite canonical baseline |
| `RAG_BENCH_HISTORY_PATH` | (unset) | Path to write a time-series snapshot |
| `RAG_BENCH_HISTORY_LABEL` | (unset) | Human-readable snapshot label |
| `RAG_BENCH_GUIDES_INDEXED` | (unset) | Stamped into snapshot metadata |
| `RAG_BENCH_EMBEDDINGS_COUNT` | (unset) | Stamped into snapshot metadata |
