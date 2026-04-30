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
  chunkSizeTokens: parseInt(process.env.CHUNK_SIZE_TOKENS || '800', 10),
  chunkOverlapTokens: parseInt(process.env.CHUNK_OVERLAP_TOKENS || '100', 10),
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
