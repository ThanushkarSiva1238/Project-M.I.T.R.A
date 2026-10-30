/** MITRA app shell: sidebar, header, hash router, and the Home dashboard. */
import { api } from './api.js';
import { h, icon, btn, clear, on } from './ui.js';
import { state, go, runDisposers, loadSettings } from './state.js';
import { createHeader } from './header.js';
import { showPrivacyNotice } from './privacy.js';
import { createTutor } from './tutor.js';
import { createDictionary } from './dictionary.js';
import { createNotepad } from './notes.js';
import { createCalendar } from './calendar.js';
import { createHistory, createRecentActivity } from './history.js';
import { createLibraryView } from './library.js';
import { createVocabularyView } from './vocabulary.js';
import { createFlashcardsView } from './flashcards.js';
import { createQuizView } from './quizzes.js';
import { createStudyView, createProgressView } from './learning.js';
import { createSettingsView } from './settings.js';

const NAV = [
  ['home', 'Home', 'house'], ['library', 'My Library', 'library'], ['tutor', 'MITRA AI Tutor', 'message-circle'],
  ['dictionary', 'Psychology Dictionary', 'book-open'], ['vocabulary', 'My Vocabulary', 'book-a'], ['flashcards', 'Flashcards', 'layers'],
  ['quizzes', 'Quiz Centre', 'clipboard-check'], ['study', 'Study & Revision', 'repeat'], ['notes', 'My Notes', 'notebook-pen'],
  ['progress', 'Learning Progress', 'chart-line'], ['settings', 'Settings', 'settings'],
];
const TITLES = Object.fromEntries(NAV.map(([k, l]) => [k, l]));

const leaf = (cls) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 100 100'); s.setAttribute('class', `leaf ${cls}`); s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', 'M10 90C10 40 40 10 90 10 90 60 60 90 10 90ZM10 90L60 40'); p.setAttribute('fill', 'currentColor'); p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', '2');
  s.append(p); return s;
};

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [pathPart, query = ''] = raw.split('?');
  const [name = 'home', ...params] = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
  return { name, params, query: new URLSearchParams(query) };
}

function view(r) {
  const [p0, p1] = r.params;
  switch (r.name) {
    case 'home': return h('div', { class: 'dash' },
      h('div', { class: 'col stack' }, createTutor(), createRecentActivity()),
      h('div', { class: 'col stack' }, createDictionary(), createNotepad()),
      h('div', { class: 'col stack' }, createCalendar(), createHistory()));
    case 'tutor': return createTutor({ full: true, routeConvId: p0 ? Number(p0) : null });
    case 'dictionary': return createDictionary({ full: true, routeId: p0 ? Number(p0) : null });
    case 'notes': return createNotepad({ full: true, routeNoteId: p0 ? Number(p0) : null });
    case 'library': return createLibraryView();
    case 'vocabulary': return createVocabularyView({ highlightId: p0 ? Number(p0) : null, status: r.query.get('status') || '' });
    case 'flashcards': return createFlashcardsView();
    case 'quizzes':
      if (p0 === 'attempt') return createQuizView({ id: Number(p1), mode: 'attempt' });
      return createQuizView({ id: p0 ? Number(p0) : null, mode: p1 === 'take' ? 'take' : null });
    case 'study': return createStudyView();
    case 'progress': return createProgressView();
    case 'settings': return createSettingsView({ anchor: p0 });
    default: return h('div', { class: 'empty' }, icon('circle-help'), h('p', null, 'That page does not exist.'), btn('Go to Home', { variant: 'primary', onClick: () => go('home') }));
  }
}

function buildShell() {
  const app = document.getElementById('app');
  const main = h('main', { class: 'main', id: 'main', tabindex: '-1' });
  const closeNav = () => document.body.classList.remove('nav-open');
  const links = NAV.map(([k, label, ic]) => h('a', { class: 'navlink', href: `#/${k}`, dataset: { nav: k }, onClick: closeNav }, icon(ic), label));
  const nav = h('nav', { class: 'sidenav', 'aria-label': 'Main' }, links,
    h('div', { class: 'nav-quote' }, leaf('a'), leaf('b'), leaf('c'), h('q', null, 'Small steps make big progress.'), h('cite', null, '— MITRA')));
  const scrim = h('div', { class: 'scrim', onClick: closeNav });
  const header = createHeader({ onMenu: () => document.body.classList.toggle('nav-open') });
  clear(app).append(h('a', { class: 'skip-link', href: '#main', onClick: (e) => { e.preventDefault(); main.focus(); } }, 'Skip to content'), h('div', { class: 'shell' }, header, nav, main), scrim);
  return { main, links };
}

export async function boot() {
  const app = document.getElementById('app');
  try { await loadSettings(); } catch (e) {
    clear(app).append(h('div', { class: 'empty', style: { margin: '80px auto', maxWidth: '460px' }, role: 'alert' }, icon('triangle-alert'), h('h1', null, 'MITRA could not start'), h('p', null, e.message || 'The MITRA server did not answer. Make sure start-mitra is still running, then try again.'), btn('Try again', { variant: 'primary', onClick: () => location.reload() })));
    document.body.classList.remove('loading');
    return;
  }
  const { main, links } = buildShell();
  function render() {
    runDisposers();
    document.body.classList.remove('nav-open');
    const r = parseRoute();
    const key = TITLES[r.name] ? r.name : null;
    document.title = `${key ? TITLES[key] : 'MITRA'} · MITRA`;
    for (const a of links) { if (a.dataset.nav === key) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
    clear(main);
    try { main.append(view(r)); } catch (e) { console.error(e); main.append(h('div', { class: 'alert error', role: 'alert' }, 'This page could not be shown. Please go back to Home and try again.')); }
    if (!render.first) window.scrollTo({ top: 0 });
    render.first = false;
  }
  render.first = true;
  window.addEventListener('hashchange', render);
  if (!location.hash) location.replace('#/home'); else render();
  if (!location.hash.startsWith('#/')) location.replace('#/home');
  document.body.classList.remove('loading');
  if (!state.settings.privacyNoticeSeen) showPrivacyNotice({ firstRun: true });
}

boot();
