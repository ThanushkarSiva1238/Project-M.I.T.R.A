/**
 * App settings + AI configuration.
 * The API key is write-only: it is saved to the backend .env file and kept in the
 * process environment. It is never returned to the browser.
 */
const fs = require('fs');
const express = require('express');
const config = require('../config');
const db = require('../database/db');
const ai = require('../services/aiService');
const { HttpError, badInput } = require('../lib/errors');
const v = require('../lib/validate');

const router = express.Router();

const DEFAULTS = { theme: 'light', displayName: 'Friend', privacyNoticeSeen: '0' };
const ALLOWED_KEYS = Object.keys(DEFAULTS);

function readAll() {
  const out = { ...DEFAULTS };
  for (const r of db.prepare('SELECT key, value FROM app_settings').all()) if (ALLOWED_KEYS.includes(r.key)) out[r.key] = r.value;
  return out;
}

function snapshot() {
  const s = readAll();
  return {
    theme: s.theme === 'dark' ? 'dark' : 'light',
    displayName: s.displayName,
    privacyNoticeSeen: s.privacyNoticeSeen === '1',
    ai: ai.status(),
    app: { version: config.APP_VERSION, dataDir: config.DATA_DIR, backupDir: config.BACKUP_DIR, host: config.HOST, port: config.PORT },
  };
}

function put(key, value) {
  db.prepare(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).run(key, value);
}

router.get('/', (req, res) => res.json(snapshot()));

router.put('/', (req, res) => {
  const b = req.body || {};
  db.transaction(() => {
    if (b.theme !== undefined) put('theme', v.oneOf(b.theme, 'theme', ['light', 'dark'], { required: true }));
    if (b.displayName !== undefined) put('displayName', v.text(b.displayName, 'Name', { max: 40 }) || 'Friend');
    if (b.privacyNoticeSeen !== undefined) put('privacyNoticeSeen', v.bool(b.privacyNoticeSeen) ? '1' : '0');
  })();
  res.json(snapshot());
});

// ---------------------------------------------------------------- AI config
function upsertEnv(updates) {
  let lines = [];
  try {
    lines = fs.readFileSync(config.ENV_FILE, 'utf8').split(/\r?\n/);
  } catch (_) {
    lines = [];
  }
  const remaining = { ...updates };
  const out = lines.map((line) => {
    const m = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
    if (m && Object.prototype.hasOwnProperty.call(remaining, m[1])) {
      const val = remaining[m[1]];
      delete remaining[m[1]];
      return `${m[1]}=${val}`;
    }
    return line;
  });
  while (out.length && out[out.length - 1] === '') out.pop();
  for (const [k, val] of Object.entries(remaining)) out.push(`${k}=${val}`);
  fs.writeFileSync(config.ENV_FILE, out.join('\n') + '\n', { mode: 0o600 });
}

router.put('/ai', (req, res) => {
  const b = req.body || {};
  const updates = {};
  if (b.provider !== undefined) updates.AI_PROVIDER = v.oneOf(b.provider, 'Provider', ['anthropic', 'openai', 'openai-compatible'], { required: true });
  if (b.model !== undefined) {
    const model = v.text(b.model, 'Model', { max: 100 }) || '';
    if (model && !/^[A-Za-z0-9._:/-]+$/.test(model)) throw badInput('The model name can only contain letters, numbers and . _ : / -');
    updates.AI_MODEL = model;
  }
  if (b.baseUrl !== undefined) {
    const url = v.text(b.baseUrl, 'Base URL', { max: 200 }) || '';
    if (url) {
      let parsed;
      try {
        parsed = new URL(url);
      } catch (_) {
        throw badInput('The base URL is not a valid web address.');
      }
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
      if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) throw badInput('The base URL must start with https:// (http:// is only allowed for localhost).');
      if (/[\s"'\\#$`]/.test(url)) throw badInput('The base URL contains characters that are not allowed.');
    }
    updates.AI_BASE_URL = url.replace(/\/+$/, '');
  }
  if (b.apiKey !== undefined && b.apiKey !== '') {
    const key = String(b.apiKey).trim();
    if (!/^[A-Za-z0-9._~+/=-]{8,400}$/.test(key)) throw badInput('That API key has unexpected characters or is too short. Please copy it again exactly as provided.');
    updates.AI_API_KEY = key;
  }
  if (!Object.keys(updates).length) throw badInput('Nothing to save.');
  try {
    upsertEnv(updates);
  } catch (e) {
    console.error('[settings] could not write .env:', e.code);
    throw new HttpError(500, 'config_write_failed', 'MITRA could not save these settings to the .env file. You can edit the .env file by hand instead (see the README).');
  }
  for (const [k, val] of Object.entries(updates)) process.env[k] = val;
  res.json(snapshot());
});

router.delete('/ai-key', (req, res) => {
  try {
    upsertEnv({ AI_API_KEY: '' });
  } catch (_) {
    throw new HttpError(500, 'config_write_failed', 'MITRA could not update the .env file.');
  }
  process.env.AI_API_KEY = '';
  res.json(snapshot());
});

module.exports = router;
