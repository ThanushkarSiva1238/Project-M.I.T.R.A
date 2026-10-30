/** My Vocabulary: the student's personal English word notebook (stored in SQLite). */
import { api, qs } from './api.js';
import { h, icon, tile, btn, toast, modal, confirmDialog, clear, emit, on, debounce, errText, emptyState, friendlyDate, STATUS_LABEL, STATUS_BADGE } from './ui.js';
import { go, onDispose } from './state.js';

const POS = ['', 'noun', 'verb', 'adjective', 'adverb', 'phrase', 'other'];
const STATUSES = ['new', 'learning', 'needs_revision', 'learned'];

export function vocabModal(entry, onSaved) {
  const e = entry || {};
  const f = {};
  const field = (key, label, el, cls = 'full') => { f[key] = el; return h('div', { class: `field ${cls}` }, h('label', { for: `vo-${key}` }, label), el); };
  const text = (key, v = '', extra = {}) => h('input', { type: 'text', id: `vo-${key}`, value: v, ...extra });
  const area = (key, v = '', extra = {}) => h('textarea', { id: `vo-${key}`, rows: '2', ...extra }, v);
  const m = modal({
    title: entry ? `Edit “${e.word}”` : 'Add a word or phrase',
    body: h('div', { class: 'form-grid' },
      field('word', 'Word or phrase', text('word', e.word || '', { maxlength: '100' })),
      field('partOfSpeech', 'Part of speech', h('select', { id: 'vo-partOfSpeech' }, POS.map((p) => h('option', { value: p, selected: (e.partOfSpeech || '') === p }, p || 'Not sure'))), ''),
      field('status', 'Learning status', h('select', { id: 'vo-status' }, STATUSES.map((s) => h('option', { value: s, selected: (e.status || 'new') === s }, STATUS_LABEL[s]))), ''),
      field('meaning', 'Simple English meaning', area('meaning', e.meaning || '')),
      field('tamil', 'தமிழ் மொழிபெயர்ப்பு (Tamil translation)', area('tamil', e.tamil || '', { lang: 'ta' })),
      field('psychMeaning', 'Meaning in psychology (if different)', area('psychMeaning', e.psychMeaning || '')),
      field('example', 'Example sentence', text('example', e.example || '')),
      field('sourceNote', 'Where did you meet this word?', text('sourceNote', e.sourceNote || '', { placeholder: 'e.g. Lecture 3, page 12' }))),
    actions: [btn('Cancel', { onClick: () => m.close() }), btn('Save', { variant: 'primary', onClick: async () => {
      const body = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]));
      if (!body.word.trim()) { f.word.focus(); return toast('Please type the word or phrase.', 'info'); }
      try {
        const saved = entry ? await api.put(`/api/vocabulary/${e.id}`, body) : await api.post('/api/vocabulary', body);
        m.close(); toast('Saved to My Vocabulary.', 'success'); emit('data:vocab'); emit('data:activity'); onSaved && onSaved(saved);
      } catch (x) { toast(errText(x), 'error'); }
    } })],
  });
}

export function createVocabularyView({ highlightId = null, status: initialStatus = '' } = {}) {
  let status = STATUSES.includes(initialStatus) ? initialStatus : '';
  let counts = { total: 0 };
  const list = h('div', { class: 'list' });
  const chipsEl = h('div', { class: 'row wrap', role: 'group', 'aria-label': 'Filter by learning status' });
  const search = h('input', { type: 'search', placeholder: 'Search your words…', 'aria-label': 'Search vocabulary' });

  async function load() {
    try {
      [counts] = await Promise.all([api.get('/api/vocabulary/counts')]);
      const rows = await api.get(`/api/vocabulary${qs({ q: search.value.trim(), status })}`);
      drawChips();
      clear(list);
      if (!rows.length) {
        return list.append(emptyState('book-a', counts.total ? 'No words match this filter.' : 'Your vocabulary is empty. Add words you meet in lectures, or press “Add to My Vocabulary” on a dictionary term.', counts.total ? null : btn('Add your first word', { icon: 'plus', variant: 'primary', onClick: () => vocabModal(null, load) })));
      }
      for (const w of rows) list.append(card(w));
      if (highlightId) {
        const el = list.querySelector(`[data-id="${highlightId}"]`);
        if (el) { el.classList.add('hl'); el.scrollIntoView({ block: 'center' }); } else toast('That word is not in your vocabulary any more.', 'info');
        highlightId = null;
      }
    } catch (e) { clear(list).append(h('div', { class: 'alert error' }, errText(e))); }
  }

  function card(w) {
    const row = (k, v, lang) => (v ? [h('dt', null, k), h('dd', { lang }, v)] : []);
    return h('article', { class: 'vocab', dataset: { id: w.id }, 'aria-label': w.word },
      h('div', null,
        h('h3', null, w.word, w.partOfSpeech ? h('span', { class: 'pos' }, w.partOfSpeech) : null),
        h('dl', null, row('Meaning', w.meaning), row('தமிழ்', w.tamil, 'ta'), row('In psychology', w.psychMeaning), row('Example', w.example), row('Source', w.sourceNote)),
        h('div', { class: 'xs muted', style: { marginTop: '8px' } }, `Added ${friendlyDate(w.createdAt, false)}${w.lastReviewed ? ` · last reviewed ${friendlyDate(w.lastReviewed, false)}` : ' · not reviewed yet'}`)),
      h('div', { class: 'side' },
        h('select', { 'aria-label': `Learning status of ${w.word}`, onChange: async (ev) => { try { await api.patch(`/api/vocabulary/${w.id}/status`, { status: ev.target.value }); emit('data:vocab'); load(); } catch (e) { toast(errText(e), 'error'); } } }, STATUSES.map((s) => h('option', { value: s, selected: w.status === s }, STATUS_LABEL[s]))),
        h('span', { class: 'row' },
          btn('Edit', { icon: 'pencil', size: 'xs', onClick: () => vocabModal(w, load) }),
          btn('Delete', { icon: 'trash-2', size: 'xs', variant: 'danger', onClick: async () => {
            if (!(await confirmDialog({ title: `Delete “${w.word}”?`, message: 'This word will be removed from your vocabulary. Flashcards made from it are kept.', confirmText: 'Delete', danger: true }))) return;
            try { await api.del(`/api/vocabulary/${w.id}`); emit('data:vocab'); toast('Word deleted.', 'success'); load(); } catch (e) { toast(errText(e), 'error'); }
          } }))));
  }

  function drawChips() {
    clear(chipsEl);
    const opts = [['', 'All', counts.total], ...STATUSES.map((s) => [s, STATUS_LABEL[s], counts[s] || 0])];
    for (const [k, l, n] of opts) chipsEl.append(h('button', { type: 'button', class: `chip ${status === k ? 'is-on' : ''}`, 'aria-pressed': String(status === k), onClick: () => { status = k; load(); } }, `${l} (${n || 0})`));
  }

  search.addEventListener('input', debounce(load, 250));
  onDispose(on('data:vocab', load));
  const root = h('div', null,
    h('div', { class: 'view-title' }, tile('book-a'), h('div', { class: 'grow' }, h('h1', null, 'My Vocabulary'), h('div', { class: 'sub' }, 'English words and phrases you are learning, with Tamil help.'))),
    h('div', { class: 'toolbar-row' },
      h('div', { class: 'search-field' }, icon('search'), search),
      btn('Add a word', { icon: 'plus', variant: 'primary', onClick: () => vocabModal(null, load) }),
      btn('Practise with flashcards', { icon: 'layers', onClick: async () => {
        try { const r = await api.post('/api/flashcards/from-vocabulary', {}); emit('data:flashcards'); toast(r.created ? `${r.created} new flashcard${r.created > 1 ? 's' : ''} created.` : 'All your words already have flashcards.', 'success'); go('flashcards'); } catch (e) { toast(errText(e), 'error'); }
      } })),
    chipsEl, h('div', { style: { height: '14px' } }), list);
  load();
  return root;
}
