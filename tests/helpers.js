/**
 * Test harness: runs the REAL Express app against a temporary data folder and a
 * local mock AI provider (an actual HTTP server), so timeouts, bad responses and
 * offline behaviour are exercised for real. Each test file runs in its own process.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const AdmZip = require('adm-zip');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mitra-test-'));
process.env.MITRA_DATA_DIR = path.join(root, 'data');
process.env.MITRA_ENV_FILE = path.join(root, '.env');
process.env.OCR_ENABLED = 'false';
process.env.AI_TIMEOUT_MS = '400';
process.env.MAX_UPLOAD_MB = '1';
delete process.env.AI_API_KEY;

const config = require('../config');
const db = require('../database/db');
const { createApp } = require('../server');

// ------------------------------------------------------------- mock provider
const mock = {
  calls: [],
  behaviour: null, // { status, body, delayMs, raw }
  server: null,
  url: null,
  reset() {
    this.calls = [];
    this.behaviour = null;
  },
};

function defaultReply(system) {
  if (system.includes('Define the psychology')) {
    return JSON.stringify({
      term: 'Test Term', is_psychology_term: true, pronunciation: '/test/', simple_english: 'A simple meaning.',
      tamil: 'எளிய விளக்கம் (test term)', definition: 'A precise definition.', example: 'An example.', everyday_example: 'Everyday.', related: ['Schema', 'Memory'],
    });
  }
  if (system.includes('study flashcards')) {
    return JSON.stringify({ cards: [{ front: 'What is X?', back: 'X is Y.', example: 'e.g.' }, { front: 'Define Z', back: 'Z is W.', example: '' }] });
  }
  if (system.includes('Write a quiz')) {
    return JSON.stringify({
      title: 'Mock quiz',
      questions: [
        { type: 'mcq', question: 'Which is right?', options: ['A one', 'B two', 'C three', 'D four'], answer: 1, explanation: 'Because two.' },
        { type: 'tf', question: 'The sky is blue.', answer: true, explanation: 'Yes.' },
        { type: 'mcq', question: 'Broken question', options: ['same', 'same', 'x', 'y'], answer: 0, explanation: '' },
      ],
    });
  }
  return '## Simple English\nThis is a simple mock explanation.\n\n## தமிழ் விளக்கம் (Tamil)\nஇது ஒரு மாதிரி விளக்கம்.';
}

async function startMock() {
  mock.server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      const isAnthropic = req.url.endsWith('/v1/messages');
      const system = isAnthropic ? parsed.system : parsed.messages?.[0]?.content || '';
      mock.calls.push({ url: req.url, headers: req.headers, body: parsed, system });
      const b = mock.behaviour;
      const respond = () => {
        if (b && b.raw !== undefined) {
          res.writeHead(b.status || 200, { 'content-type': 'application/json' });
          return res.end(b.raw);
        }
        if (b && b.status && b.status >= 400) {
          res.writeHead(b.status, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'mock error' } }));
        }
        const text = b && b.text !== undefined ? b.text : defaultReply(system);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(isAnthropic ? { content: [{ type: 'text', text }] } : { choices: [{ message: { content: text } }] }));
      };
      if (b && b.delayMs) setTimeout(respond, b.delayMs);
      else respond();
    });
  });
  await new Promise((r) => mock.server.listen(0, '127.0.0.1', r));
  mock.url = `http://127.0.0.1:${mock.server.address().port}`;
}

function configureAi(extra = {}) {
  Object.assign(process.env, {
    AI_PROVIDER: 'anthropic', AI_API_KEY: 'test-key-12345678', AI_MODEL: 'test-model', AI_BASE_URL: mock.url, AI_DAILY_LIMIT: '100', AI_MAX_INPUT_CHARS: '6000',
  }, extra);
}
function unconfigureAi() {
  process.env.AI_API_KEY = '';
}

// -------------------------------------------------------------------- app
let server;
let base;

async function startApp() {
  db.open();
  await startMock();
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  return base;
}

async function stopApp() {
  await new Promise((r) => server.close(r));
  await new Promise((r) => mock.server.close(r));
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}

async function api(method, url, body, { headers = {}, raw = false } = {}) {
  const init = { method, headers: { 'x-mitra-request': '1', ...headers } };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(base + url, init);
  if (raw) return res;
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) {
    /* non-JSON */
  }
  return { status: res.status, body: json, text, headers: res.headers };
}

const get = (u) => api('GET', u);
const post = (u, b) => api('POST', u, b ?? {});
const put = (u, b) => api('PUT', u, b);
const patch = (u, b) => api('PATCH', u, b ?? {});
const del = (u) => api('DELETE', u);

function upload(url, filename, buffer, fields = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append('file', new Blob([buffer]), filename);
  return api('POST', url, fd);
}

// ---------------------------------------------------------- sample files
function makePdf(pages) {
  // pages: array of strings (null/'' = a page with no text, like a scan)
  const objs = [];
  const add = (s) => objs.push(s) && objs.length;
  add('<< /Type /Catalog /Pages 2 0 R >>');
  const n = pages.length;
  add(`<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${n} >>`);
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  pages.forEach((text, i) => {
    const stream = text ? `BT /F1 18 Tf 72 700 Td (${text.replace(/[()\\]/g, '')}) Tj ET` : '';
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function makeDocx(text) {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`));
  zip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`));
  zip.addFile('word/document.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`));
  return zip.toBuffer();
}

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

module.exports = {
  config, db, mock, root,
  startApp, stopApp, configureAi, unconfigureAi,
  api, get, post, put, patch, del, upload,
  makePdf, makeDocx, PNG_1X1,
  base: () => base,
};
