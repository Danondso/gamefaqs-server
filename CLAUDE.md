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
DB_PATH=/data/db/gamefaqs.db # SQLite database path
ADMIN_TOKEN=                 # Optional admin authentication
OLLAMA_HOST=http://localhost:11434  # Optional AI integration
```

## Development Notes

- TypeScript strict mode enabled
- No test suite currently configured
- Initialization downloads ~12GB, extracts to ~15GB, creates ~5-10GB database (needs ~30GB disk)
- Admin panel at `/admin` shows real-time initialization progress via SSE
