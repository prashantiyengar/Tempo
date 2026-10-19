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
  askCategory: true,       // ask once for a category when a new task has none       // smart allocation: also use free slots up to this much shorter than a session
  snapMinutes: 15,
  weekView: 'calendar',  // 'calendar' (Mon–Sun) or 'rolling' (today + 6 days)
  allDayBlocks: false,
  assumePastDone: true,
  taskReminderMinutes: 5,
  taskEmailReminderMinutes: null, // null = no email reminder for task sessions; a number = minutes before
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

const dur = (c) => Math.round((c.end - c.start) / T.MIN);
// 'waived' = a done session the user removed without redoing the work: it counts as covered but takes no time.
const takesTime = (c) => c.status !== 'waived';
export const doneMinutes = (task) => (task.frozen || []).reduce((a, c) => a + dur(c), 0);

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

function allocate(slots, need, p, tz, dayUsed) {
  const out = [];
  const used = { ...dayUsed };
  for (const s of slots) {
    if (need <= 0) break;
    let pos = ceilTo(s.start, 5 * T.MIN);
    while (need > 0) {
      const k = T.dayKey(pos, tz);
      const cap = p.maxPerDay ? p.maxPerDay - (used[k] || 0) : Infinity;
      let len = Math.floor(Math.min(p.chunk, need, (s.end - pos) / T.MIN, cap));
      if (len <= 0 || len < Math.min(p.minChunk, need)) break;
      // Don't leave a tiny leftover session: absorb it into this one if it stays within the wiggle room.
      const rest = need - len;
      if (rest > 0 && rest < Math.max(15, p.wiggle || 0) && len + rest <= p.chunk + (p.wiggle || 0) && pos + (len + rest) * T.MIN <= s.end && len + rest <= cap) len += rest;
      out.push({ start: pos, end: pos + len * T.MIN });
      used[k] = (used[k] || 0) + len;
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

// Plan one task into the given free time. Returns planned chunks + feasibility info.
export function planOne(task, { occupied, now, settings, horizonDays = 366 }) {
  const tz = settings.tz;
  const p = params(task, settings);
  const remaining = totalMinutes(task) - doneMinutes(task);
  const res = { planned: [], shortfall: 0, overdue: 0, suggestedDeadline: null, fitsIgnoringBounds: null, remaining: Math.max(0, remaining) };
  if (remaining <= 0) return res;
  const from = Math.max(ceilTo(now, 5 * T.MIN), task.earliestStart || 0);
  const deadline = task.deadline || from + 30 * T.DAY;
  const busy = merge([...occupied, ...(task.skipped || [])]);
  const dayUsed = perDay((task.frozen || []).filter(takesTime), tz);
  const free = subtract(windows(from, deadline, p.bounds, tz), busy);

  // Smart allocation: normally full-length sessions, but a free slot up to `wiggle` minutes shorter is used as well
  // (e.g. a 48-min gap for a 60-min session with 15 min wiggle room). Shorter sessions, down to the minimum,
  // are used only if that's what it takes to meet the deadline.
  const smart = { ...p, minChunk: Math.max(p.chunk - p.wiggle, Math.min(p.minChunk, p.chunk)) };
  let inWindow = allocate(free, remaining, smart, tz, dayUsed);
  if (inWindow.need > 0 && p.minChunk < p.chunk) inWindow = allocate(free, remaining, p, tz, dayUsed);
  res.planned = inWindow.chunks;
  if (inWindow.need > 0) {
    res.shortfall = inWindow.need;
    // What if we ignored day bounds?
    if (!task.ignoreBounds) {
      const alt = allocate(subtract(windows(from, deadline, settings.overflowBounds, tz), busy), remaining, { ...p, bounds: settings.overflowBounds }, tz, dayUsed);
      res.fitsIgnoringBounds = alt.need <= 0;
    }
    // Keep placing past the deadline (flagged overdue) so the plan is complete, and derive a suggested deadline.
    const later = allocate(
      subtract(windows(Math.max(from, deadline), deadline + horizonDays * T.DAY, p.bounds, tz), busy),
      inWindow.need, smart, tz, perDay([...(task.frozen || []).filter(takesTime), ...inWindow.chunks], tz),
    );
    res.overdue = later.chunks.length;
    res.planned = [...inWindow.chunks, ...later.chunks.map((c) => ({ ...c, overdue: true }))];
    const last = res.planned[res.planned.length - 1];
    if (later.need <= 0 && last) res.suggestedDeadline = last.end;
  }
  return res;
}

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

// Full reschedule of every active task. `busy` is a list of {start,end} from calendars.
// Higher-ranked tasks (lower number) are placed first, so they take the earliest free time and lower-ranked
// tasks get pushed to later slots automatically.
export function rescheduleAll(tasks, busy, settings, now = Date.now()) {
  let list = tasks.map((t) => (t.archived ? t : freezePast(t, now, settings)));
  const fixed = [];
  // Task sessions keep the break before and after them for every other task too.
  const gap = (+settings.breakMinutes || 0) * T.MIN;
  const pad = (c) => ({ start: c.start - gap, end: c.end + gap });
  for (const t of list) if (!t.archived) for (const c of t.frozen || []) if (c.end > now && takesTime(c)) fixed.push(pad(c));
  let occupied = merge([...busy, ...fixed]);
  const problems = [];
  const byId = new Map(list.map((t) => [t.id, t]));
  for (const t of sortTasks(list.filter((t) => !t.archived))) {
    const r = planOne(t, { occupied, now, settings });
    // Keep chunk ids / google ids stable by ordinal so syncing patches instead of re-creating.
    const prev = t.planned || [];
    const planned = r.planned.map((c, i) => ({
      ...c, id: prev[i]?.id || newId('c'), gid: prev[i]?.gid, syncHash: prev[i]?.syncHash,
    }));
    const orphanGids = [...(t.orphanGids || []), ...prev.slice(planned.length).map((c) => c.gid).filter(Boolean)];
    const nt = { ...t, planned, orphanGids, lastPlan: { shortfall: r.shortfall, suggestedDeadline: r.suggestedDeadline, fitsIgnoringBounds: r.fitsIgnoringBounds, remaining: r.remaining, at: now } };
    byId.set(t.id, nt);
    occupied = merge([...occupied, ...planned.map(pad)]);
    if (r.shortfall > 0) problems.push({ taskId: t.id, ...nt.lastPlan });
  }
  list = list.map((t) => byId.get(t.id));
  return { tasks: list, problems };
}

// All sessions of a task, ordered, with labels like "Pride and Prejudice page 47-66, task 1/10".
export function sessions(task) {
  const all = [
    ...(task.frozen || []).map((c) => ({ ...c, kind: c.status })),
    ...(task.planned || []).map((c) => ({ ...c, kind: 'planned' })),
  ].sort((a, b) => a.start - b.start);
  const N = all.filter(takesTime).length;
  const total = totalMinutes(task);
  let cum = 0, idx = 0;
  const out = [];
  for (const c of all) {
    const mins = dur(c);
    if (!takesTime(c)) { cum += mins; continue; }
    idx++;
    const icon = task.categoryIcon ? `${task.categoryIcon} ` : '';
    let label;
    if (task.kind === 'reading') {
      const r = task.reading;
      const base = r.labels === 'relative' ? 1 : (+r.startPage || 1);
      const a = base + Math.round((cum / total) * r.pages);
      const b = base - 1 + Math.min(r.pages, Math.round(((cum + mins) / total) * r.pages));
      label = `${icon}${task.title} page ${a}-${Math.max(a, b)}, task ${idx}/${N}`;
      c.pages = [a, Math.max(a, b)];
    } else {
      label = `${icon}${task.title}, task ${idx}/${N}`;
    }
    cum += mins;
    out.push({ ...c, index: idx, count: N, minutes: mins, label, taskId: task.id });
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

export function markDone(task, chunkId) {
  const c = (task.planned || []).find((x) => x.id === chunkId) || (task.frozen || []).find((x) => x.id === chunkId);
  if (!c) return task;
  return {
    ...task,
    planned: (task.planned || []).filter((x) => x.id !== chunkId),
    frozen: [...(task.frozen || []).filter((x) => x.id !== chunkId), { ...c, status: 'done', auto: false, overdue: undefined, syncHash: null }],
  };
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

// Record time actually spent on a task (e.g. replacing another session's block).
export function addDoneBlock(task, start, end) {
  return { ...task, frozen: [...(task.frozen || []), { id: newId('c'), start, end, status: 'done', auto: false }] };
}

export function progress(task, now = Date.now()) {
  const total = totalMinutes(task);
  const done = (task.frozen || []).filter((c) => c.status === 'done' || c.status === 'waived' || (c.status === 'pinned' && c.end <= now)).reduce((a, c) => a + dur(c), 0);
  return { total, done: Math.min(total, done), pct: Math.min(100, Math.round((done / total) * 100)) };
}
