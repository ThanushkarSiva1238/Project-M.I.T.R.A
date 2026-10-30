/** Backup & restore endpoints (see services/backupService.js for the safety rules). */
const express = require('express');
const multer = require('multer');
const config = require('../config');
const backup = require('../services/backupService');
const { HttpError } = require('../lib/errors');

const router = express.Router();

const uploadZip = multer({
  dest: config.TMP_DIR,
  limits: { fileSize: config.MAX_RESTORE_BYTES, files: 1, fields: 5 },
  fileFilter(req, file, cb) {
    if (!/\.zip$/i.test(file.originalname || '')) return cb(new HttpError(415, 'unsupported_file', 'Please choose a MITRA backup file (.zip).'));
    cb(null, true);
  },
});

const cleanup = (file) => file && require('fs').rm(file.path, { force: true }, () => {});

router.get('/', (req, res) => res.json({ directory: config.BACKUP_DIR, backups: backup.list() }));

router.post('/', async (req, res) => {
  const r = await backup.create();
  res.status(201).json({ ...r, directory: config.BACKUP_DIR });
});

router.get('/:name/download', (req, res) => {
  res.download(backup.filePath(req.params.name), req.params.name);
});

router.delete('/:name', (req, res) => {
  backup.remove(req.params.name);
  res.json({ ok: true });
});

/** Validate a backup file and report what is inside, without changing anything. */
router.post('/inspect', uploadZip.single('file'), (req, res) => {
  try {
    if (req.body?.name && !req.file) {
      return res.json({ manifest: backup.inspect(backup.filePath(req.body.name)) });
    }
    if (!req.file) throw new HttpError(400, 'invalid_input', 'Please choose a backup file.');
    res.json({ manifest: backup.inspect(req.file.path) });
  } finally {
    cleanup(req.file);
  }
});

/** Replaces ALL current data. Requires confirm = "RESTORE". A safety backup is made first. */
router.post('/restore', uploadZip.single('file'), async (req, res) => {
  try {
    if (req.body?.confirm !== 'RESTORE') throw new HttpError(400, 'confirmation_required', 'Restoring replaces everything currently in MITRA. Please confirm to continue.');
    let source;
    if (req.file) source = req.file.path;
    else if (req.body.name) source = backup.filePath(req.body.name);
    else throw new HttpError(400, 'invalid_input', 'Please choose a backup to restore.');
    const r = await backup.restore(source);
    res.json({ ok: true, ...r });
  } finally {
    cleanup(req.file);
  }
});

module.exports = router;
