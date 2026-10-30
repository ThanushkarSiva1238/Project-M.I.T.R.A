const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const t = require('./helpers');

before(() => t.startApp());
after(() => t.stopApp());

test('valid PDF: stored locally, text extracted page by page, original downloadable', async () => {
  const up = await t.upload('/api/documents', 'Cognitive Psychology Lecture 02.pdf', t.makePdf(['Cognitive dissonance explained', 'Second page about schemas']));
  assert.equal(up.status, 201);
  assert.equal(up.body.kind, 'pdf');
  assert.equal(up.body.status, 'ready');
  assert.equal(up.body.pageCount, 2);
  assert.equal(up.body.title, 'Cognitive Psychology Lecture 02');

  const doc = (await t.get(`/api/documents/${up.body.id}`)).body;
  assert.equal(doc.pages.length, 2);
  assert.match(doc.pages[0], /Cognitive dissonance explained/);
  assert.match(doc.pages[1], /schemas/);

  const file = await t.api('GET', `/api/documents/${up.body.id}/file`, undefined, { raw: true });
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'application/pdf');
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await file.arrayBuffer()).byteLength, t.makePdf(['Cognitive dissonance explained', 'Second page about schemas']).length);

  // stored under a generated name, inside the uploads folder only
  const stored = t.db.prepare('SELECT stored_name FROM documents WHERE id = ?').get(up.body.id).stored_name;
  assert.match(stored, /^[0-9a-f-]{36}\.pdf$/);
  assert.ok(fs.existsSync(path.join(t.config.UPLOAD_DIR, stored)));
});

test('documents and their text remain after the database is re-opened (restart)', async () => {
  const up = await t.upload('/api/documents', 'persist.pdf', t.makePdf(['Persistent text']));
  t.db.reopen();
  const doc = (await t.get(`/api/documents/${up.body.id}`)).body;
  assert.match(doc.pages[0], /Persistent text/);
  assert.equal((await t.api('GET', `/api/documents/${up.body.id}/file`, undefined, { raw: true })).status, 200);
});

test('valid DOCX: text extracted', async () => {
  const up = await t.upload('/api/documents', 'My Notes.docx', t.makeDocx('Attachment theory basics'));
  assert.equal(up.status, 201);
  assert.equal(up.body.kind, 'docx');
  const doc = (await t.get(`/api/documents/${up.body.id}`)).body;
  assert.match(doc.text, /Attachment theory basics/);
  assert.equal(doc.pages, null);
});

test('image: stored, and OCR being unavailable is reported with a manual-entry path', async () => {
  const up = await t.upload('/api/documents', 'slide.png', t.PNG_1X1);
  assert.equal(up.status, 201);
  assert.equal(up.body.kind, 'image');
  assert.equal(up.body.status, 'needs_text');
  assert.match(up.body.statusDetail, /OCR/);
  assert.match(up.body.statusDetail, /type or paste/);

  const ocr = await t.post(`/api/documents/${up.body.id}/ocr`);
  assert.equal(ocr.body.ok, false);

  const manual = await t.put(`/api/documents/${up.body.id}/text`, { text: 'Typed from the slide' });
  assert.equal(manual.body.status, 'ready');
  assert.equal(manual.body.method, 'manual');
  assert.match((await t.get(`/api/documents/${up.body.id}`)).body.text, /Typed from the slide/);
});

test('scanned PDF (no text layer) is kept and flagged so text can be entered manually', async () => {
  const up = await t.upload('/api/documents', 'scan.pdf', t.makePdf([null, null]));
  assert.equal(up.status, 201);
  assert.equal(up.body.status, 'needs_text');
  assert.match(up.body.statusDetail, /scan/);
  assert.equal(up.body.pageCount, 2);
});

test('unsupported, spoofed, empty and oversized files are rejected and nothing is stored', async () => {
  const before = t.db.prepare('SELECT COUNT(*) c FROM documents').get().c;
  const files = fs.readdirSync(t.config.UPLOAD_DIR).length;

  const txt = await t.upload('/api/documents', 'notes.txt', Buffer.from('hello'));
  assert.equal(txt.status, 415);
  const exe = await t.upload('/api/documents', 'virus.pdf', Buffer.from('MZ\x90\x00 not a pdf at all'));
  assert.equal(exe.status, 415);
  assert.match(exe.body.error.message, /does not look like a valid PDF/);
  const fakeDocx = await t.upload('/api/documents', 'fake.docx', Buffer.from('plain text'));
  assert.equal(fakeDocx.status, 415);
  const fakePng = await t.upload('/api/documents', 'fake.png', Buffer.from('plain text'));
  assert.equal(fakePng.status, 415);
  const empty = await t.upload('/api/documents', 'empty.pdf', Buffer.alloc(0));
  assert.ok([400, 415].includes(empty.status));
  const big = await t.upload('/api/documents', 'big.pdf', Buffer.concat([t.makePdf(['x']), Buffer.alloc(2 * 1024 * 1024)]));
  assert.equal(big.status, 413);
  assert.match(big.body.error.message, /too large/);

  assert.equal(t.db.prepare('SELECT COUNT(*) c FROM documents').get().c, before);
  assert.equal(fs.readdirSync(t.config.UPLOAD_DIR).length, files);
  assert.equal(fs.readdirSync(t.config.TMP_DIR).length, 0, 'temporary upload files must be cleaned up');
});

test('a damaged PDF is stored but flagged, without crashing the server', async () => {
  const broken = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('garbage garbage garbage')]);
  const up = await t.upload('/api/documents', 'broken.pdf', broken);
  assert.equal(up.status, 201);
  assert.equal(up.body.status, 'needs_text');
  assert.equal((await t.get('/api/health')).body.ok, true);
});

test('document file paths cannot be manipulated', async () => {
  const { resolveStored } = require('../services/documentService');
  for (const bad of ['../mitra.db', '..\\..\\secret.pdf', '/etc/passwd', 'abc.pdf', '00000000-0000-0000-0000-000000000000.exe']) {
    assert.throws(() => resolveStored(bad), /not found/i);
  }
  assert.equal((await t.get('/api/documents/abc/file')).status, 400);
  assert.equal((await t.get('/api/documents/999999/file')).status, 404);
});

test('deleting a document removes its file from disk', async () => {
  const up = await t.upload('/api/documents', 'gone.pdf', t.makePdf(['bye']));
  const stored = t.db.prepare('SELECT stored_name FROM documents WHERE id = ?').get(up.body.id).stored_name;
  assert.ok(fs.existsSync(path.join(t.config.UPLOAD_DIR, stored)));
  await t.del(`/api/documents/${up.body.id}`);
  assert.ok(!fs.existsSync(path.join(t.config.UPLOAD_DIR, stored)));
});
