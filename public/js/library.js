/** My Library: uploaded study documents, and the reader where the student chooses what to explain. */
import { api, qs } from './api.js';
import { h, icon, tile, btn, toast, modal, confirmDialog, clear, emit, on, num, fmtBytes, friendlyDate, errText, emptyState, debounce } from './ui.js';
import { go, onDispose, maxInput, aiConfigured } from './state.js';
import { explainText, MODES } from './tutor.js';
import { openFlashcardGenerator } from './flashcards.js';
import { openQuizGenerator } from './quizzes.js';

const ALLOWED = ['.pdf', '.docx', '.png', '.jpg', '.jpeg', '.webp'];
const KIND_ICON = { pdf: 'file-text', docx: 'file-type', image: 'image' };
const KIND_LABEL = { pdf: 'PDF', docx: 'Word', image: 'Image' };
const METHOD_LABEL = { 'pdf-text': 'Text read from the PDF', 'docx-text': 'Text read from the Word file', ocr: 'Text read from the image (OCR)', manual: 'Text typed by you', none: 'No text yet' };

export async function uploadDocument(file) {
  const ext = '.' + (file.name.split('.').pop() || '').toLowerCase();
  if (!ALLOWED.includes(ext)) throw new Error('That file type is not supported. Please choose a PDF, a Word (.docx) file, or an image (PNG, JPG, WEBP).');
  return api.upload('/api/documents', file);
}

// -------------------------------------------------------------------- reader
export async function openReader(id) {
  let doc;
  try {
    doc = await api.get(`/api/documents/${id}`);
  } catch (e) {
    return toast(errText(e), 'error');
  }
  const hasPages = !!doc.pages;
  let page = 0;
  let selected = '';
  let editing = doc.status === 'needs_text';
  let plain = hasPages ? null : doc.text || '';

  const ta = h('textarea', { class: 'reader-text', rows: '14', readOnly: !editing, 'aria-label': 'Document text. Select the part you want MITRA to explain.', onSelect: grab, onMouseup: grab, onKeyup: grab, onTouchend: grab, onInput: () => { grab(); } });
  const selInfo = h('div', { class: 'small muted', 'aria-live': 'polite' });
  const modeSel = h('select', { 'aria-label': 'Explain as' }, MODES.filter(([v]) => v !== 'term' && v !== 'concept').map(([v, l]) => h('option', { value: v }, l)));
  const pageBar = h('div', { class: 'row wrap', style: { marginBottom: '8px' } });
  const statusBox = h('div');
  const explainBtn = btn('Explain', { icon: 'sparkles', variant: 'primary', onClick: () => doExplain() });
  const cardBtn = btn('Make flashcards', { icon: 'layers', onClick: () => { m.close(); openFlashcardGenerator(currentSource()); } });
  const quizBtn = btn('Make a quiz', { icon: 'clipboard-check', onClick: () => { m.close(); openQuizGenerator(currentSource()); } });

  const pageText = () => (hasPages ? doc.pages[page] || '' : plain);
  const pageNo = () => (hasPages ? page + 1 : null);

  function grab() {
    selected = ta.value.slice(ta.selectionStart, ta.selectionEnd).trim();
    updateInfo();
  }

  function usable() {
    const t = selected || pageText().trim();
    return t;
  }

  function currentSource() {
    if (selected) return { text: selected };
    return hasPages ? { documentId: doc.id, page: page + 1 } : { documentId: doc.id };
  }

  function updateInfo() {
    const t = usable();
    const over = t.length > maxInput();
    explainBtn.textContent = '';
    explainBtn.append(icon('sparkles', 'sm'), selected ? 'Explain selected text' : hasPages ? 'Explain this page' : 'Explain this text');
    explainBtn.disabled = !t || over;
    cardBtn.disabled = !t;
    quizBtn.disabled = !t;
    selInfo.textContent = !t ? 'There is no text to explain yet.' : selected ? `Selected: ${num(selected.length)} characters${over ? ` (too long, the limit is ${num(maxInput())})` : ''}.` : over ? `This ${hasPages ? 'page' : 'text'} has ${num(t.length)} characters; the limit is ${num(maxInput())}. Select a smaller part with your mouse or finger.` : `Nothing selected: MITRA will use the whole ${hasPages ? 'page' : 'text'} (${num(t.length)} characters). Select part of it to explain less.`;
  }

  function doExplain() {
    const text = usable();
    if (!text) return;
    if (!aiConfigured()) return toast('Online AI is not set up yet. Open Settings → Online AI.', 'info');
    m.close();
    explainText({ text, mode: modeSel.value, documentId: doc.id, docTitle: doc.title, page: pageNo() });
  }

  function drawPage() {
    ta.value = pageText();
    ta.scrollTop = 0;
    selected = '';
    clear(pageBar);
    if (hasPages) {
      const sel = h('select', { 'aria-label': 'Go to page', style: { width: 'auto' }, onChange: () => { page = Number(sel.value); drawPage(); } }, doc.pages.map((_, i) => h('option', { value: i, selected: i === page }, `Page ${i + 1} of ${doc.pages.length}`)));
      pageBar.append(btn('Previous', { icon: 'chevron-left', size: 'sm', disabled: page === 0, onClick: () => { page--; drawPage(); } }), sel, btn('Next', { icon: 'chevron-right', size: 'sm', disabled: page >= doc.pages.length - 1, onClick: () => { page++; drawPage(); } }));
    }
    updateInfo();
  }

  function drawStatus() {
    clear(statusBox);
    if (doc.status === 'needs_text') {
      const retry = doc.kind === 'image' ? btn('Try reading the image again', { size: 'xs', onClick: async () => {
        try { const r = await api.post(`/api/documents/${doc.id}/ocr`); if (r.ok) { m.close(); openReader(doc.id); } else toast(r.reason, 'info', 8000); } catch (e) { toast(errText(e), 'error'); }
      } }) : null;
      statusBox.append(h('div', { class: 'alert warn', role: 'status', style: { marginBottom: '10px' } }, icon('triangle-alert'), h('div', null, doc.statusDetail || 'MITRA could not read text from this file.', h('div', { class: 'small', style: { marginTop: '4px' } }, 'You can type or paste the text below and press “Save text”. The original file stays in your library.')), retry ? h('div', { class: 'actions' }, retry) : null));
      statusBox.append(btn('Save text', { icon: 'save', variant: 'primary', size: 'sm', onClick: async () => {
        try { await api.put(`/api/documents/${doc.id}/text`, { text: ta.value }); toast('Text saved.', 'success'); emit('data:documents'); m.close(); openReader(doc.id); } catch (e) { toast(errText(e), 'error'); }
      } }));
    } else if (!hasPages) {
      statusBox.append(h('div', { class: 'row', style: { marginBottom: '8px' } }, btn(editing ? 'Stop editing' : 'Fix or edit the text', { icon: 'pencil', size: 'xs', onClick: () => { editing = !editing; ta.readOnly = !editing; drawStatus(); } }), editing ? btn('Save text', { icon: 'save', variant: 'primary', size: 'xs', onClick: async () => {
        try { await api.put(`/api/documents/${doc.id}/text`, { text: ta.value }); plain = ta.value; editing = false; ta.readOnly = true; toast('Text saved.', 'success'); drawStatus(); updateInfo(); } catch (e) { toast(errText(e), 'error'); }
      } }) : null));
    }
  }

  const body = h('div', null,
    h('div', { class: 'row wrap', style: { marginBottom: '10px' } },
      h('span', { class: 'badge' }, KIND_LABEL[doc.kind]), doc.pageCount ? h('span', { class: 'badge grey' }, `${doc.pageCount} page${doc.pageCount > 1 ? 's' : ''}`) : null,
      h('span', { class: 'small muted' }, `${METHOD_LABEL[doc.method] || ''} · ${fmtBytes(doc.sizeBytes)} · added ${friendlyDate(doc.createdAt)}`),
      h('span', { class: 'grow' }),
      h('a', { class: 'btn btn-sm', href: `/api/documents/${doc.id}/file`, target: '_blank', rel: 'noopener' }, icon('external-link', 'sm'), 'Open original'),
      h('a', { class: 'btn btn-sm', href: `/api/documents/${doc.id}/file?download=1` }, icon('download', 'sm'), 'Download')),
    statusBox, pageBar, ta, selInfo,
    h('div', { class: 'row wrap', style: { marginTop: '12px' } }, h('label', { class: 'small' }, 'Explain as: '), modeSel, explainBtn, cardBtn, quizBtn),
    h('p', { class: 'privacy-line' }, icon('shield-check', 'sm'), 'Only the text you select (or the page shown, if you select nothing) is sent to the online AI, and only when you press a button above.')
  );
  const m = modal({ title: doc.title, size: 'wide', body, actions: [] });
  drawStatus();
  drawPage();
}

// ---------------------------------------------------------------------- view
export function createLibraryView() {
  const wrap = h('div');
  const list = h('div', { class: 'grid-cards' });
  const search = h('input', { type: 'search', placeholder: 'Search your documents…', 'aria-label': 'Search documents' });
  const fileIn = h('input', { type: 'file', multiple: true, accept: ALLOWED.join(','), hidden: true, onChange: () => { upload([...fileIn.files]); fileIn.value = ''; } });
  const drop = h('div', { class: 'drop', onDragover: (e) => { e.preventDefault(); drop.classList.add('over'); }, onDragleave: () => drop.classList.remove('over'), onDrop: (e) => { e.preventDefault(); drop.classList.remove('over'); upload([...e.dataTransfer.files]); } },
    icon('file-up', 'lg'), h('p', null, h('strong', null, 'Drop PDF, Word or image files here'), ' or choose them from your computer.'),
    btn('Choose files', { icon: 'upload', variant: 'primary', onClick: () => fileIn.click() }), fileIn,
    h('p', { class: 'xs muted', style: { marginTop: '10px' } }, 'Files are copied into MITRA’s own folder on this computer. Nothing is uploaded to the internet.'));

  async function upload(files) {
    for (const f of files) {
      try {
        toast(`Reading “${f.name}”…`, 'info', 2500);
        const d = await uploadDocument(f);
        emit('data:documents'); emit('data:activity');
        if (d.status === 'needs_text') toast(`“${d.title}” was saved, but no text could be read from it. Open it to add the text yourself.`, 'info', 8000);
        else toast(`“${d.title}” added.`, 'success');
      } catch (e) { toast(`${f.name}: ${errText(e)}`, 'error'); }
    }
    load();
  }

  async function load() {
    let docs;
    try { docs = await api.get(`/api/documents${qs({ q: search.value.trim() })}`); } catch (e) { return clear(list).append(h('div', { class: 'alert error' }, errText(e))); }
    clear(list);
    if (!docs.length) return list.append(emptyState('library', search.value ? 'No documents match your search.' : 'Your library is empty. Add your first lecture notes above.'));
    for (const d of docs) {
      list.append(h('article', { class: 'card doc-card' },
        h('div', { class: 'row' }, tile(KIND_ICON[d.kind]), h('div', { class: 'grow' }, h('h3', null, d.title), h('div', { class: 'xs muted' }, `${KIND_LABEL[d.kind]} · ${fmtBytes(d.sizeBytes)}${d.pageCount ? ` · ${d.pageCount} p.` : ''} · ${friendlyDate(d.createdAt, false)}`))),
        d.status === 'needs_text' ? h('span', { class: 'badge orange' }, 'Needs text') : h('span', { class: 'badge green' }, `${num(d.textLength)} characters read`),
        h('div', { class: 'row wrap' },
          btn('Open', { icon: 'eye', variant: 'primary', size: 'sm', onClick: () => openReader(d.id) }),
          btn('Rename', { icon: 'pencil', size: 'sm', onClick: () => rename(d) }),
          btn('Delete', { icon: 'trash-2', size: 'sm', variant: 'danger', onClick: () => remove(d) }))));
    }
  }

  function rename(d) {
    const input = h('input', { type: 'text', value: d.title, maxlength: '120', 'aria-label': 'Document title' });
    const m = modal({ title: 'Rename document', size: 'narrow', body: h('div', { class: 'field' }, input), actions: [btn('Cancel', { onClick: () => m.close() }), btn('Save', { variant: 'primary', onClick: async () => { try { await api.patch(`/api/documents/${d.id}`, { title: input.value }); m.close(); load(); } catch (e) { toast(errText(e), 'error'); } } })] });
    input.select();
  }

  async function remove(d) {
    const ok = await confirmDialog({ title: 'Delete this document?', message: `“${d.title}” and its extracted text will be deleted from this computer. Notes and flashcards that came from it are kept. This cannot be undone.`, confirmText: 'Delete document', danger: true });
    if (!ok) return;
    try { await api.del(`/api/documents/${d.id}`); toast('Document deleted.', 'success'); emit('data:documents'); load(); } catch (e) { toast(errText(e), 'error'); }
  }

  search.addEventListener('input', debounce(load, 250));
  wrap.append(h('div', { class: 'view-title' }, tile('library'), h('div', null, h('h1', null, 'My Library'), h('div', { class: 'sub' }, 'Your lecture PDFs, Word files and photos of notes, kept on this computer.'))), drop, h('div', { class: 'toolbar-row mt' }, h('div', { class: 'search-field' }, icon('search'), search)), list);
  onDispose(on('data:documents', load));
  load();
  return wrap;
}
