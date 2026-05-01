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
  synthesisModel: process.env.SYNTHESIS_MODEL || 'qwen2.5:7b-instruct',
  // Default 400 tokens is intentionally conservative: nomic-embed-text's hard
  // context limit is 2048 tokens, and our chars/4 estimate undercounts BPE for
  // content with lots of CRLF, abbreviations, or stat tables (real density can
  // be 2-3x the estimate). 400 leaves enough headroom that even pathological
  // content stays under 2048 after chunking + overlap.
  chunkSizeTokens: parseInt(process.env.CHUNK_SIZE_TOKENS || '400', 10),
  chunkOverlapTokens: parseInt(process.env.CHUNK_OVERLAP_TOKENS || '50', 10),
  vectorSearchEnabled: process.env.VECTOR_SEARCH_ENABLED !== 'false',
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
