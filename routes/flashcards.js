/**
 * Flashcards with SIMPLE fixed-interval revision scheduling (a Leitner-style ladder).
 * This is deliberately not SM-2/FSRS: "understood" moves a card up the ladder
 * 1 → 3 → 7 → 14 → 30 days; "needs revision" resets it to step 0 and due tomorrow.
 * A card counts as "learned" after four successful reviews in a row.
 */
const express = require('express');
const db = require('../database/db');
const ai = require('../services/aiService');
const { resolveSource } = require('../services/sourceText');
const activity = require('../lib/activity');
const { localDate, addDays } = require('../lib/dates');
const v = require('../lib/validate');
const { notFound } = require('../lib/errors');

const router = express.Router();
const LADDER_DAYS = [1, 3, 7, 14, 30];
const LEARNED_AFTER = 4;
const STATUSES = ['new', 'learning', 'needs_revision', 'learned'];

const view = (r) => ({
  id: r.id, front: r.front, back: r.back, example: r.example, sourceNote: r.source_note, status: r.status, step: r.step,
  dueDate: r.due_date, vocabularyId: r.vocabulary_id, documentId: r.document_id, createdAt: r.created_at, lastReviewed: r.last_reviewed,
  reviewCount: r.review_count ?? undefined,
});

const SELECT = `SELECT f.*, (SELECT COUNT(*) FROM flashcard_reviews r WHERE r.flashcard_id = f.id) AS review_count FROM flashcards f`;

function getCard(id) {
  const r = db.prepare(`${SELECT} WHERE f.id = ?`).get(id);
  if (!r) throw notFound('Flashcard');
  return r;
}

function insertCard(c, extra = {}) {
  return db
    .prepare(
      `INSERT INTO flashcards (front, back, example, source_note, due_date, vocabulary_id, document_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(c.front, c.back, c.example || null, c.sourceNote || extra.sourceNote || null, localDate(), c.vocabularyId || null, c.documentId || extra.documentId || null)
    .lastInsertRowid;
}

function cardFields(b) {
  return {
    front: v.text(b.front, 'Question or term', { max: 300, required: true }),
    back: v.text(b.back, 'Answer or definition', { max: 1500, required: true }),
    example: v.text(b.example, 'Example', { max: 600 }),
    sourceNote: v.text(b.sourceNote, 'Source note', { max: 300 }),
  };
}

router.get('/', (req, res) => {
  const status = v.oneOf(req.query.status, 'status', STATUSES);
  const q = v.text(req.query.q, 'q', { max: 100 });
  const where = [];
  const params = {};
  if (status) {
    where.push('f.status = @status');
    params.status = status;
  }
  if (v.bool(req.query.due)) {
    where.push('f.due_date <= @today');
    params.today = localDate();
  }
  if (q) {
    where.push(`(f.front LIKE @like ESCAPE '\\' OR f.back LIKE @like ESCAPE '\\')`);
    params.like = v.like(q);
  }
  const rows = db.prepare(`${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY f.created_at DESC, f.id DESC`).all(params);
  res.json(rows.map(view));
});

/** Cards due today or earlier, oldest-due first. */
router.get('/queue', (req, res) => {
  const limit = v.int(req.query.limit, 'limit', { min: 1, max: 200 }) || 50;
  const today = localDate();
  const cards = db.prepare(`${SELECT} WHERE f.due_date <= ? ORDER BY f.due_date, f.id LIMIT ?`).all(today, limit);
  const due = db.prepare('SELECT COUNT(*) c FROM flashcards WHERE due_date <= ?').get(today).c;
  const total = db.prepare('SELECT COUNT(*) c FROM flashcards').get().c;
  res.json({ due, total, cards: cards.map(view) });
});

router.post('/', (req, res) => {
  const f = cardFields(req.body || {});
  const vocabularyId = v.int(req.body.vocabularyId, 'vocabularyId');
  const id = insertCard({ ...f, vocabularyId });
  activity.log({ type: 'flashcards_added', label: `Flashcard added: ${f.front.slice(0, 60)}`, refType: 'flashcard', refId: id });
  res.status(201).json(view(getCard(id)));
});

/** Save a reviewed batch (from AI generation) in one transaction. */
router.post('/bulk', (req, res) => {
  const list = Array.isArray(req.body?.cards) ? req.body.cards : [];
  if (!list.length) throw new (require('../lib/errors').HttpError)(400, 'invalid_input', 'There are no cards to save.');
  if (list.length > 50) throw new (require('../lib/errors').HttpError)(400, 'invalid_input', 'Please save at most 50 cards at a time.');
  const documentId = v.int(req.body.documentId, 'documentId');
  const sourceNote = v.text(req.body.sourceNote, 'Source note', { max: 300 });
  const ids = db.transaction(() => list.map((c) => insertCard(cardFields(c || {}), { documentId, sourceNote })))();
  activity.log({ type: 'flashcards_added', label: `${ids.length} flashcard${ids.length === 1 ? '' : 's'} created`, refType: 'flashcard', refId: ids[0] });
  res.status(201).json({ created: ids.length });
});

/** AI draft: NOT saved until the student reviews it and calls /bulk. */
router.post('/generate', async (req, res) => {
  const src = resolveSource(req.body);
  const count = v.int(req.body?.count, 'count', { min: 1, max: 15 }) || 6;
  const r = await ai.generateFlashcards({ text: src.text, topic: src.topic, count, sourceLabel: src.type === 'document' ? src.label : null });
  res.json({ cards: r.cards, source: { type: src.type, label: src.label, documentId: src.documentId }, aiGenerated: true });
});

/** Create cards for vocabulary entries that do not have one yet. */
router.post('/from-vocabulary', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((x) => v.id(x)) : null;
  const rows = ids
    ? db.prepare(`SELECT * FROM vocabulary WHERE id IN (${ids.map(() => '?').join(',') || 'NULL'})`).all(...ids)
    : db.prepare('SELECT * FROM vocabulary').all();
  const has = db.prepare('SELECT 1 FROM flashcards WHERE vocabulary_id = ?');
  let created = 0;
  db.transaction(() => {
    for (const w of rows) {
      if (has.get(w.id)) continue;
      const back = [w.meaning, w.tamil, w.psych_meaning && `In psychology: ${w.psych_meaning}`].filter(Boolean).join('\n');
      if (!back) continue;
      insertCard({ front: w.word, back, example: w.example, sourceNote: w.source_note, vocabularyId: w.id });
      created++;
    }
  })();
  if (created) activity.log({ type: 'flashcards_added', label: `${created} flashcard${created === 1 ? '' : 's'} created from vocabulary` });
  res.status(201).json({ created });
});

router.put('/:id', (req, res) => {
  const row = getCard(v.id(req.params.id));
  const f = cardFields(req.body || {});
  db.prepare('UPDATE flashcards SET front = ?, back = ?, example = ?, source_note = ? WHERE id = ?').run(f.front, f.back, f.example, f.sourceNote, row.id);
  res.json(view(getCard(row.id)));
});

router.post('/:id/review', (req, res) => {
  const card = getCard(v.id(req.params.id));
  const result = v.oneOf(req.body?.result, 'result', ['understood', 'revision'], { required: true });
  const today = localDate();
  let step = card.step;
  let status;
  let due;
  if (result === 'understood') {
    due = addDays(today, LADDER_DAYS[Math.min(step, LADDER_DAYS.length - 1)]);
    step += 1;
    status = step >= LEARNED_AFTER ? 'learned' : 'learning';
  } else {
    step = 0;
    due = addDays(today, 1);
    status = 'needs_revision';
  }
  db.transaction(() => {
    db.prepare(`UPDATE flashcards SET step = ?, status = ?, due_date = ?, last_reviewed = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(step, status, due, card.id);
    db.prepare('INSERT INTO flashcard_reviews (flashcard_id, result, day, next_due) VALUES (?, ?, ?, ?)').run(card.id, result, today, due);
    if (card.vocabulary_id) {
      const vs = result === 'understood' ? (status === 'learned' ? 'learned' : 'learning') : 'needs_revision';
      db.prepare(`UPDATE vocabulary SET status = ?, last_reviewed = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(vs, card.vocabulary_id);
    }
    activity.log({ type: 'flashcard_reviewed', label: `Flashcard reviewed: ${card.front.slice(0, 60)}`, refType: 'flashcard', refId: card.id });
  })();
  res.json(view(getCard(card.id)));
});

router.delete('/:id', (req, res) => {
  const row = getCard(v.id(req.params.id));
  db.prepare('DELETE FROM flashcards WHERE id = ?').run(row.id); // reviews cascade
  res.json({ ok: true });
});

module.exports = router;
