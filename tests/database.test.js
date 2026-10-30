const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const t = require('./helpers');

before(() => t.startApp());
after(() => t.stopApp());

test('schema is migrated, foreign keys are enforced, and the built-in dictionary is seeded', () => {
  assert.equal(t.db.pragma('foreign_keys', { simple: true }), 1);
  assert.equal(t.db.prepare('SELECT MAX(version) v FROM schema_migrations').get().v, t.db.latestVersion());
  assert.ok(t.db.prepare(`SELECT COUNT(*) c FROM psychology_terms WHERE origin = 'builtin'`).get().c >= 30);
  assert.throws(() => t.db.prepare(`INSERT INTO messages (conversation_id, role, content) VALUES (9999, 'user', 'x')`).run(), /FOREIGN KEY/);
});

test('create, edit and reopen a note; HTML is sanitised; stale saves are rejected', async () => {
  const created = await t.post('/api/notes', { title: 'Memory', content: '<p>Encoding <b>matters</b></p><script>alert(1)</script><img src=x onerror=alert(1)>' });
  assert.equal(created.status, 201);
  assert.equal(created.body.content, '<p>Encoding <b>matters</b></p>');

  const saved = await t.put(`/api/notes/${created.body.id}`, { title: 'Memory notes', content: '<h2>Heading</h2><ul><li>one</li></ul><a href="javascript:alert(1)">bad</a><a href="https://example.org">ok</a>', version: 1 });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.version, 2);
  assert.ok(!saved.body.content.includes('javascript:'));
  assert.ok(saved.body.content.includes('href="https://example.org"'));

  const stale = await t.put(`/api/notes/${created.body.id}`, { title: 'Old', version: 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.current.title, 'Memory notes');

  const reopened = await t.get(`/api/notes/${created.body.id}`);
  assert.equal(reopened.body.title, 'Memory notes');
  const search = await t.get('/api/notes?q=heading');
  assert.equal(search.body.length, 1);
});

test('data survives an application restart (database closed and re-opened)', async () => {
  const n = await t.post('/api/notes', { title: 'Persist me', content: '<p>still here</p>' });
  t.db.reopen();
  const again = await t.get(`/api/notes/${n.body.id}`);
  assert.equal(again.status, 200);
  assert.equal(again.body.title, 'Persist me');
  assert.equal(await t.get('/api/health').then((r) => r.body.ok), true);
});

test('saved explanations can be reopened without any AI request', async () => {
  t.db.prepare(`INSERT INTO conversations (title) VALUES ('c')`).run();
  const conv = t.db.prepare('SELECT MAX(id) id FROM conversations').get().id;
  const ex = t.db.prepare(`INSERT INTO explanations (title, mode, source_text, source_hash, content) VALUES ('t','full','src','h1','saved answer')`).run().lastInsertRowid;
  t.db.prepare(`INSERT INTO messages (conversation_id, role, content, explanation_id, origin) VALUES (?, 'assistant', 'saved answer', ?, 'ai')`).run(conv, ex);
  t.mock.reset();
  const r = await t.get(`/api/explanations/${ex}`);
  assert.equal(r.body.content, 'saved answer');
  const c = await t.get(`/api/conversations/${conv}`);
  assert.equal(c.body.messages[0].content, 'saved answer');
  assert.equal(t.mock.calls.length, 0);
});

test('deleting a conversation removes its messages and unsaved explanations but keeps saved ones', async () => {
  const conv = (await t.post('/api/conversations', { title: 'del' })).body.id;
  const mk = (hash, saved) => {
    const id = t.db.prepare(`INSERT INTO explanations (title, mode, source_text, source_hash, content, saved) VALUES ('x','full','s',?,'c',?)`).run(hash, saved).lastInsertRowid;
    t.db.prepare(`INSERT INTO messages (conversation_id, role, content, explanation_id, origin) VALUES (?, 'assistant', 'c', ?, 'ai')`).run(conv, id);
    return id;
  };
  const keep = mk('keep', 1);
  const drop = mk('drop', 0);
  const r = await t.del(`/api/conversations/${conv}`);
  assert.equal(r.status, 200);
  assert.equal((await t.get(`/api/conversations/${conv}`)).status, 404);
  assert.equal(t.db.prepare('SELECT COUNT(*) c FROM messages WHERE conversation_id = ?').get(conv).c, 0);
  assert.ok(t.db.prepare('SELECT 1 FROM explanations WHERE id = ?').get(keep));
  assert.equal(t.db.prepare('SELECT 1 FROM explanations WHERE id = ?').get(drop), undefined);
});

test('deleting a document un-links notes instead of deleting them', async () => {
  const up = await t.upload('/api/documents', 'lecture.pdf', t.makePdf(['Hello MITRA']));
  assert.equal(up.status, 201);
  const note = await t.post('/api/notes', { title: 'Linked', content: '<p>x</p>', documentId: up.body.id });
  assert.equal(note.body.documentId, up.body.id);
  assert.equal((await t.del(`/api/documents/${up.body.id}`)).status, 200);
  const after = await t.get(`/api/notes/${note.body.id}`);
  assert.equal(after.status, 200);
  assert.equal(after.body.documentId, null);
});

test('built-in dictionary entries are protected; user entries are editable', async () => {
  const builtin = (await t.get('/api/dictionary?q=Cognitive Dissonance')).body[0];
  assert.equal(builtin.origin, 'builtin');
  assert.equal((await t.del(`/api/dictionary/${builtin.id}`)).status, 403);
  const own = await t.put(`/api/dictionary/${builtin.id}`, { term: 'Hacked', simpleEnglish: 'changed', personalNote: 'My own words' });
  assert.equal(own.body.term, 'Cognitive Dissonance');
  assert.notEqual(own.body.simpleEnglish, 'changed');
  assert.equal(own.body.personalNote, 'My own words');

  const mine = await t.post('/api/dictionary', { term: 'My Term', simpleEnglish: 'mine' });
  assert.equal(mine.status, 201);
  assert.equal(mine.body.origin, 'user');
  assert.equal((await t.post('/api/dictionary', { term: 'my term', simpleEnglish: 'dup' })).status, 409);
  assert.equal((await t.del(`/api/dictionary/${mine.body.id}`)).status, 200);
});
