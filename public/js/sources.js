/**
 * "What should the AI read?" picker used by flashcard and quiz generation.
 * Only the chosen source is sent to the AI, and only when the student presses Generate.
 */
import { api } from './api.js';
import { h, clear, num } from './ui.js';
import { maxInput } from './state.js';

export function sourcePicker({ preset = {}, topicLabel = 'A topic (no notes needed)' } = {}) {
  const kinds = [
    ['note', 'A note'],
    ['document', 'A document'],
    ['text', 'Pasted text'],
    ['topic', topicLabel],
  ];
  let kind = preset.noteId ? 'note' : preset.documentId ? 'document' : preset.text ? 'text' : 'note';
  const pane = h('div');
  const tabs = h('div', { class: 'row wrap', role: 'radiogroup', 'aria-label': 'Where should MITRA read from?', style: { marginBottom: '12px' } });
  const els = { noteSel: null, docSel: null, page: null, text: null, topic: null };
  let notes = null;
  let docs = null;

  async function drawPane() {
    clear(pane);
    if (kind === 'note') {
      notes = notes || (await api.get('/api/notes?limit=300').catch(() => []));
      els.noteSel = h('select', { id: 'src-note', 'aria-label': 'Choose a note' }, h('option', { value: '' }, notes.length ? 'Choose a note…' : 'You have no notes yet'), notes.map((n) => h('option', { value: n.id, selected: String(preset.noteId) === String(n.id) }, n.title || 'Untitled note')));
      pane.append(h('div', { class: 'field' }, h('label', { for: 'src-note' }, 'Note'), els.noteSel));
    } else if (kind === 'document') {
      docs = docs || (await api.get('/api/documents').catch(() => []));
      const usable = docs.filter((d) => d.textLength > 0);
      els.page = h('input', { type: 'number', min: '1', id: 'src-page', placeholder: 'All', value: preset.page || '' });
      const pageField = h('div', { class: 'field', hidden: true }, h('label', { for: 'src-page' }, 'Page (optional)'), els.page, h('span', { class: 'hint' }, 'Choose one page to keep the request small.'));
      els.docSel = h('select', { id: 'src-doc', 'aria-label': 'Choose a document', onChange: () => { const d = usable.find((x) => String(x.id) === els.docSel.value); pageField.hidden = !(d && d.hasPages); } }, h('option', { value: '' }, usable.length ? 'Choose a document…' : 'No documents with readable text yet'), usable.map((d) => h('option', { value: d.id, selected: String(preset.documentId) === String(d.id) }, `${d.title}${d.pageCount ? ` (${d.pageCount} pages)` : ''}`)));
      pane.append(h('div', { class: 'field' }, h('label', { for: 'src-doc' }, 'Document'), els.docSel), pageField);
      els.docSel.dispatchEvent(new Event('change'));
    } else if (kind === 'text') {
      const counter = h('span', { class: 'counter' });
      els.text = h('textarea', { id: 'src-text', rows: '6', placeholder: 'Paste the paragraph or notes here…', onInput: () => { counter.textContent = `${num(els.text.value.length)} / ${num(maxInput())}`; counter.classList.toggle('over', els.text.value.length > maxInput()); } }, preset.text || '');
      pane.append(h('div', { class: 'field' }, h('label', { for: 'src-text' }, 'Text'), els.text, counter));
      els.text.dispatchEvent(new Event('input'));
    } else {
      els.topic = h('input', { type: 'text', id: 'src-topic', maxlength: '150', placeholder: 'e.g. Operant conditioning' });
      pane.append(h('div', { class: 'field' }, h('label', { for: 'src-topic' }, 'Topic'), els.topic, h('span', { class: 'hint' }, 'MITRA will use general textbook knowledge, not your notes. Please check the result against your own materials.')));
    }
  }

  function drawTabs() {
    clear(tabs);
    for (const [k, label] of kinds) {
      tabs.append(h('button', { type: 'button', class: `chip ${k === kind ? 'is-on' : ''}`, role: 'radio', 'aria-checked': String(k === kind), onClick: async () => { kind = k; drawTabs(); await drawPane(); } }, label));
    }
  }
  drawTabs();
  drawPane();

  return {
    el: h('div', null, tabs, pane, h('p', { class: 'privacy-line' }, 'Only this text is sent to the online AI, and only when you press the button below.')),
    /** Returns the request fields, or throws an Error with a friendly message. */
    get() {
      if (kind === 'note') {
        if (!els.noteSel?.value) throw new Error('Please choose a note.');
        return { noteId: Number(els.noteSel.value) };
      }
      if (kind === 'document') {
        if (!els.docSel?.value) throw new Error('Please choose a document.');
        const body = { documentId: Number(els.docSel.value) };
        if (els.page?.value) body.page = Number(els.page.value);
        return body;
      }
      if (kind === 'text') {
        const t = els.text.value.trim();
        if (!t) throw new Error('Please paste some text first.');
        if (t.length > maxInput()) throw new Error(`That text is too long (${num(t.length)} characters; the limit is ${num(maxInput())}). Please use a smaller part.`);
        return { text: t };
      }
      const topic = els.topic.value.trim();
      if (!topic) throw new Error('Please type a topic.');
      return { topic };
    },
    kind: () => kind,
  };
}
