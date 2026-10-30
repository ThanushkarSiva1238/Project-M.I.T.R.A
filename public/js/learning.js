/** Study & Revision hub and Learning Progress. Every number comes from stored records; nothing is invented. */
import { api } from './api.js';
import { h, icon, tile, btn, clear, on, errText, emptyState, friendlyDate, panel, STATUS_LABEL } from './ui.js';
import { go, onDispose } from './state.js';
import { createCalendar } from './calendar.js';

const STATUS_COLOR = { new: 'var(--info)', learning: 'var(--warning)', needs_revision: 'var(--error)', learned: 'var(--success)' };
const stat = (iconName, color, value, label, onClick) => h(onClick ? 'button' : 'div', { type: onClick ? 'button' : undefined, class: 'card', style: { display: 'flex', gap: '12px', alignItems: 'center', textAlign: 'left', width: '100%' }, onClick },
  tile(iconName, color), h('div', null, h('div', { style: { fontSize: '24px', fontWeight: '700', lineHeight: 1.1 } }, String(value)), h('div', { class: 'small muted' }, label)));

function refTarget(t) {
  switch (t.refType) { case 'conversation': return `tutor/${t.refId}`; case 'note': return `notes/${t.refId}`; case 'quiz': return `quizzes/${t.refId}`; default: return null; }
}

export function createStudyView() {
  const top = h('div', { class: 'grid-cards', style: { marginBottom: '18px' } });
  const topics = h('div', { class: 'list' });
  async function load() {
    try {
      const s = await api.get('/api/progress/summary');
      clear(top).append(
        stat('layers', '', s.flashcards.due, s.flashcards.due === 1 ? 'flashcard due today' : 'flashcards due today', () => go('flashcards')),
        stat('book-a', 'orange', s.vocabulary.needs_revision, 'words need revision', () => go('vocabulary?status=needs_revision')),
        stat('calendar', 'blue', s.reminders.eventsToday, s.reminders.eventsToday === 1 ? 'study event today' : 'study events today'),
        stat('clipboard-check', 'green', s.quizzes.count, s.quizzes.count === 1 ? 'quiz ready' : 'quizzes ready', () => go('quizzes')));
      clear(topics);
      if (!s.recentTopics.length) topics.append(emptyState('sparkles', 'Topics you explain, write about or get quizzed on will appear here.'));
      for (const t of s.recentTopics) {
        const tg = refTarget(t);
        const inner = [h('span', { class: 'body' }, h('span', { class: 't' }, t.label), h('span', { class: 's' }, friendlyDate(t.at)))];
        topics.append(tg ? h('a', { class: 'item', href: `#/${tg}` }, inner) : h('div', { class: 'item' }, inner));
      }
    } catch (e) { clear(top).append(h('div', { class: 'alert error' }, errText(e))); }
  }
  onDispose(on('data:flashcards', load)); onDispose(on('data:vocab', load)); onDispose(on('data:events', load));
  load();
  return h('div', null,
    h('div', { class: 'view-title' }, tile('graduation-cap'), h('div', null, h('h1', null, 'Study & Revision'), h('div', { class: 'sub' }, 'Plan your time and revise what matters most.'))),
    top,
    h('div', { class: 'row wrap', style: { marginBottom: '18px' } }, btn('Revise flashcards', { icon: 'layers', variant: 'primary', onClick: () => go('flashcards') }), btn('Words needing revision', { icon: 'book-a', onClick: () => go('vocabulary?status=needs_revision') }), btn('Take a quiz', { icon: 'clipboard-check', onClick: () => go('quizzes') })),
    h('div', { style: { display: 'grid', gap: '20px', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', alignItems: 'start' } },
      createCalendar({ full: true }),
      panel({ title: 'Recent topics', iconName: 'history', body: topics })));
}

export function createProgressView() {
  const root = h('div');
  const body = h('div');
  async function load() {
    let s;
    try { s = await api.get('/api/progress/summary'); } catch (e) { return clear(body).append(h('div', { class: 'alert error' }, errText(e))); }
    const v = s.vocabulary; const vTotal = v.new + v.learning + v.needs_revision + v.learned;
    const max = Math.max(1, ...s.activityByDay.map((d) => d.count));
    const anything = vTotal + s.flashcards.total + s.quizzes.attempts + s.counts.notes + s.counts.conversations + s.counts.documents > 0;
    clear(body).append(
      ...(anything ? [] : [ h('div', { class: 'alert', style: { marginBottom: '16px' } }, icon('info'), h('div', null, 'Nothing to show yet. Ask MITRA a question, add a word, or write a note — your progress will appear here, based only on what you really do.'))]),
      h('div', { class: 'grid-cards', style: { marginBottom: '18px' } },
        stat('flame', 'orange', s.streakDays, s.streakDays === 1 ? 'day in a row' : 'days in a row'),
        stat('book-a', 'green', v.learned, `of ${vTotal} ${vTotal === 1 ? 'word' : 'words'} learned`, () => go('vocabulary?status=learned')),
        stat('layers', '', s.flashcards.reviewedToday, 'cards reviewed today', () => go('flashcards')),
        stat('notebook-pen', 'blue', s.counts.notes, s.counts.notes === 1 ? 'note written' : 'notes written', () => go('notes'))),
      h('div', { style: { display: 'grid', gap: '20px', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', alignItems: 'start' } },
        panel({ title: 'My vocabulary', iconName: 'book-a', body: vTotal ? h('div', null,
          h('div', { class: 'stackbar', role: 'img', 'aria-label': Object.keys(STATUS_LABEL).filter((k) => v[k] !== undefined).map((k) => `${STATUS_LABEL[k]} ${v[k]}`).join(', ') }, ['new', 'learning', 'needs_revision', 'learned'].map((k) => h('i', { style: { width: `${(v[k] / vTotal) * 100}%`, background: STATUS_COLOR[k] } }))),
          h('div', { class: 'legend' }, ['new', 'learning', 'needs_revision', 'learned'].map((k) => h('span', null, h('i', { style: { background: STATUS_COLOR[k] } }), `${STATUS_LABEL[k]}: ${v[k]}`)))) : emptyState('book-a', 'No words yet.') }),
        panel({ title: 'Flashcards', iconName: 'layers', body: s.flashcards.total ? h('dl', { class: 'kv' }, h('dt', null, 'Total cards'), h('dd', null, String(s.flashcards.total)), h('dt', null, 'Due today'), h('dd', null, String(s.flashcards.due)), h('dt', null, 'Learned'), h('dd', null, String(s.flashcards.learned)), h('dt', null, 'Needs revision'), h('dd', null, String(s.flashcards.needsRevision))) : emptyState('layers', 'No flashcards yet.') }),
        panel({ title: 'Activity — last 14 days', iconName: 'chart-column', body: h('div', null,
          h('div', { class: 'bars', role: 'img', 'aria-label': `Activity per day: ${s.activityByDay.map((d) => `${d.day} ${d.count}`).join(', ')}` }, s.activityByDay.map((d) => h('div', { class: `b ${d.count ? '' : 'zero'}`, title: `${d.day}: ${d.count}` }, h('i', { style: { height: `${Math.max(3, (d.count / max) * 100)}%` } }), h('span', null, d.day.slice(8))))),
          h('p', { class: 'xs muted' }, 'Each bar counts the things you did that day (questions asked, notes, reviews, quizzes…).')) }),
        panel({ title: 'Quizzes', iconName: 'clipboard-check', body: s.quizzes.attempts ? h('div', null,
          h('p', { class: 'small' }, `Average ${s.quizzes.averagePercent}% · best ${s.quizzes.bestPercent}% · ${s.quizzes.attempts} attempt${s.quizzes.attempts > 1 ? 's' : ''}`),
          h('div', { class: 'list' }, s.quizzes.recent.map((a) => h('a', { class: 'item', href: `#/quizzes/attempt/${a.attemptId}` }, h('span', { class: 'body' }, h('span', { class: 't' }, a.title), h('span', { class: 's' }, friendlyDate(a.completedAt))), h('span', { class: `badge ${a.percent >= 75 ? 'green' : a.percent >= 50 ? 'orange' : 'red'}` }, `${a.percent}%`))))) : emptyState('clipboard-check', 'You have not completed a quiz yet.', btn('Open Quiz Centre', { size: 'sm', onClick: () => go('quizzes') })) })));
  }
  for (const ev of ['data:activity', 'data:vocab', 'data:flashcards']) onDispose(on(ev, load));
  root.append(h('div', { class: 'view-title' }, tile('chart-column'), h('div', null, h('h1', null, 'Learning Progress'), h('div', { class: 'sub' }, 'Real numbers from what you have done — no guesses.'))), body);
  load();
  return root;
}
