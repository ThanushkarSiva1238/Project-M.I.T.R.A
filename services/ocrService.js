/**
 * Optional OCR for images, via tesseract.js (an optionalDependency).
 * The first OCR run downloads the language data from the tesseract.js CDN and
 * caches it in data/ocr-cache; later runs work offline.
 * Anything that goes wrong is reported back so the UI can offer manual entry.
 */
const config = require('../config');

function isInstalled() {
  if (String(process.env.OCR_ENABLED || '').toLowerCase() === 'false') return false;
  try {
    require.resolve('tesseract.js');
    return true;
  } catch (_) {
    return false;
  }
}

/** Returns { ok: true, text } or { ok: false, reason } and never throws. */
async function recognize(filePath, { timeoutMs = 120000 } = {}) {
  if (!isInstalled()) {
    return { ok: false, reason: 'OCR is not installed on this computer (it is switched off, or the optional "tesseract.js" package is missing).' };
  }
  let worker;
  let timer;
  try {
    const { createWorker } = require('tesseract.js');
    const run = (async () => {
      worker = await createWorker(config.OCR_LANGS, 1, { cachePath: config.OCR_CACHE_DIR });
      const { data } = await worker.recognize(filePath);
      return data.text || '';
    })();
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    });
    const text = await Promise.race([run, timeout]);
    if (!text.trim()) return { ok: false, reason: 'No readable text was found in this image.' };
    return { ok: true, text: text.trim() };
  } catch (e) {
    const timedOut = e && e.message === 'timeout';
    console.error('[ocr] failed:', timedOut ? 'timeout' : (e && e.code) || (e && e.name) || 'error');
    return {
      ok: false,
      reason: timedOut
        ? 'Reading the image took too long.'
        : 'OCR could not run. The first run needs an internet connection to download the language data.',
    };
  } finally {
    clearTimeout(timer);
    if (worker) worker.terminate().catch(() => {});
  }
}

module.exports = { isInstalled, recognize };
