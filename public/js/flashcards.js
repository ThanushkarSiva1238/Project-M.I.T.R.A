/**
 * Flashcards. Scheduling is a simple fixed ladder (1 → 3 → 7 → 14 → 30 days), not advanced spaced repetition.
 * AI-generated cards are only a draft: the student reviews and chooses which ones to keep.
 */
import { api, qs } from './api.js';
import { h, icon, tile, btn, toast, modal, confirmDialog, clear, emit, on, debounce, errText, emptyState, friendlyEventDate, STATUS_LABEL, STATUS_BADGE } from './ui.js';
import { go, onDispose, aiConfigured } from './state.js';
import { sourcePicker } from './sources.js';

export function cardModal(card, onSaved) {
  const c = card || {};
  const front = h('input', { type: 'text', id: 'fc-front', value: c.front || '', maxlength: '300' });
  const back = h('textarea', { id: 'fc-back', rows: '3' }, c.back || '');
  const ex = h('input', { type: 'text', id: 'fc-ex', value: c.example || '' });
  const src = h('input', { type: 'text', id: 'fc-src', value: c.sourceNote || '', placeholder: 'e.g. Lecture 4' });
  const f = (id, label, el) => h('div', { class: 'field' }, h('label', { for: id }, label), el);
  const m = modal({ title: card ? 'Edit flashcard' : 'New flashcard', body: h('div', null, f('fc-front', 'Question or term', front), f('fc-back', 'Answer or definition', back), f('fc-ex', 'Example (optional)', ex), f('fc-src', 'Source note (optional)', src)),
    actions: [btn('Cancel', { onClick: () => m.close() }), btn('Save', { variant: 'primary', onClick: async () => {
      const body = { front: front.value, back: back.value, example: ex.value, sourceNote: src.value };
      try { const s = card ? await api.put(`/api/flashcards/${c.id}`, body) : await api.post('/api/flashcards', body); m.close(); emit('data:flashcards'); emit('data:activity'); toast('Flashcard saved.', 'success'); onSaved && onSaved(s); } catch (e) { toast(errText(e), 'error'); }
    } })] });
}

/** Choose a source → AI drafts cards → student edits/selects → saved. */
export function openFlashcardGenerator(preset = {}) {
  const picker = sourcePicker({ preset });
  const status = h('div');
  const count = h('select', { id: 'fc-count', 'aria-label': 'How many cards' }, [4, 6, 8, 10, 12].map((n) => h('option', { value: n, selected: n === 6 }, `${n} cards`)));
  const gen = btn('Generate flashcards', { icon: 'sparkles', variant: 'primary' });
  const step1 = h('div', null, picker.el, h('div', { class: 'row', style: { marginTop: '8px' } }, h('label', { for: 'fc-count', class: 'small' }, 'Make'), count));
  const body = h('div', null, step1, status);
  const m = modal({ title: 'Create flashcards', size: 'wide', body, actions: [btn('Close', { onClick: () => m.close() }), gen] });
  if (!aiConfigured()) status.append(h('div', { class: 'alert warn', style: { marginTop: '12px' } }, icon('triangle-alert'), h('div', null, 'Online AI is not set up yet, so MITRA can’t draft cards for you. You can still make cards by hand.'), h('div', { class: 'actions' }, btn('Open Settings', { size: 'xs', onClick: () => { m.close(); go('settings'); } }), btn('Make one by hand', { size: 'xs', onClick: () => { m.close(); cardModal(null); } }))));

  gen.addEventListener('click', async () => {
    let src;
    try { src = picker.get(); } catch (e) { return toast(e.message, 'info'); }
    if (!aiConfigured()) return toast('Online AI is not set up yet. Open Settings → Online AI.', 'info');
    gen.disabled = true;
    clear(status).append(h('div', { class: 'row', style: { marginTop: '14px' }, role: 'status' }, h('span', { class: 'spinner' }), 'MITRA is writing your cards…'));
    try {
      const r = await api.post('/api/flashcards/generate', { ...src, count: Number(count.value) });
      emit('data:activity');
      review(r);
    } catch (e) {
      gen.disabled = false;
      clear(status).append(h('div', { class: 'alert error', role: 'alert', style: { marginTop: '14px' } }, icon('triangle-alert'), h('div', null, errText(e), h('div', { class: 'xs' }, 'Nothing was lost. You can press the button again to retry.'))));
    }
  });

  function review(r) {
    const rows = r.cards.map((c) => ({ on: true, front: h('input', { type: 'text', value: c.front, 'aria-label': 'Question', maxlength: '300' }), back: h('textarea', { rows: '2', 'aria-label': 'Answer' }, c.back), example: c.example || '', check: h('input', { type: 'checkbox', checked: true, style: { width: 'auto' }, 'aria-label': 'Keep this card' }) }));
    clear(body).append(
      h('div', { class: 'alert', style: { marginBottom: '12px' } }, icon('info'), h('div', null, h('strong', null, 'AI-generated draft. '), `Cards were written from: ${r.source.label}. Please read them, fix anything wrong, and untick the ones you don’t want.`)),
      h('div', { class: 'stack' }, rows.map((x, i) => h('div', { class: 'q-card', style: { marginBottom: 0 } }, h('div', { class: 'row', style: { alignItems: 'flex-start' } }, x.check, h('div', { class: 'grow stack gap-sm' }, x.front, x.back, x.example ? h('div', { class: 'xs muted' }, `Example: ${x.example}`) : null))))));
    clear(m.foot).append(btn('Cancel', { onClick: () => m.close() }), btn('Save selected cards', { icon: 'save', variant: 'primary', onClick: async () => {
      const cards = rows.filter((x) => x.check.checked && x.front.value.trim() && x.back.value.trim()).map((x) => ({ front: x.front.value, back: x.back.value, example: x.example }));
      if (!cards.length) return toast('Please keep at least one card.', 'info');
      try { const s = await api.post('/api/flashcards/bulk', { cards, documentId: r.source.documentId || undefined, sourceNote: r.source.label }); m.close(); emit('data:flashcards'); emit('data:activity'); toast(`${s.created} flashcard${s.created > 1 ? 's' : ''} saved.`, 'success'); } catch (e) { toast(errText(e), 'error'); }
    } }));
  }
}

export function createFlashcardsView() {
  let tab = 'study';
  const root = h('div');
  const content = h('div');
  const tabs = h('div', { class: 'tabs', role: 'tablist', style: { maxWidth: '360px' } });

  function drawTabs() {
    clear(tabs);
    for (const [k, l] of [['study', 'Study'], ['all', 'All cards']]) tabs.append(h('button', { type: 'button', role: 'tab', class: 'tab', 'aria-selected': String(tab === k), onClick: () => { tab = k; drawTabs(); draw(); } }, l));
  }

  // --------------------------------------------------------------- study
  async function study(all = false) {
    clear(content).append(h('div', { class: 'row', role: 'status' }, h('span', { class: 'spinner' }), 'Getting your cards…'));
    let q;
    try {
      q = all ? { cards: await api.get('/api/flashcards'), due: 0, total: 0 } : await api.get('/api/flashcards/queue?limit=50');
    } catch (e) { return clear(content).append(h('div', { class: 'alert error' }, errText(e))); }
    if (!q.cards.length) {
      return clear(content).append(emptyState('layers', all ? 'You have no flashcards yet. Create some from a note, a document, or your vocabulary.' : q.total ? 'No cards are due right now. Come back tomorrow, or practise them anyway.' : 'You have no flashcards yet.', h('div', { class: 'row wrap', style: { justifyContent: 'center' } }, q.total && !all ? btn('Practise all cards anyway', { icon: 'rotate-ccw', onClick: () => study(true) }) : null, btn('Create flashcards', { icon: 'sparkles', variant: 'primary', onClick: () => openFlashcardGenerator() }), btn('Add one by hand', { onClick: () => cardModal(null, () => study(all)) }))));
    }
    const S = { cards: q.cards.slice(), i: 0, revealed: false, done: new Set(), requeued: new Set(), res: { understood: 0, revision: 0 } };
    const stage = h('div', { class: 'fc-stage' });
    content.replaceChildren(stage);

    function show() {
      clear(stage);
      if (S.i >= S.cards.length) {
        return stage.append(h('div', { class: 'card center stack' }, h('div', { class: 'tile green', style: { margin: '0 auto', width: '56px', height: '56px', borderRadius: '50%' } }, icon('circle-check', 'lg')), h('h2', null, 'Session finished 🎉'),
          h('p', null, `You marked ${S.res.understood} card${S.res.understood === 1 ? '' : 's'} as understood and ${S.res.revision} for revision.`), h('p', { class: 'muted small' }, 'Cards for revision will come back tomorrow. Understood cards return after a few days.'),
          h('div', { class: 'row wrap', style: { justifyContent: 'center' } }, btn('Start again', { icon: 'rotate-ccw', onClick: () => study(all) }), btn('See all cards', { onClick: () => { tab = 'all'; drawTabs(); draw(); } }))));
      }
      const c = S.cards[S.i];
      const answer = S.revealed ? h('div', null, h('div', { class: 'back', lang: /[஀-௿]/.test(c.back) ? 'ta' : undefined }, c.back), c.example ? h('div', { class: 'ex', style: { marginTop: '10px' } }, `Example: ${c.example}`) : null, c.sourceNote ? h('div', { class: 'ex' }, `Source: ${c.sourceNote}`) : null) : null;
      stage.append(
        h('div', { class: 'row spread', style: { marginBottom: '10px' } }, h('span', { class: 'small muted', 'aria-live': 'polite' }, `Card ${S.i + 1} of ${S.cards.length}`), h('span', { class: `badge ${STATUS_BADGE[c.status]}` }, STATUS_LABEL[c.status])),
        h('div', { class: 'progressbar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(S.cards.length), 'aria-valuenow': String(S.i), 'aria-label': 'Session progress', style: { marginBottom: '14px' } }, h('i', { style: { width: `${(S.i / S.cards.length) * 100}%` } })),
        h('div', { class: 'fc-card', 'aria-live': 'polite' }, h('div', { class: 'front' }, c.front), answer),
        h('div', { class: 'row wrap', style: { justifyContent: 'center', marginTop: '16px' } },
          btn('Previous', { icon: 'arrow-left', disabled: S.i === 0, onClick: () => { S.i--; S.revealed = false; show(); } }),
          !S.revealed ? btn('Show answer', { icon: 'eye', variant: 'primary', onClick: () => { S.revealed = true; show(); } }) : [
            btn('Needs revision', { icon: 'flag', variant: 'warn', onClick: () => mark('revision') }),
            btn('I understood', { icon: 'check', variant: 'success', onClick: () => mark('understood') })],
          btn('Next', { icon: 'arrow-right', onClick: () => { S.i++; S.revealed = false; show(); } })),
        h('p', { class: 'xs muted center', style: { marginTop: '10px' } }, 'Tip: read the question, say the answer to yourself, then check it.'));
      const focusEl = stage.querySelector('.btn-primary, .btn-success');
      if (focusEl && S.i > 0 && S.revealed === false) focusEl.focus({ preventScroll: true });
    }

    async function mark(result) {
      const c = S.cards[S.i];
      try {
        const updated = await api.post(`/api/flashcards/${c.id}/review`, { result });
        S.cards[S.i] = updated;
        S.res[result === 'understood' ? 'understood' : 'revision']++;
        if (result === 'revision' && !S.requeued.has(c.id)) { S.requeued.add(c.id); S.cards.push(updated); }
        emit('data:flashcards'); emit('data:activity'); emit('data:vocab');
        S.i++; S.revealed = false; show();
      } catch (e) { toast(errText(e), 'error'); }
    }
    show();
  }

  // ----------------------------------------------------------------- all
  async function allCards() {
    const search = h('input', { type: 'search', placeholder: 'Search cards…', 'aria-label': 'Search flashcards' });
    let st = '';
    const list = h('div', { class: 'list' });
    const chips = h('div', { class: 'row wrap' });
    async function load() {
      let cards;
      try { cards = await api.get(`/api/flashcards${qs({ q: search.value.trim(), status: st })}`); } catch (e) { return clear(list).append(h('div', { class: 'alert error' }, errText(e))); }
      clear(chips);
      for (const [k, l] of [['', 'All'], ['new', 'New'], ['learning', 'Learning'], ['needs_revision', 'Needs Revision'], ['learned', 'Learned']]) chips.append(h('button', { type: 'button', class: `chip ${st === k ? 'is-on' : ''}`, 'aria-pressed': String(st === k), onClick: () => { st = k; load(); } }, l));
      clear(list);
      if (!cards.length) return list.append(emptyState('layers', 'No flashcards match.'));
      for (const c of cards) {
        list.append(h('article', { class: 'item', style: { alignItems: 'flex-start' } }, h('div', { class: 'body' }, h('span', { class: 't', style: { whiteSpace: 'normal' } }, c.front), h('span', { class: 's', style: { whiteSpace: 'pre-wrap' } }, c.back.length > 160 ? c.back.slice(0, 160) + '…' : c.back), h('span', { class: 'row wrap', style: { marginTop: '6px' } }, h('span', { class: `badge ${STATUS_BADGE[c.status]}` }, STATUS_LABEL[c.status]), h('span', { class: 'xs muted' }, `Next review: ${friendlyEventDate(c.dueDate)} · reviewed ${c.reviewCount || 0}×`))),
          h('span', { class: 'row' }, btn('Edit', { icon: 'pencil', size: 'xs', onClick: () => cardModal(c, load) }), btn('Delete', { icon: 'trash-2', size: 'xs', variant: 'danger', onClick: async () => {
            if (!(await confirmDialog({ title: 'Delete this flashcard?', message: 'Its review history will be deleted too.', confirmText: 'Delete', danger: true }))) return;
            try { await api.del(`/api/flashcards/${c.id}`); emit('data:flashcards'); load(); } catch (e) { toast(errText(e), 'error'); }
          } }))));
      }
    }
    search.addEventListener('input', debounce(load, 250));
    clear(content).append(h('div', { class: 'toolbar-row' }, h('div', { class: 'search-field' }, icon('search'), search), btn('New card', { icon: 'plus', variant: 'primary', onClick: () => cardModal(null, load) }), btn('Generate with AI', { icon: 'sparkles', onClick: () => openFlashcardGenerator() }), btn('From my vocabulary', { icon: 'book-a', onClick: async () => { try { const r = await api.post('/api/flashcards/from-vocabulary', {}); toast(r.created ? `${r.created} cards created.` : 'All your words already have cards.', 'success'); load(); } catch (e) { toast(errText(e), 'error'); } } })), chips, h('div', { style: { height: '12px' } }), list);
    load();
  }

  function draw() { if (tab === 'study') study(); else allCards(); }
  root.append(h('div', { class: 'view-title' }, tile('layers'), h('div', null, h('h1', null, 'Flashcards'), h('div', { class: 'sub' }, 'Flip, think, and mark what you understood. Cards you find hard come back sooner.'))), tabs, h('div', { style: { height: '14px' } }), content);
  drawTabs();
  onDispose(on('data:flashcards-new', draw));
  draw();
  return root;
}
