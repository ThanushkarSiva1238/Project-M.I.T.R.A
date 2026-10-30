/**
 * Resolves "what should the AI read?" for flashcard and quiz generation.
 * The student picks ONE source (a note, a document or page, pasted text, or just a topic);
 * only that text is ever sent to the AI provider, and only when she presses Generate.
 */
const db = require('../database/db');
const v = require('../lib/validate');
const { notFound, badInput } = require('../lib/errors');

function resolveSource(b = {}) {
  if (b.noteId) {
    const n = db.prepare('SELECT id, title, plain_text FROM study_notes WHERE id = ?').get(v.id(b.noteId, 'noteId'));
    if (!n) throw notFound('Note');
    if (!n.plain_text.trim()) throw badInput('That note is empty, so there is nothing to make questions from.');
    return { type: 'note', ref: n.id, label: n.title || 'Untitled note', text: n.plain_text, documentId: null };
  }
  if (b.documentId) {
    const d = db.prepare('SELECT id, title, page_count FROM documents WHERE id = ?').get(v.id(b.documentId, 'documentId'));
    if (!d) throw notFound('Document');
    const c = db.prepare('SELECT text, has_pages FROM document_content WHERE document_id = ?').get(d.id);
    if (!c || !c.text.trim()) throw badInput('No text has been read from that document yet. Open it in My Library and add the text first.');
    let text = c.text;
    let label = d.title;
    const page = v.int(b.page, 'page', { min: 1 });
    if (page && c.has_pages) {
      const pages = c.text.split('\f');
      if (page > pages.length) throw badInput('That page does not exist in this document.');
      text = pages[page - 1];
      label += `, page ${page}`;
      if (!text.trim()) throw badInput('That page has no readable text.');
    } else if (c.has_pages) {
      text = c.text.replace(/\f/g, '\n\n');
    }
    return { type: 'document', ref: d.id, label, text, documentId: d.id };
  }
  const text = v.text(b.text, 'Text', { max: 50000 });
  if (text) return { type: 'text', ref: null, label: 'Pasted text', text, documentId: null };
  const topic = v.text(b.topic, 'Topic', { max: 150 });
  if (topic) return { type: 'topic', ref: null, label: topic, topic, text: null, documentId: null };
  throw badInput('Please choose a note, a document, paste some text, or type a topic.');
}

module.exports = { resolveSource };
