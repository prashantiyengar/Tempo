// Splittable-task scheduler. Pure functions, no DOM / network.
//
// Task model:
// {
//   id, title, kind: 'generic' | 'reading', rank (1 = most important), deadline (ms), earliestStart (ms|null),
//   totalMinutes,                                   // generic tasks
//   reading: { pages, startPage, speed, unit: 'pph'|'ppm'|'mpp', labels: 'actual'|'relative' },
//   chunkMinutes, minChunkMinutes, maxPerDayMinutes, breakMinutes  (null -> settings defaults)
//   bounds: null | { start:'09:00', end:'17:00', days:[1,2,3,4,5] },   ignoreBounds: bool,
//   frozen:  [{ id, start, end, status: 'done'|'pinned', gid?, syncHash? }]   // fixed sessions
//   planned: [{ id, start, end, gid?, syncHash? }]                           // auto-placed sessions
//   skipped: [{ start, end }]         // slots the user deleted; never re-used for this task
//   color, calendarId, reminderMinutes, notes, created, archived
// }
import * as T from './tz.js';

export const DEFAULT_SETTINGS = {
  tz: T.systemTz(),
  weekStart: 1,
  h12: false,
  hourHeight: 48,
  bounds: { start: '09:00', end: '17:00', days: [1, 2, 3, 4, 5] },
  overflowBounds: { start: '07:00', end: '23:00', days: [0, 1, 2, 3, 4, 5, 6] },
  chunkMinutes: 60,
  minChunkMinutes: 15,     // shorter sessions are only used when full-length ones can't meet the deadline
  breakMinutes: 5,
  wiggleMinutes: 15,
  // Named time periods besides the day bounds; each is a list of rules { days, start, end }.
  periods: [
    { id: 'after-hours', name: 'After hours', rules: [
      { days: [1, 2, 3, 4, 5], start: '17:30', end: '22:00' },
      { days: [0, 6], start: '10:00', end: '20:00' },
    ] },
  ],
  sessionWarn: 20,         // ask before creating a task with more sessions than this
  sessionMax: 50,          // never create more sessions (or repeating-event occurrences) than this
  maxSpanDays: 365,        // tasks and repeating events may not extend further than this (0 = no limit)
  askCategory: true,       // ask once for a category when a new task has none
  timePrefs: { morning: ['07:00', '12:00'], afternoon: ['12:00', '17:00'], evening: ['17:00', '22:00'] }, // for category preferences
  dailyCapMinutes: 0,      // most task time per day across all tasks (0 = no cap)
  marginDays: 0,           // default safety margin: aim to finish this many days before a deadline
  repeatHorizonDays: 28,   // repeating tasks are planned this far ahead
  travelMinutes: 15,       // buffer before and after events that have a (physical) location; 0 = off
  pomodoro: { work: 25, rest: 5 },
  learnSpeed: true,        // adjust reading speed from what you report
  projects: [],            // { id, name, color, sequential, deadline }
  history: [],             // recent slips, skips, overruns (shared between devices)
  snapMinutes: 15,
  weekView: 'calendar',  // 'calendar' (Mon–Sun) or 'rolling' (today + 6 days)
  allDayBlocks: false,
  assumePastDone: true,
  taskReminderMinutes: 5,
  taskEmailReminderMinutes: null, // null = no email reminder for task sessions; a number = minutes before
  // Notification profiles (see notify.js); new events and task sessions use these unless you pick another.
  notifyProfiles: [
    { id: 'default', name: 'Default', rules: [{ method: 'popup', minutes: 10 }] },
    { id: 'important', name: 'Important', rules: [{ method: 'popup', minutes: 10 }, { method: 'email', minutes: 240 }, { method: 'email', minutes: 1440 }] },
  ],
  eventProfile: 'default',
  taskProfile: 'default',
  hoursChange: 'ask',
  sleepAssume: true,       // Analysis, full 24 hours: count this block as sleep on nights with nothing else in it
  sleepStart: '23:00',
  sleepEnd: '07:00',
  sleepCategory: null,      // category the assumed sleep counts towards (null = its own "Sleep (assumed)" group)       // when work hours or a period change: 'ask' | 'move' (re-plan sessions to fit) | 'keep'
  categories: [
    { id: 'work', name: 'Work', color: '#039be5', icon: '💼' },
    { id: 'personal', name: 'Personal', color: '#33b679', icon: '🏠' },
    { id: 'leisure', name: 'Leisure', color: '#f6bf26', icon: '🎉' },
    { id: 'study', name: 'Study', color: '#8e24aa', icon: '📚' },
  ],
  settingsVersion: 3,
  notifyTasks: true,
  notifyLocal: true,
  notifyGoogle: false,
  taskCalendarId: null,
  busyCalendars: null,      // null = every visible calendar counts as busy
  hiddenCalendars: [],
  syncTasksToGoogle: true,
  defaultEventMinutes: 60,
  defaultReminder: 10,
};

export function pagesPerHour(r) {
  const s = +r.speed || 1;
  if (r.unit === 'ppm') return s * 60;
  if (r.unit === 'mpp') return 60 / s;
  return s;
}

export function totalMinutes(task) {
  if (task.kind === 'reading') {
    const r = task.reading || {};
    return Math.max(1, Math.round(((+r.pages || 0) / pagesPerHour(r)) * 60));
  }
  return Math.max(1, Math.round(+task.totalMinutes || 0));
}

export function params(task, s) {
  const chunk = +task.chunkMinutes || s.chunkMinutes;
  return {
    chunk,
    minChunk: Math.min(+task.minChunkMinutes || +s.minChunkMinutes || chunk, chunk),
    wiggle: Math.max(0, Math.min(chunk - 5, task.wiggleMinutes != null && task.wiggleMinutes !== '' ? +task.wiggleMinutes : (s.wiggleMinutes ?? 15))),
    maxPerDay: +task.maxPerDayMinutes || null,
    breakMin: task.breakMinutes != null && task.breakMinutes !== '' ? +task.breakMinutes : s.breakMinutes,
    bounds: task.ignoreBounds ? s.overflowBounds : (task.bounds || periodRules(task, s) || s.bounds),
  };
}

// A task can be scheduled in a named period (e.g. "After hours"): its rules, or a snapshot carried by the task.
export function periodRules(task, s) {
  if (!task.periodId) return null;
  const p = (s.periods || []).find((x) => x.id === task.periodId);
  const rules = p?.rules || task.periodRules;
  return rules?.length ? rules : null;
}

// Leave days ("on leave", "sick leave"): settings.leave = { 'YYYY-MM-DD': 'vacation' | 'sick' }. Task sessions avoid them,
// unless the task says it may use them or its time period includes leave days.
export const LEAVE_KINDS = { vacation: { icon: '🏖', label: 'On leave' }, sick: { icon: '🤒', label: 'Sick leave' } };
export const leaveOf = (s, key) => (s?.leave && LEAVE_KINDS[s.leave[key]] ? s.leave[key] : null);
export function usesLeaveDays(task, s) {
  if (task.onLeave) return true;
  if (task.periodId && !task.bounds && !task.ignoreBounds) {
    const p = (s.periods || []).find((x) => x.id === task.periodId);
    return !!(p ? p.onLeave : task.periodLeave);
  }
  return false;
}
export function leaveBlocks(s, from, to) {
  const out = [];
  for (const k of Object.keys(s?.leave || {})) {
    if (!leaveOf(s, k)) continue;
    const a = T.dayStart(k, s.tz), b = T.dayStart(T.addDays(k, 1), s.tz);
    if (b > from && a < to) out.push({ start: a, end: b });
  }
  return merge(out);
}
const dur = (c) => Math.round((c.end - c.start) / T.MIN);
// 'waived' = a done session the user removed without redoing the work: it counts as covered but takes no time.
const takesTime = (c) => c.status !== 'waived';
// Work credited by a frozen session: its length, or less when it was only partly done (`credit`, in work-minutes).
// For reading tasks a session can record the pages it covered (`pagesDone`), which stays right when the reading
// speed changes later.
export const work = (c, task) => {
  if (task?.kind === 'reading' && c.pagesDone != null && c.pagesDone !== '') return (Math.max(0, +c.pagesDone) / pagesPerHour(task.reading || {})) * 60;
  return c.credit != null && c.credit !== '' ? Math.max(0, +c.credit) : dur(c);
};
export const doneWork = (task) => (task.frozen || []).reduce((a, c) => a + work(c, task), 0);
// Time budget a frozen session used up. A partly done session whose shortfall is to be squeezed into the existing
// slots (`squeeze`) uses up its whole original slot, so the remaining slots stay as they were and carry more work.
const budget = (c, task) => (c.squeeze ? Math.max(+c.slotMin || dur(c), work(c, task)) : work(c, task));
export const doneMinutes = (task) => (task.frozen || []).reduce((a, c) => a + budget(c, task), 0);

export function merge(list) {
  const arr = list.filter((i) => i.end > i.start).map((i) => ({ start: i.start, end: i.end })).sort((a, b) => a.start - b.start);
  const out = [];
  for (const i of arr) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

export function windows(from, to, bounds, tz) {
  if (Array.isArray(bounds)) return merge(bounds.flatMap((b) => windows(from, to, b, tz)));
  const out = [];
  if (to <= from) return out;
  const days = new Set(bounds.days?.length ? bounds.days : [0, 1, 2, 3, 4, 5, 6]);
  let k = T.addDays(T.dayKey(from, tz), -1);
  const lastK = T.dayKey(to, tz);
  for (let i = 0; i < 4000; i++, k = T.addDays(k, 1)) {
    if (k > lastK) break;
    if (!days.has(T.weekday(k))) continue;
    const s = T.atTime(k, bounds.start, tz);
    let e = T.atTime(k, bounds.end, tz);
    if (e <= s) e = T.atTime(T.addDays(k, 1), bounds.end, tz); // overnight bounds, e.g. 22:00-02:00
    const a = Math.max(s, from), b = Math.min(e, to);
    if (b > a) out.push({ start: a, end: b });
  }
  return merge(out);
}

export function subtract(wins, busy) {
  const out = [];
  let j = 0;
  for (const w of wins) {
    let cur = w.start;
    while (j < busy.length && busy[j].end <= cur) j++;
    let k = j;
    while (k < busy.length && busy[k].start < w.end) {
      if (busy[k].start > cur) out.push({ start: cur, end: busy[k].start });
      cur = Math.max(cur, busy[k].end);
      k++;
    }
    if (cur < w.end) out.push({ start: cur, end: w.end });
  }
  return out;
}

const ceilTo = (ms, step) => Math.ceil(ms / step) * step;

// `dayUsed`: this task's minutes per day so far; `gUsed`: all tasks' minutes per day (for the daily total cap).
function allocate(slots, need, p, tz, dayUsed, gUsed = {}) {
  const out = [];
  const used = { ...dayUsed };
  const g = { ...gUsed };
  for (const s of slots) {
    if (need <= 0) break;
    let pos = ceilTo(s.start, 5 * T.MIN);
    while (need > 0) {
      const k = T.dayKey(pos, tz);
      const cap = Math.min(p.maxPerDay ? p.maxPerDay - (used[k] || 0) : Infinity, p.dayCap ? p.dayCap - (g[k] || 0) : Infinity);
      let len = Math.floor(Math.min(p.chunk, need, (s.end - pos) / T.MIN, cap));
      if (len <= 0 || len < Math.min(p.minChunk, need)) break;
      // Don't leave a tiny leftover session: absorb it into this one if it stays within the wiggle room.
      const rest = need - len;
      if (rest > 0 && rest < Math.max(15, p.wiggle || 0) && len + rest <= p.chunk + (p.wiggle || 0) && pos + (len + rest) * T.MIN <= s.end && len + rest <= cap) len += rest;
      out.push({ start: pos, end: pos + len * T.MIN });
      used[k] = (used[k] || 0) + len;
      g[k] = (g[k] || 0) + len;
      need -= len;
      pos += (len + p.breakMin) * T.MIN;
    }
  }
  return { chunks: out, need };
}

function perDay(chunks, tz) {
  const m = {};
  for (const c of chunks) { const k = T.dayKey(c.start, tz); m[k] = (m[k] || 0) + dur(c); }
  return m;
}

let idSeq = 0;
export const newId = (p = 'id') => `${p}${Date.now().toString(36)}${(idSeq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function intersect(a, b) {
  const out = [];
  let j = 0;
  for (const x of a) {
    while (j < b.length && b[j].end <= x.start) j++;
    for (let k = j; k < b.length && b[k].start < x.end; k++) {
      const s0 = Math.max(x.start, b[k].start), e0 = Math.min(x.end, b[k].end);
      if (e0 > s0) out.push({ start: s0, end: e0 });
    }
  }
  return out;
}

// Preferred time of day for the task's category (e.g. Study → morning), as day-bounds style rules.
export function preferredWindow(task, s) {
  const cat = (s.categories || []).find((c) => c.id === task.categoryId);
  const parent = cat?.parent ? (s.categories || []).find((c) => c.id === cat.parent) : null;
  const key = task.prefer || cat?.prefer || parent?.prefer; // a sub-category without its own preference uses its main category's
  const w = key && (s.timePrefs || DEFAULT_SETTINGS.timePrefs)[key];
  return w ? { start: w[0], end: w[1], days: [0, 1, 2, 3, 4, 5, 6] } : null;
}
// Safety margin: aim to finish this many days before the deadline (task setting, else the default).
export const marginDays = (task, s) => Math.max(0, +(task.marginDays != null && task.marginDays !== '' ? task.marginDays : s.marginDays) || 0);

// Plan one task into the given free time. Returns planned chunks + feasibility info.
// Passes, each adding to the previous: preferred time of day before the target date (deadline minus safety
// margin) → any time before the target → inside the safety margin → shorter sessions to meet the deadline →
// after the deadline (flagged overdue).
export function planOne(task, { occupied, now, settings, horizonDays = 366, gUsed = {} }) {
  const tz = settings.tz;
  const p = { ...params(task, settings), dayCap: +settings.dailyCapMinutes || 0 };
  const workLeft = totalMinutes(task) - doneWork(task);
  let remaining = totalMinutes(task) - doneMinutes(task);
  if (workLeft <= 0) remaining = 0;
  else if (remaining < Math.min(p.minChunk, workLeft)) remaining = workLeft; // nothing left to squeeze into: add time
  const res = { planned: [], shortfall: 0, overdue: 0, suggestedDeadline: null, fitsIgnoringBounds: null, remaining: Math.max(0, workLeft), late: 0, finish: null };
  if (remaining <= 0) return res;
  const from = Math.max(ceilTo(now, 5 * T.MIN), task.earliestStart || 0);
  const deadline = task.deadline || from + 30 * T.DAY;
  const soft = Math.max(from, deadline - marginDays(task, settings) * T.DAY);
  const busy = merge([...occupied, ...(task.skipped || []), ...(usesLeaveDays(task, settings) ? [] : leaveBlocks(settings, now - T.DAY, now + 800 * T.DAY))]);
  const frozenTT = (task.frozen || []).filter(takesTime);
  const free = (a, b) => (b > a ? subtract(windows(a, b, p.bounds, tz), busy) : []);
  // Smart allocation: normally full-length sessions, but a free slot up to `wiggle` minutes shorter is used as well
  // (e.g. a 48-min gap for a 60-min session with 15 min wiggle room). Shorter sessions, down to the minimum,
  // are used only if that's what it takes to meet the deadline.
  const smart = { ...p, minChunk: Math.max(p.chunk - p.wiggle, Math.min(p.minChunk, p.chunk)) };
  const pref = preferredWindow(task, settings);
  const phases = [];
  if (pref) phases.push({ wins: intersect(free(from, soft), windows(from, soft, pref, tz)), p: smart });
  phases.push({ wins: free(from, soft), p: smart });
  if (soft < deadline) phases.push({ wins: free(soft, deadline), p: smart, late: true });
  if (p.minChunk < p.chunk) phases.push({ wins: free(from, deadline), p, short: true });
  let need = remaining, chunks = [];
  const gap = p.breakMin * T.MIN;
  for (const ph of phases) {
    if (need <= 0) break;
    const avail = subtract(ph.wins, merge(chunks.map((c) => ({ start: c.start - gap, end: c.end + gap }))));
    const r = allocate(avail, need, ph.p, tz, perDay([...frozenTT, ...chunks], tz), addDays(gUsed, chunks, tz));
    chunks.push(...r.chunks.map((c) => (ph.late || c.end > soft ? { ...c, late: true } : c)));
    need = r.need;
  }
  chunks.sort((a, b) => a.start - b.start);
  res.planned = chunks;
  res.late = chunks.filter((c) => c.late).length;
  if (need > 0) {
    res.shortfall = need;
    // What if we ignored day bounds?
    if (!task.ignoreBounds) {
      const alt = allocate(subtract(windows(from, deadline, settings.overflowBounds, tz), busy), remaining, { ...p, bounds: settings.overflowBounds }, tz, perDay(frozenTT, tz), gUsed);
      res.fitsIgnoringBounds = alt.need <= 0;
    }
    // Keep placing past the deadline (flagged overdue) so the plan is complete, and derive a suggested deadline.
    const later = allocate(
      subtract(windows(Math.max(from, deadline), deadline + horizonDays * T.DAY, p.bounds, tz), busy),
      need, smart, tz, perDay([...frozenTT, ...chunks], tz), addDays(gUsed, chunks, tz),
    );
    res.overdue = later.chunks.length;
    res.planned = [...chunks, ...later.chunks.map((c) => ({ ...c, overdue: true, late: true }))];
    const last = res.planned[res.planned.length - 1];
    if (later.need <= 0 && last) res.suggestedDeadline = last.end;
  }
  res.finish = res.planned.length ? res.planned[res.planned.length - 1].end : null;
  return res;
}
function addDays(m, chunks, tz) {
  const o = { ...m };
  for (const c of chunks) { const k = T.dayKey(c.start, tz); o[k] = (o[k] || 0) + dur(c); }
  return o;
}

// ---------- Repeating tasks ("3 hours per week", "30 minutes daily") ----------
// task.repeat = { every: 'day'|'week', minutes, days?: [weekdays] (daily only), until?: ms, count?: n }
// Each period (day or week) is planned like a small task due at the period's end; missed time doesn't carry over.
export function periodStart(ms, every, tz, weekStart = 1) {
  const k = T.dayKey(ms, tz);
  return every === 'week' ? T.startOfWeek(k, weekStart) : k;
}
export function repeatEnd(task, s) {
  const r = task.repeat;
  if (!r) return null;
  const first = periodStart(task.repeatStart || task.created || Date.now(), r.every, s.tz, s.weekStart);
  let end = r.until ? T.dayStart(T.addDays(T.dayKey(r.until, s.tz), 1), s.tz) : Infinity;
  if (r.count) end = Math.min(end, T.dayStart(T.addDays(first, r.count * (r.every === 'week' ? 7 : 1)), s.tz));
  return end;
}
export function periodsOf(task, s, from, to) {
  const r = task.repeat;
  const tz = s.tz, step = r.every === 'week' ? 7 : 1;
  const firstKey = periodStart(task.repeatStart || task.created || from, r.every, tz, s.weekStart);
  const end = Math.min(repeatEnd(task, s), to);
  const out = [];
  let k = periodStart(Math.max(from, T.dayStart(firstKey, tz)), r.every, tz, s.weekStart);
  for (let i = 0; i < 800; i++, k = T.addDays(k, step)) {
    const a = T.dayStart(k, tz);
    if (a >= end) break;
    if (step === 1 && r.days?.length && !r.days.includes(T.weekday(k))) continue;
    out.push({ key: k, start: a, end: Math.min(T.dayStart(T.addDays(k, step), tz), repeatEnd(task, s)) });
  }
  return out;
}
const inPeriod = (c, per) => c.start >= per.start && c.start < per.end;

export function sortTasks(tasks) {
  return [...tasks].sort((a, b) => (a.rank ?? 5) - (b.rank ?? 5) || (a.deadline || Infinity) - (b.deadline || Infinity) || (a.created || 0) - (b.created || 0));
}

// Freeze sessions that have started (assumed done) before rescheduling.
export function freezePast(task, now, settings) {
  const planned = task.planned || [];
  const past = planned.filter((c) => c.start < now);
  if (!past.length) return task;
  const keep = planned.filter((c) => c.start >= now);
  const frozen = [...(task.frozen || [])];
  const orphanGids = [...(task.orphanGids || [])];
  for (const c of past) {
    if (settings.assumePastDone) frozen.push({ ...c, status: 'done', auto: true, overdue: undefined });
    else if (c.gid) orphanGids.push(c.gid);
  }
  return { ...task, frozen, planned: keep, orphanGids };
}

// Prerequisites: explicit "starts after" tasks, plus the previous step when the task belongs to a project whose
// steps run in order.
export function prerequisites(task, tasks, s) {
  const out = new Set((task.after || []).filter(Boolean));
  const proj = task.projectId && (s.projects || []).find((x) => x.id === task.projectId);
  if (proj?.sequential) {
    const sib = tasks.filter((t) => t.projectId === task.projectId && !t.archived)
      .sort((a, b) => (a.projectStep ?? 1e9) - (b.projectStep ?? 1e9) || (a.created || 0) - (b.created || 0));
    const i = sib.findIndex((t) => t.id === task.id);
    if (i > 0) out.add(sib[i - 1].id);
  }
  out.delete(task.id);
  return [...out];
}

// Full reschedule of every active task. `busy` is a list of {start,end} from calendars.
// Higher-ranked tasks (lower number) are placed first, so they take the earliest free time and lower-ranked
// tasks get pushed to later slots automatically. A task waits for its prerequisites, and a prerequisite inherits
// the urgency (rank) of the tasks waiting for it. A daily total cap is shared by all tasks.
export function rescheduleAll(tasks, busy, settings, now = Date.now()) {
  let list = tasks.map((t) => (t.archived ? t : freezePast(t, now, settings)));
  const fixed = [];
  const tz = settings.tz;
  // Task sessions keep the break before and after them for every other task too.
  const gap = (+settings.breakMinutes || 0) * T.MIN;
  const pad = (c) => ({ start: c.start - gap, end: c.end + gap });
  let gUsed = {};
  for (const t of list) if (!t.archived) for (const c of t.frozen || []) if (takesTime(c)) {
    if (c.end > now) fixed.push(pad(c));
    gUsed = addDays(gUsed, [c], tz);
  }
  let occupied = merge([...busy, ...fixed]);
  const problems = [];
  const byId = new Map(list.map((t) => [t.id, t]));
  const active = list.filter((t) => !t.archived);
  // Order: by effective rank, never before a prerequisite.
  const deps = new Map(active.map((t) => [t.id, prerequisites(t, active, settings).filter((d) => byId.has(d) && !byId.get(d).archived)]));
  const eff = new Map(active.map((t) => [t.id, t.rank ?? 5]));
  for (let pass = 0; pass < active.length; pass++) {
    let changed = false;
    for (const t of active) for (const d of deps.get(t.id)) if (eff.get(t.id) < eff.get(d)) { eff.set(d, eff.get(t.id)); changed = true; }
    if (!changed) break;
  }
  const sorted = [...active].sort((a, b) => eff.get(a.id) - eff.get(b.id) || (a.deadline || Infinity) - (b.deadline || Infinity) || (a.created || 0) - (b.created || 0));
  const order = [], placed = new Set();
  while (order.length < sorted.length) {
    const next = sorted.find((t) => !placed.has(t.id) && deps.get(t.id).every((d) => placed.has(d))) || sorted.find((t) => !placed.has(t.id));
    order.push(next); placed.add(next.id);
  }
  const lastEnd = (t) => Math.max(0, ...[...(t.frozen || []).filter(takesTime), ...(t.planned || [])].map((c) => c.end));
  for (const t0 of order) {
    const waitFor = deps.get(t0.id).map((d) => byId.get(d)).filter(Boolean);
    const after = waitFor.length ? Math.max(...waitFor.map(lastEnd)) : 0;
    const t = after ? { ...t0, earliestStart: Math.max(t0.earliestStart || 0, after + gap) } : t0;
    const prev = t0.planned || [];
    let planned, lastPlan;
    if (t.repeat) {
      // Plan each upcoming period (day or week) of a repeating task on its own.
      const pers = periodsOf(t, settings, now - 7 * T.DAY, now + (+settings.repeatHorizonDays || 28) * T.DAY).filter((x) => x.end > now);
      planned = []; lastPlan = { shortfall: 0, remaining: 0, at: now, periods: [] };
      let occ = occupied, g = gUsed;
      for (const per of pers) {
        const vt = { ...t, repeat: null, kind: 'generic', totalMinutes: t.repeat.minutes, marginDays: 0,
          earliestStart: Math.max(per.start, t.earliestStart || 0), deadline: per.end,
          frozen: (t.frozen || []).filter((c) => inPeriod(c, per)), planned: prev.filter((c) => c.pk === per.key) };
        const r = planOne(vt, { occupied: occ, now, settings, horizonDays: 0, gUsed: g });
        const mine = r.planned.filter((c) => !c.overdue).map((c) => ({ ...c, pk: per.key, late: undefined }));
        planned.push(...mine);
        occ = merge([...occ, ...mine.map(pad)]); g = addDays(g, mine, tz);
        if (r.shortfall > 0) lastPlan.periods.push({ key: per.key, short: r.shortfall });
        lastPlan.shortfall += r.shortfall; lastPlan.remaining += r.remaining;
      }
      lastPlan.finish = planned.length ? planned[planned.length - 1].end : null;
    } else {
      const r = planOne(t, { occupied, now, settings, gUsed });
      planned = r.planned;
      lastPlan = { shortfall: r.shortfall, suggestedDeadline: r.suggestedDeadline, fitsIgnoringBounds: r.fitsIgnoringBounds, remaining: r.remaining, at: now, late: r.late, finish: r.finish, waitingFor: waitFor.length ? waitFor.map((w) => w.id) : undefined };
    }
    // Keep chunk ids / google ids stable by ordinal (per period for repeating tasks) so syncing patches instead of re-creating.
    // (never reuse the id or Google event of a session that is now fixed — done or pinned)
    const fixedIds = new Set((t0.frozen || []).map((c) => c.id)), fixedG = new Set((t0.frozen || []).map((c) => c.gid).filter(Boolean));
    const used = new Set();
    const pool = (pk) => prev.filter((c) => (c.pk || null) === (pk || null) && !used.has(c.id) && !fixedIds.has(c.id) && !(c.gid && fixedG.has(c.gid)));
    const withIds = planned.map((c) => {
      const old = pool(c.pk)[0];
      if (old) used.add(old.id);
      return { ...c, id: old?.id || newId('c'), gid: old?.gid, syncHash: old?.syncHash };
    });
    const orphanGids = [...(t0.orphanGids || []), ...prev.filter((c) => !used.has(c.id)).map((c) => c.gid).filter((g) => g && !fixedG.has(g))];
    const nt = { ...t0, planned: withIds, orphanGids, lastPlan };
    byId.set(t0.id, nt);
    occupied = merge([...occupied, ...withIds.map(pad)]);
    gUsed = addDays(gUsed, withIds, tz);
    if (lastPlan.shortfall > 0 && !t0.repeat) problems.push({ taskId: t0.id, ...lastPlan });
  }
  list = list.map((t) => byId.get(t.id));
  return { tasks: list, problems, moves: movesBetween(tasks, list, now) };
}

// Which tasks were pushed later by a re-plan: finish time or next session moved later by 10+ minutes.
export function movesBetween(before, after, now = Date.now()) {
  const out = [];
  const nextOf = (t) => (t.planned || []).filter((c) => c.end > now).map((c) => c.start).sort((a, b) => a - b)[0] ?? null;
  const finOf = (t) => Math.max(0, ...(t.planned || []).map((c) => c.end)) || null;
  for (const a of after) {
    const b = before.find((x) => x.id === a.id);
    if (!b || a.archived) continue;
    const f0 = finOf(b), f1 = finOf(a), n0 = nextOf(b), n1 = nextOf(a);
    const later = (x, y) => x != null && y != null && y - x >= 10 * T.MIN;
    if (later(f0, f1) || later(n0, n1)) {
      out.push({ taskId: a.id, title: a.title, finishFrom: f0, finishTo: f1, nextFrom: n0, nextTo: n1,
        oldSlots: (b.planned || []).filter((c) => c.end > now).map((c) => ({ start: c.start, end: c.end })) });
    }
  }
  return out;
}

// All sessions of a task, ordered, with labels like "Pride and Prejudice page 47-66, task 1/10".
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WDS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function periodLabel(key, every) {
  if (!key) return '';
  const { m, d } = T.parseKey(key);
  return every === 'week' ? `week of ${d} ${MON[m - 1]}` : `${WDS[T.weekday(key)]} ${d} ${MON[m - 1]}`;
}

export function sessions(task) {
  if (task.repeat) return repeatSessions(task);
  const all = [
    ...(task.frozen || []).map((c) => ({ ...c, kind: c.status })),
    ...(task.planned || []).map((c) => ({ ...c, kind: 'planned' })),
  ].sort((a, b) => a.start - b.start);
  const N = all.filter(takesTime).length;
  const total = totalMinutes(task);
  // Planned sessions normally carry work equal to their length. After a partly done session whose shortfall was
  // squeezed into the existing slots, the remaining work is spread over the planned sessions instead.
  const plannedLen = (task.planned || []).reduce((a, c) => a + dur(c), 0);
  const scale = (task.frozen || []).some((c) => c.squeeze) && plannedLen > 0
    ? Math.max(0, Math.min(10, (total - doneWork(task)) / plannedLen)) : 1;
  let cum = 0, idx = 0;
  const out = [];
  for (const c of all) {
    const mins = c.kind === 'planned' ? dur(c) * scale : work(c, task);
    if (!takesTime(c)) { cum += mins; continue; }
    idx++;
    const icon = task.categoryIcon ? `${task.categoryIcon} ` : '';
    let label;
    if (task.kind === 'reading' && task.reading?.format === 'audio') {
      // an audiobook: "pages" are minutes of audio — labels show where you are in it (h:mm)
      const r = task.reading, hm = (m) => `${Math.floor(m / 60)}:${String(Math.round(m % 60)).padStart(2, '0')}`;
      const base = Math.max(0, (+r.startPage || 1) - 1); // minutes already heard before the plan
      const a = base + Math.round((cum / total) * r.pages), b = base + Math.min(r.pages, Math.round(((cum + mins) / total) * r.pages));
      label = `${icon}${task.title} 🎧 ${hm(a)}–${hm(Math.max(a, b))}, task ${idx}/${N}${c.partial ? ' (partly done)' : ''}`;
      c.pages = [a + 1, Math.max(a + 1, b)];
    } else if (task.kind === 'reading') {
      const r = task.reading;
      const base = r.labels === 'relative' ? 1 : (+r.startPage || 1);
      const a = base + Math.round((cum / total) * r.pages);
      const b = base - 1 + Math.min(r.pages, Math.round(((cum + mins) / total) * r.pages));
      label = `${icon}${task.title} page ${a}-${Math.max(a, b)}, task ${idx}/${N}${c.partial ? ' (partly done)' : ''}`;
      c.pages = [a, Math.max(a, b)];
    } else {
      label = `${icon}${task.title}, task ${idx}/${N}${c.partial ? ` (${Math.round((work(c, task) / Math.max(1, +c.slotMin || dur(c))) * 100)}% done)` : ''}`;
    }
    cum += mins;
    out.push({ ...c, index: idx, count: N, minutes: dur(c), work: mins, label, taskId: task.id });
  }
  return out;
}

// Repeating task: sessions numbered within their day or week, e.g. "Exercise · week of 19 Oct 2/3".
function repeatSessions(task) {
  const all = [
    ...(task.frozen || []).map((c) => ({ ...c, kind: c.status })),
    ...(task.planned || []).map((c) => ({ ...c, kind: 'planned' })),
  ].sort((a, b) => a.start - b.start);
  const icon = task.categoryIcon ? `${task.categoryIcon} ` : '';
  const groups = new Map();
  for (const c of all) if (takesTime(c)) { const k = c.pk || 'x'; groups.set(k, (groups.get(k) || 0) + 1); }
  const seen = new Map();
  const out = [];
  for (const c of all) {
    if (!takesTime(c)) continue;
    const k = c.pk || 'x', n = groups.get(k), i = (seen.get(k) || 0) + 1;
    seen.set(k, i);
    const when = periodLabel(c.pk, task.repeat.every);
    const label = `${icon}${task.title}${when ? ` · ${when}` : ''}${n > 1 ? ` ${i}/${n}` : ''}${c.partial ? ` (${Math.round((work(c, task) / Math.max(1, +c.slotMin || dur(c))) * 100)}% done)` : ''}`;
    out.push({ ...c, index: i, count: n, minutes: dur(c), work: work(c, task), label, taskId: task.id });
  }
  return out;
}

// --- User actions on sessions -------------------------------------------------------------

export function markUndone(task, chunkId) {
  // Return the session's work to the pool; future sessions shift to absorb it.
  const c = (task.frozen || []).find((x) => x.id === chunkId);
  if (!c) return task;
  return {
    ...task,
    frozen: task.frozen.filter((x) => x.id !== chunkId),
    orphanGids: c.gid ? [...(task.orphanGids || []), c.gid] : task.orphanGids,
  };
}

export function markDone(task, chunkId, { actualMin = null } = {}) {
  const c0 = (task.planned || []).find((x) => x.id === chunkId) || (task.frozen || []).find((x) => x.id === chunkId);
  if (!c0) return task;
  // Reading: remember which pages this session covered, so a later change of reading speed doesn't shift them.
  const pg = task.kind === 'reading' ? sessions(task).find((x) => x.id === chunkId)?.pages : null;
  const c = { ...c0, pagesDone: pg ? pg[1] - pg[0] + 1 : undefined, actualMin: actualMin != null ? Math.round(actualMin) : c0.actualMin };
  return {
    ...task,
    planned: (task.planned || []).filter((x) => x.id !== chunkId),
    frozen: [...(task.frozen || []).filter((x) => x.id !== chunkId), { ...c, status: 'done', auto: false, overdue: undefined, syncHash: null, credit: undefined, partial: undefined, squeeze: undefined }],
  };
}

// "Task finished here": this session is done and covers everything that was still left (for reading: up to the
// last page); the sessions not yet done are removed. A repeating task ends with this session.
export function completeAt(task, chunkId, now = Date.now()) {
  const me = sessions(task).find((x) => x.id === chunkId);
  if (!me) return task;
  const t = markDone(task, chunkId);
  const goes = (c) => c.id !== chunkId && (c.status === undefined || (c.status === 'pinned' && c.end > now) || (c.status === 'done' && c.auto && c.start > me.start));
  const gone = [...(t.planned || []), ...(t.frozen || []).filter(goes)];
  const orphanGids = [...(t.orphanGids || []), ...gone.map((c) => c.gid).filter(Boolean)];
  let frozen = (t.frozen || []).filter((c) => !goes(c));
  if (task.repeat) {
    const repeat = { ...task.repeat, until: me.end }; delete repeat.count;
    frozen = frozen.filter((c) => c.start <= me.start || c.status !== 'pinned');
    return { ...t, planned: [], frozen, orphanGids, repeat, deadline: me.end, completedAt: now };
  }
  const others = frozen.filter((c) => c.id !== chunkId).reduce((a, c) => a + work(c, task), 0);
  const need = Math.max(0, totalMinutes(task) - others);
  frozen = frozen.map((c) => {
    if (c.id !== chunkId) return c;
    if (task.kind === 'reading') {
      const pph = pagesPerHour(task.reading || {});
      return { ...c, pagesDone: Math.ceil((need / 60) * pph * 100) / 100, credit: undefined, syncHash: null };
    }
    return { ...c, credit: Math.ceil(need * 100) / 100, syncHash: null };
  });
  return { ...t, planned: [], frozen, orphanGids, completedAt: now };
}

export function skipSession(task, chunkId) {
  // Delete one session: its slot is blocked for this task and the work shifts to later free time.
  const c = [...(task.planned || []), ...(task.frozen || [])].find((x) => x.id === chunkId);
  if (!c) return task;
  return {
    ...task,
    planned: (task.planned || []).filter((x) => x.id !== chunkId),
    frozen: (task.frozen || []).filter((x) => x.id !== chunkId),
    skipped: [...(task.skipped || []), { start: c.start, end: c.end }],
    orphanGids: c.gid ? [...(task.orphanGids || []), c.gid] : task.orphanGids,
  };
}

export function pinSession(task, chunkId, start, end) {
  const c = [...(task.planned || []), ...(task.frozen || [])].find((x) => x.id === chunkId);
  if (!c) return task;
  return {
    ...task,
    planned: (task.planned || []).filter((x) => x.id !== chunkId),
    frozen: [...(task.frozen || []).filter((x) => x.id !== chunkId), { ...c, start, end, status: 'pinned', overdue: undefined, syncHash: null }],
  };
}

// Hours changed and sessions should follow: a session under way now that was only assumed done goes back into the
// plan (keeping its id) when it doesn't fit the task's new hours, so it is re-planned from now.
export function refitOngoing(task, s, now = Date.now()) {
  const b = params(task, s).bounds;
  const keep = [], back = [];
  for (const c of task.frozen || []) {
    if (c.auto && c.status === 'done' && c.start < now && c.end > now) {
      const fits = windows(c.start - T.DAY, c.end + T.DAY, b, s.tz).some((w) => w.start <= c.start && w.end >= c.end);
      if (!fits) { const { status, auto, ...rest } = c; back.push({ ...rest, start: now + T.MIN, end: now + T.MIN + (c.end - c.start), syncHash: null }); continue; }
    }
    keep.push(c);
  }
  const planned = (task.planned || []).map((c) => {
    if (!(c.start < now && c.end > now)) return c;
    if (windows(c.start - T.DAY, c.end + T.DAY, b, s.tz).some((w) => w.start <= c.start && w.end >= c.end)) return c;
    back.push(null); return { ...c, start: now + T.MIN, end: now + T.MIN + (c.end - c.start), syncHash: null };
  });
  return back.length ? { ...task, frozen: keep, planned: [...planned, ...back.filter(Boolean)], rev: Date.now() } : task;
}

// Hours changed but planned sessions should stay: pin the upcoming ones where they are.
export function pinUpcoming(task, now = Date.now()) {
  const up = (task.planned || []).filter((c) => c.start >= now);
  if (!up.length) return task;
  return { ...task, planned: (task.planned || []).filter((c) => c.start < now), frozen: [...(task.frozen || []), ...up.map((c) => ({ ...c, status: 'pinned', overdue: undefined }))], rev: Date.now() };
}

export function unpinSession(task, chunkId) {
  const c = (task.frozen || []).find((x) => x.id === chunkId);
  if (!c) return task;
  return {
    ...task,
    frozen: task.frozen.filter((x) => x.id !== chunkId),
    orphanGids: c.gid ? [...(task.orphanGids || []), c.gid] : task.orphanGids,
  };
}

// Remove a done session without redoing its work (it still counts as covered).
export function waiveSession(task, chunkId) {
  const c = (task.frozen || []).find((x) => x.id === chunkId);
  if (!c) return task;
  return {
    ...task,
    frozen: task.frozen.map((x) => (x.id === chunkId ? { ...x, status: 'waived', gid: null, syncHash: null } : x)),
    orphanGids: c.gid ? [...(task.orphanGids || []), c.gid] : task.orphanGids,
  };
}

// A session that was only partly done. `credit` = work done in work-minutes (for reading: pages / speed);
// `start`/`end` = the time actually spent on it (shorter when something else took part of the slot);
// `squeeze` = fit the unfinished work into the remaining sessions (true) or add time for it (false).
export function markPartial(task, chunkId, { credit, start, end, squeeze = false, pagesDone = null, actualMin = null }) {
  const c = (task.planned || []).find((x) => x.id === chunkId) || (task.frozen || []).find((x) => x.id === chunkId);
  if (!c) return task;
  const slotMin = +c.slotMin || dur(c);
  const nc = { ...c, start: start ?? c.start, end: end ?? c.end, status: 'done', auto: false, overdue: undefined, syncHash: null,
    credit: Math.max(0, +credit || 0), slotMin, squeeze: !!squeeze, partial: true,
    pagesDone: pagesDone != null ? Math.max(0, +pagesDone) : undefined, actualMin: actualMin != null ? Math.round(actualMin) : c.actualMin };
  return {
    ...task,
    planned: (task.planned || []).filter((x) => x.id !== chunkId),
    frozen: [...(task.frozen || []).filter((x) => x.id !== chunkId), nc],
  };
}
// Kept going: the session now ends at `end` (a done session stays done and counts the extra time; others are pinned).
export function extendSession(task, chunkId, end) {
  const f = (task.frozen || []).find((x) => x.id === chunkId);
  if (f && f.status === 'done') return { ...task, frozen: task.frozen.map((c) => (c.id === chunkId ? { ...c, end: Math.max(c.end, end), actualMin: Math.round((Math.max(c.end, end) - c.start) / T.MIN), credit: c.credit != null ? c.credit + Math.max(0, end - c.end) / T.MIN : c.credit, syncHash: null } : c)) };
  const c = [...(task.planned || []), ...(task.frozen || [])].find((x) => x.id === chunkId);
  return c ? pinSession(task, chunkId, c.start, Math.max(c.end, end)) : task;
}
// Finished a session early: it's done (all its work), ending at `end`; the rest of the slot becomes free.
export function finishEarly(task, chunkId, end) {
  const ss = sessions(task).find((x) => x.id === chunkId);
  if (!ss) return task;
  const t = markDone(task, chunkId, { actualMin: Math.max(1, (end - ss.start) / T.MIN) });
  return { ...t, frozen: t.frozen.map((c) => (c.id === chunkId ? { ...c, end: Math.max(c.start + T.MIN, end), slotMin: +c.slotMin || dur(c), credit: task.kind === 'reading' ? c.credit : ss.work, syncHash: null } : c)) };
}

// Started a session late: it now runs from `start` to its planned end. With `reallocate`, the missed minutes are
// planned again later (the session only covers what fits); otherwise the session still counts its full work.
export function startedLate(task, chunkId, start, { reallocate = true } = {}) {
  const ss = sessions(task).find((x) => x.id === chunkId);
  const c = (task.planned || []).find((x) => x.id === chunkId) || (task.frozen || []).find((x) => x.id === chunkId);
  if (!ss || !c || start <= c.start || start >= c.end - T.MIN) return task;
  const slotMin = +c.slotMin || dur(c);
  const nc = { ...c, start, status: c.status === 'pinned' ? 'pinned' : 'done', auto: c.status === 'pinned' ? c.auto : true, overdue: undefined, syncHash: null,
    slotMin, lateMin: Math.round((start - c.start) / T.MIN), credit: reallocate ? undefined : ss.work };
  if (reallocate) delete nc.credit;
  return { ...task, planned: (task.planned || []).filter((x) => x.id !== chunkId), frozen: [...(task.frozen || []).filter((x) => x.id !== chunkId), nc] };
}

// Change a reading task's speed without shifting what's already been read: done sessions keep their pages.
export function withReadingSpeed(task, reading) {
  if (task.kind !== 'reading') return { ...task, reading };
  const frozen = (task.frozen || []).map((c) => (c.status === 'done' || c.status === 'waived') && (c.pagesDone == null || c.pagesDone === '')
    ? { ...c, pagesDone: +((work(c, task) / 60) * pagesPerHour(task.reading || {})).toFixed(2), syncHash: null } : c);
  return { ...task, frozen, reading };
}
// Reading speed learned from what you reported: weighted towards recent sessions. Needs at least two reports
// covering 30+ minutes (or one of an hour or more), so one distracted session doesn't swing the plan.
export function learnedSpeed(task) {
  const log = (task.speedLog || []).filter((x) => x.minutes >= 5 && x.pages > 0).slice(-8);
  const mins = log.reduce((a, x) => a + x.minutes, 0);
  if (!((log.length >= 2 && mins >= 30) || mins >= 60)) return null;
  let w = 0, pph = 0;
  log.forEach((x, i) => { const wt = x.minutes * (1 + i / 4); w += wt; pph += wt * (x.pages / x.minutes) * 60; });
  return +(pph / w).toFixed(1);
}

// Work a session was meant to cover (work-minutes), e.g. to turn "7 of 15 pages" into credit.
export const minutesForPages = (task, pages) => (pages / pagesPerHour(task.reading || {})) * 60;

// Record time actually spent on a task (e.g. replacing another session's block).
export function addDoneBlock(task, start, end) {
  return { ...task, frozen: [...(task.frozen || []), { id: newId('c'), start, end, status: 'done', auto: false }] };
}

export function progress(task, now = Date.now(), settings = null) {
  if (task.repeat) {
    // The period (day/week) containing now, or the next one
    const ss = sessions(task);
    const cur = ss.find((c) => c.end > now)?.pk || ss[ss.length - 1]?.pk;
    const mine = ss.filter((c) => c.pk === cur);
    const total = task.repeat.minutes || 1;
    const done = mine.filter((c) => c.kind === 'done' || c.kind === 'waived').reduce((a, c) => a + c.work, 0);
    return { total, done: Math.min(total, done), pct: Math.min(100, Math.round((done / total) * 100)), period: cur };
  }
  const total = totalMinutes(task);
  const done = (task.frozen || []).filter((c) => c.status === 'done' || c.status === 'waived' || (c.status === 'pinned' && c.end <= now)).reduce((a, c) => a + work(c, task), 0);
  return { total, done: Math.min(total, done), pct: Math.min(100, Math.round((done / total) * 100)) };
}
