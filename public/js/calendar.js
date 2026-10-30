/** Calendar & study schedule. Uses the computer's own date and time; events live in SQLite. */
import { api, qs } from './api.js';
import { h, icon, btn, iconBtn, toast, modal, confirmDialog, clear, emit, on, errText, panel, emptyState, localDateStr, parseLocalDate, friendlyEventDate, fmtHHMM, CATEGORIES } from './ui.js';
import { go, onDispose } from './state.js';

const PRIORITY = ['exam', 'assignment', 'quiz', 'revision', 'study', 'other'];
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function eventModal(ev, { date, onSaved } = {}) {
  const isNew = !ev;
  const e = ev || { title: '', description: '', date: date || localDateStr(), startTime: '10:00', endTime: '', category: 'study', completed: false };
  const title = h('input', { type: 'text', id: 'ev-title', value: e.title, maxlength: '120', required: true });
  const cat = h('select', { id: 'ev-cat' }, Object.entries(CATEGORIES).map(([k, c]) => h('option', { value: k, selected: k === e.category }, c.label)));
  const d = h('input', { type: 'date', id: 'ev-date', value: e.date });
  const st = h('input', { type: 'time', id: 'ev-start', value: e.startTime });
  const en = h('input', { type: 'time', id: 'ev-end', value: e.endTime || '' });
  const desc = h('textarea', { id: 'ev-desc', rows: '3', maxlength: '1000' }, e.description || '');
  const done = h('input', { type: 'checkbox', id: 'ev-done', checked: !!e.completed, style: { width: 'auto' } });
  const f = (id, label, el, cls = '') => h('div', { class: `field ${cls}` }, h('label', { for: id }, label), el);
  const m = modal({
    title: isNew ? 'Add a study event' : 'Edit study event',
    body: h('div', { class: 'form-grid' }, f('ev-title', 'Title', title, 'full'), f('ev-cat', 'Category', cat), f('ev-date', 'Date', d), f('ev-start', 'Starts', st), f('ev-end', 'Ends (optional)', en), f('ev-desc', 'Description (optional)', desc, 'full'), isNew ? null : h('div', { class: 'field full row' }, done, h('label', { for: 'ev-done' }, 'Completed'))),
    actions: [
      isNew ? null : btn('Delete', { icon: 'trash-2', variant: 'danger', onClick: async () => {
        if (!(await confirmDialog({ title: 'Delete this event?', message: `“${e.title}” will be removed from your calendar.`, confirmText: 'Delete', danger: true }))) return;
        try { await api.del(`/api/calendar/events/${e.id}`); m.close(); toast('Event deleted.', 'success'); emit('data:events'); onSaved && onSaved(); } catch (x) { toast(errText(x), 'error'); }
      } }),
      btn('Cancel', { onClick: () => m.close() }),
      btn(isNew ? 'Add event' : 'Save', { variant: 'primary', onClick: async () => {
        if (!title.value.trim()) { title.focus(); return toast('Please give the event a title.', 'info'); }
        const body = { title: title.value, category: cat.value, date: d.value, startTime: st.value, endTime: en.value || null, description: desc.value };
        try {
          const saved = isNew ? await api.post('/api/calendar/events', body) : await api.put(`/api/calendar/events/${e.id}`, body);
          if (!isNew && done.checked !== !!e.completed) await api.patch(`/api/calendar/events/${e.id}/complete`, { completed: done.checked });
          m.close(); toast('Event saved.', 'success'); emit('data:events'); onSaved && onSaved(saved);
        } catch (x) { toast(errText(x), 'error'); }
      } }),
    ].filter(Boolean),
  });
}

export function createCalendar({ full = false } = {}) {
  const today = () => localDateStr();
  const now = new Date();
  let year = now.getFullYear();
  let month = now.getMonth();
  let selected = null;
  let events = [];
  let upcoming = [];
  let shownToday = today();

  const title = h('div', { id: 'cal-title', 'aria-live': 'polite' });
  const grid = h('div', { class: 'cal-grid', role: 'grid', 'aria-labelledby': 'cal-title' });
  const sub = h('div', { class: 'cal-sub' });
  const list = h('div', { class: 'list' });

  async function load() {
    const first = new Date(year, month, 1);
    const start = new Date(year, month, 1 - ((first.getDay() + 6) % 7));
    const weeks = Math.ceil(((first.getDay() + 6) % 7 + new Date(year, month + 1, 0).getDate()) / 7);
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + weeks * 7 - 1);
    try {
      [events, upcoming] = await Promise.all([api.get(`/api/calendar/events${qs({ from: ymd(start), to: ymd(end) })}`), api.get('/api/calendar/upcoming?limit=' + (full ? 10 : 5))]);
    } catch (e) { toast(errText(e), 'error'); }
    draw(start, weeks);
  }

  function draw(start, weeks) {
    shownToday = today();
    title.textContent = new Date(year, month, 1).toLocaleDateString([], { month: 'long', year: 'numeric' });
    clear(grid);
    ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach((d) => grid.append(h('div', { class: 'cal-dow', role: 'columnheader' }, d)));
    const byDay = new Map();
    for (const e of events) { if (!byDay.has(e.date)) byDay.set(e.date, []); byDay.get(e.date).push(e); }
    for (let i = 0; i < weeks * 7; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const key = ymd(d);
      const evs = (byDay.get(key) || []).filter((e) => !e.completed || true);
      const open = evs.filter((e) => !e.completed);
      const top = open.length ? PRIORITY.find((c) => open.some((e) => e.category === c)) : null;
      const cls = ['cal-day', d.getMonth() !== month ? 'other' : '', key === shownToday ? 'today' : '', top && key !== shownToday ? `has cat-${top}` : '', key === selected ? 'sel' : ''].filter(Boolean).join(' ');
      grid.append(h('button', { type: 'button', class: cls, role: 'gridcell', 'aria-selected': String(key === selected), 'aria-current': key === shownToday ? 'date' : undefined,
        'aria-label': `${d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}${key === shownToday ? ', today' : ''}${evs.length ? `, ${evs.length} event${evs.length > 1 ? 's' : ''}` : ''}`,
        onClick: () => { selected = selected === key ? null : key; if (d.getMonth() !== month) { year = d.getFullYear(); month = d.getMonth(); load(); } else draw(start, weeks); } }, String(d.getDate())));
    }
    clear(sub);
    clear(list);
    if (selected) {
      const label = parseLocalDate(selected).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
      sub.append(h('span', null, `Events on ${label}`), h('span', { class: 'row' }, btn('Show upcoming', { size: 'xs', variant: 'ghost', onClick: () => { selected = null; draw(start, weeks); } }), btn('Add', { icon: 'plus', size: 'xs', onClick: () => eventModal(null, { date: selected, onSaved: load }) })));
      const day = byDay.get(selected) || [];
      if (!day.length) list.append(emptyState('calendar-plus', 'Nothing planned for this day.'));
      day.forEach((e) => list.append(eventItem(e)));
    } else {
      sub.append(h('span', null, 'Upcoming'), btn('Add Event', { icon: 'plus', size: 'xs', variant: 'ghost', onClick: () => eventModal(null, { onSaved: load }) }));
      if (!upcoming.length) list.append(emptyState('calendar', 'No upcoming events. Plan a study session to stay on track.', btn('Add an event', { icon: 'plus', size: 'sm', variant: 'primary', onClick: () => eventModal(null, { onSaved: load }) })));
      upcoming.forEach((e) => list.append(eventItem(e, true)));
    }
  }

  function eventItem(e, withDate = false) {
    const c = CATEGORIES[e.category] || CATEGORIES.other;
    return h('div', { class: 'item event', style: { '--cat': c.color, opacity: e.completed ? '.6' : '1' } },
      h('button', { type: 'button', class: 'body', style: { background: 'none', border: 0, textAlign: 'left', padding: 0 }, onClick: () => eventModal(e, { onSaved: load }), 'aria-label': `Edit ${e.title}` },
        h('span', { class: 't', style: e.completed ? { textDecoration: 'line-through' } : null }, e.title),
        h('span', { class: 's' }, withDate ? friendlyEventDate(e.date, e.startTime) : `${fmtHHMM(e.startTime)}${e.endTime ? ' – ' + fmtHHMM(e.endTime) : ''} · ${c.label}`)),
      h('button', { type: 'button', class: 'icon-btn', style: { width: '32px', height: '32px' }, 'aria-label': e.completed ? `Mark “${e.title}” as not done` : `Mark “${e.title}” as done`, title: e.completed ? 'Mark as not done' : 'Mark as done', onClick: async () => {
        try { await api.patch(`/api/calendar/events/${e.id}/complete`, { completed: !e.completed }); emit('data:events'); emit('data:activity'); load(); } catch (x) { toast(errText(x), 'error'); }
      } }, icon(e.completed ? 'rotate-ccw' : 'circle-check', 'sm')));
  }

  const nav = h('div', { class: 'cal-nav' },
    iconBtn('chevron-left', 'Previous month', () => { month--; if (month < 0) { month = 11; year--; } selected = null; load(); }), title,
    iconBtn('chevron-right', 'Next month', () => { month++; if (month > 11) { month = 0; year++; } selected = null; load(); }));
  const body = h('div', { class: full ? 'cal-big' : '' }, nav, grid, sub, list);

  const timer = setInterval(() => { if (today() !== shownToday) { const n = new Date(); year = n.getFullYear(); month = n.getMonth(); load(); } }, 60000);
  onDispose(() => clearInterval(timer));
  onDispose(on('data:events', () => load()));
  load();
  return panel({ title: 'Calendar & Schedule', iconName: 'calendar', right: full ? null : h('button', { type: 'button', class: 'card-link', onClick: () => go('study') }, 'View Full Calendar'), body });
}
