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

  // Ollama AI integration (optional)
  ollamaHost: process.env.OLLAMA_HOST || 'http://localhost:11434',
  ollamaModel: process.env.OLLAMA_MODEL || 'llama3.2',

  // Pagination
  maxPageSize: 100,
  defaultPageSize: 20,

  // Development mode
  isDev: process.env.NODE_ENV !== 'production',
};

// Ensure directories are absolute paths for Docker volumes
export function ensureAbsolutePath(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}
