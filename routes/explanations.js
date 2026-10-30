/** Saved explanations produced by the tutor (re-readable without any AI request). */
const express = require('express');
const db = require('../database/db');
const v = require('../lib/validate');
const { notFound } = require('../lib/errors');

const router = express.Router();

router.get('/', (req, res) => {
  const q = v.text(req.query.q, 'q', { max: 100 });
  const savedOnly = v.bool(req.query.saved);
  const where = [];
  const params = [];
  if (q) {
    where.push(`(e.title LIKE ? ESCAPE '\\' OR e.content LIKE ? ESCAPE '\\' OR e.source_text LIKE ? ESCAPE '\\')`);
    params.push(v.like(q), v.like(q), v.like(q));
  }
  if (savedOnly) where.push('e.saved = 1');
  const rows = db
    .prepare(
      `SELECT e.id, e.title, e.mode, e.saved, e.created_at, substr(e.content, 1, 200) AS snippet,
              (SELECT conversation_id FROM messages WHERE explanation_id = e.id ORDER BY id DESC LIMIT 1) AS conversation_id
       FROM explanations e ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY e.created_at DESC LIMIT 100`
    )
    .all(...params);
  res.json(rows);
});

router.get('/:id', (req, res) => {
  const e = db.prepare('SELECT * FROM explanations WHERE id = ?').get(v.id(req.params.id));
  if (!e) throw notFound('Explanation');
  const conv = db.prepare('SELECT conversation_id FROM messages WHERE explanation_id = ? ORDER BY id DESC LIMIT 1').get(e.id);
  res.json({ ...e, conversation_id: conv ? conv.conversation_id : null });
});

router.patch('/:id', (req, res) => {
  const id = v.id(req.params.id);
  if (!db.prepare('SELECT 1 FROM explanations WHERE id = ?').get(id)) throw notFound('Explanation');
  db.prepare('UPDATE explanations SET saved = ? WHERE id = ?').run(v.bool(req.body?.saved) ? 1 : 0, id);
  res.json(db.prepare('SELECT id, saved FROM explanations WHERE id = ?').get(id));
});

router.delete('/:id', (req, res) => {
  const id = v.id(req.params.id);
  if (!db.prepare('SELECT 1 FROM explanations WHERE id = ?').get(id)) throw notFound('Explanation');
  db.prepare('DELETE FROM explanations WHERE id = ?').run(id);
  res.json({ ok: true });
});

module.exports = router;
