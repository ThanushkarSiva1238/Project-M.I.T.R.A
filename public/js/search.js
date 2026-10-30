/** Global search across everything saved locally (no AI involved). */
import { api, qs } from './api.js';
import { h, icon, debounce, clear, modal, btn, renderMarkdown, errText } from './ui.js';
import { go } from './state.js';
import { openReader } from './library.js';
import { prefillTutor } from './tutor.js';

const GROUPS = {
  notes: ['My Notes', 'notebook-pen'],
  documents: ['My Library', 'library'],
  terms: ['Psychology terms', 'book-open'],
  vocabulary: ['My Vocabulary', 'book-a'],
  conversations: ['AI conversations', 'message-circle'],
  explanations: ['Saved explanations', 'lightbulb'],
};

async function showExplanation(id) {
  try {
    const e = await api.get(`/api/explanations/${id}`);
    modal({ title: e.title, size: 'wide', body: renderMarkdown(e.content), actions: [] });
  } catch (err) {
    modal({ title: 'Could not open it', body: h('p', null, errText(err)), actions: [] });
  }
}

const OPEN = {
  notes: (r) => go(`notes/${r.id}`),
  documents: (r) => openReader(r.id),
  terms: (r) => go(`dictionary/${r.id}`),
  vocabulary: (r) => go(`vocabulary/${r.id}`),
  conversations: (r) => go(`tutor/${r.id}`),
  explanations: (r) => (r.conversation_id ? go(`tutor/${r.conversation_id}`) : showExplanation(r.id)),
};

export function createSearch() {
  const input = h('input', {
    type: 'search', id: 'global-search', placeholder: 'Search notes, terms, or ask MITRA…', autocomplete: 'off',
    'aria-label': 'Search your notes, documents, terms, vocabulary and conversations', 'aria-controls': 'search-pop',
  });
  const pop = h('div', { class: 'search-pop', id: 'search-pop', hidden: true, role: 'region', 'aria-label': 'Search results' });
  const wrap = h('div', { class: 'search', role: 'search' }, icon('search', 'lead'), input, h('kbd', { 'aria-hidden': 'true' }, 'Ctrl + K'), pop);
  let token = 0;

  const close = () => {
    pop.hidden = true;
  };

  async function run() {
    const q = input.value.trim();
    if (q.length < 2) return close();
    const mine = ++token;
    let data;
    try {
      data = await api.get(`/api/search${qs({ q })}`);
    } catch (e) {
      if (mine !== token) return;
      clear(pop).append(h('p', { class: 'muted', style: { padding: '12px' } }, errText(e)));
      pop.hidden = false;
      return;
    }
    if (mine !== token) return;
    clear(pop);
    const names = Object.keys(data.groups);
    if (!names.length) pop.append(h('p', { class: 'muted', style: { padding: '12px 14px' } }, `Nothing saved matches “${q}”.`));
    for (const g of names) {
      const [label, ic] = GROUPS[g];
      pop.append(
        h(
          'div',
          { class: 'search-group' },
          h('h4', null, label),
          data.groups[g].map((r) =>
            h(
              'button',
              { type: 'button', class: 'search-item', onClick: () => { close(); input.value = ''; OPEN[g](r); } },
              icon(ic, 'sm'),
              h('span', null, h('span', { class: 't' }, r.title || '(untitled)'), r.snippet ? h('span', { class: 's' }, r.snippet) : null)
            )
          )
        )
      );
    }
    pop.append(
      h('div', { class: 'search-group' }, h('h4', null, 'Ask MITRA'),
        h('button', { type: 'button', class: 'search-item', onClick: () => { close(); const t = input.value.trim(); input.value = ''; prefillTutor(t); } },
          icon('sparkles', 'sm'), h('span', null, h('span', { class: 't' }, `Ask MITRA about “${q}”`), h('span', { class: 's' }, 'Opens the tutor with this text ready. Nothing is sent until you press Send.'))))
    );
    pop.hidden = false;
  }

  input.addEventListener('input', debounce(run, 250));
  input.addEventListener('focus', () => input.value.trim().length >= 2 && run());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      close();
      input.blur();
    } else if (e.key === 'ArrowDown') {
      const first = pop.querySelector('.search-item');
      if (first) {
        e.preventDefault();
        first.focus();
      }
    } else if (e.key === 'Enter') {
      const first = pop.querySelector('.search-item');
      if (first && !pop.hidden) first.click();
    }
  });
  pop.addEventListener('keydown', (e) => {
    const items = [...pop.querySelectorAll('.search-item')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' && i < items.length - 1) { e.preventDefault(); items[i + 1].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); (i > 0 ? items[i - 1] : input).focus(); }
    else if (e.key === 'Escape') { close(); input.focus(); }
  });
  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) close();
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      input.focus();
      input.select();
    }
  });
  return wrap;
}
