/**
 * Shared UI helpers. Everything is built with DOM APIs / textContent, never by
 * concatenating HTML strings, so study text and AI output can't inject markup.
 */
const SVG_NS = 'http://www.w3.org/2000/svg';

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (['value', 'checked', 'disabled', 'selected', 'readOnly'].includes(k)) el[k] = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  append(el, kids);
  return el;
}

export function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    el.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const clear = (el) => {
  el.replaceChildren();
  return el;
};

export function icon(name, cls = '') {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('class', `ic ${cls}`.trim());
  s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS(SVG_NS, 'use');
  u.setAttribute('href', `/assets/icons.svg#${name}`);
  s.append(u);
  return s;
}

export const tile = (name, color = '') => h('span', { class: `tile ${color}` }, icon(name));

export function btn(label, { icon: ic, variant = '', size = '', onClick, title, type = 'button', disabled, ariaLabel } = {}) {
  return h(
    'button',
    { type, class: `btn ${variant ? 'btn-' + variant : ''} ${size ? 'btn-' + size : ''}`.trim(), onClick, title, disabled, 'aria-label': ariaLabel },
    ic ? icon(ic, size === 'xs' || size === 'sm' ? 'sm' : '') : null,
    label
  );
}

export const iconBtn = (name, label, onClick, cls = '') =>
  h('button', { type: 'button', class: `icon-btn ${cls}`, 'aria-label': label, title: label, onClick }, icon(name));

export const orb = (size = '') => h('span', { class: `orb ${size}`, 'aria-hidden': 'true' });

// ------------------------------------------------------------------ events
const bus = new EventTarget();
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));
/** Subscribe; returns an unsubscribe function. */
export function on(name, fn) {
  const handler = (e) => fn(e.detail);
  bus.addEventListener(name, handler);
  return () => bus.removeEventListener(name, handler);
}

// ------------------------------------------------------------------- toast
export function toast(message, type = 'info', ms = 4500) {
  const box = document.getElementById('toasts');
  const t = h('div', { class: `toast ${type}` }, icon(type === 'success' ? 'circle-check' : type === 'error' ? 'triangle-alert' : 'info'), h('div', null, message));
  box.append(t);
  setTimeout(() => t.remove(), type === 'error' ? Math.max(ms, 7000) : ms);
}

// ------------------------------------------------------------------- modal
export function modal({ title, body, actions = [], size = '', onClose, dismissible = true }) {
  const previous = document.activeElement;
  const titleId = 'm' + Math.random().toString(36).slice(2, 8);
  const bodyEl = h('div', { class: 'modal-body' });
  append(bodyEl, [body]);
  const footEl = h('div', { class: 'modal-foot' }, actions);
  const closeBtn = dismissible ? iconBtn('x', 'Close', () => close()) : null;
  const box = h(
    'div',
    { class: `modal ${size}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    h('div', { class: 'modal-head' }, h('h2', { id: titleId }, title), closeBtn),
    bodyEl,
    actions.length ? footEl : null
  );
  const overlay = h('div', { class: 'overlay' }, box);
  let closed = false;
  function close(result) {
    if (closed) return;
    closed = true;
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    if (previous && previous.focus) previous.focus();
    if (onClose) onClose(result);
  }
  function onKey(e) {
    if (e.key === 'Escape' && dismissible) {
      e.stopPropagation();
      close();
    } else if (e.key === 'Tab') {
      const f = $$('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])', box).filter((x) => !x.disabled && x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay && dismissible) close();
  });
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
  const firstField = $('input:not([type=hidden]), textarea, select', bodyEl);
  (firstField || closeBtn || box).focus?.();
  return { el: box, body: bodyEl, foot: footEl, close };
}

/** Promise<boolean> confirmation dialog. */
export function confirmDialog({ title, message, confirmText = 'Confirm', danger = false, cancelText = 'Cancel' }) {
  return new Promise((resolve) => {
    let decided = false;
    const decide = (v) => {
      decided = true;
      m.close();
      resolve(v);
    };
    const m = modal({
      title,
      size: 'narrow',
      body: h('div', null, typeof message === 'string' ? h('p', null, message) : message),
      actions: [btn(cancelText, { onClick: () => decide(false) }), btn(confirmText, { variant: danger ? 'danger solid' : 'primary', onClick: () => decide(true) })],
      onClose: () => {
        if (!decided) resolve(false);
      },
    });
    m.foot.firstChild.focus();
  });
}

// ------------------------------------------------------------- formatting
const pad = (n) => String(n).padStart(2, '0');
export const localDateStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseLocalDate = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
export const fmtClock = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export function fmtHHMM(hhmm) {
  if (!hhmm) return '';
  const [hh, mm] = hhmm.split(':').map(Number);
  return fmtClock(new Date(2000, 0, 1, hh, mm));
}
/** "Today, 10:24 AM" · "Yesterday, 03:15 PM" · "Oct 18, 2025" */
export function friendlyDate(iso, withTime = true) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const diff = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
  if (diff === 0) return withTime ? `Today, ${fmtClock(d)}` : 'Today';
  if (diff === 1) return withTime ? `Yesterday, ${fmtClock(d)}` : 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}
export function friendlyEventDate(dateStr, hhmm) {
  const d = parseLocalDate(dateStr);
  const t = parseLocalDate(localDateStr());
  const diff = Math.round((d - t) / 86400000);
  const day = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : diff === -1 ? 'Yesterday' : d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  return hhmm ? `${day}, ${fmtHHMM(hhmm)}` : day;
}
export const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
export const num = (n) => Number(n).toLocaleString();

export function debounce(fn, ms) {
  let t;
  const d = (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  d.cancel = () => clearTimeout(t);
  return d;
}

export const errText = (e) => (e && e.message) || 'Something went wrong. Please try again.';

export function emptyState(iconName, text, action) {
  return h('div', { class: 'empty' }, icon(iconName), h('p', null, text), action || null);
}

/** Convert saved note HTML to plain text with line breaks (for sending to the tutor). */
export function htmlToText(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  doc.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
  doc.querySelectorAll('p,div,li,h1,h2,h3,blockquote').forEach((b) => b.append('\n'));
  return doc.body.textContent.replace(/\n{3,}/g, '\n\n').trim();
}

// ---------------------------------------------------------------- markdown
/** Small, safe Markdown subset renderer: headings, bold, italic, lists, quotes, paragraphs. */
export function renderMarkdown(src) {
  const root = h('div', { class: 'md' });
  const lines = String(src).replace(/\r/g, '').split('\n');
  let list = null;
  let para = [];
  const flushPara = () => {
    if (para.length) {
      const text = para.join(' ').trim();
      if (/^_[^_].*[^_]_$/.test(text)) root.append(h('p', { class: 'md-note' }, inline(text.slice(1, -1))));
      else root.append(h('p', null, inline(text)));
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      root.append(list);
      list = null;
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) {
      flushPara();
      flushList();
    } else if ((m = /^#{1,4}\s+(.*)$/.exec(line))) {
      flushPara();
      flushList();
      root.append(h('h4', { class: 'md-h' }, inline(m[1])));
    } else if ((m = /^\s*[-*•]\s+(.*)$/.exec(line))) {
      flushPara();
      if (!list || list.tagName !== 'UL') {
        flushList();
        list = h('ul');
      }
      list.append(h('li', null, inline(m[1])));
    } else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
      flushPara();
      if (!list || list.tagName !== 'OL') {
        flushList();
        list = h('ol');
      }
      list.append(h('li', null, inline(m[1])));
    } else if ((m = /^>\s?(.*)$/.exec(line))) {
      flushPara();
      flushList();
      root.append(h('blockquote', { class: 'md-quote' }, inline(m[1])));
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  for (const el of root.querySelectorAll('p, li, h4, blockquote')) if (/[஀-௿]/.test(el.textContent)) el.setAttribute('lang', 'ta');
  return root;
}

function inline(text) {
  const frag = document.createDocumentFragment();
  const re = /\*\*(.+?)\*\*|\*([^*\s][^*]*?)\*|`([^`]+)`/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    if (m[1] !== undefined) frag.append(h('strong', null, m[1]));
    else if (m[2] !== undefined) frag.append(h('em', null, m[2]));
    else frag.append(h('code', null, m[3]));
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

/** Convert Markdown to simple, safe note HTML (for "Save as note"). */
export function markdownToNoteHtml(md) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const container = renderMarkdown(md);
  let out = '';
  const nodeHtml = (n) => {
    if (n.nodeType === 3) return esc(n.textContent);
    const inner = [...n.childNodes].map(nodeHtml).join('');
    if (n.tagName === 'STRONG') return `<b>${inner}</b>`;
    if (n.tagName === 'EM') return `<i>${inner}</i>`;
    return inner;
  };
  for (const el of container.children) {
    const inner = [...el.childNodes].map(nodeHtml).join('');
    if (el.tagName === 'H4') out += `<h2>${inner}</h2>`;
    else if (el.tagName === 'UL' || el.tagName === 'OL') out += `<${el.tagName.toLowerCase()}>${[...el.children].map((li) => `<li>${[...li.childNodes].map(nodeHtml).join('')}</li>`).join('')}</${el.tagName.toLowerCase()}>`;
    else out += `<p>${inner}</p>`;
  }
  return out;
}

// -------------------------------------------------------------- collapsible
/** Standard dashboard card with header; the collapse button only shows on small screens. */
export function panel({ title, sub, iconName, tileColor = '', right, body, cls = '', id }) {
  const card = h('section', { class: `card ${cls}`, id, 'aria-labelledby': id ? `${id}-t` : undefined });
  const toggle = h('button', { type: 'button', class: 'icon-btn collapse-btn', 'aria-expanded': 'true', 'aria-label': `Collapse ${title}`, title: 'Collapse or expand' }, icon('chevron-down'));
  toggle.addEventListener('click', () => {
    const c = card.classList.toggle('collapsed');
    toggle.setAttribute('aria-expanded', String(!c));
  });
  card.append(
    h('div', { class: 'card-head' }, iconName ? tile(iconName, tileColor) : null, h('div', { class: 'grow' }, h('h2', { class: 'card-title', id: id ? `${id}-t` : undefined }, title), sub ? h('div', { class: 'card-sub' }, sub) : null), right || null, toggle)
  );
  if (body) append(card, [body]);
  return card;
}

export const CATEGORIES = {
  study: { label: 'Study Session', color: 'var(--cat-study)' },
  revision: { label: 'Revision', color: 'var(--cat-revision)' },
  quiz: { label: 'Quiz Practice', color: 'var(--cat-quiz)' },
  assignment: { label: 'Assignment', color: 'var(--cat-assignment)' },
  exam: { label: 'Examination', color: 'var(--cat-exam)' },
  other: { label: 'Other', color: 'var(--cat-other)' },
};

export const STATUS_LABEL = { new: 'New', learning: 'Learning', needs_revision: 'Needs Revision', learned: 'Learned' };
export const STATUS_BADGE = { new: 'blue', learning: '', needs_revision: 'orange', learned: 'green' };
