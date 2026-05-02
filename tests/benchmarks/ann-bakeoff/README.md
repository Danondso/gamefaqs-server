# ANN bake-off

Phase 1 of the plan in `TODO.md` and `/home/dublin/.claude/plans/sorted-prancing-zebra.md`.
Picks between USearch HNSW i8 and libSQL DiskANN (i8, f8) on numbers, not vibes.

## Constraints honored by this harness

- The main `gamefaqs.db` is opened **read-only**; never written to. Candidate
  indexes go in `scratch/ann/` (gitignored).
- No re-embedding. The ~50 query vectors are produced once via
  `EmbeddingService.embed()`; the rest are sampled from the existing dump.
- One scale: full current dataset (~3.7M as of writing). The 7M (2×) check
  happens after the bake-off picks a winner.
- Pause-resume the running indexer around Step 0 and Step 1 to avoid disk
  contention. The indexer is checkpointed; resume is a no-op.

## Run order

```bash
# 0 — Snapshot inputs (~10 min, ~8 of which is ground-truth compute)
RAG_BENCH=1 npx ts-node tests/benchmarks/ann-bakeoff/snapshot.ts

# 1 — Build candidates (sequential, ~30–60 min total)
RAG_BENCH=1 npx ts-node tests/benchmarks/ann-bakeoff/usearch.ts build
RAG_BENCH=1 npx ts-node tests/benchmarks/ann-bakeoff/libsql.ts build i8
RAG_BENCH=1 npx ts-node tests/benchmarks/ann-bakeoff/libsql.ts build f8

# 2 — Query each candidate, no memory cap
RAG_BENCH=1 npx ts-node tests/benchmarks/ann-bakeoff/run.ts query

# 3 — Same as 2, with a 13 GB RAM cap
systemd-run --user --scope -p MemoryMax=13G -p MemorySwapMax=0 -p CPUQuota=800% \
  -- npx ts-node tests/benchmarks/ann-bakeoff/run.ts query --capped
```

## Files produced in `scratch/ann/`

| File | Purpose |
|---|---|
| `vectors.bin` | flat `f32[768]` per chunk, in sequential-id order |
| `chunk_ids.txt` | one nanoid per line; line N == sequential id N |
| `queries.bin` | 50 query vectors + labels for traceability |
| `ground_truth.json` | brute-force top-20 per query (sequential ids) |
| `usearch_i8.bin` | USearch HNSW i8 index |
| `libsql_i8.db` | libSQL DiskANN i8 index (own SQLite file) |
| `libsql_f8.db` | libSQL DiskANN f8 index (own SQLite file) |

## Pilot mode

`snapshot.ts --pilot` uses 5000 vectors and 5 queries — validates the
harness end-to-end in ~30 s before paying the ~8 min ground-truth budget
on the full set.

## Acceptance gate

A candidate must hit **recall@20 ≥ 0.90** and **p95 ≤ 500 ms** at full
scale under the 13 GB cap. Lower p95 wins ties; smaller on-disk size
breaks further ties. All three failing escalates to USearch f16 as a
fallback (still fits memory math).
