/** Study documents: upload, reading extracted text, original file download, manual text. */
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const config = require('../config');
const db = require('../database/db');
const docs = require('../services/documentService');
const activity = require('../lib/activity');
const v = require('../lib/validate');
const { HttpError, notFound } = require('../lib/errors');

const router = express.Router();

const upload = multer({
  dest: config.TMP_DIR,
  limits: { fileSize: config.MAX_UPLOAD_BYTES, files: 1, fields: 5 },
  fileFilter(req, file, cb) {
    const name = String(file.originalname || '');
    const ok = docs.ALLOWED_EXTENSIONS.some((e) => name.toLowerCase().endsWith(e));
    if (!ok) return cb(new HttpError(415, 'unsupported_file', 'That file type is not supported. Please upload a PDF, Word (.docx) file, or an image (PNG, JPG, WEBP).'));
    cb(null, true);
  },
});

const SELECT = `SELECT d.*, c.method, c.has_pages, length(c.text) AS text_length
                FROM documents d LEFT JOIN document_content c ON c.document_id = d.id`;

function getDoc(id) {
  const d = db.prepare(`${SELECT} WHERE d.id = ?`).get(id);
  if (!d) throw notFound('Document');
  return d;
}

const view = (d) => ({
  id: d.id, title: d.title, originalName: d.original_name, kind: d.kind, mimeType: d.mime_type, sizeBytes: d.size_bytes,
  pageCount: d.page_count, status: d.status, statusDetail: d.status_detail, method: d.method, hasPages: !!d.has_pages,
  textLength: d.text_length || 0, createdAt: d.created_at, updatedAt: d.updated_at,
});

router.get('/', (req, res) => {
  const q = v.text(req.query.q, 'q', { max: 100 });
  const rows = q
    ? db.prepare(`${SELECT} WHERE d.title LIKE ? ESCAPE '\\' OR d.original_name LIKE ? ESCAPE '\\' ORDER BY d.created_at DESC`).all(v.like(q), v.like(q))
    : db.prepare(`${SELECT} ORDER BY d.created_at DESC`).all();
  res.json(rows.map(view));
});

router.post('/', upload.single('file'), async (req, res) => {
  if (!req.file) throw new HttpError(400, 'invalid_input', 'Please choose a file to upload.');
  const id = await docs.ingest({ tempPath: req.file.path, originalName: req.file.originalname, size: req.file.size });
  const d = getDoc(id);
  activity.log({ type: 'document_added', label: `Document added: ${d.title}`, refType: 'document', refId: id });
  res.status(201).json(view(d));
});

router.get('/:id', (req, res) => {
  const d = getDoc(v.id(req.params.id));
  const content = db.prepare('SELECT text FROM document_content WHERE document_id = ?').get(d.id);
  const text = content ? content.text : '';
  const pages = d.has_pages ? text.split('\f') : null;
  res.json({ ...view(d), text: pages ? undefined : text, pages });
});

router.get('/:id/file', (req, res) => {
  const d = getDoc(v.id(req.params.id));
  const file = docs.resolveStored(d.stored_name);
  if (!fs.existsSync(file)) throw new HttpError(404, 'file_missing', 'The original file is missing from MITRA\'s storage folder.');
  const asAttachment = req.query.download === '1' || d.kind === 'docx';
  res.setHeader('Content-Type', d.mime_type);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `${asAttachment ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(d.original_name)}`);
  res.sendFile(file);
});

router.patch('/:id', (req, res) => {
  const d = getDoc(v.id(req.params.id));
  const title = v.text(req.body?.title, 'Title', { max: 120, required: true });
  db.prepare(`UPDATE documents SET title = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(title, d.id);
  res.json(view(getDoc(d.id)));
});

/** Student types or pastes the text herself (scanned PDFs, failed OCR, corrections). */
router.put('/:id/text', (req, res) => {
  const d = getDoc(v.id(req.params.id));
  const text = v.text(req.body?.text, 'Text', { max: docs.MAX_TEXT_CHARS, required: true });
  db.transaction(() => {
    db.prepare(`UPDATE document_content SET text = ?, method = 'manual', has_pages = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE document_id = ?`).run(text, d.id);
    db.prepare(`UPDATE documents SET status = 'ready', status_detail = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(d.id);
  })();
  res.json(view(getDoc(d.id)));
});

router.post('/:id/ocr', async (req, res) => {
  const d = getDoc(v.id(req.params.id));
  const r = await docs.retryOcr(d.id);
  res.json({ ...r, document: view(getDoc(d.id)) });
});

router.delete('/:id', (req, res) => {
  const d = getDoc(v.id(req.params.id));
  db.prepare('DELETE FROM documents WHERE id = ?').run(d.id); // content cascades; notes/cards/messages are un-linked
  docs.removeQuietly(docs.resolveStored(d.stored_name));
  res.json({ ok: true });
});

module.exports = router;
