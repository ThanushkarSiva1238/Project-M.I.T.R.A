/**
 * Psychology dictionary.
 * origin: 'builtin' (shipped, read-only, verified) | 'user' (written by the student)
 *         | 'ai' (generated on request, NOT verified until the student confirms it).
 */
const express = require('express');
const db = require('../database/db');
const ai = require('../services/aiService');
const activity = require('../lib/activity');
const v = require('../lib/validate');
const { HttpError, notFound, conflict, badInput } = require('../lib/errors');

const router = express.Router();

function view(r) {
  let related = [];
  try {
    related = JSON.parse(r.related || '[]');
  } catch (_) {
    related = [];
  }
  return {
    id: r.id, term: r.term, pronunciation: r.pronunciation, simpleEnglish: r.simple_english, tamil: r.tamil,
    definition: r.definition, example: r.example, everydayExample: r.everyday_example, related,
    personalNote: r.personal_note, origin: r.origin, verified: !!r.verified, saved: !!r.saved,
    lastAccessed: r.last_accessed, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

const brief = (r) => ({
  id: r.id, term: r.term, origin: r.origin, verified: !!r.verified, saved: !!r.saved,
  snippet: (r.simple_english || '').slice(0, 110), lastAccessed: r.last_accessed,
});

function getTerm(id) {
  const r = db.prepare('SELECT * FROM psychology_terms WHERE id = ?').get(id);
  if (!r) throw notFound('Term');
  return r;
}

function fields(body) {
  const relatedIn = Array.isArray(body.related)
    ? body.related
    : typeof body.related === 'string'
      ? body.related.split(/[,;\n]/)
      : [];
  const related = [...new Set(relatedIn.map((x) => String(x).trim()).filter(Boolean).map((x) => x.slice(0, 80)))].slice(0, 12);
  return {
    pronunciation: v.text(body.pronunciation, 'Pronunciation', { max: 120 }),
    simple_english: v.text(body.simpleEnglish, 'Simple English', { max: 1500 }),
    tamil: v.text(body.tamil, 'Tamil explanation', { max: 2000 }),
    definition: v.text(body.definition, 'Definition', { max: 2000 }),
    example: v.text(body.example, 'Example sentence', { max: 800 }),
    everyday_example: v.text(body.everydayExample, 'Everyday example', { max: 1000 }),
    related: JSON.stringify(related),
  };
}

router.get('/', (req, res) => {
  const q = v.text(req.query.q, 'q', { max: 100 });
  const origin = v.oneOf(req.query.origin, 'origin', ['builtin', 'user', 'ai']);
  const savedOnly = v.bool(req.query.saved);
  const limit = v.int(req.query.limit, 'limit', { min: 1, max: 500 }) || 100;
  const where = [];
  const params = {};
  if (q) {
    where.push(`(term LIKE @like ESCAPE '\\' OR simple_english LIKE @like ESCAPE '\\' OR tamil LIKE @like ESCAPE '\\' OR definition LIKE @like ESCAPE '\\')`);
    params.like = v.like(q);
    params.prefix = v.like(q).slice(1); // 'q%' (prefix) variant
  }
  if (origin) {
    where.push('origin = @origin');
    params.origin = origin;
  }
  if (savedOnly) where.push('saved = 1');
  const order = q ? `(term LIKE @prefix ESCAPE '\\') DESC, term` : 'term';
  const rows = db
    .prepare(`SELECT * FROM psychology_terms ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} COLLATE NOCASE LIMIT @limit`)
    .all({ ...params, limit });
  res.json(rows.map(brief));
});

router.get('/recent', (req, res) => {
  const rows = db.prepare('SELECT * FROM psychology_terms WHERE last_accessed IS NOT NULL ORDER BY last_accessed DESC LIMIT 8').all();
  res.json(rows.map(brief));
});

router.get('/by-name/:term', (req, res) => {
  const r = db.prepare('SELECT * FROM psychology_terms WHERE term = ?').get(String(req.params.term).slice(0, 120));
  if (!r) throw notFound('Term');
  res.json(view(r));
});

/** Student explicitly asks MITRA's AI to define a term that is not in the dictionary. */
router.post('/ai-define', async (req, res) => {
  const term = v.text(req.body?.term, 'Term', { max: 100, required: true });
  const existing = db.prepare('SELECT * FROM psychology_terms WHERE term = ?').get(term);
  if (existing) return res.json({ existing: true, term: view(existing) });
  const r = await ai.defineTerm(term);
  let row = db.prepare('SELECT * FROM psychology_terms WHERE term = ?').get(r.entry.term);
  if (!row) {
    const info = db
      .prepare(
        `INSERT INTO psychology_terms (term, pronunciation, simple_english, tamil, definition, example, everyday_example, related, origin, verified)
         VALUES (@term, @pronunciation, @simple_english, @tamil, @definition, @example, @everyday_example, @related, 'ai', 0)`
      )
      .run({ ...r.entry, related: JSON.stringify(r.entry.related) });
    row = getTerm(info.lastInsertRowid);
    activity.log({ type: 'term_added', label: `Term defined: ${row.term}`, refType: 'term', refId: row.id });
  }
  res.status(201).json({ existing: false, term: view(row) });
});

router.get('/:id', (req, res) => {
  const row = getTerm(v.id(req.params.id));
  db.prepare(`UPDATE psychology_terms SET last_accessed = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(row.id);
  res.json(view(getTerm(row.id)));
});

router.post('/', (req, res) => {
  const term = v.text(req.body?.term, 'Term', { max: 100, required: true });
  const f = fields(req.body || {});
  if (!f.simple_english && !f.definition && !f.tamil) throw badInput('Please add at least a meaning (simple English, Tamil, or definition).');
  if (db.prepare('SELECT 1 FROM psychology_terms WHERE term = ?').get(term)) throw conflict(`"${term}" is already in the dictionary.`);
  const info = db
    .prepare(
      `INSERT INTO psychology_terms (term, pronunciation, simple_english, tamil, definition, example, everyday_example, related, personal_note, origin, verified, saved)
       VALUES (@term, @pronunciation, @simple_english, @tamil, @definition, @example, @everyday_example, @related, @personal_note, 'user', 1, 1)`
    )
    .run({ term, ...f, personal_note: v.text(req.body.personalNote, 'My own explanation', { max: 3000 }) });
  activity.log({ type: 'term_added', label: `Term added: ${term}`, refType: 'term', refId: info.lastInsertRowid });
  res.status(201).json(view(getTerm(info.lastInsertRowid)));
});

router.put('/:id', (req, res) => {
  const row = getTerm(v.id(req.params.id));
  const b = req.body || {};
  const note = v.text(b.personalNote, 'My own explanation', { max: 3000 });
  if (row.origin === 'builtin') {
    // Built-in text is protected; the student can only add her own explanation.
    db.prepare(`UPDATE psychology_terms SET personal_note = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(note, row.id);
    return res.json(view(getTerm(row.id)));
  }
  const term = v.text(b.term, 'Term', { max: 100 }) || row.term;
  const dup = db.prepare('SELECT id FROM psychology_terms WHERE term = ? AND id <> ?').get(term, row.id);
  if (dup) throw conflict(`"${term}" is already in the dictionary.`);
  const f = fields(b);
  db.prepare(
    `UPDATE psychology_terms SET term=@term, pronunciation=@pronunciation, simple_english=@simple_english, tamil=@tamil, definition=@definition,
       example=@example, everyday_example=@everyday_example, related=@related, personal_note=@personal_note,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=@id`
  ).run({ id: row.id, term, ...f, personal_note: note });
  res.json(view(getTerm(row.id)));
});

router.patch('/:id/saved', (req, res) => {
  const row = getTerm(v.id(req.params.id));
  const saved = v.bool(req.body?.saved) ? 1 : 0;
  db.prepare('UPDATE psychology_terms SET saved = ? WHERE id = ?').run(saved, row.id);
  if (saved) activity.log({ type: 'term_saved', label: `Term saved: ${row.term}`, refType: 'term', refId: row.id });
  res.json(view(getTerm(row.id)));
});

router.patch('/:id/verified', (req, res) => {
  const row = getTerm(v.id(req.params.id));
  if (row.origin === 'builtin') throw new HttpError(400, 'invalid_input', 'Built-in entries are already verified.');
  db.prepare('UPDATE psychology_terms SET verified = ? WHERE id = ?').run(v.bool(req.body?.verified) ? 1 : 0, row.id);
  res.json(view(getTerm(row.id)));
});

router.delete('/:id', (req, res) => {
  const row = getTerm(v.id(req.params.id));
  if (row.origin === 'builtin') throw new HttpError(403, 'protected', 'Built-in dictionary entries cannot be deleted.');
  db.prepare('DELETE FROM psychology_terms WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

module.exports = router;
