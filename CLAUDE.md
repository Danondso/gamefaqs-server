# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

GameFAQs Server - A REST API hosting the complete GameFAQs guide archive. Node.js/TypeScript/Express server that downloads and imports the GameFAQs archive (~2.2GB) on first startup, persisting data in SQLite with FTS5 full-text search.

## Build & Run Commands

```bash
npm install              # Install dependencies
npm run dev              # Development with hot reload (nodemon + ts-node)
npm run build            # Compile TypeScript to dist/
npm start                # Run production server (dist/server.js)
npm run docker:build     # Build Docker image
npm run docker:run       # Start with docker-compose
npm run mcp              # Run MCP server (stdio) against local SQLite
npm run mcp:start        # Run compiled MCP server (dist/mcp-server.js)
npm run docker:mcp:build # Build MCP server Docker image (Dockerfile.mcp)
```

## Architecture

### Core Layers

**Database (`src/database/`)**: `Database` singleton wraps better-sqlite3 with prepared statements, transactions, WAL mode, and FTS5 virtual tables for search.

**Models (`src/models/`)**: Active Record pattern with `GuideModel` and `GameModel` providing CRUD, search, pagination, and bulk operations.

**Services (`src/services/`)**:
- `InitService` - Orchestrates startup: download → extract → import
- `ArchiveDownloadService` - Streaming HTTP downloads with progress callbacks
- `ArchiveExtractor` - ZIP + 7z extraction
- `GuideImporter` - Recursive directory scan, batch database inserts. Composes guide title as `${gameName}` or `${gameName} — ${author}` (the parser's content-extracted title is unreliable — banners/bylines slip through); the original parsed title is preserved in `metadata.original_title`. The `cleanAuthor` filter (length 2..60, no `|=>` chars, ≤ 5 spaces) must stay in sync with the SQL CASE in the migration v5 title relabel.
- `GuideParser` - Extracts metadata from guide files. `titleCaseGameName()` handles lowercase particles (`of`, `the`, ...) and uppercases roman numerals II..XX (so `final-fantasy-vii` → `Final Fantasy VII`).
- `Chunker` / `IndexingService` / `EmbeddingService` - RAG indexing pipeline. Indexing writes chunks to SQLite (inside a per-guide transaction) and the embedding to `AnnIndex` (USearch HNSW i8) outside the transaction — vectors live in the ANN file, never in SQLite.
- `AnnIndex` (`src/services/AnnIndex.ts`) - USearch HNSW i8 wrapper keyed by `chunks.rowid`. Backing file at `${dbPath}.ann`; loaded at startup or starts empty for the indexer to populate. Saves periodically during indexing (every `ANN_SAVE_EVERY_GUIDES`) and on shutdown via `Database.close()`.
- `RetrievalService` - Hybrid retrieval over four sources fused with reciprocal-rank: (1) vector KNN via `AnnIndex` (returns chunk rowids → hydrated to chunk_ids), (2) BM25 over `chunks_fts` with **rare-token filtering** via `chunks_fts_vocab` — tokens whose document frequency exceeds 5% of the corpus are dropped before BM25, capped at the rarest 5 tokens (this single change cut chunk-FTS p50 from 1.4s → 144ms post-USearch), (3) title-aware BM25 over `guides_fts_meta` (every chunk of a title-matched guide enters fusion at the guide's title rank), (4) **game-match** via `games_fts` — `defaultGameMatch` walks the question's n-grams (n=5..2) right-to-left, tries each as a phrase query (with Roman/Arabic numeral aliases like `Diablo 2 ↔ Diablo II`), and skips n-grams whose first or last token is a stopword. Matched game_ids expand to all chunks of all guides for those games and enter RRF at rank 0 with `gameMatchRrfK=10` (~5× the title-FTS boost). The stopword-endpoint filter is what prevents phrases like `the best` and `the temple` from matching incidental titles ("Best of the Best Championship Karate", "Indiana Jones and the Temple of Doom"). See `BENCHMARKING.md` for the full design rationale and the time-series that motivated each piece.
- `AnswerService` / `SynthesisService` / `OllamaService` - Question answering on top of retrieval. Synthesis runs against `SYNTHESIS_MODEL` (default `qwen3:1.7b`) via Ollama; the smaller model trades off some refusal discipline on edge cases (trick / unanswerable questions) for ~40% faster synth latency.

**Routes (`src/routes/`)**: Express routers for `/api/health`, `/api/guides`, `/api/games`, `/api/admin`

**MCP Server (`src/mcp-server.ts`)**: Separate stdio entry point exposing archive search/read tools to AI assistants. Has two modes selected by `GAMEFAQS_API_URL`: unset → opens local SQLite via `Database.initialize` and uses models directly; set → skips DB init and proxies all reads through the REST API of a running server. Both modes go through the same `ds*` wrapper functions so tool handlers stay mode-agnostic.

### Key Patterns

- **Error Handling**: Use `next(error)` in route handlers; custom errors need `statusCode` and `code` properties
- **Logging**: All console logs use ISO timestamps with category prefixes: `[Server]`, `[Database]`, `[Init]`, etc.
- **Status Management**: `InitService` uses observable pattern with `onStatusChange()` for SSE streaming
- **Pagination**: Query params `page` & `limit` on list endpoints
- **Admin Auth**: Optional `ADMIN_TOKEN` env var; checked via query param or `Authorization: Bearer` header

### Database Schema

Core tables: `guides`, `games`, `bookmarks`, `notes`, `achievements`, `schema_version`.
RAG / search tables: `chunks`, `chunks_fts` (FTS5 over chunk content), `guides_fts_meta` (FTS5 over guide title + tags), `games_fts` (FTS5 over `games.title` for direct game-name lookup at retrieval time), plus fts5vocab views `chunks_fts_vocab` and `guides_fts_meta_vocab` for rare-token filtering. Vectors live in the ANN file `${dbPath}.ann`, not in SQLite.

Current `SCHEMA_VERSION` is **5**. Schema changes require a new migration in `src/database/migrations.ts`.

Migration v5 is the RAG bring-up: it adds the `chunks` table with `chunks_fts` + insert/delete triggers, the `chunks_fts_vocab` and `guides_fts_meta_vocab` fts5vocab views (read-only, used by `RetrievalService.filterToRareChunkTokens` / `filterToRareTitleTokens` to drop common tokens in O(log n) per token), the `guides.indexed_at` checkpoint column with composite index `(indexed_at, id)` for the indexer's prefetch cursor, the `games_fts` virtual table (FTS5 over `games.title` with insert/update/delete triggers + backfill, powering `RetrievalService.defaultGameMatch`), and a one-shot relabel of existing guide titles to `${games.title}` (optionally `— ${author}`) with the old title stashed in `metadata.original_title`. The relabel is idempotent — rows with `original_title` set are skipped, so it's a no-op on fresh DBs and safe to re-run. Without `games_fts`, "name the game" questions like "How do I beat the Elite Four in Pokemon Red?" had to rely on title-FTS, where the rare-token filter drops game-name tokens (`pokemon` df=675) in favor of action verbs (`beat` df=41) and surfaces the wrong games.

### ANN index

The vector store is **USearch HNSW i8** in a single file at `${dbPath}.ann` (override with `ANN_INDEX_PATH`). Keyed by `chunks.rowid`. Picked over libSQL DiskANN and other candidates in a one-time bake-off (recall@8 84-87% end-to-end, p95 vec latency 7ms, 3.3 GB on disk for 3.7M vectors).

On startup, `DatabaseService.openAnnIndex()`:
1. Loads `${dbPath}.ann` if it exists (~3s for a 3 GB file).
2. Otherwise, starts empty for the indexer to populate.

The ANN file is *not* part of SQLite ACID. A crash during indexing can leave the index missing the in-flight guide's chunks; recovery is to delete the .ann file and let the indexer re-embed any chunks lacking ANN entries on the next run. Periodic save cadence is `ANN_SAVE_EVERY_GUIDES` (default 100).

## Environment Variables

```bash
PORT=3000                    # HTTP port
DB_PATH=/data/db/gamefaqs.db # SQLite database path (ignored by MCP server in remote mode)
ADMIN_TOKEN=                 # Optional admin authentication (gates /api/admin/* only)
OLLAMA_HOST=http://localhost:11434  # Optional AI integration
GAMEFAQS_API_URL=            # Optional — when set, MCP server proxies to this REST API instead of opening local DB
ANN_INDEX_PATH=              # Optional override for the ANN file location (default `${DB_PATH}.ann`)
ANN_M=16                     # USearch HNSW connectivity (graph degree)
ANN_EF_ADD=200               # USearch ef_construction
ANN_EF_SEARCH=256            # USearch ef_search at query time (higher = better recall, slightly slower)
ANN_SAVE_EVERY_GUIDES=100    # How often the indexer flushes the ANN file to disk
```

## Development Notes

- TypeScript strict mode enabled
- Tests run via `npm test` (vitest, run-once) or `npm run test:watch`. Test layout: unit tests under `tests/`, integration tests under `tests/integration/`, RAG accuracy benchmarks under `tests/benchmarks/`.
- RAG retrieval quality is tracked by `tests/benchmarks/rag-accuracy.test.ts` (gated behind `RAG_BENCH=1`, run via `npm run rag:bench`). The canonical regression baseline is `tests/benchmarks/baselines/rag-accuracy.json`; per-corpus-state snapshots live under `tests/benchmarks/history/`. See `BENCHMARKING.md` for the full design (kind taxonomy, regex matching, baseline vs history files, the games_fts research log, and the 50k indexing run that took specific recall from 62.5% → 100%).
- Initialization downloads ~2.2GB, extracts to ~15GB, creates ~5-10GB database (needs ~30GB disk)
- Admin panel at `/admin` shows real-time initialization progress via SSE
