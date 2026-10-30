/**
 * SQLite access (better-sqlite3).
 *
 * The exported `db` is a thin handle that always delegates to the *current*
 * connection, so the backup/restore service can close and re-open the database
 * without every route holding a stale reference.
 *
 * Migrations: schema.sql is version 1; files in database/migrations named
 * NNN_description.sql (NNN >= 002) are applied in order, each in a transaction,
 * and recorded in schema_migrations.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');

const SCHEMA_FILE = path.join(__dirname, 'schema.sql');
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

let conn = null;

function migrationList() {
  const list = [{ version: 1, name: 'baseline', file: SCHEMA_FILE }];
  if (fs.existsSync(MIGRATIONS_DIR)) {
    for (const f of fs.readdirSync(MIGRATIONS_DIR).sort()) {
      const m = /^(\d{3,})_(.+)\.sql$/.exec(f);
      if (!m) continue;
      const version = Number(m[1]);
      if (version < 2) continue;
      list.push({ version, name: m[2], file: path.join(MIGRATIONS_DIR, f) });
    }
  }
  return list.sort((a, b) => a.version - b.version);
}

/** Highest schema version this copy of MITRA understands. */
function latestVersion() {
  const list = migrationList();
  return list[list.length - 1].version;
}

function migrate(d) {
  d.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`);
  const applied = new Set(d.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
  for (const m of migrationList()) {
    if (applied.has(m.version)) continue;
    const sql = fs.readFileSync(m.file, 'utf8');
    d.transaction(() => {
      d.exec(sql);
      d.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(m.version, m.name);
    })();
  }
}

function seedBuiltinTerms(d) {
  const { BUILTIN_TERMS } = require('./seed-terms');
  const insert = d.prepare(`
    INSERT OR IGNORE INTO psychology_terms
      (term, pronunciation, simple_english, tamil, definition, example, everyday_example, related, origin, verified)
    VALUES (@term, @pronunciation, @simple_english, @tamil, @definition, @example, @everyday_example, @related, 'builtin', 1)`);
  d.transaction(() => {
    for (const t of BUILTIN_TERMS) {
      insert.run({ ...t, related: JSON.stringify(t.related || []) });
    }
  })();
}

function open() {
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
  for (const dir of [config.UPLOAD_DIR, config.BACKUP_DIR, config.TMP_DIR]) fs.mkdirSync(dir, { recursive: true });
  conn = new Database(config.DB_PATH);
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  conn.pragma('busy_timeout = 5000');
  migrate(conn);
  seedBuiltinTerms(conn);
  return db;
}

const db = {
  prepare: (sql) => conn.prepare(sql),
  exec: (sql) => conn.exec(sql),
  pragma: (sql, opts) => conn.pragma(sql, opts),
  transaction: (fn) => conn.transaction(fn),
  /** Online, consistent copy of the database (works while the app is running). */
  backup: (dest) => conn.backup(dest),
  get isOpen() {
    return !!conn && conn.open;
  },
  open,
  close() {
    if (conn && conn.open) {
      try {
        conn.pragma('wal_checkpoint(TRUNCATE)');
      } catch (_) {
        /* ignore: closing anyway */
      }
      conn.close();
    }
  },
  /** Re-open after the database file was replaced (restore). */
  reopen() {
    this.close();
    return open();
  },
  latestVersion,
};

module.exports = db;
