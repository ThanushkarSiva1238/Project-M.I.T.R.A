/** Global search across everything stored locally (no AI involved). */
const express = require('express');
const db = require('../database/db');
const v = require('../lib/validate');

const router = express.Router();
const PER_GROUP = 6;

router.get('/', (req, res) => {
  const q = v.text(req.query.q, 'q', { max: 100 });
  if (!q || q.length < 2) return res.json({ query: q || '', groups: {} });
  const like = v.like(q);
  const run = (sql) => db.prepare(sql).all({ like, n: PER_GROUP });

  const groups = {
    notes: run(`SELECT id, title, substr(plain_text, 1, 100) AS snippet FROM study_notes
                WHERE title LIKE @like ESCAPE '\\' OR plain_text LIKE @like ESCAPE '\\' ORDER BY updated_at DESC LIMIT @n`),
    documents: run(`SELECT id, title, original_name AS snippet FROM documents
                    WHERE title LIKE @like ESCAPE '\\' OR original_name LIKE @like ESCAPE '\\' ORDER BY created_at DESC LIMIT @n`),
    terms: run(`SELECT id, term AS title, substr(simple_english, 1, 100) AS snippet, origin FROM psychology_terms
                WHERE term LIKE @like ESCAPE '\\' OR simple_english LIKE @like ESCAPE '\\' OR tamil LIKE @like ESCAPE '\\'
                ORDER BY (term LIKE @like ESCAPE '\\') DESC, term LIMIT @n`),
    vocabulary: run(`SELECT id, word AS title, substr(COALESCE(meaning, tamil, ''), 1, 100) AS snippet FROM vocabulary
                     WHERE word LIKE @like ESCAPE '\\' OR meaning LIKE @like ESCAPE '\\' OR tamil LIKE @like ESCAPE '\\' ORDER BY created_at DESC LIMIT @n`),
    conversations: run(`SELECT id, title, '' AS snippet FROM conversations WHERE title LIKE @like ESCAPE '\\' ORDER BY updated_at DESC LIMIT @n`),
    explanations: run(`SELECT e.id, e.title, substr(e.content, 1, 100) AS snippet,
                         (SELECT conversation_id FROM messages WHERE explanation_id = e.id ORDER BY id DESC LIMIT 1) AS conversation_id
                       FROM explanations e WHERE e.title LIKE @like ESCAPE '\\' OR e.content LIKE @like ESCAPE '\\' ORDER BY e.created_at DESC LIMIT @n`),
  };
  for (const k of Object.keys(groups)) if (!groups[k].length) delete groups[k];
  res.json({ query: q, groups });
});

module.exports = router;
