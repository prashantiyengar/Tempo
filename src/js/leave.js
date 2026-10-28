// Leave days (on leave / sick leave).
import * as T from './tz.js';
import * as S from './scheduler.js';
import * as E from './engine.js';
import * as EV from './events.js';
import { $, $$, esc, choose, popover } from './ui.js';
import { app, set, st, tz } from './core.js';
import { lastEventEnd } from './actions.js';
import { collectItems, cycle, newEvent, openSettings, render, replaceTask, saveTasks, syncSharedSoon, toast } from './app.js';
import { handleError, setStatus } from './status.js';
import { pushUndo } from './undo.js';

// Work hours or a time period changed. Planned sessions are re-planned on every cycle anyway; this decides
// (setting, or asking) whether they should move: "move" also re-plans a session that is under way right now (assumed
// done) when it no longer fits the new hours; "keep" pins the affected tasks' upcoming sessions where they are.
// ======================================================================================
// Leave days (on leave / sick leave)
// ======================================================================================
export function leaveTag(k, month = false) {
  const kind = S.leaveOf(set(), k); if (!kind) return '';
  const L = S.LEAVE_KINDS[kind];
  return `<button class="leave-tag lv-${kind} ${month ? 'm' : ''}" data-leave="${k}" title="${esc(L.label)} — click to change">${L.icon}${month ? '' : ` ${esc(L.label)}`}</button>`;
}
export function leaveMenu(k, rect) {
  const cur = S.leaveOf(set(), k);
  const day = T.format(T.dayStart(k, tz()), tz(), { weekday: 'long', day: 'numeric', month: 'long' });
  popover(rect, `<div class="pop leave-pop"><h3 style="margin:0 0 8px">${esc(day)}</h3>
      ${Object.entries(S.LEAVE_KINDS).map(([id, L]) => `<button class="btn small ${cur === id ? 'primary' : ''} lv-set" data-kind="${id}">${L.icon} ${esc(L.label)}</button>`).join(' ')}
      ${cur ? '<button class="btn small ghost lv-clear">Not on leave</button>' : ''}
      <div class="row" style="margin-top:8px"><button class="link lv-day">Open this day</button><span class="grow"></span><button class="link lv-more">Several days…</button></div></div>`, (pop, close) => {
    $$('.lv-set', pop).forEach((b) => (b.onclick = () => { close(); setLeave([k], b.dataset.kind); }));
    $('.lv-clear', pop)?.addEventListener('click', () => { close(); setLeave([k], null); });
    $('.lv-day', pop).onclick = () => { close(); app.cursor = k; app.view = 'day'; render(); };
    $('.lv-more', pop).onclick = () => { close(); openSettings(); };
  });
}
// Mark (kind) or unmark (null) days; when new leave days already have events or task sessions, offer to move them.
export async function setLeave(keys, kind, { ask = true, mode = null } = {}) {
  const before = { ...(set().leave || {}) };
  const leave = { ...before };
  for (const k of keys) { if (kind) leave[k] = kind; else delete leave[k]; }
  set().leave = leave;
  await E.persist(st(), ['settings']);
  pushUndo(kind ? 'leave day' : 'remove leave day', async () => { set().leave = before; await E.persist(st(), ['settings']); syncSharedSoon(); E.invalidate(); await render(); cycle(); });
  syncSharedSoon();
  const added = kind ? keys.filter((k) => !S.leaveOf({ leave: before }, k)) : [];
  if (added.length && (ask || mode)) { const r = await afterLeave(added, mode); if (r === 'back') { set().leave = before; await E.persist(st(), ['settings']); await render(); return; } }
  else { toast(kind ? `${S.LEAVE_KINDS[kind].icon} ${S.LEAVE_KINDS[kind].label}` : 'No longer marked as leave'); cycle(); }
}
// The next day that is a work day and not a leave day (for moving events off leave days).
function nextWorkDay(k) {
  const days = set().bounds?.days?.length ? set().bounds.days : [1, 2, 3, 4, 5];
  let d = T.addDays(k, 1);
  for (let i = 0; i < 60 && (!days.includes(T.weekday(d)) || S.leaveOf(set(), d)); i++) d = T.addDays(d, 1);
  return d;
}
export async function afterLeave(keys, forced = null) {
  const items = (await collectItems(keys)).filter((it) => !it.allDay && keys.includes(T.dayKey(it.start, tz())));
  const sessions = items.filter((it) => it.kind === 'chunk' && it.status !== 'done' && !it.task?.onLeave && !(it.task && S.usesLeaveDays(it.task, set())));
  const events = items.filter((it) => it.kind === 'event' && it.editable && !it.declined && !it.ev?.extendedProperties?.private?.tempoTask);
  if (!sessions.length && !events.length) { toast(`Marked ${keys.length} day${keys.length > 1 ? 's' : ''} as leave`); cycle(); return 'none'; }
  const what = [events.length ? `${events.length} event${events.length > 1 ? 's' : ''}` : '', sessions.length ? `${sessions.length} task session${sessions.length > 1 ? 's' : ''}` : ''].filter(Boolean).join(' and ');
  const opts = [{ value: 'all', primary: true, label: 'Yes, reschedule them', desc: `${sessions.length ? 'Task sessions move to other days. ' : ''}${events.length ? 'Events move to the next working day at the same time.' : ''}` }];
  if (events.length && sessions.length) opts.push({ value: 'tasks', label: 'Only move the task sessions', desc: 'Your events stay where they are.' });
  opts.push({ value: 'keep', label: 'No, keep everything where it is', desc: sessions.length ? 'Task sessions on these days stay (they are pinned).' : 'Events stay where they are.' });
  const r = forced || await choose(`Reschedule ${keys.length > 1 ? 'these days’' : 'this day’s'} ${what}?`, `${keys.length > 1 ? 'These days are' : 'This day is'} now marked as leave.`, opts, { cancel: 'Back — don’t mark as leave' });
  if (!r) return 'back';
  if (r === 'keep') {
    for (const it of sessions) { const t = st().tasks.find((x) => x.id === it.task.id); if (t && it.status === 'planned') replaceTask(S.pinSession(t, it.sess.id, it.start, it.end)); }
    await saveTasks('keep sessions on leave day');
  } else {
    // pinned sessions on those days go back into the plan
    for (const it of sessions) { const t = st().tasks.find((x) => x.id === it.task.id); if (t && it.status === 'pinned') replaceTask(S.unpinSession(t, it.sess.id)); }
    await saveTasks('reschedule leave day');
    if (r === 'all' && events.length) {
      let moved = 0;
      setStatus('Moving events…', 'busy');
      for (const it of events) {
        try {
          const to = nextWorkDay(T.dayKey(it.start, tz())); // skips weekends (by your work days) and leave days
          const st0 = T.atTime(to, T.hhmm(T.minutesOfDay(it.start, tz())), tz());
          await EV.moveEvent(st(), it.ev, st0, st0 + (it.end - it.start), 'this');
          moved++;
        } catch (err) { handleError(err); }
      }
      E.invalidate();
      toast(`Moved ${moved} event${moved === 1 ? '' : 's'} to the next working day${sessions.length ? ' · task sessions re-planned' : ''}`, { ms: 6000 });
    } else toast(sessions.length ? 'Task sessions re-planned around your leave' : 'Marked as leave');
  }
  cycle();
  return r;
}

export async function hoursChanged(before, after) {
  const bChanged = JSON.stringify(before.bounds) !== JSON.stringify(after.bounds);
  const perOld = new Map((before.periods || []).map((p) => [p.id, JSON.stringify(p.rules)]));
  const perChanged = new Set((after.periods || []).filter((p) => perOld.has(p.id) && perOld.get(p.id) !== JSON.stringify(p.rules)).map((p) => p.id));
  if (!bChanged && !perChanged.size) return;
  const now = Date.now();
  const affected = (t) => !t.archived && !t.ignoreBounds && !t.bounds && (t.periodId ? perChanged.has(t.periodId) : bChanged);
  const tasks = st().tasks.filter((t) => affected(t) && S.sessions(t).some((c) => c.end > now && c.kind !== 'done' && c.kind !== 'pinned' || (c.kind === 'done' && c.auto && c.end > now)));
  if (!tasks.length) return;
  let mode = after.hoursChange || 'ask';
  if (mode === 'ask') {
    const what = bChanged ? `work hours (${after.bounds.start}–${after.bounds.end})` : 'time period';
    mode = await choose('Move planned sessions?', `You changed your ${what}. ${tasks.length} task${tasks.length > 1 ? 's have' : ' has'} sessions planned with the old hours.`, [
      { value: 'move', label: 'Move them to fit the new hours', desc: 'Upcoming sessions are re-planned, including one that is under way now if it no longer fits.' },
      { value: 'keep', label: 'Keep them where they are', desc: 'Upcoming sessions stay put (pinned); only new planning uses the new hours.' },
    ], { cancel: 'Decide later (sessions follow the new hours)' });
    if (!mode) return;
  }
  const ids = new Set(tasks.map((t) => t.id));
  if (mode === 'move') {
    st().tasks = st().tasks.map((t) => (ids.has(t.id) ? S.refitOngoing(t, after, now) : t));
    app.pendingWhy = 'you changed your work hours';
  } else if (mode === 'keep') {
    st().tasks = st().tasks.map((t) => (ids.has(t.id) ? S.pinUpcoming(t, now) : t));
  }
  await saveTasks(mode === 'move' ? 'move sessions to new hours' : 'keep sessions at old hours');
  toast(mode === 'move' ? 'Sessions moved to fit the new hours' : 'Planned sessions kept where they were (pinned)');
}
export async function fillSinceLast() {
  const r = await lastEventEnd();
  newEvent({ start: r.start, end: r.end, title: '' });
  setTimeout(() => toast(r.note, { noUndo: true }), 300);
}
