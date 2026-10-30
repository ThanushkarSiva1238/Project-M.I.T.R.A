/** Tiny shared state: settings, navigation helper and per-view clean-up. */
import { api } from './api.js';

export const state = { settings: null };

let disposers = [];
/** Register clean-up work for the view currently being shown. */
export const onDispose = (fn) => disposers.push(fn);
export function runDisposers() {
  const d = disposers;
  disposers = [];
  for (const f of d) {
    try {
      f();
    } catch (_) {
      /* ignore */
    }
  }
}

export function go(path) {
  const target = '#/' + String(path).replace(/^#?\/?/, '');
  if (location.hash === target) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = target;
}

export function applyTheme() {
  document.documentElement.dataset.theme = state.settings?.theme === 'dark' ? 'dark' : 'light';
}

export async function loadSettings() {
  state.settings = await api.get('/api/settings');
  applyTheme();
  return state.settings;
}

export const aiConfigured = () => !!state.settings?.ai?.configured;
export const maxInput = () => state.settings?.ai?.maxInputChars || 6000;
