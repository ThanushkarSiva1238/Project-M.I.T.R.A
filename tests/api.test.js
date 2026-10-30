const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const t = require('./helpers');
const { localDate, addDays } = require('../lib/dates');

before(() => t.startApp());
after(() => t.stopApp());

test('security: loopback host only, CSRF header required, security headers set', async () => {
  const noHeader = await fetch(t.base() + '/api/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(noHeader.status, 403);
  const crossOrigin = await fetch(t.base() + '/api/notes', { method: 'POST', headers: { 'content-type': 'application/json', 'x-mitra-request': '1', origin: 'https://evil.example' }, body: '{}' });
  assert.equal(crossOrigin.status, 403);

  const http = require('http');
  const status = await new Promise((resolve) => {
    const u = new URL(t.base());
    http.get({ host: u.hostname, port: u.port, path: '/api/health', headers: { host: 'evil.example' } }, (res) => resolve(res.statusCode));
  });
  assert.equal(status, 421, 'DNS-rebinding style host header must be refused');

  const page = await fetch(t.base() + '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(page.headers.get('x-powered-by'), null);
});

test('the server binds to the loopback interface by default', () => {
  assert.equal(t.config.HOST, '127.0.0.1');
});

test('API key is write-only and persisted to the .env file only', async () => {
  const before = (await t.get('/api/settings')).body;
  assert.equal(before.ai.hasKey, false);
  const saved = await t.put('/api/settings/ai', { provider: 'anthropic', model: 'some-model', apiKey: 'sk-test-ABCDEFGH12345678' });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.ai.hasKey, true);
  assert.ok(!saved.text.includes('ABCDEFGH12345678'), 'the key must never be returned');
  assert.ok(!(await t.get('/api/settings')).text.includes('ABCDEFGH12345678'));
  assert.match(fs.readFileSync(t.config.ENV_FILE, 'utf8'), /AI_API_KEY=sk-test-ABCDEFGH12345678/);
  assert.equal((await t.put('/api/settings/ai', { apiKey: 'bad key with spaces\nAI_X=1' })).status, 400);
  assert.equal((await t.put('/api/settings/ai', { baseUrl: 'http://example.com' })).status, 400);
  assert.equal((await t.put('/api/settings/ai', { baseUrl: 'https://api.example.com/v1/' })).body.ai.baseUrl, 'https://api.example.com/v1');
  const removed = await t.del('/api/settings/ai-key');
  assert.equal(removed.body.ai.hasKey, false);
});

test('theme and display name persist in the database', async () => {
  await t.put('/api/settings', { theme: 'dark', displayName: 'Priya' });
  t.db.reopen();
  const s = (await t.get('/api/settings')).body;
  assert.equal(s.theme, 'dark');
  assert.equal(s.displayName, 'Priya');
  assert.equal((await t.put('/api/settings', { theme: 'neon' })).status, 400);
});

test('calendar events: validation, month query, upcoming and completion', async () => {
  const today = localDate();
  assert.equal((await t.post('/api/calendar/events', { title: '', date: today, startTime: '10:00' })).status, 400);
  assert.equal((await t.post('/api/calendar/events', { title: 'x', date: '2026-02-31', startTime: '10:00' })).status, 400);
  assert.equal((await t.post('/api/calendar/events', { title: 'x', date: today, startTime: '25:00' })).status, 400);
  assert.equal((await t.post('/api/calendar/events', { title: 'x', date: today, startTime: '10:00', endTime: '09:00' })).status, 400);

  const a = (await t.post('/api/calendar/events', { title: 'Lecture 05', date: today, startTime: '10:00', category: 'study' })).body;
  const b = (await t.post('/api/calendar/events', { title: 'Exam', date: addDays(today, 20), startTime: '09:00', endTime: '11:00', category: 'exam' })).body;
  await t.post('/api/calendar/events', { title: 'Yesterday', date: addDays(today, -1), startTime: '09:00' });

  const month = (await t.get(`/api/calendar/events?from=${addDays(today, -2)}&to=${addDays(today, 30)}`)).body;
  assert.equal(month.length, 3);
  const upcoming = (await t.get('/api/calendar/upcoming')).body;
  assert.deepEqual(upcoming.map((e) => e.title), ['Lecture 05', 'Exam']);
  await t.patch(`/api/calendar/events/${a.id}/complete`, { completed: true });
  assert.deepEqual((await t.get('/api/calendar/upcoming')).body.map((e) => e.title), ['Exam']);
  assert.equal((await t.put(`/api/calendar/events/${b.id}`, { title: 'Exam (moved)', date: addDays(today, 21), startTime: '09:00', category: 'exam' })).body.date, addDays(today, 21));
  assert.equal((await t.del(`/api/calendar/events/${b.id}`)).status, 200);
});

test('vocabulary: add, duplicates, from dictionary, status filter, flashcards from vocabulary', async () => {
  const w = await t.post('/api/vocabulary', { word: 'Reinforcement', meaning: 'Something that makes a behaviour more likely.', tamil: 'வலுவூட்டல்' });
  assert.equal(w.status, 201);
  const dup = await t.post('/api/vocabulary', { word: 'reinforcement' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.id, w.body.id);

  const term = (await t.get('/api/dictionary?q=Metacognition')).body[0];
  const fromTerm = await t.post(`/api/vocabulary/from-term/${term.id}`);
  assert.equal(fromTerm.status, 201);
  assert.equal(fromTerm.body.item.psychMeaning.length > 10, true);
  assert.equal((await t.post(`/api/vocabulary/from-term/${term.id}`)).body.existing, true);

  await t.patch(`/api/vocabulary/${w.body.id}/status`, { status: 'needs_revision' });
  assert.equal((await t.get('/api/vocabulary?status=needs_revision')).body.length, 1);
  assert.equal((await t.get('/api/vocabulary?q=வலு')).body.length, 1);
  const counts = (await t.get('/api/vocabulary/counts')).body;
  assert.equal(counts.total, 2);
  assert.equal(counts.needs_revision, 1);

  const cards = await t.post('/api/flashcards/from-vocabulary', {});
  assert.equal(cards.body.created, 2);
  assert.equal((await t.post('/api/flashcards/from-vocabulary', {})).body.created, 0);

  // reviewing a vocabulary-linked card updates the word's status
  const card = (await t.get('/api/flashcards')).body.find((c) => c.vocabularyId === w.body.id);
  await t.post(`/api/flashcards/${card.id}/review`, { result: 'understood' });
  assert.equal((await t.get('/api/vocabulary?q=Reinforcement')).body[0].status, 'learning');

  assert.equal((await t.del(`/api/vocabulary/${w.body.id}`)).status, 200);
  assert.equal((await t.get(`/api/flashcards`)).body.length, 2, 'cards survive deleting the word');
});

test('global search finds notes, terms, vocabulary, conversations and explanations', async () => {
  await t.post('/api/notes', { title: 'Piaget stages', content: '<p>sensorimotor stage</p>' });
  const conv = (await t.post('/api/conversations', { title: 'About sensorimotor play' })).body;
  const ex = t.db.prepare(`INSERT INTO explanations (title, mode, source_text, source_hash, content) VALUES ('sensorimotor explained','full','s','hh','sensorimotor means...')`).run().lastInsertRowid;
  t.db.prepare(`INSERT INTO messages (conversation_id, role, content, explanation_id, origin) VALUES (?, 'assistant', 'x', ?, 'ai')`).run(conv.id, ex);
  const r = (await t.get('/api/search?q=sensorimotor')).body;
  assert.ok(r.groups.notes && r.groups.conversations && r.groups.explanations);
  assert.equal(r.groups.explanations[0].conversation_id, conv.id);
  assert.ok((await t.get('/api/search?q=Object Permanence')).body.groups.terms);
  assert.deepEqual((await t.get('/api/search?q=a')).body.groups, {}, 'one-letter queries are ignored');
  assert.deepEqual((await t.get('/api/search?q=%25_%5C')).body.groups, {}, 'LIKE wildcards are escaped');
});

test('progress summary and activity use only real records', async () => {
  const s = (await t.get('/api/progress/summary')).body;
  assert.equal(s.today, localDate());
  assert.equal(s.activityByDay.length, 14);
  assert.equal(s.activityByDay.at(-1).day, localDate());
  assert.ok(s.activityByDay.at(-1).count > 0);
  assert.ok(s.streakDays >= 1);
  assert.equal(s.quizzes.averagePercent, null, 'no quiz attempts yet, so no average is invented');
  const act = (await t.get('/api/activity?limit=5')).body;
  assert.ok(act.length > 0 && act.every((a) => a.label && a.type));
});

test('input validation returns friendly 400/404 errors, not crashes', async () => {
  assert.equal((await t.get('/api/notes/abc')).status, 400);
  assert.equal((await t.get('/api/notes/999999')).status, 404);
  assert.equal((await t.post('/api/vocabulary', { word: 'x'.repeat(500) })).status, 400);
  assert.equal((await t.api('POST', '/api/notes', undefined, { headers: { 'content-type': 'application/json' } })).status, 201);
  const bad = await fetch(t.base() + '/api/notes', { method: 'POST', headers: { 'content-type': 'application/json', 'x-mitra-request': '1' }, body: '{not json' });
  assert.equal(bad.status, 400);
  assert.equal((await t.get('/api/nope')).status, 404);
  assert.equal((await t.post('/api/conversations/999999/messages', { content: 'x', mode: 'bogus' })).status, 404);
  const conv = (await t.post('/api/conversations', {})).body.id;
  assert.equal((await t.post(`/api/conversations/${conv}/messages`, { content: 'x', mode: 'bogus' })).status, 400);
});

test('conversations can be renamed and reopened', async () => {
  const c = (await t.post('/api/conversations', { title: 'Old name' })).body;
  assert.equal((await t.patch(`/api/conversations/${c.id}`, { title: 'New name' })).body.title, 'New name');
  assert.equal((await t.patch(`/api/conversations/${c.id}`, { title: '  ' })).status, 400);
  const list = (await t.get('/api/conversations')).body;
  assert.ok(list.some((x) => x.title === 'New name'));
});
