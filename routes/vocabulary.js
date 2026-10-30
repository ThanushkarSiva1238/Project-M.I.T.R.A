/** "My Vocabulary": the student's personal English word notebook. */
const express = require('express');
const db = require('../database/db');
const activity = require('../lib/activity');
const v = require('../lib/validate');
const { notFound, conflict } = require('../lib/errors');

const router = express.Router();
const STATUSES = ['new', 'learning', 'needs_revision', 'learned'];

const view = (r) => ({
  id: r.id, word: r.word, partOfSpeech: r.part_of_speech, meaning: r.meaning, tamil: r.tamil, psychMeaning: r.psych_meaning,
  example: r.example, sourceNote: r.source_note, status: r.status, termId: r.term_id, createdAt: r.created_at, lastReviewed: r.last_reviewed,
});

function getWord(id) {
  const r = db.prepare('SELECT * FROM vocabulary WHERE id = ?').get(id);
  if (!r) throw notFound('Vocabulary entry');
  return r;
}

function fields(b) {
  return {
    part_of_speech: v.text(b.partOfSpeech, 'Part of speech', { max: 40 }),
    meaning: v.text(b.meaning, 'Simple English meaning', { max: 1000 }),
    tamil: v.text(b.tamil, 'Tamil translation', { max: 1000 }),
    psych_meaning: v.text(b.psychMeaning, 'Psychology meaning', { max: 1500 }),
    example: v.text(b.example, 'Example sentence', { max: 800 }),
    source_note: v.text(b.sourceNote, 'Source note', { max: 300 }),
  };
}

router.get('/', (req, res) => {
  const q = v.text(req.query.q, 'q', { max: 100 });
  const status = v.oneOf(req.query.status, 'status', STATUSES);
  const where = [];
  const params = {};
  if (q) {
    where.push(`(word LIKE @like ESCAPE '\\' OR meaning LIKE @like ESCAPE '\\' OR tamil LIKE @like ESCAPE '\\' OR psych_meaning LIKE @like ESCAPE '\\')`);
    params.like = v.like(q);
  }
  if (status) {
    where.push('status = @status');
    params.status = status;
  }
  const rows = db.prepare(`SELECT * FROM vocabulary ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, id DESC`).all(params);
  res.json(rows.map(view));
});

router.get('/counts', (req, res) => {
  const counts = { new: 0, learning: 0, needs_revision: 0, learned: 0, total: 0 };
  for (const r of db.prepare('SELECT status, COUNT(*) c FROM vocabulary GROUP BY status').all()) {
    counts[r.status] = r.c;
    counts.total += r.c;
  }
  res.json(counts);
});

router.post('/', (req, res) => {
  const word = v.text(req.body?.word, 'Word or phrase', { max: 100, required: true });
  const f = fields(req.body);
  const status = v.oneOf(req.body.status, 'status', STATUSES, { fallback: 'new' });
  const dup = db.prepare('SELECT id FROM vocabulary WHERE word = ?').get(word);
  if (dup) throw conflict(`"${word}" is already in your vocabulary.`, { id: dup.id });
  const info = db
    .prepare(
      `INSERT INTO vocabulary (word, part_of_speech, meaning, tamil, psych_meaning, example, source_note, status)
       VALUES (@word, @part_of_speech, @meaning, @tamil, @psych_meaning, @example, @source_note, @status)`
    )
    .run({ word, ...f, status });
  activity.log({ type: 'vocab_added', label: `Added to Vocabulary: ${word}`, refType: 'vocabulary', refId: info.lastInsertRowid });
  res.status(201).json(view(getWord(info.lastInsertRowid)));
});

/** Add a dictionary term to the vocabulary (button in the dictionary card). */
router.post('/from-term/:termId', (req, res) => {
  const t = db.prepare('SELECT * FROM psychology_terms WHERE id = ?').get(v.id(req.params.termId, 'termId'));
  if (!t) throw notFound('Term');
  const existing = db.prepare('SELECT * FROM vocabulary WHERE word = ?').get(t.term);
  if (existing) return res.json({ existing: true, item: view(existing) });
  const info = db
    .prepare(
      `INSERT INTO vocabulary (word, meaning, tamil, psych_meaning, example, source_note, term_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(t.term, t.simple_english, t.tamil, t.definition, t.example, 'From the MITRA dictionary', t.id);
  activity.log({ type: 'vocab_added', label: `Added to Vocabulary: ${t.term}`, refType: 'vocabulary', refId: info.lastInsertRowid });
  res.status(201).json({ existing: false, item: view(getWord(info.lastInsertRowid)) });
});

router.put('/:id', (req, res) => {
  const row = getWord(v.id(req.params.id));
  const word = v.text(req.body?.word, 'Word or phrase', { max: 100 }) || row.word;
  const dup = db.prepare('SELECT id FROM vocabulary WHERE word = ? AND id <> ?').get(word, row.id);
  if (dup) throw conflict(`"${word}" is already in your vocabulary.`, { id: dup.id });
  const f = fields(req.body || {});
  const status = v.oneOf(req.body?.status, 'status', STATUSES, { fallback: row.status });
  db.prepare(
    `UPDATE vocabulary SET word=@word, part_of_speech=@part_of_speech, meaning=@meaning, tamil=@tamil,
       psych_meaning=@psych_meaning, example=@example, source_note=@source_note, status=@status WHERE id=@id`
  ).run({ id: row.id, word, ...f, status });
  res.json(view(getWord(row.id)));
});

router.patch('/:id/status', (req, res) => {
  const row = getWord(v.id(req.params.id));
  const status = v.oneOf(req.body?.status, 'status', STATUSES, { required: true });
  db.prepare(`UPDATE vocabulary SET status = ?, last_reviewed = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(status, row.id);
  res.json(view(getWord(row.id)));
});

router.delete('/:id', (req, res) => {
  const row = getWord(v.id(req.params.id));
  db.prepare('DELETE FROM vocabulary WHERE id = ?').run(row.id); // linked flashcards keep working (FK set to NULL)
  res.json({ ok: true });
});

module.exports = router;
