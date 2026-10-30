/**
 * Psychology Dictionary. Entries are 'builtin' (shipped, verified), 'user' (written by the student)
 * or 'ai' (generated on request and clearly marked unverified until the student confirms).
 */
import { api, qs } from './api.js';
import { h, icon, tile, btn, toast, modal, confirmDialog, clear, emit, on, debounce, errText, panel, emptyState } from './ui.js';
import { go, onDispose, aiConfigured } from './state.js';
import { prefillTutor } from './tutor.js';

function originBadge(t) {
  if (t.origin === 'builtin') return h('span', { class: 'badge' }, 'Psychology Term');
  if (t.origin === 'user') return h('span', { class: 'badge green' }, 'Your entry');
  return t.verified ? h('span', { class: 'badge blue' }, 'AI-generated · you verified') : h('span', { class: 'badge orange' }, 'AI-generated · not verified');
}

function speak(text) {
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = 0.9;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch (_) {
    toast('Your browser cannot read words aloud.', 'info');
  }
}

function dropdown(label, items) {
  const wrap = h('div', { class: 'rel' });
  const b = h('button', { type: 'button', class: 'btn', 'aria-haspopup': 'true', 'aria-expanded': 'false' }, label, icon('chevron-down', 'sm'));
  let pop = null;
  const close = () => {
    if (pop) pop.remove();
    pop = null;
    b.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', away, true);
  };
  const away = (e) => { if (!wrap.contains(e.target)) close(); };
  b.addEventListener('click', () => {
    if (pop) return close();
    pop = h('div', { class: 'menu-pop', style: { top: 'auto', bottom: '48px', right: '0', left: 'auto' }, role: 'menu' }, items.filter(Boolean).map(([ic, text, fn, danger]) => h('button', { type: 'button', role: 'menuitem', class: 'item', style: danger ? { color: 'var(--error-text)' } : null, onClick: () => { close(); fn(); } }, icon(ic, 'sm'), text)));
    wrap.append(pop);
    b.setAttribute('aria-expanded', 'true');
    document.addEventListener('click', away, true);
    pop.querySelector('button')?.focus();
  });
  wrap.addEventListener('keydown', (e) => e.key === 'Escape' && close());
  wrap.append(b);
  return wrap;
}

function editModal(t, done) {
  const isNew = !t;
  const builtin = t?.origin === 'builtin';
  const v = t || {};
  const f = {};
  const field = (key, label, { area = false, hint, value = '', lang } = {}) => {
    f[key] = area ? h('textarea', { id: `ed-${key}`, rows: '3', lang }, value) : h('input', { type: 'text', id: `ed-${key}`, value, lang });
    return h('div', { class: 'field full' }, h('label', { for: `ed-${key}` }, label), f[key], hint ? h('span', { class: 'hint' }, hint) : null);
  };
  const parts = [];
  if (!builtin) {
    parts.push(field('term', 'Term or phrase', { value: v.term || '' }), field('pronunciation', 'Pronunciation (optional)', { value: v.pronunciation || '', hint: 'For example /ˈkɒɡnɪtɪv/' }),
      field('simpleEnglish', 'Simple English explanation', { area: true, value: v.simpleEnglish || '' }), field('tamil', 'தமிழ் விளக்கம் (Tamil explanation)', { area: true, value: v.tamil || '', lang: 'ta' }),
      field('definition', 'Psychology definition', { area: true, value: v.definition || '' }), field('example', 'Example sentence', { value: v.example || '' }), field('everydayExample', 'Everyday example', { area: true, value: v.everydayExample || '' }),
      field('related', 'Related terms', { value: (v.related || []).join(', '), hint: 'Separate with commas' }));
  }
  parts.push(field('personalNote', 'My own explanation', { area: true, value: v.personalNote || '', hint: builtin ? 'The built-in text is protected. Add your own words here; they are saved only on this computer.' : 'Optional: explain it in the way that makes sense to you.' }));
  const m = modal({
    title: isNew ? 'Add a term' : builtin ? `My explanation: ${t.term}` : `Edit: ${t.term}`,
    body: h('div', { class: 'form-grid' }, parts),
    actions: [btn('Cancel', { onClick: () => m.close() }), btn('Save', { variant: 'primary', onClick: async () => {
      const body = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]));
      try {
        const saved = isNew ? await api.post('/api/dictionary', body) : await api.put(`/api/dictionary/${t.id}`, body);
        m.close(); toast('Saved.', 'success'); emit('data:dictionary'); done(saved);
      } catch (e) { toast(errText(e), 'error'); }
    } })],
  });
}

export function createDictionary({ full = false, routeId = null } = {}) {
  let current = null;
  let q = '';
  let filter = 'all';
  const input = h('input', { type: 'search', id: `dict-q-${full ? 'f' : 'h'}`, placeholder: 'Search psychology terms…', 'aria-label': 'Search psychology terms', autocomplete: 'off' });
  const field = h('div', { class: 'search-field' }, icon('search'), input);
  const listBox = h('div', { class: 'result-list', role: 'list' });
  const detailBox = h('div', { 'aria-live': 'polite' });
  const recentBox = h('div');
  const filters = h('div', { class: 'row wrap', style: { marginBottom: '10px' } });

  async function show(id, { push = true } = {}) {
    try {
      current = await api.get(`/api/dictionary/${id}`);
      if (full && push) history.replaceState(null, '', `#/dictionary/${id}`);
      q = ''; input.value = '';
      renderList(null);
      renderDetail();
      if (full) loadRecent();
    } catch (e) { toast(errText(e), 'error'); }
  }

  async function aiDefine(term) {
    if (!aiConfigured()) return toast('Online AI is not set up yet. You can still add the term yourself with “Add a term”.', 'info', 7000);
    if (!navigator.onLine) return toast('You are offline. MITRA can’t ask the AI right now.', 'info');
    const ok = await confirmDialog({ title: `Ask the online AI to define “${term}”?`, message: 'Only this word or phrase will be sent over the internet. The answer is saved in your dictionary as an AI-generated entry that is marked “not verified”.', confirmText: 'Ask MITRA' });
    if (!ok) return;
    try {
      toast('Asking MITRA…', 'info', 2000);
      const r = await api.post('/api/dictionary/ai-define', { term });
      emit('data:dictionary'); emit('data:activity');
      show(r.term.id);
      if (!r.existing) toast('Added as an AI-generated entry. Please check it against your notes.', 'success', 6000);
    } catch (e) { toast(errText(e), 'error', 8000); }
  }

  async function openByName(name) {
    try {
      const t = await api.get(`/api/dictionary/by-name/${encodeURIComponent(name)}`);
      show(t.id);
    } catch (e) {
      if (e.status === 404) aiDefine(name); else toast(errText(e), 'error');
    }
  }

  function renderDetail() {
    clear(detailBox);
    const t = current;
    if (!t) return detailBox.append(emptyState('book-open', 'Search for a psychology term above, or add your own.'));
    const more = h('div', { hidden: !full });
    if (t.definition) more.append(h('div', { class: 'detail-sec' }, h('div', { class: 'sec-title' }, tile('graduation-cap'), 'Psychology definition'), h('div', null, t.definition)));
    if (t.example) more.append(h('div', { class: 'detail-sec' }, h('div', { class: 'sec-title' }, tile('pencil'), 'Example sentence'), h('div', null, t.example)));
    if (t.everydayExample) more.append(h('div', { class: 'detail-sec' }, h('div', { class: 'sec-title' }, tile('lightbulb'), 'Everyday example'), h('div', null, t.everydayExample)));
    if (t.personalNote) more.append(h('div', { class: 'detail-sec' }, h('div', { class: 'sec-title' }, tile('user-round', 'green'), 'My own explanation'), h('div', { style: { whiteSpace: 'pre-wrap' } }, t.personalNote)));
    const hasMore = more.childNodes.length > 0;
    const toggle = !full && hasMore ? btn('Show more', { size: 'xs', variant: 'ghost', onClick: () => { more.hidden = !more.hidden; toggle.textContent = more.hidden ? 'Show more' : 'Show less'; } }) : null;

    const menu = dropdown('More', [
      ['pencil', t.origin === 'builtin' ? 'Add my own explanation' : 'Edit this entry', () => editModal(t, (s) => show(s.id))],
      ['sparkles', 'Ask MITRA to explain more', () => prefillTutor(`Explain "${t.term}" with a simple example.`, 'full')],
      ['layers', 'Make a flashcard', async () => {
        try { await api.post('/api/flashcards', { front: t.term, back: [t.simpleEnglish, t.tamil].filter(Boolean).join('\n'), example: t.example, sourceNote: 'From the dictionary' }); toast('Flashcard created.', 'success'); emit('data:flashcards'); } catch (e) { toast(errText(e), 'error'); }
      }],
      t.origin !== 'builtin' ? ['circle-check', t.verified ? 'Mark as not verified' : 'Mark as verified (I checked it)', async () => { try { current = await api.patch(`/api/dictionary/${t.id}/verified`, { verified: !t.verified }); renderDetail(); } catch (e) { toast(errText(e), 'error'); } }] : null,
      t.origin !== 'builtin' ? ['trash-2', 'Delete this entry', async () => {
        if (!(await confirmDialog({ title: `Delete “${t.term}”?`, message: 'This entry will be removed from your dictionary. Vocabulary words made from it are kept.', confirmText: 'Delete', danger: true }))) return;
        try { await api.del(`/api/dictionary/${t.id}`); current = null; emit('data:dictionary'); toast('Entry deleted.', 'success'); renderDetail(); if (full) { history.replaceState(null, '', '#/dictionary'); runSearch(); } } catch (e) { toast(errText(e), 'error'); }
      }, true] : null,
    ]);

    detailBox.append(h('article', { class: 'term-card', 'aria-label': t.term },
      h('div', { class: 'term-head' }, h('h3', null, t.term), originBadge(t)),
      h('div', { class: 'pron' }, t.pronunciation ? h('span', null, t.pronunciation) : null, window.speechSynthesis ? h('button', { type: 'button', class: 'icon-btn', style: { width: '30px', height: '30px' }, 'aria-label': `Hear “${t.term}” pronounced`, title: 'Hear it', onClick: () => speak(t.term) }, icon('volume-2', 'sm')) : null),
      h('div', { class: 'two-col' },
        h('div', null, h('div', { class: 'sec-title' }, tile('languages', 'green'), 'Simple English'), t.simpleEnglish || h('span', { class: 'muted' }, 'Not written yet.')),
        h('div', null, h('div', { class: 'sec-title' }, tile('languages'), h('span', { lang: 'ta' }, 'தமிழ் விளக்கம்')), t.tamil ? h('span', { lang: 'ta' }, t.tamil) : h('span', { class: 'muted' }, 'Not written yet.'))),
      more, toggle,
      t.origin === 'ai' && !t.verified ? h('div', { class: 'alert warn small', style: { marginBottom: '12px' } }, icon('triangle-alert', 'sm'), 'Made by AI and not checked. Please compare it with your lecture notes or textbook before you rely on it.') : null,
      t.related.length ? h('div', { class: 'detail-sec' }, h('div', { class: 'sec-title' }, 'Related Terms'), h('div', { class: 'chips' }, t.related.map((r) => h('button', { type: 'button', class: 'chip', onClick: () => openByName(r) }, r)))) : null,
      h('div', { class: 'card-actions' },
        btn('Add to My Vocabulary', { icon: 'plus', variant: 'primary', onClick: async () => {
          try { const r = await api.post(`/api/vocabulary/from-term/${t.id}`); emit('data:vocab'); emit('data:activity'); toast(r.existing ? `“${t.term}” is already in My Vocabulary.` : `“${t.term}” added to My Vocabulary.`, 'success'); } catch (e) { toast(errText(e), 'error'); }
        } }),
        btn(t.saved ? 'Saved' : 'Save', { icon: t.saved ? 'bookmark-check' : 'bookmark', variant: t.saved ? 'primary' : '', onClick: async () => { try { current = await api.patch(`/api/dictionary/${t.id}/saved`, { saved: !t.saved }); emit('data:dictionary'); renderDetail(); } catch (e) { toast(errText(e), 'error'); } } }),
        menu)));
  }

  function renderList(rows) {
    clear(listBox);
    if (rows === null) { listBox.hidden = !full; if (!full) return; rows = lastRows; }
    listBox.hidden = false;
    if (!rows.length) {
      listBox.append(h('div', { class: 'empty', style: { padding: '14px' } }, h('p', null, q ? `“${q}” is not in your dictionary yet.` : 'Nothing here yet.'), q ? h('div', { class: 'stack', style: { alignItems: 'center' } }, btn(`Ask MITRA to define “${q}”`, { icon: 'sparkles', variant: 'primary', size: 'sm', onClick: () => aiDefine(q) }), btn('Add it myself', { size: 'sm', onClick: () => editModal(null, (s) => show(s.id)) })) : null));
      return;
    }
    for (const r of rows.slice(0, full ? 200 : 6)) {
      listBox.append(h('button', { type: 'button', role: 'listitem', class: 'result', 'aria-current': current && current.id === r.id ? 'true' : 'false', onClick: () => show(r.id) },
        h('span', { class: 't' }, r.term, r.saved ? icon('bookmark-check', 'sm') : null, r.origin === 'ai' ? h('span', { class: `badge ${r.verified ? 'blue' : 'orange'}` }, r.verified ? 'AI ✓' : 'AI · unverified') : r.origin === 'user' ? h('span', { class: 'badge green' }, 'Mine') : null),
        h('span', { class: 's' }, r.snippet)));
    }
    if (!full && rows.length > 6) listBox.append(h('button', { type: 'button', class: 'card-link', onClick: () => go('dictionary') }, `See all ${rows.length} matches`, icon('chevron-right', 'sm')));
  }

  let lastRows = [];
  async function runSearch() {
    q = input.value.trim();
    if (!q && !full) { clear(listBox); listBox.hidden = true; detailBox.hidden = false; return; }
    try {
      const p = { q, limit: full ? 500 : 12 };
      if (full && filter === 'saved') p.saved = true;
      else if (full && filter !== 'all') p.origin = filter;
      lastRows = await api.get(`/api/dictionary${qs(p)}`);
    } catch (e) { return toast(errText(e), 'error'); }
    detailBox.hidden = !full && !!q;
    renderList(lastRows);
  }

  async function loadRecent() {
    if (!full) return;
    try {
      const rec = await api.get('/api/dictionary/recent');
      clear(recentBox);
      if (rec.length) recentBox.append(h('h3', { class: 'card-sub', style: { margin: '14px 0 6px' } }, 'Recently opened'), h('div', { class: 'chips' }, rec.map((r) => h('button', { type: 'button', class: 'chip', onClick: () => show(r.id) }, r.term))));
    } catch (_) { /* optional */ }
  }

  function drawFilters() {
    clear(filters);
    for (const [k, l] of [['all', 'All'], ['builtin', 'Built-in'], ['user', 'Mine'], ['ai', 'AI-generated'], ['saved', 'Saved']]) {
      filters.append(h('button', { type: 'button', class: `chip ${filter === k ? 'is-on' : ''}`, 'aria-pressed': String(filter === k), onClick: () => { filter = k; drawFilters(); runSearch(); } }, l));
    }
  }

  input.addEventListener('input', debounce(runSearch, 200));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const first = listBox.querySelector('.result'); if (first) first.click(); } });

  async function init() {
    if (routeId) return show(routeId, { push: false });
    try {
      const rec = await api.get('/api/dictionary/recent');
      if (rec.length) return show(rec[0].id, { push: false });
      const first = await api.get('/api/dictionary/by-name/Cognitive%20Dissonance').catch(() => null);
      if (first) return show(first.id, { push: false });
    } catch (_) { /* fall through */ }
    renderDetail();
  }

  onDispose(on('data:dictionary', () => { if (full) runSearch(); }));
  let node;
  if (!full) {
    node = panel({ title: 'Psychology Dictionary', iconName: 'book-open', right: h('button', { type: 'button', class: 'card-link', onClick: () => go('dictionary') }, 'View All', icon('plus', 'sm')), body: h('div', null, field, listBox, detailBox) });
    listBox.hidden = true;
  } else {
    drawFilters();
    node = h('div', { class: 'split' },
      h('aside', { class: 'card listpane', 'aria-label': 'Dictionary list' }, field, filters, listBox, recentBox, h('div', { class: 'mt' }, btn('Add a term', { icon: 'plus', onClick: () => editModal(null, (s) => show(s.id)) }))),
      h('div', { class: 'card' }, detailBox));
    runSearch();
    loadRecent();
  }
  init();
  return node;
}
