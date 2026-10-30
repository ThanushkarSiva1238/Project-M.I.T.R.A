/**
 * Central configuration. Nothing secret is hard-coded here: secrets and AI
 * provider settings come from environment variables (.env file).
 *
 * AI settings are read lazily (ai()) so a key saved from the Settings screen
 * takes effect without restarting the server.
 */
const path = require('path');

const ROOT = __dirname;
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });

const DATA_DIR = path.resolve(process.env.MITRA_DATA_DIR || path.join(ROOT, 'data'));

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

module.exports = {
  ROOT,
  ENV_FILE: process.env.MITRA_ENV_FILE || path.join(ROOT, '.env'),
  DATA_DIR,
  DB_PATH: path.join(DATA_DIR, 'mitra.db'),
  UPLOAD_DIR: path.join(DATA_DIR, 'uploads'),
  BACKUP_DIR: path.join(DATA_DIR, 'backups'),
  TMP_DIR: path.join(DATA_DIR, 'tmp'),
  OCR_CACHE_DIR: path.join(DATA_DIR, 'ocr-cache'),
  PUBLIC_DIR: path.join(ROOT, 'public'),
  HOST: process.env.HOST || '127.0.0.1',
  PORT: Number(process.env.PORT) || 3000,
  MAX_UPLOAD_BYTES: num(process.env.MAX_UPLOAD_MB, 20) * 1024 * 1024,
  MAX_RESTORE_BYTES: num(process.env.MAX_RESTORE_MB, 1024) * 1024 * 1024,
  OCR_LANGS: process.env.OCR_LANGS || 'eng',
  APP_VERSION: require('./package.json').version,

  /** Current AI settings, re-read from the environment on every call. */
  ai() {
    const e = process.env;
    return {
      provider: (e.AI_PROVIDER || 'anthropic').trim().toLowerCase(),
      apiKey: (e.AI_API_KEY || '').trim(),
      model: (e.AI_MODEL || '').trim(),
      baseUrl: (e.AI_BASE_URL || '').trim().replace(/\/+$/, ''),
      timeoutMs: num(e.AI_TIMEOUT_MS, 60000),
      maxInputChars: num(e.AI_MAX_INPUT_CHARS, 6000),
      maxOutputTokens: num(e.AI_MAX_OUTPUT_TOKENS, 2000),
      dailyLimit: num(e.AI_DAILY_LIMIT, 100),
    };
  },
};
