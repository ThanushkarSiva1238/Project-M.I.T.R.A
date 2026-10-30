/**
 * Study-document handling: validation, safe storage and text extraction.
 *
 * - Only PDF, DOCX, PNG, JPEG and WEBP are accepted. The extension AND the file's
 *   magic bytes must agree.
 * - Originals are stored under data/uploads with a server-generated name
 *   (uuid + extension). The browser never supplies a path.
 * - PDF text is stored page by page (separated by \f) so page numbers are real.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const config = require('../config');
const db = require('../database/db');
const ocr = require('./ocrService');
const { HttpError } = require('../lib/errors');

const MAX_TEXT_CHARS = 2_000_000;
const EXTRACT_TIMEOUT_MS = 45_000;
const MAX_DOCX_UNCOMPRESSED = 300 * 1024 * 1024;

const TYPES = {
  '.pdf': { kind: 'pdf', mime: 'application/pdf' },
  '.docx': { kind: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  '.png': { kind: 'image', mime: 'image/png' },
  '.jpg': { kind: 'image', mime: 'image/jpeg' },
  '.jpeg': { kind: 'image', mime: 'image/jpeg' },
  '.webp': { kind: 'image', mime: 'image/webp' },
};
const ALLOWED_EXTENSIONS = Object.keys(TYPES);
const STORED_NAME_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(pdf|docx|png|jpe?g|webp)$/;

const unsupported = () =>
  new HttpError(415, 'unsupported_file', 'That file type is not supported. Please upload a PDF, Word (.docx) file, or an image (PNG, JPG, WEBP).');

function readHead(file, n = 4096) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    const read = fs.readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

/** Throws unless the file's content really is what its extension claims. */
function verifyMagic(file, ext) {
  const head = readHead(file);
  const ok = {
    '.pdf': () => head.subarray(0, 1024).includes('%PDF-'),
    '.docx': () => {
      if (!(head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04)) return false;
      try {
        const zip = new AdmZip(file);
        const names = zip.getEntries().map((e) => e.entryName);
        const total = zip.getEntries().reduce((n, e) => n + e.header.size, 0);
        if (total > MAX_DOCX_UNCOMPRESSED) throw new HttpError(413, 'file_too_large', 'That Word file expands to an unreasonable size.');
        return names.includes('[Content_Types].xml') && names.some((n) => n.startsWith('word/'));
      } catch (e) {
        if (e instanceof HttpError) throw e;
        return false;
      }
    },
    '.png': () => head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    '.jpg': () => head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff,
    '.jpeg': () => head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff,
    '.webp': () => head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP',
  }[ext];
  if (!ok || !ok()) {
    throw new HttpError(415, 'unsupported_file', 'This file does not look like a valid ' + ext.slice(1).toUpperCase() + ' file, so it was not saved.');
  }
}

function withTimeout(promise, ms, label) {
  let timer;
  const t = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
  });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

let pdfjsPromise = null;
const loadPdfjs = () => (pdfjsPromise = pdfjsPromise || import('pdfjs-dist/legacy/build/pdf.mjs'));
const MAX_PDF_PAGES = 600;

/** Page-by-page text with pdf.js (maintained "legacy" build that runs in Node). */
async function extractPdf(file) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data: new Uint8Array(fs.readFileSync(file)),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  const run = (async () => {
    const doc = await task.promise;
    try {
      const pageCount = doc.numPages;
      const pages = [];
      for (let i = 1; i <= Math.min(pageCount, MAX_PDF_PAGES); i++) {
        const page = await doc.getPage(i);
        const tc = await page.getTextContent();
        let text = '';
        let lastY;
        for (const item of tc.items) {
          if (typeof item.str !== 'string') continue;
          const y = item.transform ? item.transform[5] : undefined;
          if (lastY !== undefined && y !== undefined && Math.abs(y - lastY) > 2 && text && !text.endsWith('\n')) text += '\n';
          text += item.str;
          if (item.hasEOL && !text.endsWith('\n')) text += '\n';
          if (y !== undefined) lastY = y;
        }
        pages.push(text.replace(/[ \t]+\n/g, '\n').trim());
        page.cleanup();
      }
      return { pages, pageCount };
    } finally {
      await task.destroy().catch(() => {});
    }
  })();
  try {
    return await withTimeout(run, EXTRACT_TIMEOUT_MS, 'PDF reading');
  } catch (e) {
    task.destroy().catch(() => {});
    throw e;
  }
}

async function extractDocx(file) {
  const mammoth = require('mammoth');
  const r = await withTimeout(mammoth.extractRawText({ path: file }), EXTRACT_TIMEOUT_MS, 'Word reading');
  return (r.value || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** Produces { text, method, hasPages, pageCount, status, detail } without throwing on bad content. */
async function extractText(file, kind) {
  try {
    if (kind === 'pdf') {
      const { pages, pageCount } = await extractPdf(file);
      const joined = pages.join('\f');
      if (!joined.replace(/[\f\s]/g, '')) {
        return {
          text: '', method: 'none', hasPages: 0, pageCount, status: 'needs_text',
          detail: 'This PDF has no selectable text (it may be a scan). Photograph or screenshot the pages and upload them as images, or type/paste the text yourself.',
        };
      }
      return { text: joined.slice(0, MAX_TEXT_CHARS), method: 'pdf-text', hasPages: 1, pageCount, status: 'ready', detail: null };
    }
    if (kind === 'docx') {
      const text = await extractDocx(file);
      if (!text) {
        return { text: '', method: 'none', hasPages: 0, pageCount: null, status: 'needs_text', detail: 'No text was found in this Word file.' };
      }
      return { text: text.slice(0, MAX_TEXT_CHARS), method: 'docx-text', hasPages: 0, pageCount: null, status: 'ready', detail: null };
    }
    const r = await ocr.recognize(file);
    if (r.ok) return { text: r.text.slice(0, MAX_TEXT_CHARS), method: 'ocr', hasPages: 0, pageCount: 1, status: 'ready', detail: null };
    return {
      text: '', method: 'none', hasPages: 0, pageCount: 1, status: 'needs_text',
      detail: `${r.reason} You can type or paste the text from the image yourself.`,
    };
  } catch (e) {
    console.error('[documents] extraction failed:', e && e.message ? e.message.slice(0, 120) : 'error');
    return {
      text: '', method: 'none', hasPages: 0, pageCount: null, status: 'needs_text',
      detail: 'MITRA could not read the text in this file (it may be damaged or protected). The original is saved; you can type or paste the text yourself.',
    };
  }
}

/** Fix multipart filenames that were decoded as latin1 instead of UTF-8 (e.g. Tamil names). */
function fixName(name) {
  const raw = String(name || 'document');
  if (/[\u0080-ÿ]/.test(raw) && !/[^\u0000-ÿ]/.test(raw)) {
    const utf8 = Buffer.from(raw, 'latin1').toString('utf8');
    if (!utf8.includes('�')) return utf8;
  }
  return raw;
}

function titleFrom(originalName) {
  const base = path.basename(fixName(originalName), path.extname(originalName));
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (clean || 'Untitled document').slice(0, 120);
}

/** Resolve a stored filename to an absolute path inside the uploads folder, or throw. */
function resolveStored(storedName) {
  if (typeof storedName !== 'string' || !STORED_NAME_RE.test(storedName)) throw new HttpError(404, 'not_found', 'Document file not found.');
  const full = path.join(config.UPLOAD_DIR, storedName);
  const rel = path.relative(config.UPLOAD_DIR, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new HttpError(404, 'not_found', 'Document file not found.');
  return full;
}

function removeQuietly(file) {
  try {
    fs.unlinkSync(file);
  } catch (_) {
    /* already gone */
  }
}

/** Validate, store and process an uploaded temp file. Always removes the temp file. */
async function ingest({ tempPath, originalName, size }) {
  try {
    const name = fixName(originalName);
    const ext = path.extname(name).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) throw unsupported();
    if (size === 0) throw new HttpError(400, 'invalid_input', 'That file is empty.');
    verifyMagic(tempPath, ext);

    const { kind, mime } = TYPES[ext];
    const storedName = `${crypto.randomUUID()}${ext === '.jpeg' ? '.jpg' : ext}`;
    const dest = resolveStored(storedName);
    fs.copyFileSync(tempPath, dest);

    let doc;
    try {
      const x = await extractText(dest, kind);
      doc = db.transaction(() => {
        const info = db
          .prepare(
            `INSERT INTO documents (title, original_name, stored_name, mime_type, kind, size_bytes, page_count, status, status_detail)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(titleFrom(name), name.slice(0, 200), storedName, mime, kind, size, x.pageCount, x.status, x.detail);
        db.prepare('INSERT INTO document_content (document_id, text, method, has_pages) VALUES (?, ?, ?, ?)').run(
          info.lastInsertRowid, x.text, x.method, x.hasPages
        );
        return info.lastInsertRowid;
      })();
    } catch (e) {
      removeQuietly(dest);
      throw e;
    }
    return doc;
  } finally {
    removeQuietly(tempPath);
  }
}

/** Retry OCR for an image whose first attempt failed. */
async function retryOcr(documentId) {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(documentId);
  if (!doc) throw new HttpError(404, 'not_found', 'Document was not found.');
  if (doc.kind !== 'image') throw new HttpError(400, 'invalid_input', 'Text reading (OCR) only applies to images.');
  const r = await ocr.recognize(resolveStored(doc.stored_name));
  if (!r.ok) {
    db.prepare(`UPDATE documents SET status = 'needs_text', status_detail = ? WHERE id = ?`).run(
      `${r.reason} You can type or paste the text from the image yourself.`, documentId
    );
    return { ok: false, reason: r.reason };
  }
  db.transaction(() => {
    db.prepare(`UPDATE document_content SET text = ?, method = 'ocr', has_pages = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE document_id = ?`).run(r.text.slice(0, MAX_TEXT_CHARS), documentId);
    db.prepare(`UPDATE documents SET status = 'ready', status_detail = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(documentId);
  })();
  return { ok: true };
}

module.exports = { ingest, retryOcr, resolveStored, removeQuietly, ALLOWED_EXTENSIONS, TYPES, MAX_TEXT_CHARS };
