/** Right-hand History panel (AI sessions / notes) and the Recent Activity card. Everything comes from stored records. */
import { api } from './api.js';
import { h, icon, tile, clear, emit, on, errText, panel, emptyState, friendlyDate } from './ui.js';
import { go, onDispose } from './state.js';

export function createHistory() {
  let tab = 'sessions';
  const list = h('div', { class: 'list' });
  const link = h('button', { type: 'button', class: 'card-link', onClick: () => go(tab === 'sessions' ? 'tutor' : 'notes') }, 'View All');
  const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'History' });

  function drawTabs() {
    clear(tabs);
    for (const [k, l] of [['sessions', 'AI Sessions'], ['notes', 'My Notes']]) {
      tabs.append(h('button', { type: 'button', role: 'tab', class: 'tab', 'aria-selected': String(tab === k), onClick: () => { tab = k; drawTabs(); load(); } }, l));
    }
  }

  async function load() {
    clear(list);
    try {
      if (tab === 'sessions') {
        const rows = await api.get('/api/conversations?limit=6');
        if (!rows.length) return list.append(emptyState('message-circle', 'No conversations yet. Ask MITRA something and it will appear here.'));
        for (const c of rows) {
          list.append(h('button', { type: 'button', class: 'item', onClick: () => emit('open-conversation', c.id) || go(`tutor/${c.id}`) },
            h('span', { class: 'body' }, h('span', { class: 't' }, c.title), h('span', { class: 's' }, friendlyDate(c.updated_at)))));
        }
      } else {
        const rows = await api.get('/api/notes?limit=6');
        if (!rows.length) return list.append(emptyState('notebook-pen', 'No notes yet. Your saved notes will appear here.'));
        for (const n of rows) {
          list.append(h('button', { type: 'button', class: 'item', onClick: () => { if (document.getElementById('notepad-card')) { emit('open-note', n.id); document.getElementById('notepad-card').scrollIntoView({ behavior: 'smooth', block: 'center' }); } else go(`notes/${n.id}`); } },
            h('span', { class: 'body' }, h('span', { class: 't' }, n.title || 'Untitled note'), h('span', { class: 's' }, friendlyDate(n.updatedAt)))));
        }
      }
    } catch (e) { list.append(h('div', { class: 'alert error' }, errText(e))); }
  }

  drawTabs();
  onDispose(on('data:conversations', load));
  onDispose(on('data:notes', load));
  load();
  return panel({ title: 'History', iconName: 'history', right: link, body: h('div', null, tabs, list) });
}

const TYPE_ICON = {
  explanation: ['pencil', ''], vocab_added: ['book-a', 'green'], note_created: ['notebook-pen', 'blue'], note_updated: ['notebook-pen', 'blue'],
  quiz_completed: ['clipboard-check', 'orange'], quiz_created: ['clipboard-check', 'orange'], flashcard_reviewed: ['layers', ''], flashcards_added: ['layers', ''],
  document_added: ['file-text', 'blue'], term_added: ['book-open', ''], term_saved: ['bookmark-check', ''], event_completed: ['circle-check', 'green'],
};
function target(a) {
  switch (a.refType) {
    case 'conversation': return `tutor/${a.refId}`;
    case 'note': return `notes/${a.refId}`;
    case 'quiz': return `quizzes/${a.refId}`;
    case 'term': return `dictionary/${a.refId}`;
    case 'vocabulary': return `vocabulary/${a.refId}`;
    case 'flashcard': return 'flashcards';
    case 'document': return 'library';
    case 'event': return 'study';
    default: return null;
  }
}

export function createRecentActivity({ limit = 6 } = {}) {
  const list = h('div', { class: 'list' });
  async function load() {
    try {
      const rows = await api.get(`/api/activity?limit=${limit}`);
      clear(list);
      if (!rows.length) return list.append(emptyState('sparkles', 'Nothing yet. As you study, your recent activity will show up here.'));
      for (const a of rows) {
        const [ic, color] = TYPE_ICON[a.type] || ['sparkles', ''];
        const t = target(a);
        const inner = [tile(ic, color), h('span', { class: 'body' }, h('span', { class: 't' }, a.label), h('span', { class: 's' }, friendlyDate(a.createdAt)))];
        list.append(t ? h('a', { class: 'item', href: `#/${t}` }, inner) : h('div', { class: 'item' }, inner));
      }
    } catch (e) { clear(list).append(h('div', { class: 'alert error' }, errText(e))); }
  }
  for (const ev of ['data:activity', 'data:notes', 'data:vocab', 'data:flashcards', 'data:events']) onDispose(on(ev, load));
  load();
  return panel({ title: 'Recent Activity', iconName: 'sparkles', right: h('button', { type: 'button', class: 'card-link', onClick: () => go('progress') }, 'View All'), body: list });
}
