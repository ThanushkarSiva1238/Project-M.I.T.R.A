const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const t = require('./helpers');

before(() => t.startApp());
after(() => t.stopApp());

const backupFile = (name) => path.join(t.config.BACKUP_DIR, name);

async function restoreFile(file, extra = { confirm: 'RESTORE' }) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  fd.append('file', new Blob([file.buffer]), file.name);
  return t.api('POST', '/api/backups/restore', fd);
}

test('create → change data → restore brings back notes and uploaded files', async () => {
  const note = (await t.post('/api/notes', { title: 'Before backup', content: '<p>keep me</p>' })).body;
  const doc = (await t.upload('/api/documents', 'important.pdf', t.makePdf(['Important text']))).body;

  const made = await t.post('/api/backups');
  assert.equal(made.status, 201);
  assert.match(made.body.name, /^mitra-backup-\d{8}-\d{6}\.zip$/);
  assert.equal(made.body.manifest.counts.notes, 1);
  assert.equal(made.body.manifest.uploadFiles, 1);
  assert.ok(fs.existsSync(backupFile(made.body.name)));

  // damage the live data
  await t.del(`/api/notes/${note.id}`);
  await t.del(`/api/documents/${doc.id}`);
  await t.post('/api/notes', { title: 'Added after backup' });
  assert.equal((await t.get('/api/notes')).body.length, 1);

  // restore requires explicit confirmation
  assert.equal((await t.post('/api/backups/restore', { name: made.body.name })).status, 400);
  assert.deepEqual((await t.get('/api/notes')).body.map((n) => n.title), ['Added after backup']);

  const r = await t.post('/api/backups/restore', { name: made.body.name, confirm: 'RESTORE' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.safetyBackup, /^mitra-pre-restore-/);
  assert.ok(fs.existsSync(backupFile(r.body.safetyBackup)), 'current data is backed up before it is replaced');

  const back = await t.get(`/api/notes/${note.id}`);
  assert.equal(back.body.title, 'Before backup');
  const titles = (await t.get('/api/notes')).body.map((n) => n.title);
  assert.deepEqual(titles, ['Before backup']);
  const file = await t.api('GET', `/api/documents/${doc.id}/file`, undefined, { raw: true });
  assert.equal(file.status, 200);
  assert.match((await t.get(`/api/documents/${doc.id}`)).body.pages[0], /Important text/);
  assert.equal(t.db.pragma('foreign_keys', { simple: true }), 1);
  assert.equal((await t.get('/api/health')).body.ok, true);

  // and the safety backup can undo the restore
  const undo = await t.post('/api/backups/restore', { name: r.body.safetyBackup, confirm: 'RESTORE' });
  assert.equal(undo.status, 200);
  assert.deepEqual((await t.get('/api/notes')).body.map((n) => n.title), ['Added after backup']);
});

test('restoring an uploaded backup file works and inspect previews it first', async () => {
  const made = await t.post('/api/backups');
  const buffer = fs.readFileSync(backupFile(made.body.name));
  const fd = new FormData();
  fd.append('file', new Blob([buffer]), 'my-backup.zip');
  const inspected = await t.api('POST', '/api/backups/inspect', fd);
  assert.equal(inspected.status, 200);
  assert.equal(inspected.body.manifest.app, 'MITRA');
  const r = await restoreFile({ buffer, name: 'my-backup.zip' });
  assert.equal(r.status, 200);
});

test('corrupt, foreign and malicious backups are rejected and current data is untouched', async () => {
  const before = (await t.get('/api/notes')).body.length;
  const reject = async (buffer, name = 'bad.zip') => {
    const r = await restoreFile({ buffer, name });
    assert.equal(r.status, 422, `expected rejection, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error.code, 'invalid_backup');
    assert.equal((await t.get('/api/notes')).body.length, before);
    return r.body.error.message;
  };

  assert.match(await reject(Buffer.from('this is not a zip file')), /zip/);

  const good = fs.readFileSync(backupFile((await t.post('/api/backups')).body.name));
  await reject(good.subarray(0, Math.floor(good.length / 2))); // truncated

  const noDb = new AdmZip();
  noDb.addFile('manifest.json', Buffer.from(JSON.stringify({ app: 'MITRA', schemaVersion: 1 })));
  assert.match(await reject(noDb.toBuffer()), /expected MITRA files/);

  const traversal = new AdmZip(good);
  traversal.addFile('uploads/../../evil.txt', Buffer.from('x'));
  await reject(traversal.toBuffer());
  const abs = new AdmZip(good);
  abs.addFile('/etc/evil', Buffer.from('x'));
  await reject(abs.toBuffer());

  const wrongApp = new AdmZip(good);
  wrongApp.updateFile('manifest.json', Buffer.from(JSON.stringify({ app: 'Other', schemaVersion: 1 })));
  assert.match(await reject(wrongApp.toBuffer()), /not made by MITRA/);

  const newer = new AdmZip(good);
  newer.updateFile('manifest.json', Buffer.from(JSON.stringify({ app: 'MITRA', schemaVersion: 999 })));
  assert.match(await reject(newer.toBuffer()), /newer version/);

  const badDb = new AdmZip(good);
  badDb.updateFile('mitra.db', Buffer.from('SQLite format 3\0 but actually broken'.padEnd(4096, 'x')));
  await reject(badDb.toBuffer());

  assert.ok(!fs.existsSync(path.join(t.config.DATA_DIR, '..', 'evil.txt')));
  assert.ok(!fs.existsSync(path.join(t.config.DATA_DIR, 'evil.txt')));
  assert.equal(fs.readdirSync(t.config.TMP_DIR).length, 0, 'staging folders are cleaned up');
});

test('backup names cannot be used to reach other files', async () => {
  for (const bad of ['..%2Fmitra.db', 'x.zip', 'mitra-backup-1.zip', '..%2F..%2Fetc%2Fpasswd']) {
    const r = await t.get(`/api/backups/${bad}/download`);
    assert.ok([400, 404].includes(r.status), `${bad} -> ${r.status}`);
  }
  assert.equal((await t.del('/api/backups/..%2Fmitra.db')).status, 400);
});

test('list and delete backups', async () => {
  const list = (await t.get('/api/backups')).body;
  assert.ok(list.backups.length >= 2);
  const name = list.backups[0].name;
  assert.equal((await t.del(`/api/backups/${name}`)).status, 200);
  assert.ok(!fs.existsSync(backupFile(name)));
});
