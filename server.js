/**
 * MITRA - local-first psychology learning companion.
 * Express server bound to the loopback interface by default.
 */
const express = require('express');
const helmet = require('helmet');
const config = require('./config');
const db = require('./database/db');
const ai = require('./services/aiService');
const { HttpError } = require('./lib/errors');

function allowedHostnames() {
  const names = new Set(['127.0.0.1', 'localhost', '[::1]']);
  if (!['0.0.0.0', '::'].includes(config.HOST)) names.add(config.HOST.toLowerCase());
  return names;
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  const hosts = allowedHostnames();

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          fontSrc: ["'self'"],
          connectSrc: ["'self'"],
          objectSrc: ["'self'"],
          frameAncestors: ["'self'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
        },
      },
      strictTransportSecurity: false, // plain http on localhost
      crossOriginEmbedderPolicy: false,
    })
  );

  // Defence against DNS-rebinding: only answer requests addressed to this machine.
  app.use((req, res, next) => {
    const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
    if (!hosts.has(host)) return res.status(421).json({ error: { code: 'bad_host', message: 'MITRA only answers requests addressed to this computer.' } });
    next();
  });

  // CSRF protection: state-changing requests must come from MITRA's own page.
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (origin) {
      try {
        if (new URL(origin).host !== req.headers.host) throw new Error('cross-origin');
      } catch (_) {
        return res.status(403).json({ error: { code: 'forbidden', message: 'This request did not come from MITRA.' } });
      }
    }
    if (req.headers['x-mitra-request'] !== '1') {
      return res.status(403).json({ error: { code: 'forbidden', message: 'This request did not come from MITRA.' } });
    }
    next();
  });

  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (req, res) => {
    let dbOk = false;
    try {
      dbOk = db.isOpen && db.prepare('SELECT 1 AS ok').get().ok === 1;
    } catch (_) {
      dbOk = false;
    }
    if (!dbOk) return res.status(503).json({ ok: false, error: { code: 'database_unavailable', message: 'MITRA cannot reach its database.' } });
    const s = ai.status();
    res.json({ ok: true, version: config.APP_VERSION, ai: { configured: s.configured, provider: s.provider, model: s.model, missing: s.missing } });
  });

  app.use('/api/settings', require('./routes/settings'));
  app.use('/api/conversations', require('./routes/conversations'));
  app.use('/api/documents', require('./routes/documents'));
  app.use('/api/explanations', require('./routes/explanations'));
  app.use('/api/dictionary', require('./routes/dictionary'));
  app.use('/api/vocabulary', require('./routes/vocabulary'));
  app.use('/api/notes', require('./routes/notes'));
  app.use('/api/calendar', require('./routes/calendar'));
  app.use('/api/flashcards', require('./routes/flashcards'));
  app.use('/api/quizzes', require('./routes/quizzes'));
  app.use('/api/search', require('./routes/search'));
  app.use('/api/backups', require('./routes/backups'));
  app.use('/api', require('./routes/progress'));

  app.use('/api', (req, res) => res.status(404).json({ error: { code: 'not_found', message: 'That action does not exist.' } }));

  app.use(express.static(config.PUBLIC_DIR, { index: 'index.html', maxAge: 0, etag: true }));

  // Centralised error handling: friendly JSON, technical detail only in the console (never study text).
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    let status = 500;
    let body = { code: 'server_error', message: 'Something went wrong inside MITRA. Your saved data is not affected. Please try again.' };
    if (err instanceof HttpError) {
      status = err.status;
      body = { code: err.code, message: err.message, ...(err.extra || {}) };
    } else if (err && err.name === 'MulterError') {
      status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      body = {
        code: err.code === 'LIMIT_FILE_SIZE' ? 'file_too_large' : 'invalid_upload',
        message:
          err.code === 'LIMIT_FILE_SIZE'
            ? `That file is too large. The limit is ${Math.round(config.MAX_UPLOAD_BYTES / 1024 / 1024)} MB for documents (restoring a backup allows more).`
            : 'The upload could not be read. Please try again.',
      };
    } else if (err && err.type === 'entity.too.large') {
      status = 413;
      body = { code: 'too_large', message: 'That request is too large.' };
    } else if (err instanceof SyntaxError && err.status === 400) {
      status = 400;
      body = { code: 'invalid_json', message: 'MITRA could not understand that request.' };
    } else if (err && typeof err.code === 'string' && err.code.startsWith('SQLITE')) {
      body = { code: 'database_error', message: 'MITRA could not read or write its database. Please try again; if it keeps happening, restart MITRA.' };
      console.error('[db]', err.code);
    } else {
      console.error('[server]', req.method, req.path, err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err);
    }
    res.status(status).json({ error: body });
  });

  return app;
}

function start() {
  db.open();
  const app = createApp();
  const server = app.listen(config.PORT, config.HOST, () => {
    const shown = config.HOST === '127.0.0.1' ? 'localhost' : config.HOST;
    console.log(`\n  MITRA is running.  Open  http://${shown}:${config.PORT}  in your browser.`);
    console.log(`  Your data is stored in: ${config.DATA_DIR}`);
    const s = ai.status();
    console.log(s.configured ? `  Online AI: ${s.provider} / ${s.model}` : `  Online AI: not set up yet (saved material and all other features work).`);
    console.log('  Press Ctrl+C to stop.\n');
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error(`\n  Port ${config.PORT} is already in use. MITRA may already be running - try opening http://localhost:${config.PORT}\n  (or set a different PORT in the .env file).\n`);
    else console.error('Could not start MITRA:', e.message);
    process.exit(1);
  });
  const stop = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return server;
}

if (require.main === module) start();

module.exports = { createApp, start };
