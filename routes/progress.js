/** Learning progress + recent activity. Everything here is computed from stored records. */
const express = require('express');
const db = require('../database/db');
const { localDate, addDays } = require('../lib/dates');
const v = require('../lib/validate');

const router = express.Router();

router.get('/activity', (req, res) => {
  const limit = v.int(req.query.limit, 'limit', { min: 1, max: 100 }) || 8;
  const rows = db.prepare('SELECT id, type, label, ref_type, ref_id, created_at FROM activity_log ORDER BY id DESC LIMIT ?').all(limit);
  res.json(rows.map((r) => ({ id: r.id, type: r.type, label: r.label, refType: r.ref_type, refId: r.ref_id, createdAt: r.created_at })));
});

const count = (sql, ...p) => db.prepare(sql).get(...p).c;

router.get('/progress/summary', (req, res) => {
  const today = localDate();

  const vocab = { new: 0, learning: 0, needs_revision: 0, learned: 0 };
  for (const r of db.prepare('SELECT status, COUNT(*) c FROM vocabulary GROUP BY status').all()) vocab[r.status] = r.c;

  const flash = {
    total: count('SELECT COUNT(*) c FROM flashcards'),
    due: count('SELECT COUNT(*) c FROM flashcards WHERE due_date <= ?', today),
    learned: count(`SELECT COUNT(*) c FROM flashcards WHERE status = 'learned'`),
    needsRevision: count(`SELECT COUNT(*) c FROM flashcards WHERE status = 'needs_revision'`),
    reviewedToday: count('SELECT COUNT(*) c FROM flashcard_reviews WHERE day = ?', today),
  };

  const attempts = db
    .prepare(
      `SELECT a.id, a.quiz_id, q.title, a.score, a.total, a.completed_at, ROUND(100.0 * a.score / a.total) AS percent
       FROM quiz_attempts a JOIN quizzes q ON q.id = a.quiz_id WHERE a.completed_at IS NOT NULL ORDER BY a.id DESC`
    )
    .all();
  const quizzes = {
    count: count('SELECT COUNT(*) c FROM quizzes'),
    attempts: attempts.length,
    averagePercent: attempts.length ? Math.round(attempts.reduce((s, a) => s + a.percent, 0) / attempts.length) : null,
    bestPercent: attempts.length ? Math.max(...attempts.map((a) => a.percent)) : null,
    recent: attempts.slice(0, 8).map((a) => ({ attemptId: a.id, quizId: a.quiz_id, title: a.title, score: a.score, total: a.total, percent: a.percent, completedAt: a.completed_at })),
  };

  // Activity per local day for the last 14 days.
  const start = addDays(today, -13);
  const byDay = new Map(
    db
      .prepare(`SELECT date(created_at, 'localtime') AS day, COUNT(*) c FROM activity_log WHERE date(created_at, 'localtime') >= ? GROUP BY day`)
      .all(start)
      .map((r) => [r.day, r.c])
  );
  const activityByDay = [];
  for (let i = 0; i < 14; i++) {
    const day = addDays(start, i);
    activityByDay.push({ day, count: byDay.get(day) || 0 });
  }
  // Streak: consecutive days with any activity, counting back from today (or yesterday).
  const activeDays = new Set(
    db.prepare(`SELECT DISTINCT date(created_at, 'localtime') AS day FROM activity_log WHERE date(created_at, 'localtime') >= ?`).all(addDays(today, -400)).map((r) => r.day)
  );
  let streak = 0;
  let cursor = activeDays.has(today) ? today : addDays(today, -1);
  while (activeDays.has(cursor)) {
    streak++;
    cursor = addDays(cursor, -1);
  }

  const recentTopics = db
    .prepare(
      `SELECT type, label, ref_type, ref_id, MAX(created_at) AS at FROM activity_log
       WHERE type IN ('explanation','note_updated','note_created','quiz_completed')
       GROUP BY label ORDER BY at DESC LIMIT 6`
    )
    .all()
    .map((r) => ({ type: r.type, label: r.label, refType: r.ref_type, refId: r.ref_id, at: r.at }));

  const upcoming = db
    .prepare('SELECT id, title, event_date, start_time, category FROM study_events WHERE completed = 0 AND event_date >= ? ORDER BY event_date, start_time LIMIT 5')
    .all(today)
    .map((e) => ({ id: e.id, title: e.title, date: e.event_date, startTime: e.start_time, category: e.category }));

  const reminders = {
    eventsToday: count('SELECT COUNT(*) c FROM study_events WHERE completed = 0 AND event_date = ?', today),
    overdueEvents: count('SELECT COUNT(*) c FROM study_events WHERE completed = 0 AND event_date < ?', today),
    flashcardsDue: flash.due,
    vocabularyNeedsRevision: vocab.needs_revision,
  };

  res.json({
    today,
    counts: {
      notes: count('SELECT COUNT(*) c FROM study_notes'),
      documents: count('SELECT COUNT(*) c FROM documents'),
      conversations: count('SELECT COUNT(*) c FROM conversations'),
      savedTerms: count('SELECT COUNT(*) c FROM psychology_terms WHERE saved = 1'),
      vocabulary: vocab.new + vocab.learning + vocab.needs_revision + vocab.learned,
    },
    vocabulary: vocab,
    flashcards: flash,
    quizzes,
    activityByDay,
    streakDays: streak,
    recentTopics,
    upcomingEvents: upcoming,
    reminders,
  });
});

module.exports = router;
