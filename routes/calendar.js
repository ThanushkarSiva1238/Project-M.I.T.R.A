/** Study calendar events. Dates/times are the student's local wall-clock values. */
const express = require('express');
const db = require('../database/db');
const activity = require('../lib/activity');
const { localDate } = require('../lib/dates');
const v = require('../lib/validate');
const { notFound, badInput } = require('../lib/errors');

const router = express.Router();
const CATEGORIES = ['study', 'revision', 'quiz', 'assignment', 'exam', 'other'];

const view = (r) => ({
  id: r.id, title: r.title, description: r.description, date: r.event_date, startTime: r.start_time, endTime: r.end_time,
  category: r.category, completed: !!r.completed,
});

function getEvent(id) {
  const r = db.prepare('SELECT * FROM study_events WHERE id = ?').get(id);
  if (!r) throw notFound('Event');
  return r;
}

function fields(b) {
  const f = {
    title: v.text(b.title, 'Title', { max: 120, required: true }),
    description: v.text(b.description, 'Description', { max: 1000 }),
    event_date: v.date(b.date, 'Date', { required: true }),
    start_time: v.time(b.startTime, 'Start time', { required: true }),
    end_time: v.time(b.endTime, 'End time'),
    category: v.oneOf(b.category, 'Category', CATEGORIES, { fallback: 'other' }),
  };
  if (f.end_time && f.end_time < f.start_time) throw badInput('The end time must be after the start time.');
  return f;
}

router.get('/events', (req, res) => {
  const from = v.date(req.query.from, 'from');
  const to = v.date(req.query.to, 'to');
  const rows =
    from && to
      ? db.prepare('SELECT * FROM study_events WHERE event_date BETWEEN ? AND ? ORDER BY event_date, start_time').all(from, to)
      : db.prepare('SELECT * FROM study_events ORDER BY event_date DESC, start_time LIMIT 500').all();
  res.json(rows.map(view));
});

/** Not-yet-completed events from today onward. */
router.get('/upcoming', (req, res) => {
  const limit = v.int(req.query.limit, 'limit', { min: 1, max: 50 }) || 5;
  const rows = db
    .prepare('SELECT * FROM study_events WHERE completed = 0 AND event_date >= ? ORDER BY event_date, start_time LIMIT ?')
    .all(localDate(), limit);
  res.json(rows.map(view));
});

router.post('/events', (req, res) => {
  const f = fields(req.body || {});
  const info = db
    .prepare(
      `INSERT INTO study_events (title, description, event_date, start_time, end_time, category)
       VALUES (@title, @description, @event_date, @start_time, @end_time, @category)`
    )
    .run(f);
  res.status(201).json(view(getEvent(info.lastInsertRowid)));
});

router.put('/events/:id', (req, res) => {
  const row = getEvent(v.id(req.params.id));
  const f = fields(req.body || {});
  db.prepare(
    `UPDATE study_events SET title=@title, description=@description, event_date=@event_date, start_time=@start_time,
       end_time=@end_time, category=@category, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=@id`
  ).run({ ...f, id: row.id });
  res.json(view(getEvent(row.id)));
});

router.patch('/events/:id/complete', (req, res) => {
  const row = getEvent(v.id(req.params.id));
  const completed = v.bool(req.body?.completed) ? 1 : 0;
  db.prepare(`UPDATE study_events SET completed = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(completed, row.id);
  if (completed) activity.log({ type: 'event_completed', label: `Completed: ${row.title}`, refType: 'event', refId: row.id });
  res.json(view(getEvent(row.id)));
});

router.delete('/events/:id', (req, res) => {
  const row = getEvent(v.id(req.params.id));
  db.prepare('DELETE FROM study_events WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

module.exports = router;
