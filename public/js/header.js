/** Top header: brand, search, connection status, theme, notifications, profile menu. */
import { api } from './api.js';
import { h, icon, orb, iconBtn, toast, on, emit, debounce, modal, btn, clear } from './ui.js';
import { state, go, applyTheme } from './state.js';
import { createSearch } from './search.js';
import { showPrivacyNotice } from './privacy.js';

function connection() {
  const ai = state.settings?.ai;
  if (!navigator.onLine) return { cls: 'off', icon: 'wifi-off', text: 'You are offline. Everything saved still works. New AI explanations need the internet.' };
  if (!ai?.configured) return { cls: 'warn', icon: 'wifi', text: 'Online, but AI is not set up yet. Open Settings → Online AI to add your key.' };
  return { cls: 'ok', icon: 'wifi', text: `Online. AI ready (${ai.provider}${ai.model ? ', ' + ai.model : ''}).` };
}

function popover(anchor, build) {
  const pop = h('div', { class: 'menu-pop', role: 'menu' });
  build(pop);
  anchor.append(pop);
  const off = (e) => {
    if (!anchor.contains(e.target)) close();
  };
  const esc = (e) => e.key === 'Escape' && close();
  function close() {
    pop.remove();
    document.removeEventListener('click', off, true);
    document.removeEventListener('keydown', esc);
  }
  setTimeout(() => document.addEventListener('click', off, true));
  document.addEventListener('keydown', esc);
  pop.close = close;
  return pop;
}

function about() {
  modal({
    title: 'About MITRA',
    size: 'narrow',
    body: h('div', { class: 'center stack' }, h('div', { style: { display: 'grid', placeItems: 'center' } }, orb('lg')), h('h3', null, 'MITRA'), h('p', { class: 'muted' }, 'Memory, Intelligence, Tutoring & Revision Assistant'), h('p', null, h('em', null, 'Understand More. Remember Better. Learn with Confidence.')), h('p', { class: 'small muted' }, `Version ${state.settings?.app?.version || ''}. Made as a gift, with care. 💜`)),
    actions: [],
  });
}

export function createHeader({ onMenu }) {
  const status = h('button', { type: 'button', class: 'icon-btn status-ic', onClick: () => toast(connection().text, 'info') });
  const themeBtn = h('button', { type: 'button', class: 'icon-btn', onClick: toggleTheme });
  const bellBadge = h('span', { class: 'dot', hidden: true });
  const bell = h('div', { class: 'rel' }, h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Reminders', title: 'Reminders', 'aria-haspopup': 'true', onClick: openBell }, icon('bell'), bellBadge));
  const hello = h('span', { class: 'hello' });
  const profile = h('div', { class: 'rel' }, h('button', { type: 'button', class: 'profile-btn', 'aria-haspopup': 'true', onClick: openProfile }, h('span', { class: 'avatar' }, icon('user-round')), hello, icon('chevron-down', 'sm')));

  function paint() {
    const c = connection();
    status.className = `icon-btn status-ic ${c.cls}`;
    status.setAttribute('aria-label', c.text);
    status.title = c.text;
    clear(status).append(icon(c.icon));
    const dark = state.settings?.theme === 'dark';
    themeBtn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    themeBtn.title = dark ? 'Switch to light theme' : 'Switch to dark theme';
    clear(themeBtn).append(icon(dark ? 'sun' : 'moon'));
    hello.textContent = `Hello, ${state.settings?.displayName || 'Friend'}`;
  }

  async function toggleTheme() {
    const next = state.settings.theme === 'dark' ? 'light' : 'dark';
    try {
      state.settings = await api.put('/api/settings', { theme: next });
      applyTheme();
      paint();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function reminders() {
    const s = await api.get('/api/progress/summary');
    const r = s.reminders;
    const items = [];
    if (r.eventsToday) items.push([`${r.eventsToday} study event${r.eventsToday > 1 ? 's' : ''} today`, 'calendar', 'study']);
    if (r.overdueEvents) items.push([`${r.overdueEvents} event${r.overdueEvents > 1 ? 's' : ''} not marked done`, 'clock', 'study']);
    if (r.flashcardsDue) items.push([`${r.flashcardsDue} flashcard${r.flashcardsDue > 1 ? 's' : ''} ready to review`, 'layers', 'flashcards']);
    if (r.vocabularyNeedsRevision) items.push([`${r.vocabularyNeedsRevision} word${r.vocabularyNeedsRevision > 1 ? 's' : ''} need revision`, 'book-a', 'vocabulary']);
    return items;
  }

  async function refreshBadge() {
    try {
      const n = (await reminders()).length;
      bellBadge.hidden = n === 0;
      bellBadge.textContent = n;
    } catch (_) {
      bellBadge.hidden = true;
    }
  }

  async function openBell() {
    let items = [];
    try {
      items = await reminders();
    } catch (_) {
      /* show empty */
    }
    popover(bell, (pop) => {
      pop.append(h('div', { class: 'small muted', style: { padding: '6px 12px' } }, 'Reminders'));
      if (!items.length) pop.append(h('p', { style: { padding: '8px 12px' } }, 'You are all caught up. 🎉'));
      for (const [text, ic, route] of items) {
        pop.append(h('button', { type: 'button', class: 'item', role: 'menuitem', onClick: () => { pop.close(); go(route); } }, icon(ic, 'sm'), text));
      }
      pop.append(h('hr'), h('p', { class: 'xs muted', style: { padding: '0 12px 6px' } }, 'Reminders appear here inside MITRA. MITRA does not send desktop or phone notifications.'));
    });
  }

  function openProfile() {
    popover(profile, (pop) => {
      const row = (ic, text, fn) => h('button', { type: 'button', class: 'item', role: 'menuitem', onClick: () => { pop.close(); fn(); } }, icon(ic, 'sm'), text);
      pop.append(
        h('div', { style: { padding: '8px 12px' } }, h('strong', null, state.settings?.displayName || 'Friend'), h('div', { class: 'xs muted' }, 'Your local MITRA profile (no account, nothing in the cloud)')),
        h('hr'),
        row('settings', 'Preferences', () => go('settings')),
        row('shield-check', 'Privacy notice', () => showPrivacyNotice()),
        row('archive-restore', 'Backup & restore', () => go('settings/backup')),
        row('info', 'About MITRA', about)
      );
    });
  }

  const header = h(
    'header',
    { class: 'topbar' },
    h('button', { type: 'button', class: 'icon-btn menu-btn', 'aria-label': 'Open menu', onClick: onMenu }, icon('menu')),
    h('a', { class: 'brand', href: '#/home', 'aria-label': 'MITRA home' }, orb(), h('span', { class: 'brand-name' }, 'MITRA'), h('span', { class: 'brand-sub' }, 'Your Personal Psychology Learning Companion')),
    createSearch(),
    h('div', { class: 'top-actions' }, status, themeBtn, bell, profile)
  );

  paint();
  window.addEventListener('online', () => { paint(); emit('connection'); });
  window.addEventListener('offline', () => { paint(); emit('connection'); });
  on('settings', paint);
  const soon = debounce(refreshBadge, 600);
  for (const ev of ['data:events', 'data:flashcards', 'data:vocab']) on(ev, soon);
  refreshBadge();
  setInterval(refreshBadge, 5 * 60 * 1000);
  return header;
}
