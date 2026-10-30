/**
 * MITRA AI Tutor: conversation interface (used on the Home dashboard and as a full view).
 * Conversations are stored in SQLite; reopening one never calls the AI again.
 * A message is only saved after the AI answered, so a failed request leaves the typed text in place.
 */
import { api } from './api.js';
import { h, icon, tile, orb, btn, iconBtn, toast, modal, confirmDialog, renderMarkdown, markdownToNoteHtml, htmlToText, clear, emit, on, num, errText, friendlyDate, emptyState } from './ui.js';
import { state, go, onDispose, maxInput, aiConfigured } from './state.js';
import { openReader, uploadDocument } from './library.js';
import { openFlashcardGenerator } from './flashcards.js';
import { showPrivacyNotice } from './privacy.js';
import { lastNoteId } from './notes.js';

export const MODES = [
  ['full', 'Full explanation'],
  ['simple_english', 'Simple English'],
  ['tamil', 'Tamil explanation'],
  ['sentence_by_sentence', 'Sentence by sentence'],
  ['terminology', 'Psychology terminology'],
  ['everyday_example', 'Everyday examples'],
  ['main_idea', 'Main idea'],
  ['compare', 'Compare concepts'],
  ['revision_summary', 'Revision summary'],
  ['concept', 'Help me with a concept'],
  ['term', 'Meaning of a term'],
];
const MODE_LABEL = Object.fromEntries(MODES);

const DEFAULT_PLACEHOLDER = 'Type your question or paste a paragraph…';
const S = { convId: null, title: 'New conversation', messages: [], pending: null, sending: false, error: null, draft: '', mode: 'full', attached: null, placeholder: null };
let active = null;
let queuedSend = false;

// ---------------------------------------------------------------- public API
/** Put text in the composer (and optionally a mode). Nothing is sent until the student presses Send. */
export function prefillTutor(text, mode) {
  S.draft = text || '';
  if (mode) S.mode = mode;
  if (active) {
    active.sync();
    active.focus();
  } else go('tutor');
}

/** Student explicitly asked to explain this text (e.g. from the document reader): send now. */
export function explainText({ text, mode = 'full', documentId = null, docTitle = '', page = null }) {
  S.draft = text;
  S.mode = mode;
  S.attached = documentId ? { id: documentId, title: docTitle, page } : null;
  if (active) {
    active.sync();
    active.send();
  } else {
    queuedSend = true;
    go('tutor');
  }
}

export function resetConversation() {
  Object.assign(S, { convId: null, title: 'New conversation', messages: [], pending: null, error: null });
}

async function openConversation(id) {
  const c = await api.get(`/api/conversations/${id}`);
  Object.assign(S, { convId: c.id, title: c.title, messages: c.messages, pending: null, error: null });
}

// ------------------------------------------------------------------- view
export function createTutor({ full = false, routeConvId = null } = {}) {
  const msgs = h('div', { class: 'msgs', role: 'log', 'aria-live': 'polite', 'aria-label': 'Conversation with MITRA', tabindex: '0' });
  const errorBox = h('div', { class: 'msg-error' });
  const attachedBox = h('div');
  const modeSel = h('select', { id: `mode-${full ? 'f' : 'h'}`, 'aria-label': 'Explain as', onChange: () => { S.mode = modeSel.value; } }, MODES.map(([v, l]) => h('option', { value: v }, l)));
  const counter = h('span', { class: 'counter', 'aria-live': 'off' });
  const ta = h('textarea', {
    id: `ask-${full ? 'f' : 'h'}`, rows: '2', 'aria-label': 'Your question or paragraph',
    onInput: () => { S.draft = ta.value; updateCounter(); },
    onKeydown: (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send();
      }
    },
  });
  const sendBtn = h('button', { type: 'button', class: 'send-btn', 'aria-label': 'Send to MITRA', title: 'Send (Enter)', onClick: () => send() }, icon('send', 'lg'));
  const disclosure = h('p', { class: 'privacy-line' });
  const convBar = h('div', { class: 'convbar' });
  const statusPill = h('span', { class: 'pill-online' });

  function fileInput(accept, label, ic, text) {
    const input = h('input', { type: 'file', accept, hidden: true, 'aria-hidden': 'true', tabindex: '-1', onChange: async () => { const f = input.files[0]; input.value = ''; if (f) await handleFile(f); } });
    const b = h('button', { type: 'button', class: 'attach', 'aria-label': label, onClick: () => input.click() }, tile(ic), text);
    return { input, b };
  }
  const attach = fileInput('.pdf,.docx,.png,.jpg,.jpeg,.webp', 'Attach a file (PDF, Word or image)', 'paperclip', 'Attach');
  const attImg = fileInput('.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp', 'Attach an image', 'image', 'Image');
  const attPdf = fileInput('.pdf,application/pdf', 'Attach a PDF', 'file-text', 'PDF');
  const attDoc = fileInput('.docx', 'Attach a Word document', 'file-type', 'Word');

  async function handleFile(file) {
    try {
      toast(`Reading “${file.name}”…`, 'info', 2500);
      const doc = await uploadDocument(file);
      emit('data:documents');
      openReader(doc.id);
    } catch (e) {
      toast(errText(e), 'error');
    }
  }

  // --------------------------------------------------------------- quick actions
  async function pickNote() {
    const notes = await api.get('/api/notes?limit=200').catch(() => []);
    if (!notes.length) return toast('You have no notes yet. Write one in the Notepad first.', 'info');
    const m = modal({
      title: 'Simplify which note?',
      body: h('div', { class: 'stack' }, h('p', { class: 'muted small' }, 'MITRA will put the note text in the box so you can check it. Nothing is sent until you press Send.'), h('div', { class: 'list' }, notes.map((n) => h('button', { type: 'button', class: 'item', onClick: async () => {
        m.close();
        const full = await api.get(`/api/notes/${n.id}`);
        const text = htmlToText(full.content);
        if (!text) return toast('That note is empty.', 'info');
        S.draft = text;
        S.mode = 'simple_english';
        S.attached = null;
        sync();
        focus();
        if (text.length > maxInput()) toast(`This note is long (${num(text.length)} characters). Please keep the part you want explained; the limit is ${num(maxInput())}.`, 'info', 8000);
      } }, tile('notebook-pen'), h('span', { class: 'body' }, h('span', { class: 't' }, n.title || 'Untitled note'), h('span', { class: 's' }, n.snippet || 'Empty note')))))),
      actions: [],
    });
  }

  function guide(mode, placeholder, ready = true) {
    S.mode = mode;
    S.placeholder = placeholder;
    sync();
    if (ready && S.draft.trim()) return send();
    focus();
  }

  const QUICK = [
    ['pencil', 'Explain this paragraph', () => guide('full', 'Paste the paragraph you want explained…')],
    ['message-circle', 'Simplify my notes', pickNote],
    ['file-text', 'What does this term mean?', () => guide('term', 'Type a word or term, e.g. cognitive dissonance')],
    ['layers', 'Create a flashcard', () => openFlashcardGenerator({ text: S.draft.trim() || undefined })],
    ['circle-help', 'Help me with a concept', () => guide('concept', 'Which concept is confusing? e.g. operant conditioning')],
    ['upload', 'Upload a file', () => attach.input.click()],
  ];
  const quick = h('div', { class: 'quick-grid' }, QUICK.map(([ic, label, fn]) => h('button', { type: 'button', class: 'quick', onClick: fn }, tile(ic), label)));

  // ----------------------------------------------------------------- rendering
  function welcome() {
    return h('div', { class: 'bubble-row' }, orb('sm'), h('div', { class: 'bubble ai' }, h('p', null, 'Hello! I’m MITRA. 💜'), h('p', null, 'I’m here to help you understand difficult psychology concepts, explore English terminology, and make your learning journey easier.'), h('p', null, h('strong', null, 'How can I help you today?'))));
  }

  function actionButtons(m, i) {
    const row = h('div', { class: 'meta' });
    const tag = m.origin === 'cache' ? 'Saved copy · no new AI request' : m.origin === 'local' ? 'From your MITRA dictionary' : 'AI-generated · check against your notes';
    row.append(h('span', { class: 'tag' }, tag));
    if (m.explanation_id) {
      row.append(btn(m.saved ? 'Saved' : 'Save', { icon: m.saved ? 'bookmark-check' : 'bookmark', size: 'xs', variant: m.saved ? 'primary' : '', onClick: async () => {
        try {
          const r = await api.patch(`/api/explanations/${m.explanation_id}`, { saved: !m.saved });
          S.messages.forEach((x) => { if (x.explanation_id === m.explanation_id) x.saved = r.saved; });
          renderMessages(false);
          toast(r.saved ? 'Explanation saved. It stays even if you delete this conversation.' : 'Explanation un-saved.', 'success');
        } catch (e) { toast(errText(e), 'error'); }
      } }));
    }
    if (m.term_id) row.append(btn('Open in dictionary', { icon: 'book-open', size: 'xs', onClick: () => go(`dictionary/${m.term_id}`) }));
    row.append(btn('Copy', { icon: 'copy', size: 'xs', onClick: async () => { try { await navigator.clipboard.writeText(m.content); toast('Copied.', 'success', 1800); } catch (_) { toast('Could not copy automatically. Select the text and press Ctrl+C.', 'info'); } } }));
    row.append(btn('Save as note', { icon: 'notebook-pen', size: 'xs', onClick: async () => {
      const prev = S.messages[i - 1];
      try {
        const n = await api.post('/api/notes', { title: (prev?.content || 'MITRA explanation').replace(/\s+/g, ' ').slice(0, 60), content: markdownToNoteHtml(m.content) });
        emit('data:notes');
        toast('Saved as a note in My Notes.', 'success');
        lastNoteId(n.id);
      } catch (e) { toast(errText(e), 'error'); }
    } }));
    if (!m.term_id) {
      row.append(btn('Flashcards', { icon: 'layers', size: 'xs', onClick: () => openFlashcardGenerator({ text: S.messages[i - 1]?.content || m.content }) }));
      if (S.messages[i - 1]) row.append(btn('Regenerate', { icon: 'refresh-cw', size: 'xs', onClick: () => regenerate(i) }));
    }
    return row;
  }

  function renderMessages(scroll = true) {
    clear(msgs).append(welcome());
    S.messages.forEach((m, i) => {
      if (m.role === 'user') {
        msgs.append(h('div', { class: 'bubble-row user' }, h('div', { class: 'bubble user' }, m.source_label ? h('div', { class: 'src' }, `📄 ${m.source_label}`) : null, m.mode && m.mode !== 'full' ? h('div', { class: 'src' }, `Explain as: ${MODE_LABEL[m.mode] || m.mode}`) : null, m.content.length > 700 ? m.content.slice(0, 700) + '…' : m.content)));
      } else {
        msgs.append(h('div', { class: 'bubble-row' }, orb('sm'), h('div', { class: 'bubble ai' }, renderMarkdown(m.content), actionButtons(m, i))));
      }
    });
    if (S.pending) {
      msgs.append(h('div', { class: 'bubble-row user' }, h('div', { class: 'bubble user', style: { opacity: '.75' } }, S.pending.text.length > 700 ? S.pending.text.slice(0, 700) + '…' : S.pending.text)));
      msgs.append(h('div', { class: 'bubble-row' }, orb('sm'), h('div', { class: 'bubble ai', role: 'status' }, h('span', { class: 'dots', 'aria-label': 'MITRA is thinking' }, h('i'), h('i'), h('i')), h('span', { class: 'small muted', style: { marginLeft: '10px' } }, 'MITRA is thinking…'))));
    }
    if (scroll) requestAnimationFrame(() => { msgs.scrollTop = msgs.scrollHeight; });
  }

  function renderError() {
    clear(errorBox);
    if (!S.error) return;
    const e = S.error;
    const actions = h('div', { class: 'actions' });
    if (e.code === 'ai_not_configured') actions.append(btn('Open Settings', { size: 'xs', onClick: () => go('settings') }));
    else if (e.canRetry) actions.append(btn('Retry', { icon: 'refresh-cw', size: 'xs', onClick: () => send() }));
    actions.append(btn('Dismiss', { size: 'xs', variant: 'ghost', onClick: () => { S.error = null; renderError(); } }));
    errorBox.append(h('div', { class: 'alert error', role: 'alert' }, icon('triangle-alert'), h('div', null, e.message, h('div', { class: 'xs', style: { marginTop: '4px' } }, 'Your text is still in the box below, nothing was lost.')), actions));
  }

  function updateCounter() {
    const n = ta.value.length;
    counter.textContent = n ? `${num(n)} / ${num(maxInput())}` : '';
    counter.classList.toggle('over', n > maxInput());
  }

  function renderAttached() {
    clear(attachedBox);
    if (!S.attached) return;
    attachedBox.append(h('div', { class: 'attached' }, icon('file-text', 'sm'), h('span', { class: 'grow' }, `${S.attached.title}${S.attached.page ? `, page ${S.attached.page}` : ''}`), btn('Open', { size: 'xs', onClick: () => openReader(S.attached.id) }), iconBtn('x', 'Remove the document from this question', () => { S.attached = null; renderAttached(); })));
  }

  function renderDisclosure() {
    const ai = state.settings.ai;
    clear(disclosure).append(icon('shield-check', 'sm'));
    if (!ai.configured) disclosure.append(h('span', null, 'Online AI is not set up yet, so MITRA can’t explain new text. Your saved dictionary, notes and flashcards still work. ', h('a', { href: '#/settings' }, 'Set up AI')));
    else disclosure.append(h('span', null, `Text you send is processed online by ${ai.provider}. Saved answers stay on this computer. `, h('a', { href: '#', onClick: (e) => { e.preventDefault(); showPrivacyNotice(); } }, 'Privacy')));
    const c = !navigator.onLine ? ['off', 'Offline'] : ai.configured ? ['', 'Online'] : ['warn', 'AI not set up'];
    statusPill.className = `pill-online ${c[0]}`.trim();
    statusPill.textContent = c[1];
  }

  function sync() {
    ta.value = S.draft;
    ta.placeholder = S.placeholder || DEFAULT_PLACEHOLDER;
    modeSel.value = S.mode;
    updateCounter();
    renderAttached();
  }
  const focus = () => ta.focus();

  // ------------------------------------------------------------------ actions
  async function send({ regenerate: regen = false, override } = {}) {
    if (S.sending) return;
    const text = (override?.text ?? S.draft).trim();
    const mode = override?.mode ?? S.mode;
    const att = override ? override.attached : S.attached;
    if (!text) { toast('Please type a question or paste some text first.', 'info'); return focus(); }
    if (text.length > maxInput()) {
      S.error = { message: `That text is ${num(text.length)} characters. One AI request can handle up to ${num(maxInput())}. Please select a smaller part.`, canRetry: false };
      return renderError();
    }
    if (!aiConfigured()) {
      S.error = { code: 'ai_not_configured', message: 'Online AI is not set up yet. Open Settings → Online AI to add your key. Everything you saved still works.' };
      return renderError();
    }
    if (!navigator.onLine) {
      S.error = { message: 'You appear to be offline. New explanations need the internet; saved ones are still here.', canRetry: true };
      return renderError();
    }
    S.sending = true;
    S.error = null;
    S.pending = { text };
    sendBtn.disabled = true;
    renderError();
    renderMessages();
    try {
      if (!S.convId) {
        const c = await api.post('/api/conversations', {});
        S.convId = c.id;
      }
      const r = await api.post(`/api/conversations/${S.convId}/messages`, { content: text, mode, documentId: att?.id, page: att?.page, regenerate: regen });
      S.messages.push(r.userMessage, r.assistantMessage);
      S.title = r.conversation.title;
      if (!override) {
        S.draft = '';
        S.attached = null;
        S.placeholder = null;
      }
      emit('data:conversations');
      emit('data:activity');
      emit('data:vocab-hint');
      if (r.assistantMessage.origin === 'cache') toast('You asked this before, so MITRA reused the saved answer (no new AI request). Use Regenerate for a fresh one.', 'info', 6000);
    } catch (e) {
      S.error = { code: e.code, message: errText(e), canRetry: e.code !== 'ai_not_configured' && e.code !== 'ai_input_too_long' && e.code !== 'ai_limit_reached' };
    } finally {
      S.sending = false;
      S.pending = null;
      sendBtn.disabled = false;
      sync();
      renderError();
      renderMessages();
      refreshConvBar();
    }
  }

  function regenerate(i) {
    const user = S.messages[i - 1];
    if (!user) return;
    const page = /, page (\d+)$/.exec(user.source_label || '');
    send({ regenerate: true, override: { text: user.content, mode: user.mode || 'full', attached: user.document_id ? { id: user.document_id, page: page ? Number(page[1]) : null } : null } });
  }

  // -------------------------------------------------------- conversation bar
  let convList = [];
  async function refreshConvBar() {
    if (!full) return;
    try { convList = await api.get('/api/conversations?limit=100'); } catch (_) { convList = []; }
    clear(convBar);
    const sel = h('select', { 'aria-label': 'Open a saved conversation', onChange: async () => {
      if (!sel.value) return;
      try { await openConversation(Number(sel.value)); history.replaceState(null, '', `#/tutor/${S.convId}`); renderMessages(); renderError(); }
      catch (e) { toast(errText(e), 'error'); }
    } }, h('option', { value: '' }, convList.length ? 'Open a saved conversation…' : 'No saved conversations yet'), convList.map((c) => h('option', { value: c.id, selected: c.id === S.convId }, `${c.title} · ${friendlyDate(c.updated_at, false)}`)));
    convBar.append(
      btn('New conversation', { icon: 'message-square-plus', size: 'sm', variant: 'primary', onClick: () => { resetConversation(); history.replaceState(null, '', '#/tutor'); sync(); renderMessages(); renderError(); refreshConvBar(); focus(); } }),
      sel
    );
    if (S.convId) {
      convBar.append(
        btn('Rename', { icon: 'pencil', size: 'sm', onClick: renameConv }),
        btn('Delete', { icon: 'trash-2', size: 'sm', variant: 'danger', onClick: deleteConv })
      );
    }
  }

  function renameConv() {
    const input = h('input', { type: 'text', value: S.title, maxlength: '100', 'aria-label': 'Conversation name' });
    const m = modal({ title: 'Rename conversation', size: 'narrow', body: h('div', { class: 'field' }, input), actions: [btn('Cancel', { onClick: () => m.close() }), btn('Save', { variant: 'primary', onClick: async () => {
      try { const c = await api.patch(`/api/conversations/${S.convId}`, { title: input.value }); S.title = c.title; m.close(); emit('data:conversations'); refreshConvBar(); }
      catch (e) { toast(errText(e), 'error'); }
    } })] });
    input.select();
  }

  async function deleteConv() {
    const ok = await confirmDialog({ title: 'Delete this conversation?', message: 'The messages in this conversation will be deleted from this computer. Explanations you marked as Saved are kept. This cannot be undone.', confirmText: 'Delete', danger: true });
    if (!ok) return;
    try {
      await api.del(`/api/conversations/${S.convId}`);
      resetConversation();
      history.replaceState(null, '', '#/tutor');
      emit('data:conversations');
      renderMessages(); refreshConvBar();
      toast('Conversation deleted.', 'success');
    } catch (e) { toast(errText(e), 'error'); }
  }

  // ------------------------------------------------------------------- assemble
  const card = h(
    'section',
    { class: `card tutor-card ${full ? 'full' : ''}`, 'aria-labelledby': 'tutor-title' },
    h('div', { class: 'tutor-head' }, orb(full ? '' : ''), h('div', { class: 'grow' }, h('h2', { id: 'tutor-title' }, 'MITRA AI Tutor'), h('div', { class: 'card-sub' }, 'Ask questions, get simple explanations, or upload your notes.')), statusPill),
    full ? convBar : null,
    msgs,
    errorBox,
    full ? h('div', { style: { margin: '10px 0' } }, h('div', { class: 'row wrap' }, QUICK.map(([ic, label, fn]) => h('button', { type: 'button', class: 'chip', onClick: fn }, icon(ic, 'sm'), label)))) : quick,
    h('div', { class: 'composer' },
      h('div', { class: 'mode-row' }, h('label', { for: modeSel.id }, 'Explain as:'), modeSel, counter),
      attachedBox, ta,
      h('div', { class: 'composer-bar' }, attach.b, attImg.b, attPdf.b, attDoc.b, attach.input, attImg.input, attPdf.input, attDoc.input, sendBtn)
    ),
    disclosure
  );

  const api2 = { sync, focus, send };
  active = api2;
  onDispose(() => { if (active === api2) active = null; });
  onDispose(on('settings', renderDisclosure));
  onDispose(on('connection', renderDisclosure));
  onDispose(on('open-conversation', async (id) => {
    try { await openConversation(id); sync(); renderMessages(); renderError(); refreshConvBar(); card.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    catch (e) { toast(errText(e), 'error'); }
  }));

  (async () => {
    if (routeConvId && routeConvId !== S.convId) {
      try { await openConversation(routeConvId); } catch (e) { toast(errText(e), 'error'); }
    }
    sync(); renderDisclosure(); renderMessages(); renderError(); refreshConvBar();
    if (queuedSend) { queuedSend = false; send(); }
  })();
  return card;
}
