// Repeating events and tasks that end: on their last day Tempo asks whether to extend them — by the length they were
// set up with (14 days, or 10 more times) or by a length you choose — or to let them end. With "extend automatically"
// on (the default, Settings → Scheduling → Planning), one that ended without an answer is extended the next day.
//   Events: the series carries tempoLast (day of its last occurrence), tempoExt ('D14' days / 'C10' times) and
//   tempoAutoExt ('1' / '0') in its private properties (event-dialog.js). Tasks: task.repeat.auto / .extend.
// What was asked or done is kept in settings.recurExt (shared), so two devices don't both extend one series; an event
// series is re-read before it is extended and left alone if another device already did.
import * as T from './tz.js';
import * as S from './scheduler.js';
import * as E from './engine.js';
import * as G from './gcal.js';
import { parseRRule, buildRRule, untilFromMs } from './rrule.js';
import { recurrenceExtent } from './dialogs.js';
import { set, st, tz } from './core.js';
import { $, esc, modal } from './ui.js';
import { collectItems, cycle, render, replaceTask, saveTasks, syncSharedSoon, toast } from './app.js';
import { job } from './autoblocks.js';

const LOCAL = E.LOCAL_CAL;
const lenLabel = (x) => (x.count ? `${x.count} more time${x.count === 1 ? '' : 's'}` : x.days % 7 === 0 ? `${x.days / 7} week${x.days === 7 ? '' : 's'}` : `${x.days} day${x.days === 1 ? '' : 's'}`);
const ext = (code) => (code?.[0] === 'C' ? { count: +code.slice(1) } : code?.[0] === 'D' ? { days: +code.slice(1) } : null);

// ---------- tasks ----------
// The day a repeating task with an end happens for the last time
export function taskLastDay(t, s) {
  const r = t.repeat;
  if (!r || !(r.count || r.until)) return null;
  const end = S.repeatEnd(t, s);
  if (!Number.isFinite(end)) return null;
  if (r.on === 'day' || (r.every === 'day' && (r.interval || 1) === 1)) {
    const ps = S.periodsOf(t, s, end - 800 * T.DAY, end);
    return ps.length ? ps[ps.length - 1].key : null;
  }
  return T.dayKey(end - 1, s.tz);
}
// how: { same: true } (the length it was set up with) or { days: n }
export function extendedTask(t, how, s) {
  const r = { ...t.repeat }, z = s.tz;
  const by = how.same ? r.extend || (r.count ? { count: r.count } : { days: 14 }) : how;
  if (by.count && r.count && !r.until) r.count += by.count;
  else {
    // until a date: the end moves on by that many days (from the old end date, or from the last day for a count)
    const endKey = r.until ? T.dayKey(r.until, z) : taskLastDay(t, s);
    const key = by.months ? T.addMonthsKeep(endKey, by.months) : T.addDays(endKey, by.days || (by.count ? by.count * 7 : 14));
    r.until = T.atTime(key, '23:59', z); delete r.count;
  }
  const nt = { ...t, repeat: r };
  return { ...nt, deadline: S.repeatEnd(nt, s) };
}

// ---------- events ----------
async function masterOf(cal, sid) {
  if (cal === LOCAL) return (st().localEvents || []).find((e) => e.id === sid) || null;
  try { return await G.getEvent(cal, sid); } catch { return null; }
}
// Extend an event series; `seenLast` = the last day we saw (skipped if it has changed meanwhile, e.g. another device)
export async function extendSeries(cal, sid, how, seenLast) {
  const m = await masterOf(cal, sid);
  if (!m || m.status === 'cancelled' || !m.recurrence?.length) return false;
  const p = m.extendedProperties?.private || {};
  if (seenLast && p.tempoLast && p.tempoLast !== seenLast) return false;
  const r = parseRRule(m.recurrence); if (!r || !(r.count || r.until)) return false;
  const z = tz(), allDay = !!m.start.date, zone = m.start.timeZone || z;
  const st0 = allDay ? T.dayStart(m.start.date, zone) : Date.parse(m.start.dateTime);
  const by = how.same ? ext(p.tempoExt) || (r.count ? { count: r.count } : { days: 14 }) : how;
  if (by.count && r.count) r.count += by.count;
  else {
    const old = r.until ? `${r.until.slice(0, 4)}-${r.until.slice(4, 6)}-${r.until.slice(6, 8)}` : p.tempoLast;
    const key = by.months ? T.addMonthsKeep(old, by.months) : T.addDays(old, by.days || 14);
    r.count = null; r.until = allDay ? key.replace(/-/g, '') : untilFromMs(T.atTime(key, '23:59', zone) + 59000);
  }
  const rec = m.recurrence.map((l) => (l.startsWith('RRULE:') ? buildRRule(r) : l));
  const e2 = recurrenceExtent(rec, st0, allDay, m.start.date, zone);
  const last = Number.isFinite(e2.end) ? T.dayKey(e2.end, zone) : '';
  const props = { ...p, tempoLast: last };
  if (cal === LOCAL) { Object.assign(m, { recurrence: rec, extendedProperties: { ...(m.extendedProperties || {}), private: props } }); await E.persist(st(), ['localEvents']); }
  else await G.patchEvent(cal, sid, { recurrence: rec, extendedProperties: { private: props } });
  E.invalidate();
  return last;
}

// ---------- the question on the last day ----------
function ask({ title, what, len, auto }) {
  return modal(`<form class="choice recur-ext"><h2>🔁 “${esc(title)}” ${what === 'task' ? 'repeats for the last time today' : 'ends today'}</h2>
      <p class="muted">Extend it? ${auto ? `If you don't choose, it is extended by ${esc(lenLabel(len))} when it ends.` : 'Otherwise it ends today.'}</p>
      <div class="choice-list">
        <button type="button" class="choice-btn primary re-same" autofocus><strong>Extend by ${esc(lenLabel(len))}</strong><span>The same as before</span></button>
        <div class="re-custom row"><span>Extend by</span><input type="number" name="n" min="1" max="520" value="${len.days && len.days % 7 === 0 ? len.days / 7 : len.days || 2}" class="num" aria-label="How long">
          <select name="u"><option value="d">days</option><option value="w" ${!len.days || len.days % 7 === 0 ? 'selected' : ''}>weeks</option><option value="m">months</option></select>
          <button type="button" class="btn re-go">Extend</button></div>
        <button type="button" class="choice-btn re-end"><strong>Let it end</strong><span>${auto ? 'And don’t extend it automatically' : 'Nothing changes'}</span></button>
      </div>
      <div class="actions"><button type="button" class="btn ghost" data-close>${auto ? 'Decide later' : 'Close'}</button></div></form>`, (dlg, close) => {
    const f = $('form', dlg);
    $('.re-same', dlg).onclick = () => close({ same: true });
    $('.re-end', dlg).onclick = () => close({ end: true });
    $('.re-go', dlg).onclick = () => { const n = Math.max(1, Math.round(+f.n.value || 1)); close({ days: n * (f.u.value === 'w' ? 7 : f.u.value === 'm' ? 30 : 1), months: f.u.value === 'm' ? n : 0 }); };
  }, { cls: 'narrow' });
}

const mark = (key, v) => { const m = { ...(set().recurExt || {}) }; m[key] = v; const ks = Object.keys(m); for (const k of ks.slice(0, Math.max(0, ks.length - 200))) delete m[k]; set().recurExt = m; };

// Runs after each refresh: today's last days (asked once), and yesterday's (or earlier) ends (extended if automatic).
export const recurExtendCheck = job(async () => {
  const s = set(), z = tz(), today = T.dayKey(Date.now(), z), seen = s.recurExt || {};
  const list = [];
  for (const t of st().tasks) {
    if (t.archived || !t.repeat) continue;
    const last = taskLastDay(t, s);
    if (!last || last < T.addDays(today, -30)) continue;
    list.push({ what: 'task', key: `t:${t.id}:${last}`, title: t.title, last, auto: t.repeat.auto === true, len: t.repeat.extend || (t.repeat.count ? { count: t.repeat.count } : { days: 14 }), id: t.id });
  }
  const items = await collectItems([T.addDays(today, -30), today]);
  const series = new Map();
  for (const it of items) {
    const p = it.ev?.extendedProperties?.private;
    if (it.kind !== 'event' || !p?.tempoLast || !(it.ev.recurringEventId || it.ev.recurrence)) continue;
    const cal = it.ev._calId, sid = it.ev.recurringEventId || it.ev.id;
    if (!series.has(`${cal}|${sid}`)) series.set(`${cal}|${sid}`, { what: 'event', key: `e:${cal}|${sid}:${p.tempoLast}`, title: it.ev.summary || it.title, last: p.tempoLast, auto: p.tempoAutoExt === '1', len: ext(p.tempoExt) || { days: 14 }, cal, sid });
  }
  list.push(...series.values());
  let changed = false, replan = false;
  for (const x of list.sort((a, b) => a.last.localeCompare(b.last))) {
    const v = seen[x.key];
    if (v === 'extended' || v === 'ended' || x.last > today) continue;
    const doIt = async (how) => {
      if (x.what === 'task') {
        const t = st().tasks.find((y) => y.id === x.id); if (!t) return false;
        let nt = extendedTask(t, how, s);
        // (an end long past: keep going until it reaches today)
        for (let i = 0; i < 30 && taskLastDay(nt, s) < today; i++) nt = extendedTask(nt, how.same ? how : { days: how.days || 14 }, s);
        replaceTask(nt); await saveTasks(`extend “${t.title}”`); replan = true;
        return taskLastDay(nt, s);
      }
      let last = await extendSeries(x.cal, x.sid, how, x.last);
      for (let i = 0; i < 30 && last && last < today; i++) last = await extendSeries(x.cal, x.sid, how, last);
      return last;
    };
    if (x.last === today && !v) {
      if (document.querySelector('dialog[open]')) continue; // not over another dialog: next time
      mark(x.key, 'asked'); changed = true;
      const r = await ask(x);
      if (!r) continue;
      if (r.end) { mark(x.key, 'ended'); continue; }
      const last = await doIt(r.same ? { same: true } : { days: r.days, months: r.months || 0 });
      mark(x.key, 'extended');
      if (last) toast(`🔁 “${x.title}” now runs until ${T.fmtDate(T.dayStart(last, z), z)}`, { ms: 5000 });
      continue;
    }
    if (x.last < today) {
      if (!x.auto) { mark(x.key, 'ended'); changed = true; continue; }
      const last = await doIt({ same: true });
      mark(x.key, 'extended'); changed = true;
      if (last) toast(`🔁 “${x.title}” ended and was extended by ${lenLabel(x.len)} — now until ${T.fmtDate(T.dayStart(last, z), z)}`, { ms: 6000 });
    }
  }
  if (changed) { await E.persist(st(), ['settings']); syncSharedSoon(); E.invalidate(); await render(); }
  if (replan) cycle(); // plan the new sessions of an extended task
}, { every: 5 * T.MIN });
