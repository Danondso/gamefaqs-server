import * as path from 'path';

export const config = {
  // Server settings
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',

  // Database
  dbPath: process.env.DB_PATH || '/data/db/gamefaqs.db',

  // Archive settings
  archiveUrl: process.env.ARCHIVE_URL || 'https://archive.org/compress/Gamespot_Gamefaqs_TXTs/formats=7Z&file=/Gamespot_Gamefaqs_TXTs.zip',
  tempDir: process.env.TEMP_DIR || '/tmp/gamefaqs',
  // Where the downloaded archive lives. Decoupled from tempDir so an operator
  // can mount this from a stable host path and survive `docker compose down -v`
  // without losing the ~12 GB download. Falls back to tempDir for backwards
  // compatibility. The directory will be created if missing; the archive file
  // inside is reused on next start when its size matches the remote size.
  archiveDir: process.env.ARCHIVE_DIR || process.env.TEMP_DIR || '/tmp/gamefaqs',
  // Set KEEP_ARCHIVE=true to retain gamefaqs_archive.zip after extraction so a
  // future fresh setup can skip the ~12 GB download. Default deletes it after
  // extract to free disk during import.
  keepArchive: process.env.KEEP_ARCHIVE === 'true',

  // Admin panel security (optional)
  adminToken: process.env.ADMIN_TOKEN, // Set to protect admin panel

  // MCP server: when set, the MCP server proxies to this REST API instead of opening the local DB.
  // Example: GAMEFAQS_API_URL=http://my-server:3000
  mcpApiUrl: process.env.GAMEFAQS_API_URL,

  // Ollama AI integration (optional)
  ollamaHost: process.env.OLLAMA_HOST || 'http://localhost:11434',
  ollamaModel: process.env.OLLAMA_MODEL || 'llama3.2',

  // RAG / answer feature
  embeddingHost: process.env.EMBEDDING_OLLAMA_HOST || process.env.OLLAMA_HOST || 'http://localhost:11434',
  embeddingModel: process.env.EMBEDDING_MODEL || 'nomic-embed-text',
  embeddingDim: parseInt(process.env.EMBEDDING_DIM || '768', 10),
  synthesisHost: process.env.SYNTHESIS_OLLAMA_HOST || process.env.OLLAMA_HOST || 'http://localhost:11434',
  synthesisModel: process.env.SYNTHESIS_MODEL || 'qwen3:30b-a3b-instruct-2507-q4_K_M',
  // Default 400 tokens is intentionally conservative: nomic-embed-text's hard
  // context limit is 2048 tokens, and our chars/4 estimate undercounts BPE for
  // content with lots of CRLF, abbreviations, or stat tables (real density can
  // be 2-3x the estimate). 400 leaves enough headroom that even pathological
  // content stays under 2048 after chunking + overlap.
  chunkSizeTokens: parseInt(process.env.CHUNK_SIZE_TOKENS || '400', 10),
  chunkOverlapTokens: parseInt(process.env.CHUNK_OVERLAP_TOKENS || '50', 10),
  // Chunker dispatch: 'v1' (legacy greedy paragraph packer) | 'v2' (type-aware,
  // emits content_type/section_heading per chunk). v1 is the default until
  // Phase 5's bench shows v2 improvement on the live corpus; flip via
  // CHUNKER_VERSION=v2 to opt newly-indexed guides into v2 without re-indexing
  // already-indexed ones (mixed populations are fine — schema v11 defaults
  // legacy rows to content_type='prose'). See CHUNKER_DESIGN.md.
  chunkerVersion: (process.env.CHUNKER_VERSION === 'v2' ? 'v2' : 'v1') as 'v1' | 'v2',
  // ANN (USearch HNSW i8). Default file lives next to the SQLite db so a
  // single mount covers both. Knobs match the bake-off run that picked
  // USearch i8 (recall@8 87% end-to-end vs the brute-force baseline,
  // p95 vec latency 7ms).
  annIndexPath: process.env.ANN_INDEX_PATH, // defaults to `${dbPath}.ann` if unset
  annM: parseInt(process.env.ANN_M || '16', 10),
  annEfAdd: parseInt(process.env.ANN_EF_ADD || '200', 10),
  annEfSearch: parseInt(process.env.ANN_EF_SEARCH || '256', 10),
  // Periodic save cadence for the ANN index during ingest. Saving the full
  // file is ~2s for a 3 GB index; saving every 100 indexed guides keeps
  // crash-recovery loss bounded to ~100 guides without pegging IO.
  annSaveEveryGuides: parseInt(process.env.ANN_SAVE_EVERY_GUIDES || '100', 10),
  ragTopK: parseInt(process.env.RAG_TOP_K || '8', 10),
  answerRateLimitPerMin: parseInt(process.env.ANSWER_RATE_LIMIT || '10', 10),

  // Pagination
  maxPageSize: 100,
  defaultPageSize: 20,

  // Development mode
  isDev: process.env.NODE_ENV !== 'production',

  // CORS: in production, set CORS_ORIGIN to restrict (e.g. "https://app.example.com" or comma-separated list)
  corsOrigin: process.env.CORS_ORIGIN,
};

// Ensure directories are absolute paths for Docker volumes
export function ensureAbsolutePath(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}
