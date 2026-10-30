/** Privacy notice (shown on first launch and from the profile menu / Settings). */
import { h, icon, modal, btn } from './ui.js';
import { api } from './api.js';
import { state } from './state.js';

export function privacyBody() {
  const s = state.settings?.ai;
  const provider = s?.configured ? `${s.provider}${s.model ? ' (' + s.model + ')' : ''}` : 'the AI provider you configure';
  return h(
    'div',
    { class: 'stack' },
    h('div', { class: 'row', style: { alignItems: 'flex-start' } }, icon('hard-drive', 'lg'), h('p', null, h('strong', null, 'Saved on this computer. '), 'Your notes, documents, vocabulary, flashcards, quizzes and conversations are stored in a folder on this computer. You can read everything you have saved even when you are offline.')),
    h('div', { class: 'row', style: { alignItems: 'flex-start' } }, icon('send', 'lg'), h('p', null, h('strong', null, 'Online AI sends text away. '), `When you press Send, Explain or Generate, only the text you chose is sent over the internet to ${provider}. Documents are never uploaded automatically. That provider's own privacy and data-retention policies apply, so please avoid sending anything you would not want a third party to process.`)),
    h('div', { class: 'row', style: { alignItems: 'flex-start' } }, icon('wifi-off', 'lg'), h('p', null, h('strong', null, 'Offline use. '), 'New AI explanations, flashcards and quizzes need an internet connection. Everything already saved, including the built-in dictionary, notes and revision tools, works without one.')),
    h('div', { class: 'row', style: { alignItems: 'flex-start' } }, icon('lock', 'lg'), h('p', null, h('strong', null, 'Not encrypted. '), 'MITRA keeps your data in ordinary files. Anyone who can use this computer account can open them, so protect the computer itself (password, disk encryption) and keep backups somewhere safe.'))
  );
}

export function showPrivacyNotice({ firstRun = false } = {}) {
  const m = modal({
    title: 'Your privacy in MITRA',
    body: privacyBody(),
    dismissible: !firstRun,
    actions: [
      btn(firstRun ? 'I understand' : 'Close', {
        variant: 'primary',
        onClick: async () => {
          if (firstRun) {
            try {
              state.settings = await api.put('/api/settings', { privacyNoticeSeen: true });
            } catch (_) {
              /* shown again next time */
            }
          }
          m.close();
        },
      }),
    ],
  });
  return m;
}
