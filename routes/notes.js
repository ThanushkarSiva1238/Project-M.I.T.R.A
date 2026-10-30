/** Personal notes (Notepad). Content is sanitised HTML; saves use a version counter. */
const express = require('express');
const db = require('../database/db');
const activity = require('../lib/activity');
const { cleanNoteHtml, htmlToPlain } = require('../lib/sanitize');
const v = require('../lib/validate');
const { notFound, conflict } = require('../lib/errors');

const router = express.Router();
const MAX_CONTENT = 500_000;

const full = (r) => ({
  id: r.id, title: r.title, content: r.content, documentId: r.document_id, version: r.version, createdAt: r.created_at, updatedAt: r.updated_at,
});

function getNote(id) {
  const r = db.prepare('SELECT * FROM study_notes WHERE id = ?').get(id);
  if (!r) throw notFound('Note');
  return r;
}

function checkDocument(id) {
  if (id && !db.prepare('SELECT 1 FROM documents WHERE id = ?').get(id)) throw notFound('Linked document');
}

router.get('/', (req, res) => {
  const q = v.text(req.query.q, 'q', { max: 100 });
  const limit = v.int(req.query.limit, 'limit', { min: 1, max: 500 }) || 200;
  const cols = `id, title, substr(plain_text, 1, 160) AS snippet, document_id, updated_at, created_at`;
  const rows = q
    ? db.prepare(`SELECT ${cols} FROM study_notes WHERE title LIKE @like ESCAPE '\\' OR plain_text LIKE @like ESCAPE '\\' ORDER BY updated_at DESC LIMIT @limit`).all({ like: v.like(q), limit })
    : db.prepare(`SELECT ${cols} FROM study_notes ORDER BY updated_at DESC, id DESC LIMIT ?`).all(limit);
  res.json(rows.map((r) => ({ id: r.id, title: r.title, snippet: r.snippet, documentId: r.document_id, updatedAt: r.updated_at, createdAt: r.created_at })));
});

router.post('/', (req, res) => {
  const b = req.body || {};
  const title = v.text(b.title, 'Title', { max: 150 }) || '';
  const content = cleanNoteHtml(typeof b.content === 'string' ? b.content.slice(0, MAX_CONTENT) : '');
  const documentId = v.int(b.documentId, 'documentId');
  checkDocument(documentId);
  const info = db
    .prepare('INSERT INTO study_notes (title, content, plain_text, document_id) VALUES (?, ?, ?, ?)')
    .run(title, content, htmlToPlain(content), documentId);
  const row = getNote(info.lastInsertRowid);
  activity.log({ type: 'note_created', label: `Note: ${title || 'Untitled'}`, refType: 'note', refId: row.id });
  res.status(201).json(full(row));
});

router.get('/:id', (req, res) => res.json(full(getNote(v.id(req.params.id)))));

router.put('/:id', (req, res) => {
  const row = getNote(v.id(req.params.id));
  const b = req.body || {};
  const expected = v.int(b.version, 'version');
  if (expected !== null && expected !== row.version) {
    throw conflict('This note was changed somewhere else (maybe in another tab). Reload it to see the latest version.', { current: full(row) });
  }
  const title = b.title === undefined ? row.title : v.text(b.title, 'Title', { max: 150 }) || '';
  const content = b.content === undefined ? row.content : cleanNoteHtml(String(b.content).slice(0, MAX_CONTENT));
  let documentId = row.document_id;
  if (b.documentId !== undefined) {
    documentId = v.int(b.documentId, 'documentId');
    checkDocument(documentId);
  }
  const changed = title !== row.title || content !== row.content || documentId !== row.document_id;
  if (changed) {
    db.prepare(
      `UPDATE study_notes SET title = ?, content = ?, plain_text = ?, document_id = ?, version = version + 1,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
    ).run(title, content, htmlToPlain(content), documentId, row.id);
    activity.logNoteUpdate({ id: row.id, title });
  }
  res.json(full(getNote(row.id)));
});

router.delete('/:id', (req, res) => {
  const row = getNote(v.id(req.params.id));
  db.prepare('DELETE FROM study_notes WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

module.exports = router;
