// App state, calendar data access (Google + local), the reschedule cycle and Google sync of task sessions.
// DOM-free so the background worker can run it too.
import * as T from './tz.js';
import * as S from './scheduler.js';
import * as G from './gcal.js';
import { expand } from './rrule.js';
import { get, set } from './storage.js';

const KEYS = ['settings', 'tasks', 'localEvents', 'gmeta', 'orphanGids', 'acks', 'reminderQueue', 'syncInfo', 'installId', 'tombstones'];
export const LOCAL_CAL = 'local';

export async function loadState() {
  const raw = await get([...KEYS, 'auth']);
  if (!raw.installId) { raw.installId = S.newId('i'); await set({ installId: raw.installId }); }
  const settings = { ...S.DEFAULT_SETTINGS, ...(raw.settings || {}) };
  settings.bounds = { ...S.DEFAULT_SETTINGS.bounds, ...(settings.bounds || {}) };
  settings.overflowBounds = { ...S.DEFAULT_SETTINGS.overflowBounds, ...(settings.overflowBounds || {}) };
  if (!T.isValidTz(settings.tz)) settings.tz = T.systemTz();
  return {
    settings,
    tasks: raw.tasks || [],
    localEvents: raw.localEvents || [],
    gmeta: raw.gmeta || { calendars: [] },
    orphanGids: raw.orphanGids || [],
    acks: raw.acks || {},
    auth: raw.auth || {},
    reminderQueue: raw.reminderQueue || [],
    syncInfo: raw.syncInfo || null,
    installId: raw.installId,
    tombstones: raw.tombstones || [],
  };
}

export async function persist(state, keys = KEYS) {
  const o = {};
  for (const k of keys) o[k] = state[k];
  await set(o);
}

export const connected = (state) => !!(state.auth?.connected && G.hasClient(state.auth));

// Calendar ids: 'primary' is an alias — normalise to the real id when we know it so gids compare reliably.
export const primaryId = (state) => (state.gmeta?.calendars || []).find((c) => c.primary)?.id || 'primary';
export const normCal = (state, id) => (!id || id === 'primary' ? primaryId(state) : id);
export const splitGid = (g) => { const i = g.indexOf('::'); return i < 0 ? ['primary', g] : [g.slice(0, i), g.slice(i + 2)]; };
export const normGid = (state, g) => { if (!g) return g; const [c, id] = splitGid(g); return `${normCal(state, c)}::${id}`; };
export const defaultTaskCal = (state) => normCal(state, state.settings.taskCalendarId);
export const taskCal = (state, task) => normCal(state, task.calendarId || state.settings.taskCalendarId);
const writableCals = (state) => {
  const list = (state.gmeta?.calendars || []).filter((c) => ['owner', 'writer'].includes(c.accessRole)).map((c) => c.id);
  return list.length ? list : [primaryId(state)];
};

// ---------- Event helpers (Google-shaped events, also used for local ones) ----------

export function interval(ev, tz) {
  if (ev.start?.date) {
    return {
      allDay: true, startKey: ev.start.date, endKey: ev.end?.date || T.addDays(ev.start.date, 1),
      start: T.dayStart(ev.start.date, tz), end: T.dayStart(ev.end?.date || T.addDays(ev.start.date, 1), tz),
    };
  }
  const start = Date.parse(ev.start.dateTime), end = Date.parse(ev.end.dateTime);
  return { allDay: false, start, end, startKey: T.dayKey(start, tz), endKey: T.dayKey(end - 1, tz) };
}

export function expandLocal(localEvents, from, to, tz) {
  const out = [];
  for (const ev of localEvents) {
    const iv = interval(ev, tz);
    if (!ev.recurrence?.length) {
      if (iv.end > from && iv.start < to) out.push({ ...ev, _calId: LOCAL_CAL });
      continue;
    }
    const evTz = ev.start.timeZone || tz;
    const durMs = iv.end - iv.start;
    const dayLen = iv.allDay ? T.daysBetween(iv.startKey, iv.endKey) : 0;
    const occ = expand({ rule: ev.recurrence, startMs: iv.start, startKey: iv.startKey, allDay: iv.allDay, tz: evTz, durationMs: durMs, exdates: ev.exdates || [] }, from, to, tz);
    for (const o of occ) {
      const inst = { ...ev, id: `${ev.id}_${o}`, recurringEventId: ev.id, _calId: LOCAL_CAL, _occ: o, recurrence: undefined };
      if (iv.allDay) {
        inst.start = { date: o }; inst.end = { date: T.addDays(o, dayLen) };
      } else {
        inst.start = { dateTime: new Date(o).toISOString(), timeZone: evTz };
        inst.end = { dateTime: new Date(o + durMs).toISOString(), timeZone: evTz };
      }
      inst.originalStartTime = iv.allDay ? { date: o } : { dateTime: inst.start.dateTime };
      out.push(inst);
    }
  }
  return out;
}

// ---------- Google event cache ----------
const cache = new Map(); // key -> {at, items}
const TTL = 90 * 1000;
export function invalidate() { cache.clear(); }

export function visibleCalendars(state) {
  const hidden = new Set(state.settings.hiddenCalendars || []);
  return (state.gmeta.calendars || []).filter((c) => !hidden.has(c.id));
}

export async function googleEvents(state, from, to, { calendars, force } = {}) {
  if (!connected(state)) return [];
  const cals = calendars || visibleCalendars(state);
  const all = await Promise.all(cals.map(async (c) => {
    const key = `${c.id}|${from}|${to}`;
    const hit = cache.get(key);
    if (hit && !force && Date.now() - hit.at < TTL) return hit.items;
    const items = (await G.listEvents(c.id, from, to)).map((e) => ({ ...e, _calId: c.id }));
    cache.set(key, { at: Date.now(), items });
    return items;
  }));
  // Task sessions we know about are drawn from the scheduler (with their labels, status and actions), so the
  // Google copies are hidden to avoid duplicates. Tempo events we DON'T know (not yet imported) stay visible.
  const known = knownGids(state);
  const mine = (e) => known.has(`${normCal(state, e._calId)}::${e.id}`);
  return all.flat().filter((e) => e.status !== 'cancelled' && !(e.extendedProperties?.private?.tempoTask && mine(e)));
}

export function knownGids(state) {
  const set = new Set();
  for (const t of state.tasks) for (const c of [...(t.planned || []), ...(t.frozen || [])]) if (c.gid) set.add(normGid(state, c.gid));
  return set;
}

function isBusy(ev, state, tz) {
  if (ev.transparency === 'transparent') return false;
  const me = ev.attendees?.find((a) => a.self);
  if (me?.responseStatus === 'declined') return false;
  if (ev.start?.date && !state.settings.allDayBlocks) return false;
  return true;
}

export async function busyIntervals(state, from, to) {
  const tz = state.settings.tz;
  const busyCals = state.settings.busyCalendars;
  let gEvents = [];
  if (connected(state)) {
    const cals = (state.gmeta.calendars || []).filter((c) => (busyCals ? busyCals.includes(c.id) : !(state.settings.hiddenCalendars || []).includes(c.id)));
    try { gEvents = await googleEvents(state, from, to, { calendars: cals }); } catch (e) { console.warn('busy fetch failed', e); throw e; }
  }
  const local = (busyCals && !busyCals.includes(LOCAL_CAL)) ? [] : expandLocal(state.localEvents, from, to, tz);
  const list = [...gEvents, ...local].filter((e) => isBusy(e, state, tz)).map((e) => interval(e, tz));
  return { busy: S.merge(list.map(({ start, end }) => ({ start, end }))), gEvents, local };
}

export function horizon(state, now) {
  const maxDl = Math.max(now + 14 * T.DAY, ...state.tasks.filter((t) => !t.archived).map((t) => (t.deadline || 0) + 21 * T.DAY));
  return Math.min(maxDl, now + 200 * T.DAY);
}

// ---------- The cycle: fetch busy -> reschedule -> sync -> reminders ----------
export async function reschedule(state, now = Date.now()) {
  const to = horizon(state, now);
  const { busy, gEvents, local } = await busyIntervals(state, now - T.DAY, to);
  const { tasks, problems } = S.rescheduleAll(state.tasks, busy, state.settings, now);
  state.tasks = tasks;
  state.reminderQueue = buildReminderQueue(state, gEvents, local, now);
  return { problems, busy };
}

export function chunkBody(task, sess, state) {
  const tz = state.settings.tz;
  const done = sess.kind === 'done';
  const rem = task.reminderMinutes != null && task.reminderMinutes !== '' ? +task.reminderMinutes : state.settings.taskReminderMinutes;
  return {
    summary: (done ? '✓ ' : '') + sess.label,
    description: [task.notes, 'Scheduled by Tempo Calendar — edit this task in the extension; changes here will be overwritten.'].filter(Boolean).join('\n\n'),
    start: { dateTime: new Date(sess.start).toISOString(), timeZone: tz },
    end: { dateTime: new Date(sess.end).toISOString(), timeZone: tz },
    colorId: G.nearestColorId(task.color || '#4f6bed'),
    transparency: 'opaque',
    status: 'confirmed',
    reminders: { useDefault: false, overrides: done || rem == null || rem < 0 ? [] : [{ method: 'popup', minutes: rem }] },
    extendedProperties: { private: { tempoTask: '1', taskId: task.id, chunkId: sess.id, tSeq: String(sess.index), tStatus: sess.kind, tRev: String(task.rev || task.created || 0), ...encodeDef(task) } },
  };
}

// ---------- Task definitions stored on Google (so any browser / a fresh install can rebuild the task list) ----------
const DEF_FIELDS = ['id', 'title', 'kind', 'rank', 'totalMinutes', 'reading', 'deadline', 'earliestStart', 'chunkMinutes', 'minChunkMinutes',
  'maxPerDayMinutes', 'breakMinutes', 'bounds', 'ignoreBounds', 'color', 'reminderMinutes', 'notes', 'created', 'rev', 'calendarId'];
const PART = 900; // Google allows 1024 chars per extended-property value

export function encodeDef(task) {
  const def = {};
  for (const k of DEF_FIELDS) if (task[k] != null && task[k] !== '') def[k] = task[k];
  def.skipped = (task.skipped || []).filter((x) => x.end > Date.now() - 7 * T.DAY).slice(-40);
  let json = JSON.stringify(def);
  if (json.length > PART * 24) { def.notes = (def.notes || '').slice(0, 2000); json = JSON.stringify(def); }
  const out = {};
  const n = Math.ceil(json.length / PART);
  for (let i = 0; i < n; i++) out['tdef_' + i] = json.slice(i * PART, (i + 1) * PART);
  out.tdefN = String(n);
  return out;
}

export function decodeDef(p) {
  const n = +p.tdefN;
  if (!n) return null;
  let json = '';
  for (let i = 0; i < n; i++) { if (p['tdef_' + i] == null) return null; json += p['tdef_' + i]; }
  try { return JSON.parse(json); } catch { return null; }
}

const evStart = (ev) => Date.parse(ev.start?.dateTime || ev.start?.date);
const evEnd = (ev) => Date.parse(ev.end?.dateTime || ev.end?.date);

// Sessions created by older versions carry no definition: rebuild a sensible task from the event titles.
function legacyDef(taskId, events) {
  const first = events[0];
  const clean = (s) => (s || '').replace(/^✓\s*/, '').replace(/,\s*task \d+\/\d+\s*$/, '');
  const pages = events.map((e) => clean(e.summary).match(/^(.*) page (\d+)-(\d+)$/)).filter(Boolean);
  const minutes = events.reduce((a, e) => a + (evEnd(e) - evStart(e)) / T.MIN, 0);
  const def = {
    id: taskId, rank: 3, created: evStart(first), rev: 0, legacy: true,
    color: G.EVENT_COLORS[first.colorId] || '#4f6bed',
    deadline: Math.max(...events.map(evEnd)),
  };
  if (pages.length === events.length && pages.length) {
    const a = Math.min(...pages.map((m) => +m[2])), b = Math.max(...pages.map((m) => +m[3]));
    def.kind = 'reading'; def.title = pages[0][1];
    def.reading = { pages: b - a + 1, startPage: a, speed: +((b - a + 1) / (minutes / 60)).toFixed(2), unit: 'pph', labels: 'actual' };
  } else {
    def.kind = 'generic'; def.title = clean(first.summary) || 'Imported task'; def.totalMinutes = Math.round(minutes);
  }
  return def;
}

export function taskFromEvents(taskId, events, calId, settings, now = Date.now()) {
  // calId: fallback calendar; each event may carry its own in ev._cal
  events = [...events].sort((a, b) => evStart(a) - evStart(b));
  const withDef = events.map((e) => ({ e, p: e.extendedProperties?.private || {} }))
    .map((x) => ({ ...x, def: decodeDef(x.p), rev: +x.p.tRev || 0 })).filter((x) => x.def).sort((a, b) => b.rev - a.rev);
  const def = withDef[0]?.def || legacyDef(taskId, events);
  const frozen = [], planned = [], seen = new Set();
  for (const ev of events) {
    const p = ev.extendedProperties?.private || {};
    let id = p.chunkId || S.newId('c');
    if (seen.has(id)) continue; // duplicate copy of the same session
    seen.add(id);
    const c = { id, start: evStart(ev), end: evEnd(ev), gid: `${ev._cal || calId}::${ev.id}`, syncHash: null };
    // Old-version sessions carry no planning settings, so keep their exact times (pinned) instead of re-planning.
    const status = p.tStatus || (/^✓/.test(ev.summary || '') ? 'done' : def.legacy && c.start >= now ? 'pinned' : 'planned');
    if (status === 'done' || status === 'pinned') frozen.push({ ...c, status });
    else if (c.start < now && settings.assumePastDone) frozen.push({ ...c, status: 'done', auto: true });
    else planned.push(c);
  }
  return { ...def, id: taskId, calendarId: def.calendarId || events[0]?._cal || calId, frozen, planned, skipped: def.skipped || [], orphanGids: [], imported: Date.now() };
}

// Pull task state from Google: import tasks this browser doesn't have, apply newer edits made elsewhere, and drop
// tasks that were deleted on another device (every one of their sessions is gone from Google).
export async function pullTasks(state, now = Date.now()) {
  const res = { imported: [], updated: [], removed: [], calendars: [] };
  if (!connected(state) || !state.settings.syncTasksToGoogle) return res;
  const from = now - 90 * T.DAY, to = now + 400 * T.DAY;
  const cals = [...new Set([...writableCals(state), defaultTaskCal(state), ...state.tasks.map((t) => taskCal(state, t))])];
  const events = [];
  for (const cal of cals) {
    try {
      for (const ev of await G.listTaskEvents(cal, from, to)) if (ev.status !== 'cancelled') events.push({ ...ev, _cal: cal });
    } catch (e) {
      if (e instanceof G.AuthError || e instanceof G.PermissionError) throw e;
      console.warn('Tempo: could not read', cal, e.message);
      res.unreadable = [...(res.unreadable || []), cal];
    }
  }
  res.calendars = cals;
  const byTask = new Map();
  for (const ev of events) {
    const id = ev.extendedProperties?.private?.taskId;
    if (!id) continue;
    if (!byTask.has(id)) byTask.set(id, []);
    byTask.get(id).push(ev);
  }
  const tomb = new Set(state.tombstones || []);
  for (const [id, evs] of byTask) {
    if (tomb.has(id)) { for (const e of evs) { const g = `${e._cal}::${e.id}`; if (!state.orphanGids.includes(g)) state.orphanGids.push(g); } continue; }
    const local = state.tasks.find((t) => t.id === id);
    const remoteRev = Math.max(...evs.map((e) => +e.extendedProperties?.private?.tRev || 0));
    if (!local) {
      const t = taskFromEvents(id, evs, evs[0]._cal, state.settings, now);
      state.tasks.push(t); res.imported.push(t);
    } else if (remoteRev > (local.rev || 0)) {
      const t = taskFromEvents(id, evs, evs[0]._cal, state.settings, now);
      state.tasks = state.tasks.map((x) => (x.id === id ? { ...t, orphanGids: x.orphanGids || [] } : x));
      res.updated.push(t);
    }
  }
  // A fresh browser adopts the calendar your tasks already live in as its default for new tasks.
  if (!state.settings.taskCalendarId && res.imported.length) {
    const counts = {};
    for (const t of res.imported) counts[t.calendarId] = (counts[t.calendarId] || 0) + 1;
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (best && best !== primaryId(state)) { state.settings.taskCalendarId = best; res.adoptedCalendar = best; }
  }
  // Deleted elsewhere: the task had sessions inside the window on calendars we read, and none of them exist any more.
  const readable = new Set(cals.filter((c) => !(res.unreadable || []).includes(c)));
  const remoteIds = new Set(events.map((e) => `${e._cal}::${e.id}`));
  for (const t of [...state.tasks]) {
    if (t.archived || byTask.has(t.id)) continue;
    const mine = [...(t.planned || []), ...(t.frozen || [])]
      .filter((c) => c.gid && readable.has(splitGid(normGid(state, c.gid))[0]) && c.start >= from && c.start <= to);
    if (mine.length && !mine.some((c) => remoteIds.has(normGid(state, c.gid)))) {
      state.tasks = state.tasks.filter((x) => x.id !== t.id);
      res.removed.push(t);
    }
  }
  return res;
}

// Push task sessions to Google. `apply(fn)` writes results back into the live state.
// Every run also reconciles with what is really on Google: sessions whose event was deleted there are
// re-created, and stray Tempo events from this browser are removed.
export async function syncTasks(state, apply, onProgress) {
  if (!connected(state)) return recordSync(state, apply, { ok: false, kind: 'local', error: 'Not connected to Google — task sessions are only stored in this browser.' });
  if (!state.settings.syncTasksToGoogle) return recordSync(state, apply, { ok: false, kind: 'off', error: 'Writing task sessions to Google is turned off in Settings.' });
  const calId = defaultTaskCal(state);
  const all = state.tasks.filter((t) => !t.archived).map((t) => ({ task: t, cal: taskCal(state, t), list: S.sessions(t) }));
  const total = all.reduce((a, x) => a + x.list.length, 0);
  const setGid = (taskId, chunkId, gid, hash) => apply((s) => {
    const t = s.tasks.find((x) => x.id === taskId);
    for (const arr of [t?.planned || [], t?.frozen || []]) { const k = arr.find((x) => x.id === chunkId); if (k) { k.gid = gid; k.syncHash = hash; } }
  });
  let n = 0, failed = 0, lastErr = null;
  try {
    // 1. Reconcile with what is really on Google (per calendar used by tasks)
    const starts = all.flatMap((x) => x.list.map((c) => c.start));
    const remote = new Map();
    if (starts.length) {
      const from = Math.min(...starts, Date.now()) - T.DAY, to = Math.max(...all.flatMap((x) => x.list.map((c) => c.end))) + T.DAY;
      for (const cal of new Set(all.map((x) => x.cal))) {
        for (const ev of await G.listTaskEvents(cal, from, to)) remote.set(`${cal}::${ev.id}`, ev);
      }
    }
    const known = new Set();
    for (const { task, cal, list } of all) for (const c of list) {
      if (!c.gid) continue;
      const g = normGid(state, c.gid);
      if (splitGid(g)[0] !== cal) continue;
      known.add(g);
      if (c.start > Date.now() - 30 * T.DAY && !remote.has(g)) { setGid(task.id, c.id, null, null); c.gid = null; }
    }
    const localIds = new Set(state.tasks.map((t) => t.id));
    const tomb = new Set(state.tombstones || []);
    for (const [gid, ev] of remote) {
      const tid = ev.extendedProperties?.private?.taskId;
      // Only remove stray copies of OUR tasks (duplicates) or of tasks deleted here; unknown tasks are imported by pullTasks.
      if (!known.has(gid) && (localIds.has(tid) || tomb.has(tid))) state.orphanGids.includes(gid) || state.orphanGids.push(gid);
    }
    // 2. Deletions
    const orphans = [...state.orphanGids.map((g) => [null, g]), ...state.tasks.flatMap((t) => (t.orphanGids || []).map((g) => [t.id, g]))];
    for (const [taskId, gid] of orphans) {
      const [cal, id] = splitGid(normGid(state, gid));
      await G.deleteEvent(cal, id);
      apply((s) => {
        if (taskId) { const t = s.tasks.find((x) => x.id === taskId); if (t) t.orphanGids = (t.orphanGids || []).filter((g) => g !== gid); }
        else s.orphanGids = s.orphanGids.filter((g) => g !== gid);
      });
    }
    // 3. Upserts
    for (const { task, cal, list } of all) {
      if (!task.calendarId) apply((s) => { const t = s.tasks.find((x) => x.id === task.id); if (t) t.calendarId = cal; });
      const tk = { ...task, calendarId: cal };
      for (const sess of list) {
        const body = chunkBody(tk, sess, state);
        const hash = JSON.stringify([body.summary, body.start, body.end, body.colorId, body.reminders, body.description, body.extendedProperties]);
        const g0 = sess.gid ? normGid(state, sess.gid) : null;
        if (g0 && sess.syncHash === hash && splitGid(g0)[0] === cal) continue;
        try {
          let gid = g0;
          if (gid && splitGid(gid)[0] !== cal) { await G.deleteEvent(...splitGid(gid)); gid = null; }
          if (gid) {
            try { await G.patchEvent(...splitGid(gid), body); }
            catch (e) { if (/not found|deleted/i.test(e.message)) gid = null; else throw e; }
          }
          if (!gid) { const ev = await G.insertEvent(cal, body); gid = `${cal}::${ev.id}`; }
          n++;
          onProgress?.(n, total);
          setGid(task.id, sess.id, gid, hash);
        } catch (e) {
          if (e instanceof G.AuthError || e instanceof G.PermissionError) throw e;
          failed++; lastErr = e;
        }
      }
    }
  } catch (e) {
    return recordSync(state, apply, { ok: false, kind: e instanceof G.PermissionError ? 'permission' : e instanceof G.AuthError ? 'auth' : 'error', error: e.message, total, calId }, e);
  }
  const onGoogle = state.tasks.filter((t) => !t.archived).reduce((a, t) => a + S.sessions(t).filter((c) => c.gid).length, 0);
  return recordSync(state, apply, failed
    ? { ok: false, kind: 'partial', error: `${failed} session(s) could not be written: ${lastErr?.message}`, total, onGoogle, calId, changed: n }
    : { ok: true, total, onGoogle, calId, changed: n });
}

function recordSync(state, apply, info, err) {
  const rec = { ...info, at: Date.now() };
  apply((s) => { s.syncInfo = rec; });
  state.syncInfo = rec;
  if (err) throw err;
  return rec;
}

// Remove Google events tagged by Tempo that no task knows about (e.g. after reinstalling).
export async function cleanupOrphans(state) {
  const calId = defaultTaskCal(state);
  const known = knownGids(state);
  const now = Date.now();
  const items = await G.listTaskEvents(calId, now - 365 * T.DAY, now + 400 * T.DAY);
  let n = 0;
  for (const ev of items) if (!known.has(`${calId}::${ev.id}`)) { await G.deleteEvent(calId, ev.id); n++; }
  return n;
}

export function buildReminderQueue(state, gEvents, local, now) {
  const s = state.settings, tz = s.tz;
  const until = now + 3 * T.DAY;
  const q = [];
  if (s.notifyTasks) {
    for (const t of state.tasks.filter((x) => !x.archived)) {
      const rem = t.reminderMinutes != null && t.reminderMinutes !== '' ? +t.reminderMinutes : s.taskReminderMinutes;
      if (rem == null || rem < 0) continue;
      for (const c of S.sessions(t)) {
        if (c.kind === 'done' || c.start > until || c.start < now) continue;
        q.push({ id: `t:${c.id}:${c.start}`, when: c.start - rem * T.MIN, title: c.label, body: `${T.fmtTime(c.start, tz, s.h12)}–${T.fmtTime(c.end, tz, s.h12)}` });
      }
    }
  }
  const addEv = (ev, defaults) => {
    if (!ev.start?.dateTime) return;
    const start = Date.parse(ev.start.dateTime);
    if (start < now || start > until) return;
    const mins = ev.reminders?.useDefault === false ? (ev.reminders.overrides || []).filter((o) => o.method === 'popup').map((o) => o.minutes) : defaults;
    for (const m of mins) q.push({ id: `e:${ev.id}:${m}`, when: start - m * T.MIN, title: ev.summary || '(No title)', body: `${T.fmtTime(start, tz, s.h12)}${ev.location ? ' · ' + ev.location : ''}` });
  };
  if (s.notifyLocal) for (const ev of local || []) addEv(ev, [s.defaultReminder]);
  if (s.notifyGoogle) {
    const defs = new Map((state.gmeta.calendars || []).map((c) => [c.id, (c.defaultReminders || []).filter((r) => r.method === 'popup').map((r) => r.minutes)]));
    for (const ev of gEvents || []) addEv(ev, defs.get(ev._calId) || []);
  }
  return q.filter((r) => r.when >= now - 60000).sort((a, b) => a.when - b.when).slice(0, 200);
}

export async function refreshCalendars(state) {
  const cals = await G.listCalendars();
  state.gmeta = {
    ...state.gmeta,
    calendars: cals.map((c) => ({
      id: c.id, summary: c.summaryOverride || c.summary, color: c.backgroundColor, primary: !!c.primary,
      accessRole: c.accessRole, timeZone: c.timeZone, defaultReminders: c.defaultReminders || [],
    })).sort((a, b) => (b.primary - a.primary) || a.summary.localeCompare(b.summary)),
  };
  return state.gmeta.calendars;
}
