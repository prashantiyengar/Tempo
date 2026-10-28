// The command interface for AI assistants and automation (window.tempo, AI console), and quick add.
import * as T from './tz.js';
import * as S from './scheduler.js';
import * as E from './engine.js';
import * as D from './dialogs.js';
import * as A from './analysis.js';
import * as C from './categories.js';
import { $, esc, modal, setHTML } from './ui.js';
import { parseTask } from './parse.js';
import { createApi, AI_PROMPT } from './api.js';
import * as P from './projects.js';
import { app, set, st, tz } from './core.js';
import { finishedEarly, itemsToday } from './actions.js';
import { collectItems, ctx, cycle, render, replaceTask, saveTasks, setEventDone, toast } from './app.js';
import { setLeave } from './leave.js';
import { afterEventChange, askCategoryOnce } from './popovers.js';
import { deleteTask, newTask, pushUndo, undo, undoStack } from './undo.js';

// ======================================================================================
// Command interface for AI assistants and automation (window.tempo, AI console)
// ======================================================================================
export async function freeSlots(from, to, minMin, within) {
  const s = set(), z = tz();
  const { busy } = await E.busyIntervals(st(), from, to);
  const sess = st().tasks.filter((t) => !t.archived).flatMap((t) => S.sessions(t).filter((c) => c.kind !== 'waived').map((c) => ({ start: c.start, end: c.end })));
  const wins = /any|all/i.test(within) ? [{ start: from, end: to }] : /waking|day/i.test(within) ? S.windows(from, to, s.overflowBounds || { start: '07:00', end: '23:00', days: [0, 1, 2, 3, 4, 5, 6] }, z) : S.windows(from, to, s.bounds, z);
  return S.subtract(wins, S.merge([...busy, ...sess])).map((w) => ({ start: Math.max(w.start, Date.now()), end: w.end })).filter((w) => w.end - w.start >= minMin * T.MIN);
}
async function finishedEarlyApi(a) {
  const now = Date.now();
  const items = (await itemsToday()).filter((x) => !x.allDay && x.start <= now && x.end > now && (x.kind === 'chunk' ? x.status !== 'done' || x.sess.auto : x.editable && A.isOccupying(x, set())));
  let it = null;
  if (a.item) it = items.find((x) => x.key === a.item || x.sess?.id === a.item || x.key === `c|${a.item}` || (x.title || '').toLowerCase().includes(String(a.item).toLowerCase()));
  else if (items.length === 1) it = items[0];
  if (!it) { const e = new Error(items.length ? `Several things are running: ${items.map((x) => x.title).join(', ')} — give "item".` : 'Nothing is running right now.'); e.api = true; throw e; }
  const then = /move|fill|up/i.test(a.then || '') ? 'fill' : /free|keep/i.test(a.then || '') ? 'free' : 'later';
  return finishedEarly(it, then);
}
let api = null;
export function setupApi() {
  api = createApi({
    setLeave, st, set, tz, cycle, saveTasks, replaceTask, deleteTask, buildDraft, collectItems, freeSlots, undo, pushUndo, undoStack, finishedEarlyApi, setEventDone, render,
    afterEventChange, defaultCalendar: () => ctx.defaultCalendar(), lastBusy: () => app.lastBusy, toast: (m) => toast(m),
  });
  window.tempo = api;
  if (new URLSearchParams(location.search).get('ai') === '1') setTimeout(openAiConsole, 600);
}
export async function openAiConsole() {
  const example = JSON.stringify([{ cmd: 'today' }, { cmd: 'listTasks' }], null, 1);
  await modal(`<div class="ai-console"><header class="dlg-head"><h2>AI &amp; automation</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></header>
    <div class="dlg-body">
      <p class="small">An AI assistant that works in your browser (e.g. <b>Claude in Chrome</b>, included in your Claude subscription) can control Tempo through a command interface — no API key, no extra cost. Copy the instructions below into your chat with it, or paste commands here yourself.</p>
      <div class="row"><button type="button" class="btn small copy-prompt">Copy instructions for your AI</button><button type="button" class="btn small ghost show-help">Show all commands</button></div>
      <label class="field"><span>Commands (JSON — one object or a list)</span><textarea id="ai-input" class="mono" rows="7" spellcheck="false">${esc(example)}</textarea></label>
      <div class="row"><button type="button" class="btn primary run" id="ai-run">Run</button><button type="button" class="btn dry" id="ai-dry">Preview (dry run)</button><span class="grow"></span><span class="muted small ai-status"></span></div>
      <pre id="ai-output" class="ai-out" aria-live="polite"></pre>
    </div></div>`, (dlg) => {
    const out = $('#ai-output', dlg), status = $('.ai-status', dlg);
    const go = async (dryRun) => {
      let cmds;
      try { cmds = JSON.parse($('#ai-input', dlg).value); } catch (e) { out.textContent = JSON.stringify({ error: 'Not valid JSON: ' + e.message }, null, 2); return; }
      status.textContent = 'Running…';
      const r = await api.run(cmds, { dryRun });
      out.textContent = JSON.stringify(r, null, 2);
      status.textContent = dryRun ? 'Preview only — nothing changed' : 'Done';
    };
    $('#ai-run', dlg).onclick = () => go(false);
    $('#ai-dry', dlg).onclick = () => go(true);
    $('.show-help', dlg).onclick = () => { out.textContent = JSON.stringify(api.help(), null, 2); };
    $('.copy-prompt', dlg).onclick = async () => {
      const text = `${AI_PROMPT}\nThe app is open at ${location.origin + location.pathname}.`;
      try { await navigator.clipboard.writeText(text); status.textContent = 'Copied'; } catch { out.textContent = text; status.textContent = 'Copy this text:'; }
    };
  }, { cls: 'wide' });
}

// ======================================================================================
// Quick add in plain language
// ======================================================================================
export function setupQuickAdd() {
  const inp = $('#quick-add'), pv = $('#quick-preview');
  if (!inp) return;
  let parsed = null;
  const show = () => {
    const v = inp.value.trim();
    if (!v) { pv.hidden = true; parsed = null; return; }
    parsed = parseTask(v, set(), st().tasks);
    pv.hidden = false;
    setHTML(pv, `<div class="qp-title">${esc(parsed.draft.title)}</div><div class="qp-chips">${parsed.chips.map((c) => `<span class="chip-btn on">${esc(c)}</span>`).join('')}${parsed.hasDeadline ? '' : '<span class="chip-btn">due in a week (default)</span>'}</div>
      <div class="qp-act"><span class="muted small">Enter to add</span><button class="link qp-edit">Edit details…</button></div>`);
    $('.qp-edit', pv).onclick = () => { const d = buildDraft(parsed.draft); inp.value = ''; show(); newTask({ draft: d, kind: d.kind }); };
  };
  inp.addEventListener('input', show);
  inp.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') { inp.value = ''; show(); inp.blur(); }
    if (e.key !== 'Enter' || !parsed) return;
    e.preventDefault();
    const t = buildDraft(parsed.draft);
    if (!(await D.checkTaskLimits(ctx, t))) return;
    inp.value = ''; show();
    let nt = projectCategory({ ...t, rev: Date.now() });
    if (!nt.categoryId && set().askCategory !== false) nt = await askCategoryOnce(nt);
    st().tasks.push(nt);
    app.pendingWhy = `you added “${nt.title}” (rank ${nt.rank})`;
    await saveTasks(`add “${nt.title}”`);
    await cycle();
    const ss = S.sessions(st().tasks.find((x) => x.id === nt.id) || nt);
    toast(`Added “${nt.title}” — ${ss.length} session${ss.length === 1 ? '' : 's'} planned`);
  });
}
// A task in a project with a category, and none of its own, gets the project's category
export function projectCategory(t) {
  if (t.categoryId || !t.projectId) return t;
  const c = P.byId(set(), t.projectId)?.catId;
  return c && C.catById(set(), c) ? C.applyCategory(t, C.catById(set(), c)) : t;
}
// A full task from what the quick-add parser understood (same defaults as the task dialog).
export function buildDraft(d) {
  const s = set(), z = tz(), now = Date.now();
  let t = {
    id: S.newId('t'), kind: 'generic', title: 'Task', rank: 3, totalMinutes: 60,
    reading: { pages: 100, startPage: 1, speed: s.readingDefaults?.speed || 15, unit: 'pph', labels: 'actual' },
    deadline: T.atTime(T.addDays(T.dayKey(now, z), 7), s.bounds.end, z), earliestStart: null,
    chunkMinutes: null, minChunkMinutes: null, maxPerDayMinutes: null, breakMinutes: null, bounds: null, ignoreBounds: false,
    color: D.TASK_COLORS_PUBLIC[st().tasks.length % D.TASK_COLORS_PUBLIC.length], reminderMinutes: null, notes: '', frozen: [], planned: [], skipped: [], created: now,
    ...d,
  };
  if (t.repeat) t.deadline = S.repeatEnd(t, s);
  if (t.categoryId) t = C.applyCategory(t, C.catById(s, t.categoryId));
  return t;
}
