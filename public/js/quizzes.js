/**
 * Quiz Centre. Grading happens on the server by exact comparison; the AI is only used to write the
 * questions, which the student can inspect (with answers) and remove before taking a quiz.
 */
import { api } from './api.js';
import { h, icon, tile, btn, toast, modal, confirmDialog, clear, emit, on, errText, emptyState, friendlyDate } from './ui.js';
import { go, onDispose, aiConfigured } from './state.js';
import { sourcePicker } from './sources.js';

const LETTERS = ['A', 'B', 'C', 'D'];
const pctBadge = (p) => (p >= 75 ? 'green' : p >= 50 ? 'orange' : 'red');

/** Human-readable text of the right answer for a question returned with answers. */
function answerText(q, value) {
  if (value === null || value === undefined) return 'No answer';
  if (q.type === 'tf') return value === 'true' ? 'True' : 'False';
  const i = Number(value);
  return q.options && q.options[i] !== undefined ? `${LETTERS[i]}. ${q.options[i]}` : String(value);
}

export function openQuizGenerator(preset = {}) {
  const picker = sourcePicker({ preset });
  const status = h('div');
  const count = h('select', { id: 'qz-count', 'aria-label': 'Number of questions' }, [5, 8, 10, 12, 15].map((n) => h('option', { value: n, selected: n === 5 }, `${n} questions`)));
  const mcq = h('input', { type: 'checkbox', id: 'qz-mcq', checked: true, style: { width: 'auto' } });
  const tf = h('input', { type: 'checkbox', id: 'qz-tf', checked: true, style: { width: 'auto' } });
  const gen = btn('Create quiz', { icon: 'sparkles', variant: 'primary' });
  const m = modal({ title: 'Create a quiz', size: 'wide', body: h('div', null, picker.el,
    h('div', { class: 'row wrap', style: { marginTop: '10px' } }, count, h('label', { class: 'row', for: 'qz-mcq' }, mcq, 'Multiple choice'), h('label', { class: 'row', for: 'qz-tf' }, tf, 'True / False')),
    h('p', { class: 'xs muted' }, 'Only multiple-choice and true/false are offered, because those can be marked exactly and fairly.'), status),
  actions: [btn('Close', { onClick: () => m.close() }), gen] });
  if (!aiConfigured()) status.append(h('div', { class: 'alert warn', style: { marginTop: '12px' } }, icon('triangle-alert'), h('div', null, 'Online AI is not set up yet, so MITRA can’t write quiz questions.'), h('div', { class: 'actions' }, btn('Open Settings', { size: 'xs', onClick: () => { m.close(); go('settings'); } }))));

  gen.addEventListener('click', async () => {
    let src;
    try { src = picker.get(); } catch (e) { return toast(e.message, 'info'); }
    const types = [mcq.checked && 'mcq', tf.checked && 'tf'].filter(Boolean);
    if (!types.length) return toast('Choose at least one question type.', 'info');
    if (!aiConfigured()) return toast('Online AI is not set up yet. Open Settings → Online AI.', 'info');
    gen.disabled = true;
    clear(status).append(h('div', { class: 'row', style: { marginTop: '14px' }, role: 'status' }, h('span', { class: 'spinner' }), 'MITRA is writing your quiz…'));
    try {
      const r = await api.post('/api/quizzes/generate', { ...src, count: Number(count.value), types });
      emit('data:quizzes'); emit('data:activity');
      m.close(); toast('Quiz created. Have a look at the questions first.', 'success'); go(`quizzes/${r.id}`);
    } catch (e) {
      gen.disabled = false;
      clear(status).append(h('div', { class: 'alert error', role: 'alert', style: { marginTop: '14px' } }, icon('triangle-alert'), h('div', null, errText(e), h('div', { class: 'xs' }, 'Nothing was saved. You can press the button again to retry.'))));
    }
  });
}

// ---------------------------------------------------------------- list
export function createQuizView({ id = null, mode = null } = {}) {
  const root = h('div');
  if (!id) list(); else if (mode === 'take') take(id); else if (mode === 'attempt') result(id); else overview(id);
  return root;

  async function list() {
    const body = h('div', { class: 'grid-cards' });
    const load = async () => {
      try {
        const rows = await api.get('/api/quizzes');
        clear(body);
        if (!rows.length) return body.append(emptyState('clipboard-check', 'No quizzes yet. Create one from a note, a document, or any topic.', btn('Create a quiz', { icon: 'sparkles', variant: 'primary', onClick: () => openQuizGenerator() })));
        for (const q of rows) {
          body.append(h('article', { class: 'card doc-card' },
            h('h3', null, q.title),
            h('div', { class: 'xs muted' }, `${q.questionCount} questions · ${q.sourceLabel || 'Topic'} · ${friendlyDate(q.createdAt, false)}`),
            h('div', { class: 'row wrap' }, q.aiGenerated ? h('span', { class: 'badge blue' }, 'AI-generated') : null, q.attemptCount ? h('span', { class: `badge ${pctBadge(q.bestPercent)}` }, `Best ${q.bestPercent}%`) : h('span', { class: 'badge grey' }, 'Not taken yet'), q.attemptCount ? h('span', { class: 'xs muted' }, `${q.attemptCount} attempt${q.attemptCount > 1 ? 's' : ''}`) : null),
            h('div', { class: 'row wrap' }, btn('Start', { icon: 'play', variant: 'primary', size: 'sm', onClick: () => go(`quizzes/${q.id}/take`) }), btn('Review questions', { size: 'sm', onClick: () => go(`quizzes/${q.id}`) }))));
        }
      } catch (e) { clear(body).append(h('div', { class: 'alert error' }, errText(e))); }
    };
    onDispose(on('data:quizzes', load));
    root.append(h('div', { class: 'view-title' }, tile('clipboard-check'), h('div', { class: 'grow' }, h('h1', null, 'Quiz Centre'), h('div', { class: 'sub' }, 'Test yourself. Marking is exact — the AI only writes the questions.')), btn('Create a quiz', { icon: 'sparkles', variant: 'primary', onClick: () => openQuizGenerator() })), body);
    load();
  }

  // ----------------------------------------------------------- overview/review
  async function overview(qid) {
    root.append(h('div', { class: 'row', role: 'status' }, h('span', { class: 'spinner' }), 'Loading…'));
    let quiz, attempts;
    try { [quiz, attempts] = await Promise.all([api.get(`/api/quizzes/${qid}?review=1`), api.get(`/api/quizzes/${qid}/attempts`)]); } catch (e) { return clear(root).append(h('div', { class: 'alert error' }, errText(e)), btn('Back to Quiz Centre', { onClick: () => go('quizzes') })); }
    const draw = () => {
      clear(root).append(
        h('div', { class: 'view-title' }, tile('clipboard-check'), h('div', { class: 'grow' }, h('h1', null, quiz.title), h('div', { class: 'sub' }, `${quiz.questions.length} questions · ${quiz.sourceLabel || 'Topic'}`)),
          btn('Start quiz', { icon: 'play', variant: 'primary', onClick: () => go(`quizzes/${qid}/take`) }),
          btn('Delete quiz', { icon: 'trash-2', variant: 'danger', onClick: async () => {
            if (!(await confirmDialog({ title: 'Delete this quiz?', message: 'The questions and all your attempts will be deleted.', confirmText: 'Delete', danger: true }))) return;
            try { await api.del(`/api/quizzes/${qid}`); emit('data:quizzes'); toast('Quiz deleted.', 'success'); go('quizzes'); } catch (e) { toast(errText(e), 'error'); }
          } })),
        quiz.aiGenerated ? h('div', { class: 'alert', style: { marginBottom: '14px' } }, icon('info'), h('div', null, h('strong', null, 'AI-generated questions. '), 'The questions, answers and explanations were written by an AI and can contain mistakes. If something looks wrong, remove that question and check your notes.')) : null,
        attempts.length ? h('div', { class: 'card', style: { marginBottom: '16px' } }, h('h2', { style: { fontSize: '17px', marginBottom: '8px' } }, 'Your attempts'), h('div', { class: 'list' }, attempts.map((a) => h('a', { class: 'item', href: `#/quizzes/attempt/${a.id}` }, h('span', { class: 'body' }, h('span', { class: 't' }, `${a.score} / ${a.total} (${a.percent}%)`), h('span', { class: 's' }, friendlyDate(a.completedAt))), h('span', { class: `badge ${pctBadge(a.percent)}` }, `${a.percent}%`))))) : null,
        h('h2', { style: { fontSize: '17px', margin: '6px 0 10px' } }, 'Questions and answers'),
        ...quiz.questions.map((q, i) => h('div', { class: 'q-card' },
          h('div', { class: 'row spread', style: { alignItems: 'flex-start' } }, h('h3', null, `${i + 1}. ${q.question}`), btn('Remove', { icon: 'trash-2', size: 'xs', variant: 'danger', onClick: async () => {
            if (!(await confirmDialog({ title: 'Remove this question?', message: 'It will be deleted from the quiz.', confirmText: 'Remove', danger: true }))) return;
            try { await api.del(`/api/quizzes/questions/${q.id}`); quiz.questions.splice(i, 1); emit('data:quizzes'); draw(); } catch (e) { toast(errText(e), 'error'); }
          } })),
          q.type === 'mcq' ? q.options.map((o, k) => h('div', { class: `opt ${String(k) === q.correct ? 'right' : ''}` }, h('span', null, `${LETTERS[k]}.`), h('span', null, o), String(k) === q.correct ? h('span', { class: 'badge green', style: { marginLeft: 'auto' } }, 'Correct') : null))
            : h('div', { class: 'small' }, 'Correct answer: ', h('strong', null, answerText(q, q.correct))),
          q.explanation ? h('p', { class: 'small muted', style: { marginTop: '6px' } }, h('em', null, 'AI explanation: '), q.explanation) : null)));
    };
    draw();
  }

  // ----------------------------------------------------------------- take
  async function take(qid) {
    root.append(h('div', { class: 'row', role: 'status' }, h('span', { class: 'spinner' }), 'Getting your quiz…'));
    let a;
    try { a = await api.post(`/api/quizzes/${qid}/attempts`, {}); } catch (e) { return clear(root).append(h('div', { class: 'alert error' }, errText(e)), btn('Back', { onClick: () => go('quizzes') })); }
    const answers = {};
    let i = 0;
    let submitting = false;
    const draw = () => {
      const q = a.questions[i];
      const opts = q.type === 'tf' ? [['true', 'True'], ['false', 'False']] : q.options.map((o, k) => [String(k), `${LETTERS[k]}. ${o}`]);
      clear(root).append(
        h('div', { class: 'view-title' }, tile('clipboard-check'), h('div', { class: 'grow' }, h('h1', null, a.quiz.title), h('div', { class: 'sub' }, `Question ${i + 1} of ${a.questions.length} · ${Object.keys(answers).length} answered`))),
        h('div', { class: 'progressbar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(a.questions.length), 'aria-valuenow': String(i + 1), 'aria-label': 'Quiz progress', style: { marginBottom: '16px' } }, h('i', { style: { width: `${((i + 1) / a.questions.length) * 100}%` } })),
        h('fieldset', { class: 'q-card', style: { margin: 0 } }, h('legend', { style: { fontWeight: 600, fontSize: '17px', padding: '0 6px' } }, q.question),
          opts.map(([val, label]) => h('label', { class: 'opt' }, h('input', { type: 'radio', name: `q${q.id}`, value: val, checked: answers[q.id] === val, onChange: () => { answers[q.id] = val; draw2(); } }), h('span', null, label)))),
        h('div', { class: 'row wrap', style: { marginTop: '14px' } },
          btn('Previous', { icon: 'arrow-left', disabled: i === 0, onClick: () => { i--; draw(); } }),
          i < a.questions.length - 1 ? btn('Next', { icon: 'arrow-right', variant: 'primary', onClick: () => { i++; draw(); } }) : null,
          h('span', { class: 'grow' }),
          btn('Submit quiz', { icon: 'check', variant: i === a.questions.length - 1 ? 'primary' : '', onClick: submit })));
      root.querySelector('input[type=radio]')?.focus({ preventScroll: true });
    };
    const draw2 = () => { const s = root.querySelector('.sub'); if (s) s.textContent = `Question ${i + 1} of ${a.questions.length} · ${Object.keys(answers).length} answered`; };
    async function submit() {
      if (submitting) return;
      const missing = a.questions.length - Object.keys(answers).length;
      if (missing && !(await confirmDialog({ title: 'Submit with unanswered questions?', message: `${missing} question${missing > 1 ? 's are' : ' is'} unanswered and will be marked wrong.`, confirmText: 'Submit anyway' }))) return;
      submitting = true;
      try { const r = await api.post(`/api/quizzes/attempts/${a.attemptId}/submit`, { answers }); emit('data:quizzes'); emit('data:activity'); showResult(r); }
      catch (e) { submitting = false; toast(errText(e), 'error'); }
    }
    draw();
  }

  async function result(aid) {
    root.append(h('div', { class: 'row', role: 'status' }, h('span', { class: 'spinner' }), 'Loading result…'));
    try { showResult(await api.get(`/api/quizzes/attempts/${aid}`)); } catch (e) { clear(root).append(h('div', { class: 'alert error' }, errText(e)), btn('Back', { onClick: () => go('quizzes') })); }
  }

  function showResult(r) {
    let wrongOnly = false;
    const draw = () => {
      const shown = r.results.map((q, i) => ({ q, i })).filter(({ q }) => !wrongOnly || !q.isCorrect);
      clear(root).append(
        h('div', { class: 'view-title' }, tile('clipboard-check'), h('div', { class: 'grow' }, h('h1', null, 'Quiz result'), h('div', { class: 'sub' }, r.quiz.title))),
        h('div', { class: 'card row wrap', style: { gap: '24px', marginBottom: '16px' } },
          h('div', { class: 'score-ring', style: { '--p': r.percent }, role: 'img', 'aria-label': `${r.percent} percent` }, h('span', null, `${r.percent}%`)),
          h('div', { class: 'grow stack gap-sm' }, h('h2', null, `${r.score} out of ${r.total} correct`),
            h('p', { class: 'muted' }, r.percent >= 75 ? 'Well done! Keep it up.' : r.percent >= 50 ? 'A good start. Look at the questions you missed and try again.' : 'This was a hard one. Review the answers below, then try again when you are ready.'),
            h('div', { class: 'row wrap' }, btn('Try again', { icon: 'rotate-ccw', variant: 'primary', onClick: () => go(`quizzes/${r.quiz.id}/take`) }), btn('Quiz overview', { onClick: () => go(`quizzes/${r.quiz.id}`) }), btn('All quizzes', { onClick: () => go('quizzes') })))),
        h('div', { class: 'row spread', style: { marginBottom: '10px' } }, h('h2', { style: { fontSize: '17px' } }, 'Your answers'),
          r.results.some((q) => !q.isCorrect) ? h('label', { class: 'row small' }, h('input', { type: 'checkbox', style: { width: 'auto' }, checked: wrongOnly, onChange: (e) => { wrongOnly = e.target.checked; draw(); } }), 'Show only questions I got wrong') : null),
        ...shown.map(({ q, i }) => h('div', { class: 'q-card' },
          h('div', { class: 'row spread', style: { alignItems: 'flex-start' } }, h('h3', null, `${i + 1}. ${q.question}`), h('span', { class: `badge ${q.isCorrect ? 'green' : 'red'}` }, q.isCorrect ? 'Correct' : 'Not correct')),
          h('div', { class: 'small' }, 'Your answer: ', h('strong', null, answerText(q, q.yourAnswer))),
          q.isCorrect ? null : h('div', { class: 'small' }, 'Correct answer: ', h('strong', null, answerText(q, q.correct))),
          q.explanation ? h('p', { class: 'small muted', style: { marginTop: '6px' } }, h('em', null, 'AI explanation: '), q.explanation) : null)));
    };
    draw();
    window.scrollTo({ top: 0 });
  }
}
