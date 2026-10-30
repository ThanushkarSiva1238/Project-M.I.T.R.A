/**
 * Backup & restore.
 *
 * A backup is one .zip file in data/backups containing:
 *   manifest.json   what/when/which schema version
 *   mitra.db        a consistent copy of the database (made with SQLite's online backup API)
 *   uploads/<file>  every stored study document
 *
 * Restore validates everything BEFORE touching live data, takes a safety backup
 * of the current data first, and rolls back if the swap fails.
 *
 * Note: zips are built in memory (adm-zip), which is fine for a student's
 * documents but not for multi-gigabyte libraries (see MAX_RESTORE_MB).
 */
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const Database = require('better-sqlite3');
const config = require('../config');
const db = require('../database/db');
const { HttpError } = require('../lib/errors');

const BACKUP_NAME_RE = /^mitra-(?:backup|pre-restore)-\d{8}-\d{6}(?:-\d+)?\.zip$/;
const UPLOAD_ENTRY_RE = /^uploads\/([A-Za-z0-9][A-Za-z0-9._-]{0,100})$/;
const REQUIRED_TABLES = ['schema_migrations', 'study_notes', 'documents', 'psychology_terms', 'conversations', 'messages'];
const MAX_ENTRY_BYTES = 500 * 1024 * 1024;

const pad = (n) => String(n).padStart(2, '0');
function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function safeBackupName(name) {
  if (typeof name !== 'string' || !BACKUP_NAME_RE.test(name)) throw new HttpError(400, 'invalid_input', 'That is not a valid backup name.');
  return path.join(config.BACKUP_DIR, name);
}

function list() {
  fs.mkdirSync(config.BACKUP_DIR, { recursive: true });
  return fs
    .readdirSync(config.BACKUP_DIR)
    .filter((f) => BACKUP_NAME_RE.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(config.BACKUP_DIR, f));
      return { name: f, sizeBytes: st.size, createdAt: st.mtime.toISOString(), kind: f.startsWith('mitra-pre-restore') ? 'pre-restore' : 'manual' };
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

function uniqueName(prefix) {
  let name = `mitra-${prefix}-${stamp()}.zip`;
  let n = 1;
  while (fs.existsSync(path.join(config.BACKUP_DIR, name))) name = `mitra-${prefix}-${stamp()}-${n++}.zip`;
  return name;
}

async function create({ prefix = 'backup' } = {}) {
  fs.mkdirSync(config.BACKUP_DIR, { recursive: true });
  fs.mkdirSync(config.TMP_DIR, { recursive: true });
  const tmpDb = path.join(config.TMP_DIR, `backup-${process.pid}-${Date.now()}.db`);
  try {
    await db.backup(tmpDb);
    const zip = new AdmZip();
    const files = fs.existsSync(config.UPLOAD_DIR) ? fs.readdirSync(config.UPLOAD_DIR).filter((f) => UPLOAD_ENTRY_RE.test('uploads/' + f)) : [];
    for (const f of files) zip.addLocalFile(path.join(config.UPLOAD_DIR, f), 'uploads');
    zip.addLocalFile(tmpDb, '', 'mitra.db');
    const counts = {};
    for (const [key, table] of Object.entries({ notes: 'study_notes', documents: 'documents', vocabulary: 'vocabulary', conversations: 'conversations', flashcards: 'flashcards' })) {
      counts[key] = db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
    }
    const manifest = {
      app: 'MITRA',
      appVersion: config.APP_VERSION,
      schemaVersion: db.latestVersion(),
      createdAt: new Date().toISOString(),
      uploadFiles: files.length,
      counts,
    };
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
    const name = uniqueName(prefix);
    const final = path.join(config.BACKUP_DIR, name);
    zip.writeZip(final + '.part');
    fs.renameSync(final + '.part', final);
    return { name, sizeBytes: fs.statSync(final).size, manifest };
  } finally {
    fs.rmSync(tmpDb, { force: true });
  }
}

function remove(name) {
  const file = safeBackupName(name);
  if (!fs.existsSync(file)) throw new HttpError(404, 'not_found', 'Backup was not found.');
  fs.unlinkSync(file);
}

function filePath(name) {
  const file = safeBackupName(name);
  if (!fs.existsSync(file)) throw new HttpError(404, 'not_found', 'Backup was not found.');
  return file;
}

const corrupt = (why) => new HttpError(422, 'invalid_backup', `This backup cannot be used: ${why}`);

/** Validate a zip and extract it into `stagingDir`. Nothing outside stagingDir is written. */
function stage(zipFile, stagingDir) {
  let zip;
  try {
    zip = new AdmZip(zipFile);
  } catch (_) {
    throw corrupt('the file is not a readable zip archive (it may be incomplete or damaged).');
  }
  const entries = zip.getEntries();
  let total = 0;
  let manifest = null;
  let hasDb = false;
  const uploadEntries = [];
  for (const e of entries) {
    if (e.isDirectory) continue;
    const name = e.entryName;
    total += e.header.size;
    if (e.header.size > MAX_ENTRY_BYTES || total > config.MAX_RESTORE_BYTES) throw corrupt('it is larger than the allowed restore size.');
    if (name === 'manifest.json') manifest = e;
    else if (name === 'mitra.db') hasDb = true;
    else if (UPLOAD_ENTRY_RE.test(name)) uploadEntries.push(e);
    else throw corrupt(`it contains an unexpected item ("${name.slice(0, 60)}").`);
  }
  if (!manifest || !hasDb) throw corrupt('it does not contain the expected MITRA files.');
  let info;
  try {
    info = JSON.parse(manifest.getData().toString('utf8'));
  } catch (_) {
    throw corrupt('its description file is damaged.');
  }
  if (info.app !== 'MITRA') throw corrupt('it was not made by MITRA.');
  if (!Number.isInteger(info.schemaVersion) || info.schemaVersion > db.latestVersion()) {
    throw corrupt('it was made by a newer version of MITRA. Please update MITRA first.');
  }

  fs.mkdirSync(path.join(stagingDir, 'uploads'), { recursive: true });
  const dbFile = path.join(stagingDir, 'mitra.db');
  try {
    fs.writeFileSync(dbFile, zip.getEntry('mitra.db').getData());
    for (const e of uploadEntries) {
      const base = UPLOAD_ENTRY_RE.exec(e.entryName)[1];
      const dest = path.join(stagingDir, 'uploads', base);
      if (path.relative(path.join(stagingDir, 'uploads'), dest).startsWith('..')) throw corrupt('it contains an unsafe file path.');
      fs.writeFileSync(dest, e.getData()); // getData verifies the CRC
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw corrupt('one of its files is damaged.');
  }

  let check;
  try {
    check = new Database(dbFile, { readonly: true, fileMustExist: true });
    const integrity = check.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw corrupt('its database failed an integrity check.');
    const tables = new Set(check.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((r) => r.name));
    for (const t of REQUIRED_TABLES) if (!tables.has(t)) throw corrupt('its database is missing required data.');
    if (check.pragma('foreign_key_check').length) throw corrupt('its database has inconsistent references.');
    const v = check.prepare('SELECT MAX(version) v FROM schema_migrations').get().v;
    if (v > db.latestVersion()) throw corrupt('it was made by a newer version of MITRA. Please update MITRA first.');
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw corrupt('its database could not be opened.');
  } finally {
    if (check) check.close();
  }
  return { manifest: info, uploadCount: uploadEntries.length };
}

/** Validate only (used to preview what a restore would do). */
function inspect(zipFile) {
  const staging = fs.mkdtempSync(path.join(config.TMP_DIR, 'inspect-'));
  try {
    return stage(zipFile, staging).manifest;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

async function restore(zipFile) {
  fs.mkdirSync(config.TMP_DIR, { recursive: true });
  const staging = fs.mkdtempSync(path.join(config.TMP_DIR, 'restore-'));
  try {
    const { manifest } = stage(zipFile, staging); // 1. validate everything first
    const safety = await create({ prefix: 'pre-restore' }); // 2. keep a copy of what is there now

    const oldDb = path.join(config.TMP_DIR, `old-${Date.now()}.db`);
    const oldUploads = path.join(config.DATA_DIR, `uploads.old-${Date.now()}`);
    db.close();
    let swapped = false;
    try {
      fs.renameSync(config.DB_PATH, oldDb);
      for (const ext of ['-wal', '-shm']) fs.rmSync(config.DB_PATH + ext, { force: true });
      fs.copyFileSync(path.join(staging, 'mitra.db'), config.DB_PATH);
      fs.renameSync(config.UPLOAD_DIR, oldUploads);
      fs.renameSync(path.join(staging, 'uploads'), config.UPLOAD_DIR);
      swapped = true;
      db.open(); // runs migrations if the backup is from an older schema
    } catch (e) {
      // roll back to exactly what was there before
      try {
        db.close();
      } catch (_) { /* ignore */ }
      fs.rmSync(config.DB_PATH, { force: true });
      for (const ext of ['-wal', '-shm']) fs.rmSync(config.DB_PATH + ext, { force: true });
      if (fs.existsSync(oldDb)) fs.renameSync(oldDb, config.DB_PATH);
      if (fs.existsSync(oldUploads)) {
        fs.rmSync(config.UPLOAD_DIR, { recursive: true, force: true });
        fs.renameSync(oldUploads, config.UPLOAD_DIR);
      }
      db.open();
      console.error('[backup] restore failed and was rolled back:', e && e.code);
      throw new HttpError(500, 'restore_failed', 'The restore could not be completed, so nothing was changed. Your current data is safe.');
    }
    if (swapped) {
      fs.rmSync(oldDb, { force: true });
      fs.rmSync(oldUploads, { recursive: true, force: true });
    }
    return { restoredFrom: manifest, safetyBackup: safety.name };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

module.exports = { create, list, remove, filePath, inspect, restore, safeBackupName, BACKUP_NAME_RE };
