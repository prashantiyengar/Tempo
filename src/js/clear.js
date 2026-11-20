// Three ways of taking things off the calendar:
//  · Abandon the rest of a task — from a session on: a book is set aside (the Bookcase keeps how far you got and can
//    plan the rest later), a repeating task ends there, any other task's remaining work goes to the Graveyard.
//  · ☢ Clear the schedule of a day (or some hours of it): events are deleted, task sessions move to other times.
//  · Envelop: a new event over time that already has events becomes several blocks around them.
import * as T from './tz.js';
import * as S from './scheduler.js';
import * as E from './engine.js';
import * as EV from './events.js';
import { $, $$, esc, choose, modal, setHTML } from './ui.js';
import { app, set, st, tz } from './core.js';
import { collectItems, cycle, render, replaceTask, saveTasks, syncSharedSoon, toast } from './app.js';
import { handleError, setStatus } from './status.js';
import { pushUndo } from './undo.js';
import { addToGraveyard } from './sidebar.js';

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ———————————————————————————————— Abandon the rest ————————————————————————————————
// The sessions that go: this one and every later one not done yet.
export function restOf(task, me, now = Date.now()) {
  return S.sessions(task).filter((c) => c.start >= me.start && c.kind !== 'done' && c.kind !== 'waived' && !(c.kind === 'pinned' && c.end <= now));
}
export async function abandonRest(taskId, sessId = null, { ask = true } = {}) {
  const now = Date.now();
  const cur = st().tasks.find((t) => t.id === taskId); if (!cur) return null;
  const all = S.sessions(cur);
  const pick = (sessId && all.find((c) => c.id === sessId)) || all.find((c) => c.kind !== 'done' && c.kind !== 'waived' && c.end > now);
  if (!pick) return null;
  // A session under way (or already done) stays and runs to its end; what's abandoned are the ones after it.
  const keep = (pick.start <= now && pick.end > now) || pick.kind === 'done' || pick.kind === 'waived' ? pick : null;
  const me = keep ? all.find((c) => c.id !== keep.id && c.start >= keep.start && c.kind !== 'done' && c.kind !== 'waived' && c.end > now) : pick;
  if (!me) { if (ask) toast('Nothing after this session to abandon.'); return null; }
  const at = keep ? Math.max(now, keep.end) : now;   // progress as of the end of the session under way
  const withKeep = (t) => (keep && keep.kind === 'planned' ? S.pinSession(t, keep.id, keep.start, keep.end) : t);
  const n = restOf(cur, me, now).length;
  const p = S.progress(withKeep(cur), at);
  const reading = cur.kind === 'reading' && !cur.repeat;
  const graveAll = !reading && !cur.repeat && p.done <= 0;
  const left = Math.max(0, p.total - p.done);
  if (ask) {
    const r = cur.reading || {}, pages = Math.max(0, (+r.pages || 0) - Math.max(0, (+r.startPage || 1) - 1));
    const msg = reading
      ? `${keep ? `This session stays; the ${plural(n, 'session')} after it come${n === 1 ? 's' : ''}` : `This session and the ${n > 1 ? `${n - 1} after it` : 'ones after it'} come`} off the calendar. The Bookcase keeps what you've read (${cur.reading?.format === 'audio' ? `${p.pct}%` : `about ${Math.round(pages * p.pct / 100)} of ${pages} pages`}) and can plan the rest of the book later.`
      : cur.repeat ? `The series ends ${keep ? 'with this session' : 'before this session'}; ${plural(n, 'upcoming session')} come${n === 1 ? 's' : ''} off the calendar. What's done stays.`
      : graveAll ? `Nothing of it is done yet, so the whole task moves to the Graveyard (${plural(n, 'session')} come off the calendar). You can reschedule it from there.`
      : `${keep ? `This session stays; the ${plural(n, 'session')} after it` : plural(n, 'session')} come${n === 1 ? 's' : ''} off the calendar; what's done stays. The remaining ${T.fmtDur(Math.round(left))} goes to the Graveyard, where you can reschedule it.`;
    const v = await choose(reading ? `Stop reading “${cur.title}” here?` : `Abandon the rest of “${cur.title}”?`, msg,
      [{ value: 'yes', primary: true, label: reading ? 'Yes, set the book aside' : cur.repeat ? 'Yes, end the series here' : 'Yes, abandon the rest' }]);
    if (v !== 'yes') return null;
  }
  const t0 = st().tasks.find((t) => t.id === taskId); if (!t0) return null;
  const cat = t0.categoryId ? { catId: t0.categoryId } : {};
  if (graveAll) {
    await addToGraveyard({ id: S.newId('g'), text: t0.title, kind: 'task', taskId: t0.id, addedAt: now, created: t0.created || now, ...(S.totalMinutes(t0) > 0 ? { minutes: S.totalMinutes(t0) } : {}), ...cat });
    st().orphanGids.push(...[...(t0.planned || []), ...(t0.frozen || [])].map((c) => c.gid).filter(Boolean), ...(t0.orphanGids || []));
    st().tasks = st().tasks.filter((x) => x.id !== t0.id);
    st().tombstones = [...(st().tombstones || []), t0.id].slice(-300);
    delete st().acks[t0.id];
    await saveTasks(`graveyard "${t0.title}"`);
    toast(`⛔ “${t0.title}” moved to the Graveyard`);
  } else {
    const t = S.abandonFrom(withKeep(t0), me.id, at, set());
    replaceTask(t);
    await saveTasks(`abandon the rest of "${t0.title}"`);
    if (!reading && !t0.repeat && left > 0) await addToGraveyard({ id: S.newId('g'), text: t0.title, kind: 'task', taskId: t0.id, addedAt: now, created: t0.created || now, minutes: Math.round(left), ...cat });
    toast(reading ? `📖 “${t0.title}” set aside — reschedule the rest from the Bookcase` : t0.repeat ? `“${t0.title}” ends here — ${plural(n, 'session')} removed` : `⛔ Rest of “${t0.title}” abandoned — ${T.fmtDur(Math.round(left))} moved to the Graveyard`, { ms: 6000 });
  }
  cycle();
  return { task: t0.title, removed: n, as: graveAll ? 'graveyard' : reading ? 'set aside' : t0.repeat ? 'series ended' : 'rest to graveyard', ...(graveAll || reading || t0.repeat ? {} : { graveyardMinutes: Math.round(left) }) };
}
// A set-aside book planned again: by when should the rest be read?
export async function resumeBook(taskId, deadline = null) {
  const cur = st().tasks.find((t) => t.id === taskId); if (!cur?.abandoned) return null;
  const z = tz(), now = Date.now();
  const firstStart = Math.min(...(cur.frozen || []).map((c) => c.start), cur.abandoned.at);
  const span = Math.max(7 * T.DAY, Math.min(90 * T.DAY, (+cur.deadline || now) - firstStart));
  const leftShare = Math.max(0.1, 1 - (cur.abandoned.pct || 0) / 100);
  const defKey = T.dayKey(now + Math.max(7 * T.DAY, span * leftShare), z);
  const hm = T.hhmm(T.minutesOfDay(+cur.deadline || T.atTime(defKey, '17:00', z), z)) || '17:00';
  if (deadline == null) {
    const k = await modal(`<form class="choice resume-book"><h2>Read the rest of “${esc(cur.title)}”</h2>
      <p class="muted">${cur.abandoned.pages ? `You read about ${cur.abandoned.read} of ${cur.abandoned.pages} pages (${cur.abandoned.pct}%).` : `You got ${cur.abandoned.pct}% through.`} The rest (${T.fmtDur(cur.abandoned.leftMin || 0)}) will be planned again.</p>
      <label class="field"><span>Finish by</span><input type="date" name="d" value="${defKey}" min="${T.dayKey(now, z)}" required></label>
      <div class="actions"><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn primary">Plan the rest</button></div></form>`, (dlg, close) => {
      $('form', dlg).addEventListener('submit', (e) => { e.preventDefault(); close($('[name=d]', dlg).value); });
    }, { cls: 'narrow' });
    if (!k) return null;
    deadline = T.atTime(k, hm, z);
  }
  replaceTask(S.resumeAbandoned(cur, deadline, now));
  await saveTasks(`reschedule the rest of "${cur.title}"`);
  toast(`📖 The rest of “${cur.title}” is planned again`);
  await cycle();
  return { task: cur.title, by: deadline };
}

// ———————————————————————————————— ☢ Clear the schedule ————————————————————————————————
// What clearing [a, b) would take away: events (yours to change; not sleep blocks Tempo keeps) and task sessions not done.
const isSleep = (it) => !!it.ev?.extendedProperties?.private?.tempoSleep;
export async function clearTargets(key, a, b, only = 'all') {
  const items = (await collectItems([key])).filter((it) => !it.allDay && it.start >= a && it.start < b);
  const events = only === 'tasks' ? [] : items.filter((it) => it.kind === 'event' && it.editable && !it.declined && !it.ev?.extendedProperties?.private?.tempoTask && !isSleep(it));
  const sessions = only === 'events' ? [] : items.filter((it) => it.kind === 'chunk' && it.status !== 'done' && it.status !== 'waived');
  return { events, sessions };
}
// The range a day is cleared over: the whole day, or what's left of it today; or the hours given.
export function clearRange(key, from = '', to = '') {
  const z = tz(), now = Date.now();
  const d0 = T.dayStart(key, z), d1 = T.dayStart(T.addDays(key, 1), z);
  let a = from ? T.atTime(key, from, z) : d0;
  let b = to && to !== '24:00' && to !== '23:59' ? T.atTime(key, to, z) : d1;
  if (!from && T.dayKey(now, z) === key) a = Math.floor(now / T.MIN) * T.MIN;
  a = Math.max(d0, a); b = Math.min(d1, b);
  return [a, b];
}
export async function clearSchedule({ day = null, from = '', to = '', only = 'all' } = {}) {
  const z = tz(), key = day || T.dayKey(Date.now(), z);
  const [a, b] = clearRange(key, from, to);
  if (!(b > a)) return { cleared: 0, error: 'Nothing left of that time to clear.' };
  const { events, sessions } = await clearTargets(key, a, b, only);
  const before = st().tasks.filter((t) => sessions.some((it) => it.task.id === t.id)).map((t) => JSON.parse(JSON.stringify(t)));
  const holdsBefore = [...(set().holds || [])];
  // task sessions: pinned ones go back into the plan, and the time is kept free so they move elsewhere
  if (only !== 'events') {
    for (const it of sessions) { const t = st().tasks.find((x) => x.id === it.task.id); if (t && it.status === 'pinned') replaceTask(S.unpinSession(t, it.sess.id)); }
    set().holds = [...(set().holds || []).filter((h) => h.end > Date.now() - T.DAY), { id: S.newId('h'), start: a, end: b, label: 'Cleared' }];
    await E.persist(st(), ['settings']);
    syncSharedSoon();
    await saveTasks(false);
  }
  let gone = 0;
  const copies = [];
  if (events.length) setStatus('Clearing…', 'busy');
  for (const it of events) {
    try {
      await EV.deleteEvent(st(), it.ev, 'this'); gone++;
      if (!it.ev.recurringEventId) copies.push(JSON.parse(JSON.stringify(it.ev)));
    } catch (err) { handleError(err); }
  }
  await E.persist(st(), ['localEvents']);
  E.invalidate();
  setStatus('');
  pushUndo('clear the schedule', async () => {
    for (const ev of copies) { try { await EV.createEvent(st(), ev._calId, ev); } catch (err) { handleError(err); } }
    if (only !== 'events') {
      set().holds = holdsBefore; await E.persist(st(), ['settings']); syncSharedSoon();
      st().tasks = st().tasks.map((t) => before.find((x) => x.id === t.id) || t); await saveTasks(false);
    }
    await E.persist(st(), ['localEvents']); E.invalidate(); await render(); cycle();
  });
  const span = `${T.fmtTime(a, z, set().h12)}–${b >= T.dayStart(T.addDays(key, 1), z) ? 'midnight' : T.fmtTime(b, z, set().h12)}`;
  const what = [only !== 'tasks' ? plural(gone, 'event') + ' deleted' : '', only !== 'events' ? `${plural(sessions.length, 'task session')} moved elsewhere` : ''].filter(Boolean).join(' · ');
  toast(`☢ Cleared ${span} — ${what}`, { ms: 7000 });
  await render();
  cycle();
  return { day: key, from: T.toDTInput(a, z).replace('T', ' '), to: T.toDTInput(b, z).replace('T', ' '), eventsDeleted: gone, sessionsMoved: only === 'events' ? 0 : sessions.length, keptFree: only !== 'events' };
}
// The dialog: which day, the whole day (what's left of today) or some hours, and tasks / events / everything.
export async function openClearDay(key0 = null) {
  const z = tz(), today = T.dayKey(Date.now(), z);
  const key = key0 || (app.view === 'day' && app.cursor >= today ? app.cursor : today);
  const nowHM = T.hhmm(T.minutesOfDay(Date.now(), z));
  const r = await modal(`<form class="choice clear-day"><h2>☢ Clear the schedule</h2>
    <p class="muted small">Events are deleted (one occurrence of a repeating event); task sessions move to other times and nothing new is planned here. Undo puts it back.</p>
    <label class="field"><span>Day</span><input type="date" name="day" value="${key}"></label>
    <div class="cd-span">
      <label class="chk"><input type="radio" name="span" value="day" checked> <span class="cd-day-l"></span></label>
      <label class="chk"><input type="radio" name="span" value="hours"> Only between
        <input type="time" name="from" value="${key === today ? nowHM : '09:00'}" step="300"> and <input type="time" name="to" value="17:00" step="300"></label>
    </div>
    <div class="cd-only">
      <label class="chk"><input type="radio" name="only" value="all" checked> Everything</label>
      <label class="chk"><input type="radio" name="only" value="tasks"> Only tasks</label>
      <label class="chk"><input type="radio" name="only" value="events"> Only events</label>
    </div>
    <p class="cd-preview small"></p>
    <div class="cd-holds small"></div>
    <div class="actions"><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn danger cd-go">☢ Clear</button></div>
  </form>`, (dlg, close) => {
    const f = $('form', dlg);
    const opts = () => ({ day: f.day.value || today, from: f.span.value === 'hours' ? f.from.value : '', to: f.span.value === 'hours' ? f.to.value : '', only: f.only.value });
    let seq = 0;
    const preview = async () => {
      const o = opts(), my = ++seq;
      $('.cd-day-l', dlg).textContent = o.day === today ? 'The rest of today (from now)' : 'The whole day';
      const [a, b] = clearRange(o.day, o.from, o.to);
      if (!(b > a)) { $('.cd-preview', dlg).textContent = 'That time is already over.'; $('.cd-go', dlg).disabled = true; return; }
      const { events, sessions } = await clearTargets(o.day, a, b, o.only);
      if (my !== seq) return;
      const parts = [o.only !== 'tasks' ? plural(events.length, 'event') : '', o.only !== 'events' ? plural(sessions.length, 'task session') : ''].filter(Boolean);
      $('.cd-preview', dlg).textContent = `${T.fmtTime(a, z, set().h12)}–${b >= T.dayStart(T.addDays(o.day, 1), z) ? 'midnight' : T.fmtTime(b, z, set().h12)}: ${parts.join(' and ')}${events.length + sessions.length ? ' will be cleared.' : ' — nothing to clear.'}`;
      $('.cd-go', dlg).disabled = !(events.length + sessions.length) && o.only === 'events';
      // time kept free on that day (cleared before, or after finishing early) can be given back to tasks
      const d0 = T.dayStart(o.day, z), d1 = T.dayStart(T.addDays(o.day, 1), z);
      const hs = (set().holds || []).filter((h) => h.end > d0 && h.start < d1 && h.end > Date.now());
      setHTML($('.cd-holds', dlg), hs.map((h) => `<div class="row">🛡 Kept free ${esc(T.fmtTime(h.start, z, set().h12))}–${esc(T.fmtTime(h.end, z, set().h12))}<span class="grow"></span><button type="button" class="link cd-free" data-id="${esc(h.id)}">Let tasks back in</button></div>`).join(''));
      $$('.cd-free', dlg).forEach((btn) => (btn.onclick = async () => {
        set().holds = (set().holds || []).filter((h) => h.id !== btn.dataset.id);
        await E.persist(st(), ['settings']); syncSharedSoon(); toast('Tasks can be planned there again'); cycle(); preview();
      }));
    };
    f.addEventListener('change', preview);
    f.addEventListener('submit', (e) => { e.preventDefault(); close(opts()); });
    preview();
  }, { cls: 'narrow' });
  if (!r) return null;
  return clearSchedule(r);
}

// ———————————————————————————————— Envelop ————————————————————————————————
// The free pieces of [a, b) around what's already there (each at least 5 minutes).
export function envelopPieces(a, b, busy) {
  const out = [];
  let t = a;
  for (const x of S.merge(busy.map((x) => ({ start: Math.max(a, x.start), end: Math.min(b, x.end) })).filter((x) => x.end > x.start))) {
    if (x.start - t >= 5 * T.MIN) out.push([t, x.start]);
    t = Math.max(t, x.end);
  }
  if (b - t >= 5 * T.MIN) out.push([t, b]);
  return out;
}
// A new timed, one-off event over time that already has events: one event as it is, or envelop them (several
// blocks in the free time around them). Resolves with the list of [start, end] to create, or null (cancelled).
export async function askEnvelop(body) {
  if (!body?.start?.dateTime || body.recurrence?.length) return null;
  const a = Date.parse(body.start.dateTime), b = Date.parse(body.end.dateTime), z = tz();
  const days = []; for (let k = T.dayKey(a, z); k <= T.dayKey(b - 1, z); k = T.addDays(k, 1)) days.push(k);
  const there = (await collectItems(days)).filter((it) => it.kind === 'event' && !it.allDay && !it.declined && it.ev?.transparency !== 'transparent'
    && !it.ev?.extendedProperties?.private?.tempoTask && it.start < b && it.end > a)
    .sort((x, y) => x.start - y.start);
  if (!there.length) return null;
  const pieces = envelopPieces(a, b, there);
  const h12 = set().h12, tm = (ms) => T.fmtTime(ms, z, h12);
  const list = there.slice(0, 4).map((it) => `${tm(it.start)}–${tm(it.end)} ${it.title}`).join(', ') + (there.length > 4 ? ` and ${there.length - 4} more` : '');
  const opts = [];
  if (pieces.length) opts.push({ value: 'wrap', primary: true, label: `Envelop ${there.length === 1 ? 'it' : 'them'}: ${plural(pieces.length, 'block')}`, desc: `${pieces.map(([x, y]) => `${tm(x)}–${tm(y)}`).join(', ')} — what's already there stays as it is.` });
  opts.push({ value: 'one', label: 'One event over it all', desc: `${tm(a)}–${tm(b)}, overlapping what's there.` });
  const v = await choose(`“${body.summary}” overlaps ${plural(there.length, 'event')}`, `Already there: ${list}.`, opts, { cancel: 'Cancel' });
  if (!v) return 'cancel';
  return v === 'wrap' ? pieces : null;
}
