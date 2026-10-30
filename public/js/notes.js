/**
 * Notepad. Notes live in SQLite (never browser storage).
 * Autosave is debounced, only one save is in flight at a time, "Saved" is only shown after the
 * server confirms, and a version counter protects against overwriting changes made in another tab.
 */
import { api, qs } from './api.js';
import { h, icon, tile, btn, toast, modal, confirmDialog, clear, emit, on, debounce, errText, fmtClock, friendlyDate, panel, emptyState } from './ui.js';
import { go, onDispose } from './state.js';

let remembered = null;
let activePad = null;
export const lastNoteId = (id) => {
  if (id !== undefined) remembered = id;
  return remembered;
};

window.addEventListener('beforeunload', (e) => {
  if (activePad && activePad.unsaved()) {
    e.preventDefault();
    e.returnValue = '';
  }
});

export function createNotepad({ full = false, routeNoteId = null } = {}) {
  let note = { id: null, version: null, documentId: null };
  let dirty = false;
  let saving = false;
  let timer = null;
  let state = 'idle'; // idle | saved | saving | unsaved | error
  let errorMsg = '';
  let lastSaved = null;
  let conflict = null;
  let disposed = false;

  const titleIn = h('input', { type: 'text', class: 'note-title', placeholder: 'Note Title…', 'aria-label': 'Note title', maxlength: '150', onInput: () => touch() });
  const editor = h('div', {
    class: 'editor', contenteditable: 'true', role: 'textbox', 'aria-multiline': 'true', 'aria-label': 'Note content', 'data-placeholder': 'Write your notes here…', spellcheck: 'true',
    onInput: () => touch(),
    onPaste: (e) => {
      e.preventDefault();
      const t = (e.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, t);
    },
  });
  const statusEl = h('div', { class: 'save-state', role: 'status', 'aria-live': 'polite' });
  const conflictBox = h('div');
  const docSel = h('select', { id: 'note-doc', 'aria-label': 'Linked source document', onChange: () => { note.documentId = docSel.value ? Number(docSel.value) : null; touch(true); } });
  const picker = h('select', { 'aria-label': 'Open one of your notes', onChange: () => picker.value && openNote(Number(picker.value)) });
  const noteSearch = h('input', { type: 'search', placeholder: 'Search notes…', 'aria-label': 'Search your notes', onInput: debounce(() => loadList(), 250) });
  const listEl = h('div', { class: 'list' });

  // ---------------------------------------------------------------- status
  function setStatus(s, msg = '') {
    state = s;
    errorMsg = msg;
    statusEl.className = `save-state ${s}`;
    clear(statusEl);
    statusEl.append(h('span', { class: 'd' }));
    const when = lastSaved ? `Last saved: ${fmtClock(lastSaved)}` : '';
    if (s === 'saving') statusEl.append('Saving…');
    else if (s === 'unsaved') statusEl.append('Unsaved changes…');
    else if (s === 'error') statusEl.append(`Not saved: ${msg}`, btn('Try again', { size: 'xs', onClick: () => save() }));
    else statusEl.append(h('span', null, 'Auto-save'), when ? h('span', { class: 'muted' }, ` · ${s === 'saved' ? 'Saved. ' : ''}${when}`) : null);
  }

  function touch(force = false) {
    dirty = true;
    if (!conflict) setStatus('unsaved');
    clearTimeout(timer);
    timer = setTimeout(save, force ? 100 : 1200);
  }

  const isEmpty = () => !titleIn.value.trim() && !editor.textContent.trim() && !editor.querySelector('li, a');

  async function save() {
    clearTimeout(timer);
    if (saving || conflict) return;
    if (!dirty) return;
    if (!note.id && isEmpty()) { dirty = false; return setStatus('idle'); }
    const title = titleIn.value.trim();
    const content = editor.innerHTML;
    saving = true;
    setStatus('saving');
    try {
      const body = { title, content, documentId: note.documentId };
      const r = note.id ? await api.put(`/api/notes/${note.id}`, { ...body, version: note.version }) : await api.post('/api/notes', body);
      const created = !note.id;
      note = { id: r.id, version: r.version, documentId: r.documentId };
      remembered = r.id;
      lastSaved = new Date();
      dirty = titleIn.value.trim() !== title || editor.innerHTML !== content; // typed during the request?
      setStatus(dirty ? 'unsaved' : 'saved');
      emit('data:notes');
      emit('data:activity');
      if (created && full && !disposed) history.replaceState(null, '', `#/notes/${r.id}`);
      if (full) loadList();
    } catch (e) {
      if (e.status === 409 && e.extra?.current) { conflict = e.extra.current; showConflict(); setStatus('error', 'this note was changed somewhere else'); }
      else setStatus('error', errText(e));
    } finally {
      saving = false;
      if (dirty && !conflict && state !== 'error' && !disposed) timer = setTimeout(save, 400);
    }
  }

  function showConflict() {
    clear(conflictBox).append(h('div', { class: 'alert warn', role: 'alert', style: { marginBottom: '10px' } }, icon('triangle-alert'),
      h('div', null, 'This note was changed somewhere else (maybe in another tab). Your changes are still here.'),
      h('div', { class: 'actions' },
        btn('Load the latest', { size: 'xs', onClick: () => { const c = conflict; conflict = null; clear(conflictBox); fill(c); } }),
        btn('Keep my version', { size: 'xs', variant: 'primary', onClick: () => { note.version = conflict.version; conflict = null; clear(conflictBox); dirty = true; save(); } }))));
  }

  // ------------------------------------------------------------ note actions
  function fill(n) {
    note = n ? { id: n.id, version: n.version, documentId: n.documentId } : { id: null, version: null, documentId: null };
    titleIn.value = n ? n.title : '';
    editor.innerHTML = n ? n.content : '';
    docSel.value = note.documentId || '';
    dirty = false;
    lastSaved = n ? new Date(n.updatedAt) : null;
    remembered = note.id;
    setStatus(n ? 'saved' : 'idle');
    if (full && !disposed) history.replaceState(null, '', note.id ? `#/notes/${note.id}` : '#/notes');
  }

  async function flush() {
    clearTimeout(timer);
    for (let i = 0; i < 5 && (saving || (dirty && !conflict && state !== 'error')); i++) {
      if (saving) await new Promise((r) => setTimeout(r, 150));
      else await save();
    }
  }

  async function openNote(id) {
    await flush();
    if (dirty && !(await confirmDialog({ title: 'Leave without saving?', message: 'Your latest changes could not be saved yet. If you open another note they will be lost.', confirmText: 'Open the other note', danger: true }))) { picker.value = note.id || ''; return; }
    try { conflict = null; clear(conflictBox); fill(await api.get(`/api/notes/${id}`)); if (full) loadList(); } catch (e) { toast(errText(e), 'error'); }
  }

  async function newNote() {
    await flush();
    if (dirty && !(await confirmDialog({ title: 'Start a new note?', message: 'Your latest changes could not be saved yet and would be lost.', confirmText: 'Start new note', danger: true }))) return;
    conflict = null; clear(conflictBox); fill(null); picker.value = ''; titleIn.focus();
  }

  async function cancelEdit() {
    if (!dirty) return toast('There are no unsaved changes to cancel.', 'info', 2500);
    if (!(await confirmDialog({ title: 'Discard your latest changes?', message: note.id ? 'The note will go back to the last saved version.' : 'This note has not been saved yet and will be cleared.', confirmText: 'Discard changes', danger: true }))) return;
    clearTimeout(timer); conflict = null; clear(conflictBox);
    if (note.id) { try { fill(await api.get(`/api/notes/${note.id}`)); } catch (e) { toast(errText(e), 'error'); } } else fill(null);
  }

  async function deleteNote() {
    if (!note.id) return;
    if (!(await confirmDialog({ title: 'Delete this note?', message: 'The note will be deleted from this computer. This cannot be undone.', confirmText: 'Delete note', danger: true }))) return;
    try { await api.del(`/api/notes/${note.id}`); toast('Note deleted.', 'success'); emit('data:notes'); fill(null); if (full) loadList(); } catch (e) { toast(errText(e), 'error'); }
  }

  async function loadList() {
    let notes = [];
    try { notes = await api.get(`/api/notes${qs({ q: noteSearch.value.trim(), limit: full ? 200 : 60 })}`); } catch (_) { /* leave */ }
    clear(picker).append(h('option', { value: '' }, notes.length ? 'Open a note…' : 'No notes yet'), notes.map((n) => h('option', { value: n.id, selected: n.id === note.id }, `${n.title || 'Untitled note'} · ${friendlyDate(n.updatedAt, false)}`)));
    if (!full) return;
    clear(listEl);
    if (!notes.length) return listEl.append(emptyState('notebook-pen', noteSearch.value ? 'No notes match your search.' : 'No notes yet. Start writing →'));
    for (const n of notes) {
      listEl.append(h('button', { type: 'button', class: 'item', 'aria-current': n.id === note.id ? 'true' : 'false', style: n.id === note.id ? { borderColor: 'var(--primary)', background: 'var(--lav)' } : null, onClick: () => openNote(n.id) },
        h('span', { class: 'body' }, h('span', { class: 't' }, n.title || 'Untitled note'), h('span', { class: 's' }, n.snippet || 'Empty note'), h('span', { class: 'xs muted' }, friendlyDate(n.updatedAt)))));
    }
  }

  async function loadDocs() {
    if (!full) return;
    const docs = await api.get('/api/documents').catch(() => []);
    clear(docSel).append(h('option', { value: '' }, 'None'), docs.map((d) => h('option', { value: d.id }, d.title)));
    docSel.value = note.documentId || '';
  }

  // ------------------------------------------------------------------ toolbar
  const fmt = (cmd, val) => { editor.focus(); document.execCommand(cmd, false, val); touch(); updateTb(); };
  async function addLink() {
    const sel = window.getSelection();
    const range = sel.rangeCount && editor.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
    const url = h('input', { type: 'url', placeholder: 'https://example.org', 'aria-label': 'Web address' });
    const m = modal({ title: 'Add a link', size: 'narrow', body: h('div', { class: 'field' }, h('label', { for: 'x' }, 'Web address'), url), actions: [btn('Cancel', { onClick: () => m.close() }), btn('Add link', { variant: 'primary', onClick: () => {
      let u = url.value.trim();
      if (!u) return;
      if (!/^(https?:\/\/|mailto:)/i.test(u)) u = 'https://' + u;
      try { new URL(u); } catch (_) { return toast('That does not look like a web address.', 'error'); }
      m.close(); editor.focus();
      if (range) { sel.removeAllRanges(); sel.addRange(range); }
      if (sel.isCollapsed) document.execCommand('insertHTML', false, `<a href="${u.replace(/"/g, '%22')}">${u.replace(/[<>&]/g, '')}</a>`);
      else document.execCommand('createLink', false, u);
      touch();
    } })] });
  }
  const TB = [
    ['heading-2', 'Heading', () => fmt('formatBlock', document.queryCommandValue('formatBlock').toLowerCase() === 'h2' ? 'p' : 'h2'), () => document.queryCommandValue('formatBlock').toLowerCase() === 'h2'],
    ['bold', 'Bold', () => fmt('bold'), () => document.queryCommandState('bold')],
    ['italic', 'Italic', () => fmt('italic'), () => document.queryCommandState('italic')],
    ['underline', 'Underline', () => fmt('underline'), () => document.queryCommandState('underline')],
    null,
    ['list', 'Bulleted list', () => fmt('insertUnorderedList'), () => document.queryCommandState('insertUnorderedList')],
    ['list-ordered', 'Numbered list', () => fmt('insertOrderedList'), () => document.queryCommandState('insertOrderedList')],
    ['link', 'Add link', addLink, () => false],
    null,
    ['eraser', 'Clear formatting', () => { fmt('removeFormat'); fmt('formatBlock', 'p'); }, () => false],
    ['undo-2', 'Undo', () => fmt('undo'), () => false],
  ];
  const tbButtons = TB.map((t) => (t ? h('button', { type: 'button', class: 'tb', 'aria-label': t[1], title: t[1], 'aria-pressed': 'false', onMousedown: (e) => e.preventDefault(), onClick: t[2] }, icon(t[0])) : h('span', { class: 'tb-sep' })));
  const toolbar = h('div', { class: 'toolbar', role: 'toolbar', 'aria-label': 'Text formatting' }, tbButtons);
  function updateTb() {
    if (!editor.contains(document.getSelection()?.anchorNode)) return;
    TB.forEach((t, i) => { if (t) { try { tbButtons[i].setAttribute('aria-pressed', String(!!t[3]())); } catch (_) { /* ignore */ } } });
  }
  const onSel = () => updateTb();
  document.addEventListener('selectionchange', onSel);

  // ------------------------------------------------------------------ assemble
  const saveBtn = btn('Save', { icon: 'save', variant: 'primary', onClick: () => { dirty = dirty || !note.id; save(); } });
  const foot = h('div', { class: 'note-foot' }, statusEl, h('div', { class: 'btns' }, btn('Cancel', { onClick: cancelEdit }), saveBtn));
  const editorArea = h('div', { class: `notepad ${full ? 'full' : ''}` },
    full ? null : h('div', { class: 'note-pick' }, noteSearch, picker),
    titleIn, toolbar, editor, conflictBox,
    full ? h('div', { class: 'field', style: { marginTop: '12px' } }, h('label', { for: 'note-doc' }, 'Linked source document'), docSel, h('span', { class: 'hint' }, 'Optional: remember which lecture file these notes came from.')) : null,
    foot,
    full ? h('div', { class: 'mt' }, btn('Delete this note', { icon: 'trash-2', variant: 'danger', size: 'sm', onClick: deleteNote })) : null);

  const pad = { unsaved: () => dirty || saving, flush };
  activePad = pad;
  onDispose(() => { disposed = true; if (activePad === pad) activePad = null; document.removeEventListener('selectionchange', onSel); clearTimeout(timer); if (dirty && !saving && !conflict) { disposed = false; save().finally(() => { disposed = true; }); } });
  onDispose(on('open-note', (id) => openNote(id)));
  onDispose(on('data:notes', () => { if (!saving) loadList(); }));

  let node;
  if (full) {
    node = h('div', { class: 'split' },
      h('aside', { class: 'card listpane', 'aria-label': 'Your notes' }, h('div', { class: 'row', style: { marginBottom: '12px' } }, btn('New Note', { icon: 'plus', variant: 'primary', onClick: newNote })), h('div', { class: 'search-field' }, icon('search'), noteSearch), listEl),
      h('section', { class: 'card', 'aria-label': 'Note editor' }, editorArea));
  } else {
    node = panel({ id: 'notepad-card', title: 'Notepad', iconName: 'notebook-pen', right: btn('New Note', { icon: 'plus', variant: 'primary', size: 'sm', onClick: newNote }), body: editorArea });
    node.querySelector('.card-head .btn')?.classList.add('card-link-btn');
  }

  setStatus('idle');
  (async () => {
    await loadDocs();
    await loadList();
    const target = routeNoteId || remembered;
    if (target) { try { fill(await api.get(`/api/notes/${target}`)); await loadList(); } catch (_) { remembered = null; } }
  })();
  return node;
}
