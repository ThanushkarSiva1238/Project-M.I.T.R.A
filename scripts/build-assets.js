/**
 * Builds local front-end assets so MITRA works fully offline (no CDN calls):
 *   - public/assets/fonts/*.woff2   (Inter + Noto Sans Tamil, copied from @fontsource)
 *   - public/assets/icons.svg       (SVG sprite of the Lucide icons the UI uses)
 *
 * The generated files are committed, so end users do not need to run this.
 * Run `npm run build:assets` only if you change the icon list or fonts.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const fontsOut = path.join(root, 'public', 'assets', 'fonts');
fs.mkdirSync(fontsOut, { recursive: true });

const fontFiles = [
  ['@fontsource/inter/files', 'inter-latin-400-normal.woff2'],
  ['@fontsource/inter/files', 'inter-latin-500-normal.woff2'],
  ['@fontsource/inter/files', 'inter-latin-600-normal.woff2'],
  ['@fontsource/inter/files', 'inter-latin-700-normal.woff2'],
  ['@fontsource/noto-sans-tamil/files', 'noto-sans-tamil-tamil-400-normal.woff2'],
  ['@fontsource/noto-sans-tamil/files', 'noto-sans-tamil-tamil-600-normal.woff2'],
];
for (const [dir, file] of fontFiles) {
  fs.copyFileSync(path.join(root, 'node_modules', dir, file), path.join(fontsOut, file));
}

// Icon names are Lucide names. The id used in the sprite is the same name.
const icons = [
  'house', 'library', 'message-circle', 'book-open', 'book-a', 'layers', 'clipboard-check',
  'repeat', 'notebook-pen', 'chart-line', 'settings', 'search', 'wifi', 'wifi-off', 'moon', 'sun',
  'bell', 'chevron-down', 'chevron-left', 'chevron-right', 'send', 'paperclip', 'image',
  'file-text', 'file-type', 'plus', 'bookmark', 'bookmark-check', 'ellipsis', 'volume-2',
  'bold', 'italic', 'underline', 'list', 'list-ordered', 'link', 'heading-2', 'undo-2', 'save',
  'calendar', 'calendar-plus', 'trash-2', 'pencil', 'x', 'check', 'circle-check', 'refresh-cw',
  'sparkles', 'lightbulb', 'languages', 'upload', 'download', 'shield-check', 'history', 'clock',
  'triangle-alert', 'info', 'menu', 'rotate-ccw', 'arrow-left', 'arrow-right', 'eye', 'brain',
  'graduation-cap', 'database', 'file-up', 'eraser', 'circle-help', 'user-round', 'target',
  'message-square-plus', 'flag', 'list-checks', 'copy', 'external-link', 'archive-restore',
  'hard-drive', 'lock', 'chart-column', 'play', 'flame',
];

const iconDir = path.join(root, 'node_modules', 'lucide-static', 'icons');
const missing = [];
let symbols = '';
for (const name of icons) {
  const file = path.join(iconDir, name + '.svg');
  if (!fs.existsSync(file)) { missing.push(name); continue; }
  const svg = fs.readFileSync(file, 'utf8');
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').trim();
  symbols += `<symbol id="${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</symbol>\n`;
}
if (missing.length) {
  console.error('Missing Lucide icons:', missing.join(', '));
  process.exit(1);
}
fs.writeFileSync(
  path.join(root, 'public', 'assets', 'icons.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" style="display:none">\n${symbols}</svg>\n`
);
console.log(`Built ${icons.length} icons and ${fontFiles.length} font files.`);
