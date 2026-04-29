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
- `GuideImporter` - Recursive directory scan, batch database inserts
- `GuideParser` - Extracts metadata from guide files

**Routes (`src/routes/`)**: Express routers for `/api/health`, `/api/guides`, `/api/games`, `/api/admin`

**MCP Server (`src/mcp-server.ts`)**: Separate stdio entry point exposing archive search/read tools to AI assistants. Has two modes selected by `GAMEFAQS_API_URL`: unset → opens local SQLite via `Database.initialize` and uses models directly; set → skips DB init and proxies all reads through the REST API of a running server. Both modes go through the same `ds*` wrapper functions so tool handlers stay mode-agnostic.

### Key Patterns

- **Error Handling**: Use `next(error)` in route handlers; custom errors need `statusCode` and `code` properties
- **Logging**: All console logs use ISO timestamps with category prefixes: `[Server]`, `[Database]`, `[Init]`, etc.
- **Status Management**: `InitService` uses observable pattern with `onStatusChange()` for SSE streaming
- **Pagination**: Query params `page` & `limit` on list endpoints
- **Admin Auth**: Optional `ADMIN_TOKEN` env var; checked via query param or `Authorization: Bearer` header

### Database Schema

Tables: `guides`, `games`, `bookmarks`, `notes`, `achievements`, `schema_version`, `guides_fts` (FTS5)

Schema changes require migrations in `src/database/migrations.ts`.

## Environment Variables

```bash
PORT=3000                    # HTTP port
DB_PATH=/data/db/gamefaqs.db # SQLite database path (ignored by MCP server in remote mode)
ADMIN_TOKEN=                 # Optional admin authentication (gates /api/admin/* only)
OLLAMA_HOST=http://localhost:11434  # Optional AI integration
GAMEFAQS_API_URL=            # Optional — when set, MCP server proxies to this REST API instead of opening local DB
```

## Development Notes

- TypeScript strict mode enabled
- No test suite currently configured
- Initialization downloads ~12GB, extracts to ~15GB, creates ~5-10GB database (needs ~30GB disk)
- Admin panel at `/admin` shows real-time initialization progress via SSE
