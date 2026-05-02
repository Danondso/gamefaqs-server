# TODO

## Vector retrieval performance — needs a real ANN index

`chunk_embeddings_v2` (sqlite-vec vec0) does brute-force KNN over ~3.7M
embeddings. Warm cache is ~10s/query, cold cache is ~35s. That floor is the
biggest contributor to slow `/api/guides/answer` latency.

What we tried:
- **`partition_by` (migration v8)**: partitioned the vec table on `games.rowid`
  hoping per-partition KNN would scope the scan. It doesn't — sqlite-vec 0.1.9
  treats `partition_by` as a metadata column, not a scoped index. Per-partition
  KNN was no faster than global. The column stays on the table but goes unused
  by RetrievalService.

What's left to evaluate:
- **`libsql_vector_idx` (Turso fork of SQLite)**: native HNSW. Smallest code
  delta if their sync wrapper is mature enough; otherwise the API change
  (sync → async) ripples through every model/service/migration call site.
- **LanceDB alongside SQLite**: keep current code, run LanceDB just for
  vectors. Best HNSW perf, but maintain two stores and sync chunk inserts.
- **DuckDB + `vss`**: HNSW + columnar. Bigger SQL rewrite (different dialect,
  no FTS5 — DuckDB has its own FTS).
- **pgvector**: most battle-tested, but means running a server.

Validate ANN perf with a representative dataset *before* committing to a
migration this time — the v8 partition_by attempt cost ~110 minutes of disk
I/O and produced no speed-up because the small-scale probe didn't catch the
real behavior.
