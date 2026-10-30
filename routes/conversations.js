/**
 * Conversations with the MITRA AI Tutor.
 *
 * Persistence policy (also in the README):
 *  - A question and its answer are saved together, only after the answer arrives.
 *    If the AI request fails nothing is saved and the browser keeps the typed text,
 *    so there are no half-saved conversations and no duplicates on retry.
 *  - Answers are kept in "explanations" so the identical question is answered from
 *    the local copy instead of calling the AI again (unless "regenerate" is asked).
 *  - Deleting a conversation also deletes its explanations, except ones the student
 *    marked as saved.
 */
const crypto = require('crypto');
const express = require('express');
const db = require('../database/db');
const ai = require('../services/aiService');
const prompts = require('../services/prompts');
const { termToMarkdown } = require('../services/termFormat');
const activity = require('../lib/activity');
const v = require('../lib/validate');
const { HttpError, notFound } = require('../lib/errors');

const router = express.Router();
const inflight = new Set();

const MESSAGE_SELECT = `
  SELECT m.id, m.role, m.content, m.mode, m.origin, m.document_id, m.source_label, m.term_id,
         m.explanation_id, m.created_at, COALESCE(e.saved, 0) AS saved
  FROM messages m LEFT JOIN explanations e ON e.id = m.explanation_id`;

function getConversation(id) {
  const c = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  if (!c) throw notFound('Conversation');
  return c;
}

router.get('/', (req, res) => {
  const limit = v.int(req.query.limit, 'limit', { min: 1, max: 200 }) || 50;
  const rows = db
    .prepare(
      `SELECT c.id, c.title, c.created_at, c.updated_at,
              (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) AS message_count,
              (SELECT substr(content, 1, 140) FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS preview,
              (SELECT role FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_role
       FROM conversations c ORDER BY c.updated_at DESC, c.id DESC LIMIT ?`
    )
    .all(limit);
  res.json(rows);
});

router.post('/', (req, res) => {
  const title = v.text(req.body?.title, 'Title', { max: 100 }) || 'New conversation';
  const info = db.prepare('INSERT INTO conversations (title) VALUES (?)').run(title);
  res.status(201).json(getConversation(info.lastInsertRowid));
});

router.get('/:id', (req, res) => {
  const c = getConversation(v.id(req.params.id));
  const messages = db.prepare(`${MESSAGE_SELECT} WHERE m.conversation_id = ? ORDER BY m.id`).all(c.id);
  res.json({ ...c, messages });
});

router.patch('/:id', (req, res) => {
  const c = getConversation(v.id(req.params.id));
  const title = v.text(req.body?.title, 'Title', { max: 100, required: true });
  db.prepare(`UPDATE conversations SET title = ? WHERE id = ?`).run(title, c.id);
  res.json(getConversation(c.id));
});

router.delete('/:id', (req, res) => {
  const c = getConversation(v.id(req.params.id));
  db.transaction(() => {
    db.prepare(
      `DELETE FROM explanations
       WHERE saved = 0
         AND id IN (SELECT explanation_id FROM messages WHERE conversation_id = @c AND explanation_id IS NOT NULL)
         AND id NOT IN (SELECT explanation_id FROM messages WHERE conversation_id <> @c AND explanation_id IS NOT NULL)`
    ).run({ c: c.id });
    db.prepare('DELETE FROM conversations WHERE id = ?').run(c.id); // messages cascade
  })();
  res.json({ ok: true });
});

// ------------------------------------------------------------------ send
function normalise(t) {
  return t.replace(/\s+/g, ' ').trim().toLowerCase();
}

function cleanTermQuery(text) {
  return text
    .replace(/^\s*(what\s+(does|is|are)|define|meaning\s+of|explain|what's)\s+/i, '')
    .replace(/\s+(mean|means)\s*\??\s*$/i, '')
    .replace(/[?!.]+\s*$/, '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .trim();
}

function saveAiTerm(entry, provider, model) {
  const existing = db.prepare('SELECT * FROM psychology_terms WHERE term = ?').get(entry.term);
  if (existing) return existing;
  const info = db
    .prepare(
      `INSERT INTO psychology_terms (term, pronunciation, simple_english, tamil, definition, example, everyday_example, related, origin, verified)
       VALUES (@term, @pronunciation, @simple_english, @tamil, @definition, @example, @everyday_example, @related, 'ai', 0)`
    )
    .run({ ...entry, related: JSON.stringify(entry.related || []) });
  return db.prepare('SELECT * FROM psychology_terms WHERE id = ?').get(info.lastInsertRowid);
}

router.post('/:id/messages', async (req, res) => {
  const conv = getConversation(v.id(req.params.id));
  const b = req.body || {};
  const text = v.text(b.content, 'Your message', { max: 50000, required: true });
  const mode = v.oneOf(b.mode, 'Explanation type', prompts.ALL_MODES, { fallback: 'full' });
  const regenerate = v.bool(b.regenerate);

  let documentId = null;
  let sourceLabel = null;
  if (b.documentId) {
    const doc = db.prepare('SELECT id, title, page_count FROM documents WHERE id = ?').get(v.id(b.documentId, 'documentId'));
    if (!doc) throw notFound('Document');
    const hasPages = db.prepare('SELECT has_pages FROM document_content WHERE document_id = ?').get(doc.id)?.has_pages;
    documentId = doc.id;
    sourceLabel = doc.title;
    const page = v.int(b.page, 'page', { min: 1 });
    if (page && hasPages && doc.page_count && page <= doc.page_count) sourceLabel += `, page ${page}`;
  }

  if (inflight.has(conv.id)) throw new HttpError(409, 'busy', 'MITRA is still answering your previous message in this conversation. Please wait a moment.');
  inflight.add(conv.id);
  try {
    let answer;
    let origin;
    let provider = null;
    let model = null;
    let termRow = null;
    let explanationId = null;

    if (mode === 'term') {
      const q = cleanTermQuery(text).slice(0, 100);
      if (!q) throw new HttpError(400, 'invalid_input', 'Please type the word or term you want explained.');
      termRow = db.prepare('SELECT * FROM psychology_terms WHERE term = ?').get(q);
      if (termRow) {
        origin = 'local';
      } else {
        const r = await ai.defineTerm(q);
        provider = r.provider;
        model = r.model;
        origin = 'ai';
        termRow = r.entry;
      }
    } else {
      const hash = crypto.createHash('sha256').update(`${mode}\n${normalise(text)}\n${sourceLabel || ''}`).digest('hex');
      const cached = regenerate ? null : db.prepare('SELECT * FROM explanations WHERE source_hash = ? ORDER BY id DESC LIMIT 1').get(hash);
      if (cached) {
        answer = cached.content;
        origin = 'cache';
        explanationId = cached.id;
      } else {
        const history = db
          .prepare(`SELECT role, content FROM messages WHERE conversation_id = ? AND origin <> 'local' ORDER BY id DESC LIMIT 6`)
          .all(conv.id)
          .reverse();
        const r = await ai.explain({ mode, text, sourceLabel, history });
        answer = r.text;
        provider = r.provider;
        model = r.model;
        origin = 'ai';
        explanationId = { hash };
      }
    }

    const result = db.transaction(() => {
      if (mode === 'term') {
        if (origin === 'ai') termRow = saveAiTerm(termRow);
        else db.prepare(`UPDATE psychology_terms SET last_accessed = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(termRow.id);
        answer = termToMarkdown(termRow, origin === 'ai' || termRow.origin === 'ai');
      } else if (explanationId && typeof explanationId === 'object') {
        const title = text.replace(/\s+/g, ' ').slice(0, 80);
        explanationId = db
          .prepare(
            `INSERT INTO explanations (document_id, title, mode, source_text, source_hash, content, provider, model)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(documentId, title, mode, text, explanationId.hash, answer, provider, model).lastInsertRowid;
      }
      if (conv.title === 'New conversation') {
        db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(text.replace(/\s+/g, ' ').slice(0, 60), conv.id);
      }
      const userMsg = db
        .prepare(`INSERT INTO messages (conversation_id, role, content, mode, document_id, source_label, origin) VALUES (?, 'user', ?, ?, ?, ?, 'user')`)
        .run(conv.id, text, mode, documentId, sourceLabel).lastInsertRowid;
      const aiMsg = db
        .prepare(
          `INSERT INTO messages (conversation_id, role, content, mode, document_id, source_label, origin, explanation_id, term_id)
           VALUES (?, 'assistant', ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(conv.id, answer, mode, documentId, sourceLabel, origin, mode === 'term' ? null : explanationId, mode === 'term' ? termRow.id : null).lastInsertRowid;
      db.prepare(`UPDATE conversations SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(conv.id);
      activity.log({
        type: 'explanation',
        label: mode === 'term' ? `Term: ${termRow.term}` : `Explanation: ${text.replace(/\s+/g, ' ').slice(0, 60)}`,
        refType: 'conversation',
        refId: conv.id,
      });
      return { userMsg, aiMsg };
    })();

    const messages = db.prepare(`${MESSAGE_SELECT} WHERE m.id IN (?, ?) ORDER BY m.id`).all(result.userMsg, result.aiMsg);
    res.status(201).json({ conversation: getConversation(conv.id), userMessage: messages[0], assistantMessage: messages[1] });
  } finally {
    inflight.delete(conv.id);
  }
});

module.exports = router;
