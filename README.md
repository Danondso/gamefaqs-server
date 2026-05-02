# GameFAQs Server

A REST API server that hosts the complete GameFAQs guide archive. On first startup, the server automatically downloads the archive from Internet Archive (~2.2GB), extracts it, and imports all guides to SQLite. The server provides REST API endpoints for the mobile app plus a web-based admin panel for monitoring and management.

## Architecture

- **Server:** Node.js/TypeScript/Express with SQLite database
- **Database:** better-sqlite3 with FTS5 for full-text search
- **First Run:** Automatic download → extract → import (20-40 minutes)
- **Deployment:** Docker container with persistent volume storage
- **Admin Panel:** Real-time progress monitoring via Server-Sent Events
- **AI Integration:** Optional Ollama for metadata extraction/fixing

## Getting Started

### Prerequisites

- Node.js 20+ (for local development)
- Docker (for containerized deployment)
- ~30GB free disk space (25-30GB during init, ~5-10GB after)

### Local Development

```bash
# Install dependencies
npm install

# Start development server (hot reload)
npm run dev

# Build TypeScript
npm run build

# Run production build
npm start
```

### Docker Deployment

```bash
# Build and start
npm run docker:build
npm run docker:run

# Or with docker-compose directly
docker-compose up --build

# Monitor initialization progress
open http://localhost:3000/admin

# Watch logs
docker-compose logs -f gamefaqs-server
```

### Environment Variables

```bash
# Server Configuration
PORT=3000                    # HTTP port (default: 3000)
NODE_ENV=production          # Environment mode

# Database
DB_PATH=/data/db/gamefaqs.db # Database file path

# Archive Download
ARCHIVE_URL=https://archive.org/download/Gamespot_Gamefaqs_TXTs/Gamespot_Gamefaqs_TXTs.zip
TEMP_DIR=/tmp/gamefaqs        # Temporary extraction directory

# Admin Panel Security (optional)
ADMIN_TOKEN=                  # Token to protect admin panel (empty = open access)

# Ollama AI Integration (optional)
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=llama3.2

# MCP Server (optional)
GAMEFAQS_API_URL=             # If set, MCP server proxies to this REST API instead of opening the local DB
```

## First Startup Behavior

When the server starts for the first time with an empty database:

1. **Download** (~2.2GB ZIP from Internet Archive)
2. **Extract** (ZIP → 9 nested 7z archives → ~10GB uncompressed)
3. **Import** (Parse and import all guides to SQLite)
4. **Cleanup** (Delete temporary files)

**Total time:** 20-40 minutes depending on system performance

**Subsequent startups:** Instant (<5 seconds) - database persists. Migrations run automatically; upgrading an existing DB to schema v7 will relabel guide titles in-place to `Game Name` or `Game Name — Author` (the previous content-extracted titles often picked up ASCII banners or bylines). The original parsed title is preserved on each row under `metadata.original_title`.

### Guide title format

Guide titles returned by the API are derived from the linked game's name rather than the guide file's content, so titles in `/api/guides/*` responses look like `Final Fantasy VII` or `Final Fantasy VII — SomeAuthor`. This also makes the `/api/guides/answer` retriever more reliable for game-named questions: a title-aware BM25 source is fused with vector + content FTS, so chunks from the right guide get boosted even when the chunk text doesn't repeat the game's name.

## API Documentation

Interactive API docs available at **`/api-docs`** when the server is running:

- **Local:** http://localhost:3000/api-docs
- **Docker:** http://localhost:3000/api-docs

Swagger UI lists all endpoints with request/response schemas and live testing.

## API Endpoints

### Health & Status
- `GET /api/health` - Basic health check
- `GET /api/health/ready` - Kubernetes readiness probe (503 until initialized)
- `GET /api/health/live` - Kubernetes liveness probe
- `GET /api/health/stats` - Database statistics

### Guides
- `GET /api/guides` - List guides (paginated)
- `GET /api/guides/search?q=query` - Full-text search
- `GET /api/guides/:id` - Get guide with full content
- `GET /api/guides/:id/content` - Get guide content only
- `GET /api/guides/:id/metadata` - Get guide metadata only
- `PUT /api/guides/:id/position` - Update last read position

### Games
- `GET /api/games` - List games (paginated)
- `GET /api/games/with-guides` - Games with guide counts
- `GET /api/games/search?q=query` - Search by title
- `GET /api/games/:id` - Get game details
- `GET /api/games/:id/guides` - Get all guides for game
- `PUT /api/games/:id/status` - Update game status
- `PUT /api/games/:id/completion` - Update completion percentage

### Admin (Protected by ADMIN_TOKEN)
- `GET /admin` - Admin panel HTML
- `GET /api/admin/status` - Server status
- `GET /api/admin/stats` - Statistics
- `GET /api/admin/status/stream` - SSE live updates

## Storage Requirements

- **During initialization:**
  - Download: 2.2GB (deleted after extraction)
  - Extraction: ~15GB peak (files deleted progressively during import)
  - Database: ~5-10GB persistent (with FTS5 index)
  - **Total: ~25-30GB peak**

- **After initialization:**
  - Database only: ~5-10GB

- **Recommended:** 30GB+ free disk space

### If you get "database or disk is full"

1. **Increase Docker Desktop disk:** Settings → Resources → increase "Virtual disk limit" to 64GB+
2. **Use host volumes** (more space): In `docker-compose.yml`, replace:
   ```yaml
   - gamefaqs-data:/data/db
   - gamefaqs-temp:/tmp/gamefaqs
   ```
   with:
   ```yaml
   - ./data:/data/db
   - ./temp:/tmp/gamefaqs
   ```
3. **Clean up and retry:** `docker compose down -v` then `docker compose up --build`

## FTS5 Support

**CRITICAL:** `better-sqlite3` must be compiled with FTS5 support for full-text search to work.

**Verify FTS5 support:**
```bash
node -e "const db = require('better-sqlite3')(':memory:'); db.prepare('CREATE VIRTUAL TABLE test USING fts5(content)').run(); console.log('FTS5 supported!');"
```

## Ollama AI Integration (Optional)

Ollama provides AI-powered metadata extraction for guides with incomplete or incorrect metadata.

**Setup:**
```bash
# Start Ollama container
docker run -d -p 11434:11434 --name ollama ollama/ollama

# Pull model
docker exec ollama ollama pull llama3.2
```

## Admin Panel Security

**Development/Home Lab:**
- Leave `ADMIN_TOKEN` empty for open access
- Suitable when behind firewall

**Production:**
- Set `ADMIN_TOKEN` environment variable
- Access with query parameter: `?token=your-token`
- Or Authorization header: `Bearer your-token`

**Generate secure token:**
```bash
# macOS/Linux
export ADMIN_TOKEN=$(uuidgen)

# Or with Node
node -e "console.log(require('crypto').randomUUID())"
```

## Performance Notes

- **Memory:** 200-500MB normal, 1-2GB during extraction
- **CPU:** Multi-core beneficial for 7z extraction
- **Disk I/O:** Using tmpfs for /tmp/gamefaqs speeds up extraction

**Docker memory limits:**
```yaml
services:
  gamefaqs-server:
    mem_limit: 2G
    mem_reservation: 512M
```

## MCP Server

An MCP (Model Context Protocol) server is included so AI assistants can search and read the archive directly. It exposes six tools: `search_guides`, `search_games`, `read_guide`, `get_game`, `browse_guides`, and `get_archive_stats`.

**Run modes:**

```bash
# Local mode — opens the SQLite DB directly (DB_PATH must be readable)
npm run mcp

# Remote mode — proxies all reads to a running gamefaqs-server REST API.
# Useful when the MCP host doesn't have the ~5-10GB database locally.
GAMEFAQS_API_URL=http://your-server:3000 npm run mcp
```

In remote mode the MCP process never opens SQLite, so it works on machines without `DB_PATH`. The remote server's `/api/guides` and `/api/games` endpoints are unauthenticated, so no token is required even when `ADMIN_TOKEN` is set on the remote box.

**Production build:**
```bash
npm run build
GAMEFAQS_API_URL=http://your-server:3000 npm run mcp:start
```

### Docker

A separate `Dockerfile.mcp` builds an image that runs the MCP server over stdio. No port is exposed; the AI client launches `docker run` and pipes stdin/stdout.

```bash
# Build once
npm run docker:mcp:build

# Remote mode — point at a running gamefaqs-server. No volume needed.
docker run --rm -i \
  -e GAMEFAQS_API_URL=http://your-server:3000 \
  gamefaqs-mcp

# Local mode — share the SQLite volume with the main server container.
docker run --rm -i \
  -v gamefaqs-data:/data/db \
  gamefaqs-mcp
```

**Wiring into an MCP client (e.g. Claude Desktop):**

```json
{
  "mcpServers": {
    "gamefaqs": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "-e", "GAMEFAQS_API_URL=http://your-server:3000",
        "gamefaqs-mcp"
      ]
    }
  }
}
```

The `-i` flag is required (stdin must stay open). Don't add `-t`; the AI client isn't a TTY.

## Related Projects

- **Mobile App:** [gamefaqs-reader](../gamefaqs-reader/) - React Native mobile app
- **Archive Source:** [GameFAQs TXT Archive](https://archive.org/details/Gamespot_Gamefaqs_TXTs) on Internet Archive

## Technical Stack

| Component | Choice | Reason |
|-----------|--------|--------|
| HTTP Client | axios | Simple streaming downloads with progress tracking |
| ZIP Extraction | yauzl | Streaming-focused, memory efficient |
| SQLite Library | better-sqlite3 | Synchronous, faster for server (requires FTS5) |
| 7z Extraction | node-7z | Wraps p7zip binary (installed via Docker) |
| Admin Security | Token auth | Optional token via environment variable |
| AI Integration | Ollama | Local LLM for metadata extraction |

## License

ISC
