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
```

## First Startup Behavior

When the server starts for the first time with an empty database:

1. **Download** (~2.2GB ZIP from Internet Archive)
2. **Extract** (ZIP → 9 nested 7z archives → ~10GB uncompressed)
3. **Import** (Parse and import all guides to SQLite)
4. **Cleanup** (Delete temporary files)

**Total time:** 20-40 minutes depending on system performance

**Subsequent startups:** Instant (<5 seconds) - database persists

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
