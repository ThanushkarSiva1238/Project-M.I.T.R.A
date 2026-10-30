/** HTML sanitising for notes (the only place the app stores user HTML). */
const sanitizeHtml = require('sanitize-html');

const NOTE_OPTIONS = {
  allowedTags: ['h1', 'h2', 'h3', 'p', 'br', 'b', 'strong', 'i', 'em', 'u', 'ul', 'ol', 'li', 'a', 'div', 'span', 'blockquote'],
  allowedAttributes: { a: ['href', 'target', 'rel'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowProtocolRelative: false,
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }),
  },
};

function cleanNoteHtml(html) {
  return sanitizeHtml(String(html || ''), NOTE_OPTIONS);
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

function htmlToPlain(html) {
  const spaced = String(html || '')
    .replace(/<\/(p|div|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n');
  const stripped = sanitizeHtml(spaced, { allowedTags: [], allowedAttributes: {} });
  return stripped
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m])
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = { cleanNoteHtml, htmlToPlain };
