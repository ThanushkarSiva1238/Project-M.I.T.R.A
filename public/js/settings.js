/** Settings: profile, theme, Online AI, privacy, and backup & restore. */
import { api } from './api.js';
import { h, icon, tile, btn, toast, modal, confirmDialog, clear, emit, errText, emptyState, friendlyDate } from './ui.js';
import { state, applyTheme, loadSettings } from './state.js';
import { showPrivacyNotice } from './privacy.js';

const PROVIDERS = [['anthropic', 'Anthropic (Claude)'], ['openai', 'OpenAI'], ['openai-compatible', 'Other (OpenAI-compatible)']];
const fmtSize = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const section = (title, ...kids) => h('section', { class: 'card settings-sec' }, h('h2', null, title), ...kids);
const field = (id, label, el, hint) => h('div', { class: 'field' }, h('label', { for: id }, label), el, hint ? h('div', { class: 'xs muted' }, hint) : null);

export function createSettingsView({ anchor = null } = {}) {
  const root = h('div');
  const ai = () => state.settings.ai;

  // ------------------------------------------------------------ profile
  function profile() {
    const name = h('input', { id: 'st-name', type: 'text', maxlength: '40', value: state.settings.displayName });
    const theme = h('select', { id: 'st-theme' }, [['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => h('option', { value: v, selected: state.settings.theme === v }, l)));
    return section('You & appearance', h('div', { class: 'form-grid' }, field('st-name', 'Your name (shown as “Hello, …”)', name), field('st-theme', 'Theme', theme)),
      btn('Save', { icon: 'save', variant: 'primary', onClick: async () => {
        try { state.settings = await api.put('/api/settings', { displayName: name.value, theme: theme.value }); applyTheme(); emit('settings'); toast('Saved.', 'success'); } catch (e) { toast(errText(e), 'error'); }
      } }));
  }

  // ------------------------------------------------------------------ AI
  function aiSection() {
    const a = ai();
    const provider = h('select', { id: 'st-prov' }, PROVIDERS.map(([v, l]) => h('option', { value: v, selected: a.provider === v }, l)));
    const model = h('input', { id: 'st-model', type: 'text', value: a.model || '', placeholder: 'Model name from your provider', autocomplete: 'off' });
    const base = h('input', { id: 'st-base', type: 'url', value: a.baseUrl || '', placeholder: 'https://… (only for “Other”)', autocomplete: 'off' });
    const key = h('input', { id: 'st-key', type: 'password', value: '', placeholder: a.hasKey ? 'A key is saved — leave blank to keep it' : 'Paste your API key', autocomplete: 'off' });
    const state1 = a.configured
      ? h('div', { class: 'alert success' }, icon('circle-check'), h('div', null, `Online AI is set up (${a.provider}${a.model ? ', ' + a.model : ''}).`))
      : h('div', { class: 'alert warn' }, icon('triangle-alert'), h('div', null, 'Online AI is not set up yet. Still missing: ', h('strong', null, (a.missing || []).join(', ') || 'a valid provider'), '. The dictionary, notes, vocabulary, calendar and revision tools work without it.'));
    return section('Online AI', state1,
      h('p', { class: 'small muted', style: { margin: '10px 0' } }, 'MITRA sends only the text you choose to the provider you pick here. The key is saved in the .env file on this computer, is never shown again, and is never sent to your browser.'),
      h('div', { class: 'form-grid' }, field('st-prov', 'Provider', provider), field('st-model', 'Model', model), h('div', { class: 'full' }, field('st-base', 'Base URL (optional)', base, 'Needed only for “Other” providers or a local server.')), h('div', { class: 'full' }, field('st-key', 'API key', key))),
      h('div', { class: 'row wrap' },
        btn('Save AI settings', { icon: 'save', variant: 'primary', onClick: async () => {
          const body = { provider: provider.value, model: model.value, baseUrl: base.value };
          if (key.value.trim()) body.apiKey = key.value.trim();
          try { state.settings = await api.put('/api/settings/ai', body); key.value = ''; emit('settings'); toast('AI settings saved.', 'success'); redraw(); } catch (e) { toast(errText(e), 'error'); }
        } }),
        a.hasKey ? btn('Remove saved key', { icon: 'trash-2', variant: 'danger', onClick: async () => {
          if (!(await confirmDialog({ title: 'Remove the saved API key?', message: 'Online AI will stop working until you add a key again.', confirmText: 'Remove key', danger: true }))) return;
          try { state.settings = await api.del('/api/settings/ai-key'); emit('settings'); toast('Key removed.', 'success'); redraw(); } catch (e) { toast(errText(e), 'error'); }
        } }) : null),
      h('dl', { class: 'kv', style: { marginTop: '14px' } }, h('dt', null, 'Used today'), h('dd', null, `${a.usedToday} of ${a.dailyLimit} AI requests`), h('dt', null, 'Time limit per request'), h('dd', null, `${Math.round(a.timeoutMs / 1000)} seconds`), h('dt', null, 'Longest text sent at once'), h('dd', null, `${a.maxInputChars} characters`)),
      h('p', { class: 'xs muted' }, 'These limits are set in the .env file (see the README).'));
  }

  function privacySection() {
    return section('Privacy & data', h('p', null, 'Everything you save stays in this folder on your computer:'), h('p', null, h('code', null, state.settings.app.dataDir)), h('div', { class: 'row wrap', style: { marginTop: '10px' } }, btn('Read the privacy notice', { icon: 'shield-check', onClick: () => showPrivacyNotice() })));
  }

  // -------------------------------------------------------------- backups
  function backupSection() {
    const listEl = h('div', { class: 'list' });
    const fileInput = h('input', { type: 'file', accept: '.zip', hidden: true });
    async function load() {
      try {
        const r = await api.get('/api/backups');
        clear(listEl);
        if (!r.backups.length) listEl.append(emptyState('archive-restore', 'No backups yet. Make one before big changes, and keep a copy somewhere safe (a USB drive, for example).'));
        for (const b of r.backups) {
          listEl.append(h('div', { class: 'item' }, h('span', { class: 'body' }, h('span', { class: 't' }, b.name), h('span', { class: 's' }, `${friendlyDate(b.createdAt)} · ${fmtSize(b.sizeBytes)}${b.kind === 'pre-restore' ? ' · automatic safety copy' : ''}`)),
            h('span', { class: 'row wrap' },
              h('a', { class: 'btn btn-xs', href: `/api/backups/${encodeURIComponent(b.name)}/download`, download: b.name }, icon('download', 'sm'), 'Download'),
              btn('Restore', { icon: 'archive-restore', size: 'xs', onClick: () => restore({ name: b.name }) }),
              btn('Delete', { icon: 'trash-2', size: 'xs', variant: 'danger', onClick: async () => {
                if (!(await confirmDialog({ title: 'Delete this backup?', message: b.name, confirmText: 'Delete', danger: true }))) return;
                try { await api.del(`/api/backups/${encodeURIComponent(b.name)}`); load(); } catch (e) { toast(errText(e), 'error'); }
              } }))));
        }
        dir.textContent = r.directory;
      } catch (e) { clear(listEl).append(h('div', { class: 'alert error' }, errText(e))); }
    }
    const dir = h('code');

    async function restore(src) {
      // Step 1: look inside without changing anything.
      let manifest;
      try {
        if (src.file) manifest = (await api.upload('/api/backups/inspect', src.file)).manifest; else manifest = (await api.post('/api/backups/inspect', { name: src.name })).manifest;
      } catch (e) { return toast(errText(e), 'error'); }
      const word = h('input', { type: 'text', id: 'rs-word', autocomplete: 'off', placeholder: 'Type RESTORE' });
      const go1 = btn('Replace my data with this backup', { variant: 'danger', icon: 'archive-restore', disabled: true });
      const m = modal({ title: 'Restore from backup?', size: 'narrow', body: h('div', { class: 'stack' },
        h('div', { class: 'alert warn' }, icon('triangle-alert'), h('div', null, h('strong', null, 'This replaces everything currently in MITRA '), '(notes, vocabulary, flashcards, quizzes, documents, settings). MITRA first saves an automatic safety copy of what you have now.')),
        h('dl', { class: 'kv' }, h('dt', null, 'Backup made'), h('dd', null, manifest.createdAt ? friendlyDate(manifest.createdAt) : 'unknown'), h('dt', null, 'MITRA version'), h('dd', null, String(manifest.appVersion || 'unknown')), h('dt', null, 'Contains'), h('dd', null, manifest.counts ? `${manifest.counts.notes} notes, ${manifest.counts.vocabulary} words, ${manifest.counts.flashcards} flashcards, ${manifest.counts.documents} documents` : 'unknown')),
        field('rs-word', 'To confirm, type RESTORE', word)), actions: [btn('Cancel', { onClick: () => m.close() }), go1] });
      word.addEventListener('input', () => { go1.disabled = word.value.trim() !== 'RESTORE'; });
      go1.addEventListener('click', async () => {
        go1.disabled = true;
        try {
          if (src.file) await api.upload('/api/backups/restore', src.file, { confirm: 'RESTORE' });
          else await api.post('/api/backups/restore', { confirm: 'RESTORE', name: src.name });
          m.close(); toast('Backup restored. Reloading…', 'success'); setTimeout(() => location.reload(), 900);
        } catch (e) { go1.disabled = false; toast(errText(e), 'error'); }
      });
    }

    fileInput.addEventListener('change', () => { const f = fileInput.files[0]; fileInput.value = ''; if (f) restore({ file: f }); });
    load();
    return h('section', { class: 'card settings-sec', id: 'backup' }, h('h2', null, 'Backup & restore'),
      h('p', { class: 'small muted' }, 'A backup is one .zip file with your database and uploaded documents. It does not contain your API key. Backups are saved in: ', dir),
      h('div', { class: 'row wrap', style: { margin: '12px 0' } },
        btn('Make a backup now', { icon: 'archive-restore', variant: 'primary', onClick: async () => { try { const r = await api.post('/api/backups', {}); toast(`Backup saved: ${r.name}`, 'success'); load(); } catch (e) { toast(errText(e), 'error'); } } }),
        btn('Restore from a file…', { icon: 'upload', onClick: () => fileInput.click() }), fileInput),
      listEl);
  }

  function aboutSection() {
    return section('About MITRA', h('p', null, 'MITRA — Memory, Intelligence, Tutoring & Revision Assistant.'), h('p', { class: 'muted small' }, `Version ${state.settings.app.version} · runs only on this computer at http://${state.settings.app.host}:${state.settings.app.port}`));
  }

  function redraw() {
    clear(root).append(
      h('div', { class: 'view-title' }, tile('settings'), h('div', null, h('h1', null, 'Settings'), h('div', { class: 'sub' }, 'Make MITRA yours.'))),
      profile(), aiSection(), backupSection(), privacySection(), aboutSection());
    if (anchor === 'backup') root.querySelector('#backup')?.scrollIntoView();
  }
  loadSettings().then(redraw).catch((e) => root.append(h('div', { class: 'alert error' }, errText(e))));
  return root;
}
