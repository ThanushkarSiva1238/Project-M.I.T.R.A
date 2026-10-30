const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const t = require('./helpers');

before(() => t.startApp());
after(() => t.stopApp());
beforeEach(() => {
  t.mock.reset();
  t.configureAi();
});

const send = async (conv, payload) => t.post(`/api/conversations/${conv}/messages`, payload);
const newConv = async () => (await t.post('/api/conversations', {})).body.id;
const countMessages = (conv) => t.db.prepare('SELECT COUNT(*) c FROM messages WHERE conversation_id = ?').get(conv).c;

test('missing API key: clear error, nothing saved, rest of the app still works', async () => {
  t.unconfigureAi();
  const conv = await newConv();
  const r = await send(conv, { content: 'Explain cognitive dissonance in simple words.', mode: 'simple_english' });
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, 'ai_not_configured');
  assert.match(r.body.error.message, /Settings/);
  assert.equal(countMessages(conv), 0);
  assert.equal(t.mock.calls.length, 0);
  assert.equal((await t.get('/api/dictionary?q=schema')).status, 200);
  assert.equal((await t.post('/api/notes', { title: 'works' })).status, 201);
});

test('valid paragraph: simple English explanation is generated and saved', async () => {
  const conv = await newConv();
  const r = await send(conv, { content: 'Cognitive dissonance is the mental discomfort of holding conflicting beliefs.', mode: 'simple_english' });
  assert.equal(r.status, 201);
  assert.match(r.body.assistantMessage.content, /Simple English/);
  assert.equal(r.body.assistantMessage.origin, 'ai');
  assert.equal(t.mock.calls.length, 1);
  const call = t.mock.calls[0];
  assert.equal(call.headers['x-api-key'], 'test-key-12345678');
  assert.equal(call.body.model, 'test-model');
  assert.match(call.system, /clear, simple English/);
  assert.match(call.body.messages[0].content, /<<<TEXT/);
  const reopened = await t.get(`/api/conversations/${conv}`);
  assert.equal(reopened.body.messages.length, 2);
  assert.equal(reopened.body.title, 'Cognitive dissonance is the mental discomfort of holding conflicting beliefs.'.slice(0, 60));
});

test('Tamil mode asks for Tamil with English terms in brackets', async () => {
  const conv = await newConv();
  const r = await send(conv, { content: 'Reinforcement increases behaviour.', mode: 'tamil' });
  assert.equal(r.status, 201);
  assert.match(t.mock.calls[0].system, /Tamil/);
  assert.match(t.mock.calls[0].system, /தமிழ் விளக்கம்/);
  assert.match(r.body.assistantMessage.content, /தமிழ்/);
});

test('the same question is answered from the saved copy (no new AI request) unless regenerated', async () => {
  const conv = await newConv();
  const payload = { content: 'Explain schema theory.', mode: 'full' };
  const first = await send(conv, payload);
  assert.equal(t.mock.calls.length, 1);
  const second = await send(conv, { ...payload, content: '  explain   SCHEMA theory. ' });
  assert.equal(second.status, 201);
  assert.equal(second.body.assistantMessage.origin, 'cache');
  assert.equal(second.body.assistantMessage.explanation_id, first.body.assistantMessage.explanation_id);
  assert.equal(t.mock.calls.length, 1);
  await send(conv, { ...payload, regenerate: true });
  assert.equal(t.mock.calls.length, 2);
});

test('errors never erase input and never save partial records', async () => {
  const conv = await newConv();
  const payload = { content: 'A paragraph the student typed.', mode: 'full' };

  t.mock.behaviour = { delayMs: 1200 };
  const timeout = await send(conv, payload);
  assert.equal(timeout.status, 504);
  assert.equal(timeout.body.error.code, 'ai_timeout');

  t.mock.behaviour = { raw: '{"nonsense":true}' };
  const invalid = await send(conv, payload);
  assert.equal(invalid.status, 502);
  assert.equal(invalid.body.error.code, 'ai_invalid_response');

  t.mock.behaviour = { raw: 'this is not json' };
  assert.equal((await send(conv, payload)).body.error.code, 'ai_invalid_response');

  t.mock.behaviour = { status: 401 };
  const badKey = await send(conv, payload);
  assert.equal(badKey.status, 502);
  assert.match(badKey.body.error.message, /API key/);

  t.mock.behaviour = { status: 429 };
  assert.match((await send(conv, payload)).body.error.message, /quota|too many/);

  t.mock.behaviour = { status: 503 };
  assert.match((await send(conv, payload)).body.error.message, /problems|later/);

  assert.equal(countMessages(conv), 0, 'failed requests must not leave records behind');

  t.mock.reset();
  const ok = await send(conv, payload); // user-initiated retry works and creates exactly one pair
  assert.equal(ok.status, 201);
  assert.equal(countMessages(conv), 2);
});

test('offline: unreachable provider gives a friendly error', async () => {
  t.configureAi({ AI_BASE_URL: 'http://127.0.0.1:9' });
  const conv = await newConv();
  const r = await send(conv, { content: 'Hello there', mode: 'full' });
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, 'ai_offline');
  assert.match(r.body.error.message, /internet connection/);
  assert.equal(countMessages(conv), 0);
});

test('input limit and daily usage limit are enforced before calling the provider', async () => {
  const conv = await newConv();
  t.configureAi({ AI_MAX_INPUT_CHARS: '50' });
  const long = await send(conv, { content: 'x'.repeat(200), mode: 'full' });
  assert.equal(long.status, 413);
  assert.equal(long.body.error.code, 'ai_input_too_long');
  assert.equal(t.mock.calls.length, 0);

  t.configureAi({ AI_DAILY_LIMIT: '1' });
  t.db.prepare(`INSERT INTO ai_usage (day, provider, model, ok) VALUES (?, 'anthropic', 'm', 1)`).run(require('../lib/dates').localDate());
  const limited = await send(conv, { content: 'short', mode: 'full' });
  assert.equal(limited.status, 429);
  assert.equal(t.mock.calls.length, 0);
});

test('openai-compatible providers use chat/completions with a Bearer key', async () => {
  t.configureAi({ AI_PROVIDER: 'openai-compatible' });
  const conv = await newConv();
  const r = await send(conv, { content: 'Explain working memory.', mode: 'main_idea' });
  assert.equal(r.status, 201);
  assert.ok(t.mock.calls[0].url.endsWith('/chat/completions'));
  assert.equal(t.mock.calls[0].headers.authorization, 'Bearer test-key-12345678');
  assert.equal(t.mock.calls[0].body.messages[0].role, 'system');
});

test('term lookup uses the local dictionary first; unknown terms are AI-defined and marked unverified', async () => {
  const conv = await newConv();
  const local = await send(conv, { content: 'What does cognitive dissonance mean?', mode: 'term' });
  assert.equal(local.status, 201);
  assert.equal(local.body.assistantMessage.origin, 'local');
  assert.match(local.body.assistantMessage.content, /no AI request was made/);
  assert.equal(t.mock.calls.length, 0);

  const ai = await send(conv, { content: 'Test Term', mode: 'term' });
  assert.equal(ai.body.assistantMessage.origin, 'ai');
  assert.match(ai.body.assistantMessage.content, /not verified/);
  const entry = (await t.get('/api/dictionary?q=Test Term')).body.find((x) => x.term === 'Test Term');
  assert.equal(entry.origin, 'ai');
  assert.equal(entry.verified, false);
  assert.equal(t.mock.calls.length, 1);
});

test('document source labels only include a page when the page is really known', async () => {
  const up = await t.upload('/api/documents', 'cog_psych.pdf', t.makePdf(['Page one text', 'Page two text']));
  const conv = await newConv();
  const withPage = await send(conv, { content: 'Page two text', mode: 'full', documentId: up.body.id, page: 2 });
  assert.equal(withPage.body.userMessage.source_label, 'cog psych, page 2');
  assert.match(t.mock.calls[0].body.messages[0].content, /Source: cog psych, page 2/);
  const bogus = await send(conv, { content: 'Other text', mode: 'full', documentId: up.body.id, page: 99 });
  assert.equal(bogus.body.userMessage.source_label, 'cog psych');
  const docx = await t.upload('/api/documents', 'notes.docx', t.makeDocx('Some words'));
  const noPages = await send(conv, { content: 'Some words', mode: 'full', documentId: docx.body.id, page: 3 });
  assert.equal(noPages.body.userMessage.source_label, 'notes');
});

test('flashcards: AI draft is not saved until reviewed; saved cards follow the interval ladder', async () => {
  const gen = await t.post('/api/flashcards/generate', { text: 'X is Y. Z is W.', count: 4 });
  assert.equal(gen.status, 200);
  assert.equal(gen.body.cards.length, 2);
  assert.equal((await t.get('/api/flashcards')).body.length, 0);
  assert.match(t.mock.calls[0].system, /ONLY on the student's supplied text/);

  const saved = await t.post('/api/flashcards/bulk', { cards: gen.body.cards, sourceNote: 'Lecture 1' });
  assert.equal(saved.body.created, 2);
  const queue = (await t.get('/api/flashcards/queue')).body;
  assert.equal(queue.due, 2);

  const today = require('../lib/dates').localDate();
  const id = queue.cards[0].id;
  let r = (await t.post(`/api/flashcards/${id}/review`, { result: 'understood' })).body;
  assert.equal(r.dueDate, require('../lib/dates').addDays(today, 1));
  assert.equal(r.status, 'learning');
  r = (await t.post(`/api/flashcards/${id}/review`, { result: 'understood' })).body;
  assert.equal(r.dueDate, require('../lib/dates').addDays(today, 3));
  r = (await t.post(`/api/flashcards/${id}/review`, { result: 'revision' })).body;
  assert.equal(r.status, 'needs_revision');
  assert.equal(r.step, 0);
  assert.equal(r.dueDate, require('../lib/dates').addDays(today, 1));
  assert.equal(r.reviewCount, 3);
  assert.equal((await t.get('/api/flashcards/queue')).body.due, 1);
});

test('quiz: generated, invalid AI questions dropped, deterministic grading, history saved', async () => {
  const gen = await t.post('/api/quizzes/generate', { topic: 'Memory', count: 5 });
  assert.equal(gen.status, 201);
  const review = (await t.get(`/api/quizzes/${gen.body.id}?review=1`)).body;
  assert.equal(review.questions.length, 2, 'the question with duplicate options must be rejected');
  assert.equal(review.aiGenerated, true);
  const taking = (await t.get(`/api/quizzes/${gen.body.id}`)).body;
  assert.equal(taking.questions[0].correct, undefined, 'answers must not be sent while taking the quiz');

  const attempt = (await t.post(`/api/quizzes/${gen.body.id}/attempts`)).body;
  const [q1, q2] = attempt.questions;
  const res = await t.post(`/api/quizzes/attempts/${attempt.attemptId}/submit`, { answers: { [q1.id]: '1', [q2.id]: 'false' } });
  assert.equal(res.body.score, 1);
  assert.equal(res.body.total, 2);
  assert.equal(res.body.percent, 50);
  assert.equal(res.body.results[0].isCorrect, true);
  assert.equal(res.body.results[1].isCorrect, false);
  assert.equal(res.body.results[1].correct, 'true');
  assert.equal((await t.post(`/api/quizzes/attempts/${attempt.attemptId}/submit`, { answers: {} })).status, 409);

  const hist = (await t.get(`/api/quizzes/${gen.body.id}/attempts`)).body;
  assert.equal(hist.length, 1);
  assert.equal(hist[0].percent, 50);
  const summary = (await t.get('/api/progress/summary')).body;
  assert.equal(summary.quizzes.attempts, 1);
  assert.equal(summary.quizzes.averagePercent, 50);
});
