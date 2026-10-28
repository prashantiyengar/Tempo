// Automatic blocks (sleep and fill-in blocks) and the background job runner.
import * as T from './tz.js';
import * as S from './scheduler.js';
import * as E from './engine.js';
import * as EV from './events.js';
import * as G from './gcal.js';
import * as C from './categories.js';
import * as I from './items.js';
import { app, set, st, tz } from './core.js';
import { collectItems, ctx, render, syncSharedSoon, toast } from './app.js';
import { handleError } from './status.js';

// ======================================================================================
// Automatic blocks: sleep (each night that has passed, in your sleep hours) and fill-in blocks (unplanned time in a
// window, e.g. "Childcare" 18:00–20:00) — one engine. Once a window (plus the wait you chose) is over, each gap of
// 15 min or more in it becomes an event of its category, around anything already there (an event from 2–3 am gives
// sleep 23:00–02:00 and 03:00–07:00). Optional: skip the day if anything at all is planned in the window.
// ======================================================================================
// A background job that runs at most every `every` ms (unless forced) and never twice at once
export function job(fn, { every = 2 * T.MIN, quiet = false } = {}) {
  let at = 0, busy = false;
  return async ({ force = false } = {}) => {
    if (busy || (!force && Date.now() - at < every)) return;
    busy = true; at = Date.now();
    try { return await fn(); } catch (err) { if (quiet) console.warn('Tempo: background job', err); else handleError(err); } finally { busy = false; }
  };
}
// The windows of a rule on the days fromDay…toDay: { d, st, en, due }
export function fillWindows(r, z, now, fromDay, toDay) {
  const out = [];
  for (let d = fromDay; d <= toDay; d = T.addDays(d, 1)) {
    if (r.since && d < r.since) continue;
    const wd = new Date(T.dayStart(d, z) + 12 * T.HOUR).getUTCDay();
    if (r.days?.length && !r.days.includes(wd)) continue;
    const st0 = T.atTime(d, r.from, z), en = T.parseHHMM(r.to) > T.parseHHMM(r.from) ? T.atTime(d, r.to, z) : T.atTime(T.addDays(d, 1), r.to, z);
    out.push({ d, st: st0, en, due: en + (+r.delayMin || 0) * T.MIN });
  }
  return out;
}
// All the automatic-block rules: sleep (if on) first, then your fill-in blocks. Each knows how its events are tagged
// (so another device's copy is recognised), what to call them and where "done" days are remembered.
function autoRules(s = set()) {
  const out = [];
  if (s.sleepEvents) {
    const cat = s.sleepCategory && C.catById(s, s.sleepCategory);
    out.push({ id: 'sleep', from: s.sleepStart || '23:00', to: s.sleepEnd || '07:00', delayMin: s.sleepDelayMin, since: s.sleepEventsFrom || T.addDays(T.dayKey(Date.now(), tz()), -1),
      cat, cal: s.sleepCal, tag: 'tempoSleep', key: (d) => d, title: `${cat?.icon && cat.icon !== '😴' ? cat.icon + ' ' : ''}😴 Sleep`, doneKey: 'sleepDone', keep: 40, label: 'sleep block' });
  }
  for (const r of s.autoFills || []) {
    if (r.on === false || !r.from || !r.to || !r.catId) continue;
    const cat = C.catById(s, r.catId);
    out.push({ ...r, cat, tag: 'tempoFill', key: (d) => `${r.id}:${d}`, title: `${cat?.icon ? cat.icon + ' ' : ''}${(r.name || '').trim() || cat?.name || 'Fill-in'}`, doneKey: 'autoFillDone', keep: 200, label: (r.name || '').trim() || cat?.name || 'fill-in block' });
  }
  return out;
}
export const autoBlocks = job(async () => {
  const s = set(), rules = autoRules(s);
  if (!rules.length) return;
  const z = tz(), now = Date.now(), today = T.dayKey(now, z);
  const done = { sleepDone: new Set(s.sleepDone || []), autoFillDone: new Set(s.autoFillDone || []) };
  const jobs = [];
  for (const r of rules) for (const w of fillWindows(r, z, now, T.addDays(today, -3), today)) if (w.due <= now && !done[r.doneKey].has(r.key(w.d))) jobs.push({ r, ...w });
  if (!jobs.length) return;
  jobs.sort((a, b) => a.st - b.st);
  const items = await collectItems([jobs[0].d, T.addDays(jobs[jobs.length - 1].d, 1)]);
  const made = {};
  for (const j of jobs) {
    const key = j.r.key(j.d), mark = (x) => x.ev?.extendedProperties?.private?.[j.r.tag];
    const inWin = items.filter((it) => !it.allDay && it.end > j.st && it.start < j.en && !it.declined && !I.isWaived(it));
    if (inWin.some((it) => mark(it) === key)) { done[j.r.doneKey].add(key); continue; } // already there (another device)
    const busy = S.merge(inWin.filter((it) => I.takesTime(it)).map((it) => ({ start: Math.max(it.start, j.st), end: Math.min(it.end, j.en) })));
    if (j.r.skipIfAny && busy.length) { done[j.r.doneKey].add(key); continue; }
    const cal = j.r.cal === 'local' ? E.LOCAL_CAL : ctx.defaultCalendar(), cat = j.r.cat;
    for (const g of S.subtract([{ start: j.st, end: j.en }], busy).filter((g) => g.end - g.start >= 15 * T.MIN)) {
      const priv = { [j.r.tag]: key, ...(cat ? { tempoCategory: cat.id, tempoCatName: cat.name, tempoCatColor: cat.color, tempoCatIcon: cat.icon || '' } : {}) };
      await EV.createEvent(st(), cal, { ...(cat ? { colorId: G.nearestColorId(cat.color) } : {}), summary: j.r.title, start: { dateTime: new Date(g.start).toISOString(), timeZone: z }, end: { dateTime: new Date(g.end).toISOString(), timeZone: z },
        transparency: 'opaque', reminders: { useDefault: false, overrides: [] }, extendedProperties: { private: priv } });
      made[j.r.label] = (made[j.r.label] || 0) + 1;
    }
    done[j.r.doneKey].add(key);
  }
  s.sleepDone = [...done.sleepDone].sort().slice(-40);
  s.autoFillDone = [...done.autoFillDone].sort().slice(-200);
  await E.persist(st(), ['settings', 'localEvents']); syncSharedSoon();
  const parts = Object.entries(made);
  if (parts.length) {
    E.invalidate(); await render();
    const n = (k, v) => (k === 'sleep block' ? `${v} sleep block${v > 1 ? 's' : ''}` : `${v} × ${k}`);
    toast(parts.length === 1 && parts[0][0] === 'sleep block' ? `😴 Added ${n(...parts[0])} for last night` : `Filled ${parts.reduce((a, [, v]) => a + v, 0)} gap${parts.reduce((a, [, v]) => a + v, 0) > 1 ? 's' : ''}: ${parts.map(([k, v]) => n(k, v)).join(', ')}`, { ms: 4000 });
  }
});
// Run the automatic blocks again right when the next one is due (they also run after every refresh)
export function scheduleAutoBlocks() {
  clearTimeout(app.autoBlockT);
  const s = set(), z = tz(), now = Date.now(), today = T.dayKey(now, z);
  const dues = [];
  for (const r of autoRules(s)) for (const w of fillWindows(r, z, now, T.addDays(today, -1), T.addDays(today, 1))) if (w.due > now && !(s[r.doneKey] || []).includes(r.key(w.d))) dues.push(w.due);
  if (!dues.length) return;
  const wait = Math.min(...dues) - now + 5000;
  if (wait < 26 * T.HOUR) app.autoBlockT = setTimeout(() => autoBlocks({ force: true }).then(scheduleAutoBlocks), Math.min(wait, 2 ** 31 - 1));
}
