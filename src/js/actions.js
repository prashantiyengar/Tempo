// Things you do to an item after the fact: extend until now, finished early, started late, fill since last /
// till next event, done at another time.
import * as T from './tz.js';
import * as S from './scheduler.js';
import * as E from './engine.js';
import * as EV from './events.js';
import * as D from './dialogs.js';
import * as A from './analysis.js';
import * as C from './categories.js';
import * as I from './items.js';
import { $, $$, esc, choose, modal } from './ui.js';
import * as UI from './ui.js';
import { app, set, st, tz } from './core.js';
import { collectItems, ctx, cycle, render, replaceTask, saveTasks, toast } from './app.js';
import { handleError, logHistory, setStatus } from './status.js';
import { afterEventChange, saveNewEvent, selBody } from './popovers.js';
import { undoableEventChange } from './undo.js';

// ======================================================================================
// "Until now": the latest event or session that ended in the last 4 hours can be stretched to now (you kept going)
// ======================================================================================
// worked out again from what's on screen right now (time has moved on since the last redraw)
export const currentToNow = () => (app.items ? toNowItem([...app.items.values()].filter((x) => !x.allDay)) : null);
export function toNowItem(timed) {
  const now = Date.now();
  // (sleep blocks count too: you slept in, or stayed in bed — extend the sleep until now)
  const busyNow = timed.some((it) => it.start <= now && it.end > now && I.takesTime(it));
  if (busyNow) return null;
  // the latest item that ended in the last 4 hours — only that one (never an earlier one: if the latest was just
  // extended until now, or can't be changed, there's nothing to offer)
  const recent = timed.filter((it) => it.end <= now && it.end >= now - 4 * T.HOUR && I.takesTime(it))
    .sort((a, b) => b.end - a.end);
  const last = recent[0];
  return last && last.editable && now - last.end >= T.MIN ? last : null;
}
export function wireToNow(root) {
  $$('[data-tonow]', root).forEach((b) => {
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    b.addEventListener('click', (e) => { e.stopPropagation(); const it = app.toNowIt; if (it && it.key === b.dataset.tonow) extendToNow(it); });
  });
}
// A task session done at a different time than planned (e.g. 03:00–04:00 instead of 21:00): pick when, and it moves
// there and counts as done — even outside the hours the task is normally planned in.
function askDoneWhen(title, sess, { what = 'session', move = 'the session moves there and the rest of the task is planned again' } = {}) {
  const z = tz(), len = Math.max(5, Math.round((sess.end - sess.start) / T.MIN)), now = Math.floor(Date.now() / (5 * T.MIN)) * 5 * T.MIN;
  const st0 = Math.min(now - len * T.MIN, sess.start), dt = (ms) => T.toDTInput(ms, z);
  return modal(`<form class="choice done-at-f"><h2>🕓 When did you do it?</h2>
      <p class="muted small" style="margin:0">${esc(title)} — ${what} planned ${esc(T.fmtDate(sess.start, z))} ${esc(T.fmtTime(sess.start, z, set().h12))}–${esc(T.fmtTime(sess.end, z, set().h12))} (${T.fmtDur(len)})</p>
      <label class="field"><span>Day</span><input type="date" name="d" value="${dt(st0).slice(0, 10)}" max="${dt(Date.now()).slice(0, 10)}"></label>
      <div class="row"><label class="field"><span>From</span><input type="time" name="a" value="${dt(st0).slice(11, 16)}" step="300"></label><label class="field"><span>To</span><input type="time" name="b" value="${dt(st0 + len * T.MIN).slice(11, 16)}" step="300"></label></div>
      <p class="muted small dat-say" style="margin:0"></p>
      <div class="actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">✓ Mark done then</button></div></form>`,
  (dlg, close) => {
    const f = $('form', dlg);
    UI.linkRange(f.a, f.b);
    const read = () => { const a = T.atTime(f.d.value, f.a.value || '00:00', z); let b = T.atTime(f.d.value, f.b.value || '00:00', z); if (b <= a) b = T.atTime(T.addDays(f.d.value, 1), f.b.value, z); return { a, b }; };
    const say = () => { const { a, b } = read(); $('.dat-say', dlg).textContent = a > Date.now() ? 'That is still to come — pick a time that has passed.' : `${T.fmtDur(Math.round((b - a) / T.MIN))} done — ${move}.`; };
    f.addEventListener('input', say); f.addEventListener('change', say); say();
    f.onsubmit = (e) => { e.preventDefault(); const { a, b } = read(); if (a > Date.now()) return; close({ a, b: Math.min(b, Math.max(Date.now(), a + 5 * T.MIN)) }); };
  }, { cls: 'narrow' });
}
export async function doneAtAnotherTime(task, sess) {
  if (!task || !sess) return;
  const z = tz();
  const r = await askDoneWhen(task.title, sess);
  if (!r) return;
  replaceTask(S.doneAt(task, sess.id, r.a, r.b));
  logHistory({ kind: 'done', task, sess, t: r.a });
  await saveTasks(`“${task.title}” done at another time`);
  toast(`✓ “${task.title}” done ${T.format(r.a, z, { weekday: 'short' })} ${T.fmtTime(r.a, z, set().h12)}–${T.fmtTime(r.b, z, set().h12)} — the rest of the task re-planned`);
  cycle();
}
// An event you did at a different time: this occurrence moves there and is marked done
export async function eventDoneAtAnotherTime(it) {
  if (!it?.ev || !it.editable) return;
  const z = tz(), ev = it.ev;
  const r = await askDoneWhen(it.title, it, { what: 'event', move: `the event${ev.recurringEventId ? ' (just this occurrence)' : ''} moves there, marked done` });
  if (!r) return;
  try {
    setStatus('Saving…');
    const zone = ev.start.timeZone || z, priv = { ...(ev.extendedProperties?.private || {}), tempoDone: '1' };
    await EV.updateEvent(st(), ev, { start: { dateTime: new Date(r.a).toISOString(), timeZone: zone }, end: { dateTime: new Date(r.b).toISOString(), timeZone: ev.end.timeZone || zone }, extendedProperties: { ...(ev.extendedProperties || {}), private: priv } }, 'this');
    undoableEventChange(`“${it.title}” done at another time`, ev, 'this');
    await afterEventChange();
    toast(`✓ “${it.title}” done ${T.format(r.a, z, { weekday: 'short' })} ${T.fmtTime(r.a, z, set().h12)}–${T.fmtTime(r.b, z, set().h12)}`);
  } catch (err) { handleError(err); render(); }
}
export async function extendToNow(it) {
      const end = Math.floor(Date.now() / T.MIN) * T.MIN;
      try {
        if (it.kind === 'chunk') {
          replaceTask(S.extendSession(it.task, it.sess.id, end));
          await saveTasks(`extend “${it.task.title}” until now`);
          toast(`“${it.task.title}” now runs until ${T.fmtTime(end, tz(), set().h12)}`);
          return cycle();
        }
        setStatus('Saving…');
        await EV.moveEvent(st(), it.ev, it.start, end, 'this');
        undoableEventChange(`extend “${it.ev.summary || 'event'}” until now`, it.ev, 'this');
        await afterEventChange();
        toast(`“${it.title}” now runs until ${T.fmtTime(end, tz(), set().h12)}`);
      } catch (err) { handleError(err); render(); }
}

// ======================================================================================
// "Finished early" and "Fill time since last event"
// ======================================================================================
export const nowMin = () => Math.floor(Date.now() / T.MIN) * T.MIN;
export async function itemsToday() {
  const k = T.dayKey(Date.now(), tz());
  return collectItems([k]);
}
// Started a task session late: shorten it to start when you began; optionally record what filled the time
// before, and plan the missed minutes again later (or drop them).
export async function startedLate(it0) {
  let it = it0;
  if (!it) {
    const now = Date.now();
    const list = (await itemsToday()).filter((x) => x.kind === 'chunk' && x.start < now && x.end > now + T.MIN && (x.status !== 'done' || x.sess.auto));
    if (!list.length) { toast('No task session is running right now.'); return; }
    if (list.length === 1) it = list[0];
    else {
      const k = await choose('Which session did you start late?', null, list.map((x) => ({ value: x.key, label: x.title, desc: `${T.fmtTime(x.start, tz(), set().h12)}–${T.fmtTime(x.end, tz(), set().h12)}` })));
      it = list.find((x) => x.key === k); if (!it) return;
    }
  }
  if (it.kind !== 'chunk') {
    // an event: it now starts when you began
    const at = await askStartedAt(it);
    if (at == null) return;
    try {
      const z = it.ev.start.timeZone || tz();
      await EV.updateEvent(st(), it.ev, { start: { dateTime: new Date(at).toISOString(), timeZone: z } }, 'this');
      undoableEventChange(`start “${it.title}” late`, it.ev, 'this');
      await afterEventChange();
      toast(`“${it.title}” now starts at ${hm(at)}`);
    } catch (err) { handleError(err); }
    return;
  }
  const cur = st().tasks.find((t) => t.id === it.task.id);
  const sess = S.sessions(cur).find((c) => c.id === it.sess.id);
  if (!sess) return;
  const r = await D.startedLateDialog(ctx, { task: cur, sess });
  if (!r) return;
  const missed = Math.round((r.start - sess.start) / T.MIN);
  try {
    replaceTask(S.startedLate(cur, sess.id, r.start, { reallocate: r.reallocate }));
    if (r.fill?.kind === 'task') {
      const o = st().tasks.find((t) => t.id === r.fill.taskId);
      if (o) replaceTask(S.addDoneBlock(o, sess.start, r.start));
    }
    app.pendingWhy = `you started “${cur.title}” ${T.fmtDur(missed)} late`;
    await saveTasks('started late');
    if (r.fill?.kind === 'event') {
      const cat = C.catById(set(), r.fill.catId);
      const g = r.fill.calId !== E.LOCAL_CAL;
      await saveNewEvent(r.fill.calId, { ...selBody({ start: sess.start, end: r.start }, r.fill.title, r.fill.calId), ...(cat ? C.eventCategoryChanges({}, cat) : {}), reminders: { useDefault: false, overrides: [] }, ...(g ? {} : {}) });
    }
    await cycle();
    toast(r.reallocate ? `Started ${T.fmtDur(missed)} late — the missed time is planned again later` : `Started ${T.fmtDur(missed)} late — the missed time was dropped`);
  } catch (err) { handleError(err); }
}

export async function finishedEarly(it0, choice = null) {
  let it = it0;
  if (!it) {
    const now = Date.now();
    const list = (await itemsToday()).filter((x) => !x.allDay && x.start <= now && x.end > now && (x.kind === 'chunk' ? x.status !== 'done' || x.sess.auto : x.editable && A.isOccupying(x, set())));
    if (!list.length) { toast('Nothing is going on right now.'); return; }
    if (list.length === 1) it = list[0];
    else {
      const k = await choose('Which one did you finish?', null, list.map((x) => ({ value: x.key, label: x.title, desc: `${T.fmtTime(x.start, tz(), set().h12)}–${T.fmtTime(x.end, tz(), set().h12)}` })));
      it = list.find((x) => x.key === k);
      if (!it) return;
    }
  }
  const origEnd = it.end;
  let end = nowMin();
  // already over (or you'd rather say when): ask when you finished
  if (end >= origEnd || choice === 'ask') {
    if (choice === 'ask') choice = null;
    end = await askFinishedAt(it);
    if (end == null) return;
  }
  if (end <= it.start || end >= origEnd) { toast('That isn’t running right now.'); return; }
  try {
    if (it.kind === 'chunk') {
      const cur = st().tasks.find((t) => t.id === it.task.id);
      replaceTask(S.finishEarly(cur, it.sess.id, end));
      await saveTasks('finish early');
    } else {
      const z = it.ev.end.timeZone || tz();
      await EV.updateEvent(st(), it.ev, { end: { dateTime: new Date(end).toISOString(), timeZone: z } }, 'this');
      undoableEventChange(`finish “${it.ev.summary || 'event'}” early`, it.ev, 'this');
      await E.persist(st(), ['localEvents']); E.invalidate();
    }
  } catch (err) { handleError(err); return; }
  const freeMin = Math.round((origEnd - end) / T.MIN);
  const until = T.fmtTime(origEnd, tz(), set().h12);
  if (origEnd <= Date.now()) {
    // all of it is in the past: the rest simply stays unallocated
    await cycle();
    toast(`“${it.title}” now ends at ${T.fmtTime(end, tz(), set().h12)} — ${T.fmtDur(freeMin)} left unallocated`);
    return { finished: it.title, endedAt: T.toDTInput(end, tz()).replace('T', ' '), freedMinutes: freeMin, then: 'free' };
  }
  const restFrom = Math.max(end, nowMin());
  const v = choice || await choose(`Finished ${T.fmtDur(freeMin)} early`, `“${it.title}” now ends at ${T.fmtTime(end, tz(), set().h12)}. What should happen until ${until}?`, [
    { value: 'fill', label: 'Move tasks up', desc: 'Pull your next task sessions into this time.' },
    { value: 'free', label: 'Leave it free', desc: `Nothing gets scheduled until ${until}.` },
  ], { cancel: 'Decide later' });
  if (v === 'fill') await fillGap(restFrom, origEnd);
  else if (v === 'free') {
    set().holds = [...(set().holds || []).filter((h) => h.end > Date.now() - T.DAY), { id: S.newId('h'), start: restFrom, end: origEnd }];
    await E.persist(st(), ['settings']);
    toast(`Kept free until ${until}`);
  }
  await cycle();
  return { finished: it.title, endedAt: T.toDTInput(end, tz()).replace('T', ' '), freedMinutes: freeMin, then: v || 'nothing' };
}
// When did you finish? (a time between the start and the planned end, at most now)
// Pick one time inside an item (its day; past midnight when earlier than the start). `ok(t)` decides which times are
// allowed, `say(t, ok)` the line under the field. Resolves with the time, or undefined if cancelled.
function pickTimeFor(it, { cls, heading, note, label, def, ok, say, button }) {
  const z = tz(), dt = (ms) => T.toDTInput(ms, z);
  return modal(`<form class="choice pick-time ${cls}"><h2>${heading}</h2>
      <p class="muted small" style="margin:0">${esc(it.title)} — planned ${esc(T.fmtTime(it.start, z, set().h12))}–${esc(T.fmtTime(it.end, z, set().h12))}. ${note}</p>
      <label class="field"><span>${label}</span><input type="time" name="t" value="${dt(def).slice(11, 16)}" step="300" required></label>
      <p class="muted small fa-say" style="margin:0"></p>
      <div class="actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">${button}</button></div></form>`,
  (dlg, close) => {
    const f = $('form', dlg);
    const read = () => { let t = T.atTime(T.dayKey(it.start, z), f.t.value || '00:00', z); if (t <= it.start) t = T.atTime(T.addDays(T.dayKey(it.start, z), 1), f.t.value || '00:00', z); return t; };
    const upd = () => { const t = read(); $('.fa-say', dlg).textContent = say(t, ok(t)); };
    f.addEventListener('input', upd); upd();
    f.onsubmit = (e) => { e.preventDefault(); const t = read(); if (ok(t)) close(t); };
  }, { cls: 'narrow' });
}
const hm = (ms) => T.fmtTime(ms, tz(), set().h12);
// When did you finish? (between the start and the planned end, at most now)
function askFinishedAt(it) {
  const max = Math.min(it.end - T.MIN, nowMin());
  return pickTimeFor(it, { cls: 'fin-at-f', heading: '⏹ When did you finish?', note: 'It will end then; the rest is left unallocated.', label: 'Finished at', button: '⏹ Finish then',
    def: Math.max(it.start + 5 * T.MIN, Math.min(max, Math.floor((it.start + (it.end - it.start) / 2) / (5 * T.MIN)) * 5 * T.MIN)),
    ok: (t) => t > it.start && t < it.end && t <= Date.now(),
    say: (t, good) => (good ? `${T.fmtDur(Math.round((it.end - t) / T.MIN))} early` : `Pick a time between ${hm(it.start)} and ${hm(Math.min(it.end, Date.now()))}.`) });
}
// When did you start? (after the planned start, at most now)
function askStartedAt(it) {
  return pickTimeFor(it, { cls: 'start-at-f', heading: '⏰ When did you start?', note: 'It will start then.', label: 'Started at', button: '⏰ Start then',
    def: Math.min(it.end - 5 * T.MIN, Math.floor(Date.now() / (5 * T.MIN)) * 5 * T.MIN),
    ok: (t) => t > it.start && t < it.end - T.MIN && t <= Date.now() + T.MIN,
    say: (t, good) => (good ? `${T.fmtDur(Math.round((t - it.start) / T.MIN))} late` : `Pick a time between ${hm(it.start)} and ${hm(Math.min(it.end, Date.now()))}.`) });
}
// Pull upcoming sessions (most important first) into [start, end).
async function fillGap(start, end) {
  const s = set(), brk = (+s.breakMinutes || 0) * T.MIN;
  let pos = start;
  const moved = [];
  for (const t0 of S.sortTasks(st().tasks.filter((t) => !t.archived))) {
    if (end - pos < 10 * T.MIN) break;
    const t = st().tasks.find((x) => x.id === t0.id);
    const next = S.sessions(t).filter((c) => c.kind === 'planned' && c.start >= start).sort((a, b) => a.start - b.start)[0];
    if (!next) continue;
    const len = Math.min(next.minutes, Math.floor((end - pos) / T.MIN));
    if (len < 10) continue;
    replaceTask(S.pinSession(t, next.id, pos, pos + len * T.MIN));
    moved.push(`${t.title} (${T.fmtDur(len)})`);
    pos += len * T.MIN + brk;
  }
  if (!moved.length) { toast('No upcoming task sessions to move up.'); return; }
  await saveTasks('move tasks up');
  toast(`Moved up: ${moved.join(', ')}`, { ms: 7000 });
}
// The end of your last event (today or yesterday, at most 12 hours ago) — e.g. at 6:00 you can record that you
// slept since 22:00 the evening before.
const LOOKBACK = 12 * T.HOUR;
// `ref` = the time to look back from (the start of the slot you're creating; default: now). The new start is that
// event's end plus the buffer from Settings (0–15 min).
// Tapping an empty spot between two events: a gap of up to 4 hours is filled from the end of the one before
// ("since last event") to the start of the next ("till next event"); a longer gap gets the side the tap is closer to.
export function smartSlot(tapAt, sel) {
  const s = set(), z = tz(), len = Math.max(5, +s.defaultEventMinutes || 60) * T.MIN;
  const bufA = Math.max(0, Math.min(15, +s.sinceLastBuffer || 0)) * T.MIN, bufB = Math.max(0, Math.min(15, +(s.tillNextBuffer ?? s.sinceLastBuffer) || 0)) * T.MIN;
  const all = [...(app.items?.values?.() || [])].filter((x) => !x.allDay && !x.declined && x.end > x.start && A.isOccupying(x, s));
  if (all.some((x) => x.start <= tapAt && x.end > tapAt)) return sel; // (on an event: nothing to fill)
  const before = all.filter((x) => x.end <= tapAt && x.end > tapAt - LOOKBACK), after = all.filter((x) => x.start > tapAt && x.start < tapAt + LOOKBACK);
  if (!before.length || !after.length) return sel;
  const prev = before.reduce((p, x) => (x.end > p.end ? x : p)), next = after.reduce((p, x) => (x.start < p.start ? x : p));
  const a = prev.end + bufA, b = next.start - bufB;
  if (b - a < 5 * T.MIN) return sel;
  const fmt = (ms) => T.fmtTime(ms, z, s.h12);
  if (next.start - prev.end <= 4 * T.HOUR) return { ...sel, start: a, end: b, note: `Fills the gap: since “${prev.title}” (${fmt(prev.end)}) till “${next.title}” (${fmt(next.start)})` };
  if (tapAt - prev.end <= next.start - tapAt) return { ...sel, start: a, end: Math.min(b, a + len), note: `Starts when “${prev.title}” ended (${fmt(prev.end)})` };
  return { ...sel, start: Math.max(a, b - len), end: b, note: `Ends when “${next.title}” starts (${fmt(next.start)})` };
}
export async function lastEventEnd({ ref = null, exclude = null } = {}) {
  const now = nowMin(), z = tz();
  const at = ref ?? now, day = T.dayKey(at, z);
  const buf = Math.max(0, Math.min(15, +set().sinceLastBuffer || 0)) * T.MIN;
  const items = (await collectItems([T.addDays(day, -1), day])).filter((x) => !x.allDay && x.key !== exclude && x.end <= at && x.end > at - LOOKBACK && A.isOccupying(x, set()));
  if (!items.length) return { start: at - LOOKBACK, end: now, found: false, note: 'No event in the 12 hours before — starting 12 hours earlier; adjust the start as needed.' };
  const last = items.reduce((a, b) => (b.end > a.end ? b : a));
  const start = Math.min(last.end + buf, at - 5 * T.MIN);
  const when = T.dayKey(last.end, z) === day ? T.fmtTime(last.end, z, set().h12) : `${T.dayKey(last.end, z) === T.addDays(day, -1) ? 'the day before' : T.format(last.end, z, { weekday: 'short' })} ${T.fmtTime(last.end, z, set().h12)}`;
  return { start, end: now, found: true, note: `From “${last.title}” (ended ${when})${buf ? ` + ${buf / T.MIN} min` : ''}` };
}
// "Till next event": the start of the next event after `ref` (looking ahead up to 12 hours), minus the buffer.
export async function nextEventStart({ ref, exclude = null } = {}) {
  const z = tz(), at = ref ?? nowMin(), day = T.dayKey(at, z);
  const buf = Math.max(0, Math.min(15, +(set().tillNextBuffer ?? set().sinceLastBuffer) || 0)) * T.MIN;
  const items = (await collectItems([day, T.addDays(day, 1)])).filter((x) => !x.allDay && x.key !== exclude && x.start > at && x.start <= at + LOOKBACK && A.isOccupying(x, set()));
  if (!items.length) return { found: false, note: 'No event in the 12 hours after this — set the end yourself.' };
  const next = items.reduce((a, b) => (b.start < a.start ? b : a));
  const end = Math.max(next.start - buf, at + 5 * T.MIN);
  const when = T.dayKey(next.start, z) === day ? T.fmtTime(next.start, z, set().h12) : `${T.format(next.start, z, { weekday: 'short' })} ${T.fmtTime(next.start, z, set().h12)}`;
  return { found: true, end, note: `Until “${next.title}” (starts ${when})${buf ? ` − ${buf / T.MIN} min` : ''}` };
}
