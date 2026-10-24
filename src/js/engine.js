// App state, calendar data access (Google + local), the reschedule cycle and Google sync of task sessions.
// DOM-free so the background worker can run it too.
import * as T from './tz.js';
import * as S from './scheduler.js';
import * as G from './gcal.js';
import { externalEvents } from './accounts.js';
import { expand } from './rrule.js';
import * as N from './notify.js';
import { get, set } from './storage.js';

const KEYS = ['settings', 'tasks', 'localEvents', 'gmeta', 'orphanGids', 'acks', 'reminderQueue', 'syncInfo', 'installId', 'tombstones', 'eventCats', 'eventDone'];
export const LOCAL_CAL = 'local';

export async function loadState() {
  const raw = await get([...KEYS, 'auth']);
  if (!raw.installId) { raw.installId = S.newId('i'); await set({ installId: raw.installId }); }
  // One-time upgrade of saved settings to the newer defaults (5-min breaks, 15-min shortest session, categories).
  if (raw.settings && (raw.settings.settingsVersion || 1) < 2) {
    const o = raw.settings;
    if (!o.breakMinutes) o.breakMinutes = S.DEFAULT_SETTINGS.breakMinutes;
    if (o.minChunkMinutes == null || o.minChunkMinutes === '') o.minChunkMinutes = S.DEFAULT_SETTINGS.minChunkMinutes;
    o.settingsVersion = 2;
    await set({ settings: o });
  }
  // Version 3: categories get icons (the built-in ones get their default emoji).
  if (raw.settings && raw.settings.settingsVersion < 3) {
    const o = raw.settings;
    const defIcon = Object.fromEntries(S.DEFAULT_SETTINGS.categories.map((c) => [c.id, c.icon]));
    if (Array.isArray(o.categories)) o.categories = o.categories.map((c) => (c.icon == null && defIcon[c.id] ? { ...c, icon: defIcon[c.id] } : c));
    o.settingsVersion = 3;
    await set({ settings: o });
  }
  const settings = { ...S.DEFAULT_SETTINGS, ...(raw.settings || {}) };
  if (!Array.isArray(settings.categories)) settings.categories = S.DEFAULT_SETTINGS.categories;
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
    eventCats: raw.eventCats || {},
    eventDone: raw.eventDone || {},
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

// Any change on Google (visible calendars + task calendars) since the per-calendar cursors? Updates the cursors.
export async function googleChanged(state, cursors) {
  if (!connected(state)) return false;
  const cals = new Set([...visibleCalendars(state).map((c) => c.id), defaultTaskCal(state), ...state.tasks.map((t) => taskCal(state, t))]);
  let changed = false;
  for (const c of cals) {
    if (cursors[c] == null) { cursors[c] = Date.now() - 60000; continue; }
    const r = await G.changedSince(c, cursors[c]);
    if (r.n) { changed = true; cursors[c] = r.max; }
  }
  return changed;
}

export function visibleCalendars(state) {
  const hidden = new Set(state.settings.hiddenCalendars || []);
  return (state.gmeta.calendars || []).filter((c) => !hidden.has(c.id));
}

// ---------- Offline snapshot of calendar events (about two months back to four months ahead) ----------
const SNAP_BACK = 60 * T.DAY, SNAP_AHEAD = 130 * T.DAY, SNAP_MAX = 4000;
const snapStart = (e) => (e.start?.dateTime ? Date.parse(e.start.dateTime) : e.start?.date ? Date.parse(e.start.date + 'T00:00:00') : 0);
const snapEnd = (e) => (e.end?.dateTime ? Date.parse(e.end.dateTime) : e.end?.date ? Date.parse(e.end.date + 'T00:00:00') : snapStart(e));
const slim = (e) => ({ id: e.id, _calId: e._calId, summary: e.summary, start: e.start, end: e.end, status: e.status, location: e.location, colorId: e.colorId,
  recurringEventId: e.recurringEventId, transparency: e.transparency, iCalUID: e.iCalUID, htmlLink: e.htmlLink, reminders: e.reminders, extendedProperties: e.extendedProperties,
  attendees: e.attendees?.filter((a) => a.self), description: e.description ? String(e.description).slice(0, 400) : undefined, hangoutLink: e.hangoutLink, organizer: e.organizer });
let snapMem = null, snapTimer = null;
async function loadSnap() { if (!snapMem) snapMem = (await get('evsnap')).evsnap || { at: 0, cals: {} }; return snapMem; }
function saveSnap(calId, from, to, items) {
  const now = Date.now(), a = Math.max(from, now - SNAP_BACK), b = Math.min(to, now + SNAP_AHEAD);
  if (b <= a) return;
  loadSnap().then((snap) => {
    const keep = (snap.cals[calId] || []).filter((e) => (snapEnd(e) <= a || snapStart(e) >= b) && snapEnd(e) > now - SNAP_BACK && snapStart(e) < now + SNAP_AHEAD);
    snap.cals[calId] = [...keep, ...items.filter((e) => snapEnd(e) > a && snapStart(e) < b && !e.extendedProperties?.private?.tempoTask).map(slim)].slice(-SNAP_MAX);
    snap.at = now;
    clearTimeout(snapTimer);
    snapTimer = setTimeout(() => set({ evsnap: snap }).catch(() => {}), 1500);
  });
}
export const offlineSince = (state) => state.offline?.since ?? null;

export async function googleEvents(state, from, to, { calendars, force } = {}) {
  if (!connected(state)) return [];
  const cals = calendars || visibleCalendars(state);
  const all = await Promise.all(cals.map(async (c) => {
    const key = `${c.id}|${from}|${to}`;
    const hit = cache.get(key);
    if (hit && !force && Date.now() - hit.at < TTL) return hit.items;
    let items;
    try {
      items = (await G.listEvents(c.id, from, to)).map((e) => ({ ...e, _calId: c.id }));
    } catch (err) {
      // Offline (or Google unreachable): show the events saved the last time we were online.
      if (!G.isOffline(err) && !/reach Google/i.test(err?.message || '')) throw err;
      const snap = await loadSnap();
      state.offline = { since: snap.at || null };
      return (snap.cals?.[c.id] || []).filter((e) => snapEnd(e) > from && snapStart(e) < to);
    }
    state.offline = null;
    cache.set(key, { at: Date.now(), items });
    saveSnap(c.id, from, to, items);
    return items;
  }));
  // Task sessions we know about are drawn from the scheduler (with their labels, status and actions), so the
  // Google copies are hidden to avoid duplicates. Tempo events we DON'T know (not yet imported) stay visible.
  const known = knownGids(state);
  const gone = new Set((state.orphanGids || []).map((g) => normGid(state, g)));
  for (const t of state.tasks) for (const g of t.orphanGids || []) gone.add(normGid(state, g));
  const tomb = new Set(state.tombstones || []);
  const mine = (e) => known.has(`${normCal(state, e._calId)}::${e.id}`);
  // Copies still in the cache of sessions that were just deleted (or are about to be) are hidden right away.
  const deleted = (e) => gone.has(`${normCal(state, e._calId)}::${e.id}`) || tomb.has(e.extendedProperties?.private?.taskId);
  return all.flat().filter((e) => e.status !== 'cancelled' && !(e.extendedProperties?.private?.tempoTask && (mine(e) || deleted(e))));
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

// Events at a physical place get a travel buffer before and after (online meetings don't).
export const hasPlace = (ev) => !!ev?.location && !ev.start?.date && !/^(https?:|www\.)|zoom|meet\.google|teams\.|microsoft teams|webex|skype|whereby|online|virtual|phone|call/i.test(ev.location);
export function travelBlocks(ev, iv, minutes) {
  if (!minutes || !hasPlace(ev)) return [];
  return [{ start: iv.start - minutes * T.MIN, end: iv.start }, { start: iv.end, end: iv.end + minutes * T.MIN }];
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
  let ext = [];
  try { ext = (await externalEvents(state, from, to)).filter((e) => e._busy); } catch (e) { console.warn('Tempo: other calendars', e); }
  // time you chose to keep free (e.g. after finishing something early)
  const holds = (state.settings.holds || []).filter((h) => h.end > from && h.start < to).map((h) => ({ start: h.start, end: h.end }));
  const travel = +state.settings.travelMinutes || 0;
  const list = [...gEvents, ...local, ...ext].filter((e) => isBusy(e, state, tz)).flatMap((e) => { const iv = interval(e, tz); return [iv, ...travelBlocks(e, iv, travel)]; });
  return { busy: S.merge([...list.map(({ start, end }) => ({ start, end })), ...holds]), gEvents, local };
}

export function horizon(state, now) {
  const maxDl = Math.max(now + 14 * T.DAY, ...state.tasks.filter((t) => !t.archived).map((t) => (t.deadline || 0) + 21 * T.DAY));
  return Math.min(maxDl, now + 200 * T.DAY);
}

// ---------- The cycle: fetch busy -> reschedule -> sync -> reminders ----------
export async function reschedule(state, now = Date.now()) {
  const to = horizon(state, now);
  const { busy, gEvents, local } = await busyIntervals(state, now - T.DAY, to);
  const { tasks, problems, moves } = S.rescheduleAll(state.tasks, busy, state.settings, now);
  state.tasks = tasks;
  state.reminderQueue = buildReminderQueue(state, gEvents, local, now);
  return { problems, busy, moves };
}

export function chunkBody(task, sess, state) {
  const tz = state.settings.tz;
  const done = sess.kind === 'done';
  const rules = N.overrides(N.taskRules(task, state.settings));
  return {
    summary: (done ? '✓ ' : '') + sess.label,
    description: [task.notes, 'Scheduled by Tempo Calendar — edit this task in the extension; changes here will be overwritten.'].filter(Boolean).join('\n\n'),
    start: { dateTime: new Date(Math.round(sess.start / 1000) * 1000).toISOString(), timeZone: tz },
    end: { dateTime: new Date(Math.round(sess.end / 1000) * 1000).toISOString(), timeZone: tz },
    colorId: G.nearestColorId(task.color || '#4f6bed'),
    transparency: 'opaque',
    status: 'confirmed',
    reminders: { useDefault: false, overrides: done ? [] : rules },
    extendedProperties: { private: { tempoTask: '1', taskId: task.id, chunkId: sess.id, tSeq: String(sess.index), tStatus: sess.kind, tRev: String(task.rev || task.created || 0),
      // partly done: credited work (Google merges private properties on patch, so clear them explicitly otherwise)
      ...(sess.partial ? { tCredit: String(+(+sess.credit).toFixed(2)), tSlot: String(sess.slotMin || ''), tSq: sess.squeeze ? '1' : '' } : { tCredit: '', tSlot: '', tSq: '' }),
      // period of a repeating task, pages a reading session covered, minutes actually spent (timer)
      tPk: sess.pk || '', tPages: sess.pagesDone != null ? String(sess.pagesDone) : '', tAct: sess.actualMin != null ? String(sess.actualMin) : '',
      ...encodeDef(task) } },
  };
}

// ---------- Task definitions stored on Google (so any browser / a fresh install can rebuild the task list) ----------
const DEF_FIELDS = ['id', 'title', 'kind', 'rank', 'totalMinutes', 'reading', 'deadline', 'earliestStart', 'chunkMinutes', 'minChunkMinutes',
  'maxPerDayMinutes', 'breakMinutes', 'wiggleMinutes', 'bounds', 'ignoreBounds', 'color', 'reminderMinutes', 'emailReminderMinutes', 'notifyProfile', 'notes', 'created', 'rev', 'calendarId',
  'categoryId', 'categoryName', 'categoryColor', 'categoryIcon', 'periodId', 'periodName', 'periodRules',
  'repeat', 'repeatStart', 'marginDays', 'after', 'projectId', 'projectName', 'projectStep', 'speedLog', 'prefer', 'onLeave', 'periodLeave', 'completedAt', 'fromLater'];
const PART = 900; // Google allows 1024 chars per extended-property value

export function encodeDef(task) {
  const def = {};
  for (const k of DEF_FIELDS) if (task[k] != null && task[k] !== '') def[k] = task[k];
  def.skipped = (task.skipped || []).filter((x) => x.end > Date.now() - 7 * T.DAY).slice(-40);
  def.waived = (task.frozen || []).filter((c) => c.status === 'waived').slice(-60).map((c) => ({ id: c.id, start: c.start, end: c.end }));
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
  const clean = (s) => (s || '').replace(/^✓\s*/, '').replace(/^\p{Extended_Pictographic}[\uFE0F\u200D\p{Extended_Pictographic}]*\s*/u, '').replace(/\s*\((partly|\d+%) done\)\s*$/, '').replace(/,\s*task \d+\/\d+\s*$/, '');
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
    if (p.tCredit != null && p.tCredit !== '' && status === 'done') Object.assign(c, { credit: +p.tCredit, slotMin: +p.tSlot || undefined, squeeze: p.tSq === '1', partial: true });
    if (p.tPk) c.pk = p.tPk;
    if (p.tPages) c.pagesDone = +p.tPages;
    if (p.tAct) c.actualMin = +p.tAct;
    if (status === 'done' || status === 'pinned') frozen.push({ ...c, status });
    else if (c.start < now && settings.assumePastDone) frozen.push({ ...c, status: 'done', auto: true });
    else planned.push(c);
  }
  for (const w of def.waived || []) if (!seen.has(w.id)) frozen.push({ ...w, status: 'waived' });
  const { waived, ...rest } = def;
  return { ...rest, id: taskId, calendarId: def.calendarId || events[0]?._cal || calId, frozen, planned, skipped: def.skipped || [], orphanGids: [], imported: Date.now() };
}

// Pull task state from Google: import tasks this browser doesn't have, apply newer edits made elsewhere, and drop
// tasks that were deleted on another device (every one of their sessions is gone from Google).
export async function pullTasks(state, now = Date.now()) {
  const res = { imported: [], updated: [], removed: [], calendars: [] };
  if (!connected(state) || !state.settings.syncTasksToGoogle) return res;
  const from = now - 90 * T.DAY, to = now + 400 * T.DAY;
  const cals = [...new Set([...writableCals(state), defaultTaskCal(state), ...state.tasks.map((t) => taskCal(state, t))])];
  const events = [];
  await G.pool(cals, G.PARALLEL, async (cal) => {
    try {
      for (const ev of await G.listTaskEvents(cal, from, to)) if (ev.status !== 'cancelled') events.push({ ...ev, _cal: cal });
    } catch (e) {
      if (e instanceof G.AuthError || e instanceof G.PermissionError) throw e;
      console.warn('Tempo: could not read', cal, e.message);
      res.unreadable = [...(res.unreadable || []), cal];
    }
  });
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

// Does the event on Google match what we meant to write?
// (Lenient where Google normalises: whitespace in the title, times to the second.)
const normTitle = (x) => String(x || '').normalize('NFC').replace(/\s+/g, ' ').trim();
const sameSec = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) < 1000;
function matches(ev, body) {
  if (!ev || ev.status === 'cancelled') return false;
  const p = ev.extendedProperties?.private || {}, q = body.extendedProperties.private;
  return normTitle(ev.summary) === normTitle(body.summary) && sameSec(ev.start?.dateTime || ev.start?.date, body.start.dateTime)
    && sameSec(ev.end?.dateTime || ev.end?.date, body.end.dateTime)
    && p.chunkId === q.chunkId && p.taskId === q.taskId && (p.tStatus || '') === q.tStatus && (p.tCredit || '') === (q.tCredit || '') && p.tRev === q.tRev;
}
const bodyHash = (body) => JSON.stringify([body.summary, body.start, body.end, body.colorId, body.reminders, body.description, body.extendedProperties]);

// Push task sessions to Google. `apply(fn)` writes results back into the live state.
// Requests run in parallel (several at once, with automatic back-off when Google rate-limits). Every run also
// verifies against what is really on Google: sessions that are missing or differ there are written again, stray
// Tempo copies are removed, and after writing, everything is read back once more to confirm it arrived intact.
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
  const starts = all.flatMap((x) => x.list.map((c) => c.start));
  const range = starts.length ? [Math.min(...starts, Date.now()) - T.DAY, Math.max(...all.flatMap((x) => x.list.map((c) => c.end))) + T.DAY] : null;
  const cals = [...new Set(all.map((x) => x.cal))];
  const readRemote = async () => {
    const remote = new Map();
    if (!range) return remote;
    await G.pool(cals, G.PARALLEL, async (cal) => { for (const ev of await G.listTaskEvents(cal, ...range)) if (ev.status !== 'cancelled') remote.set(`${cal}::${ev.id}`, ev); });
    return remote;
  };
  // Everything we intend to have on Google
  const jobs = [];
  for (const { task, cal, list } of all) {
    if (!task.calendarId) apply((s) => { const t = s.tasks.find((x) => x.id === task.id); if (t) t.calendarId = cal; });
    const tk = { ...task, calendarId: cal };
    for (const sess of list) {
      const body = chunkBody(tk, sess, state);
      jobs.push({ task, cal, sess, body, hash: bodyHash(body), gid: sess.gid ? normGid(state, sess.gid) : null, syncHash: sess.syncHash });
    }
  }
  // Two sessions must never share one Google event (they would overwrite each other forever): the later one gets its own.
  const seenG = new Set(), seenC = new Set();
  for (const j of jobs) {
    const ck = `${j.task.id}|${j.sess.id}`;
    if (seenC.has(ck)) { j.dupChunk = true; continue; }
    seenC.add(ck);
    if (j.gid && seenG.has(j.gid)) { j.gid = null; j.syncHash = null; setGid(j.task.id, j.sess.id, null, null); }
    if (j.gid) seenG.add(j.gid);
  }
  for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].dupChunk) jobs.splice(i, 1);
  let n = 0, failed = 0, lastErr = null, repaired = 0, verified = 0, unverified = [], deletedN = 0;
  const upsert = async (j) => {
    try {
      let gid = j.gid;
      if (gid && splitGid(gid)[0] !== j.cal) { await G.deleteEvent(...splitGid(gid)); gid = null; }
      if (gid) {
        try { await G.patchEvent(...splitGid(gid), j.body); }
        catch (e) { if (/not found|deleted/i.test(e.message)) gid = null; else throw e; }
      }
      if (!gid) { const ev = await G.insertEvent(j.cal, j.body); gid = `${j.cal}::${ev.id}`; }
      j.gid = gid; j.syncHash = j.hash;
      n++;
      onProgress?.(n, total);
      setGid(j.task.id, j.sess.id, gid, j.hash);
    } catch (e) {
      if (e instanceof G.AuthError || e instanceof G.PermissionError) throw e;
      failed++; lastErr = e; j.failed = true;
    }
  };
  try {
    // 1. Verify against Google: anything missing or different is written again.
    let remote = await readRemote();
    const known = new Set();
    for (const j of jobs) {
      if (!j.gid || splitGid(j.gid)[0] !== j.cal) continue;
      known.add(j.gid);
      const ev = remote.get(j.gid);
      if (!ev) {
        // Missing on Google (deleted there, or a write that never arrived): create it again.
        if (j.sess.start > Date.now() - 30 * T.DAY) { if (j.syncHash) repaired++; setGid(j.task.id, j.sess.id, null, null); j.gid = null; j.syncHash = null; }
      } else if (j.syncHash === j.hash && !matches(ev, j.body)) { j.syncHash = null; repaired++; } // changed on Google: overwrite
    }
    const localIds = new Set(state.tasks.map((t) => t.id));
    const tomb = new Set(state.tombstones || []);
    for (const [gid, ev] of remote) {
      const tid = ev.extendedProperties?.private?.taskId;
      // Only remove stray copies of OUR tasks (duplicates) or of tasks deleted here; unknown tasks are imported by pullTasks.
      if (!known.has(gid) && (localIds.has(tid) || tomb.has(tid))) state.orphanGids.includes(gid) || state.orphanGids.push(gid);
    }
    // 2. Deletions (in parallel)
    const orphans = [...state.orphanGids.map((g) => [null, g]), ...state.tasks.flatMap((t) => (t.orphanGids || []).map((g) => [t.id, g]))];
    await G.pool(orphans, G.PARALLEL, async ([taskId, gid]) => {
      const [cal, id] = splitGid(normGid(state, gid));
      await G.deleteEvent(cal, id);
      deletedN++;
      apply((s) => {
        if (taskId) { const t = s.tasks.find((x) => x.id === taskId); if (t) t.orphanGids = (t.orphanGids || []).filter((g) => g !== gid); }
        else s.orphanGids = s.orphanGids.filter((g) => g !== gid);
      });
    });
    // 3. Creates and updates (in parallel)
    const todo = jobs.filter((j) => !(j.gid && j.syncHash === j.hash && splitGid(j.gid)[0] === j.cal));
    await G.pool(todo, G.PARALLEL, upsert);
    // 4. Read back what we wrote and confirm it; write again whatever didn't arrive intact (up to two more rounds).
    if (todo.length || orphans.length) {
      for (let round = 0; round < 4; round++) {
        onProgress?.(n, total, 'verify');
        remote = await readRemote();
        const bad = jobs.filter((j) => !j.failed && (!j.gid || !matches(remote.get(j.gid), j.body)));
        const strays = orphans.filter(([, g]) => remote.has(normGid(state, g)));
        if (!bad.length && !strays.length) break;
        if (round === 3) { unverified = bad; break; }
        repaired += bad.length;
        for (const j of bad) if (j.gid && !remote.has(j.gid)) j.gid = null;
        // Patching didn't take twice: replace the event on Google with a fresh copy.
        if (round === 2) await G.pool(bad.filter((j) => j.gid), G.PARALLEL, async (j) => { try { await G.deleteEvent(...splitGid(j.gid)); } catch { /* already gone */ } j.gid = null; });
        await G.pool(strays, G.PARALLEL, ([, g]) => G.deleteEvent(...splitGid(normGid(state, g))));
        await G.pool(bad, G.PARALLEL, upsert);
      }
    }
    verified = jobs.filter((j) => j.gid && !j.failed && !unverified.includes(j)).length;
  } catch (e) {
    return recordSync(state, apply, { ok: false, kind: e instanceof G.PermissionError ? 'permission' : e instanceof G.AuthError ? 'auth' : 'error', error: e.message, total, calId }, e);
  }
  for (const j of unverified) setGid(j.task.id, j.sess.id, j.gid, null); // try again next time
  const onGoogle = state.tasks.filter((t) => !t.archived).reduce((a, t) => a + S.sessions(t).filter((c) => c.gid).length, 0);
  const base = { total, onGoogle, calId, changed: n + deletedN, deleted: deletedN, verified, repaired, at: Date.now() };
  if (failed || unverified.length) {
    const msg = failed ? `${failed} session(s) could not be written: ${lastErr?.message}` : `${unverified.length} session(s) didn't arrive intact on Google; Tempo will retry.`;
    return recordSync(state, apply, { ok: false, kind: 'partial', error: msg, ...base });
  }
  return recordSync(state, apply, { ok: true, ...base });
}

// ---------- Settings shared between devices ----------
// Categories, time periods, projects, work hours, limits, notification choices and the recent history live in one
// hidden all-day "Tempo settings" event on your primary calendar (private properties, dated 1 Jan 2000 so it never
// shows up in your week). Each setting merges on its own: what you changed here since the last sync wins, the rest
// comes from Google. A device syncing for the first time keeps its own settings where Google only has defaults.
const SHARED_PART = 450;
export const SHARED_KEYS = ['categories', 'periods', 'projects', 'history', 'bounds', 'overflowBounds', 'chunkMinutes', 'minChunkMinutes', 'breakMinutes',
  'wiggleMinutes', 'sessionWarn', 'sessionMax', 'maxSpanDays', 'askCategory', 'taskReminderMinutes', 'taskEmailReminderMinutes', 'notifyTasks',
  'notifyLocal', 'notifyGoogle', 'defaultReminder', 'defaultEventMinutes', 'weekStart', 'h12', 'weekView', 'assumePastDone', 'allDayBlocks', 'timePrefs',
  'dailyCapMinutes', 'marginDays', 'repeatHorizonDays', 'travelMinutes', 'pomodoro', 'learnSpeed', 'snapMinutes', 'colorLabels', 'readingDefaults', 'outlookClientId', 'holds', 'sinceLastBuffer', 'tillNextBuffer', 'notifyProfiles', 'eventProfile', 'taskProfile', 'hoursChange', 'sleepAssume', 'sleepStart', 'sleepEnd', 'sleepCategory', 'reviewAllEvents', 'zodiac', 'paperPeriod', 'horoscopeSource', 'goals', 'goalsMonths', 'goalHeads', 'goalRepeats', 'paperCats', 'paperName', 'paperScope', 'picSources', 'goalNotice', 'goalNoticeAt', 'goalNoticeShown', 'later', 'weather', 'leave', 'habits', 'sleepEvents', 'sleepCal', 'sleepDone', 'sleepEventsFrom', 'game', 'notes', 'dayRatings'];
const normCat = ({ id, name, color, icon, prefer, parent }) => ({ id, name, color, icon: icon || '', ...(prefer ? { prefer } : {}), ...(parent ? { parent } : {}) });
function sharedOf(s) {
  const o = {};
  for (const k of SHARED_KEYS) if (s[k] !== undefined) o[k] = k === 'categories' ? (s.categories || []).map(normCat) : s[k];
  return o;
}
const hashOf = (o) => JSON.stringify(o ?? null);
const isDefault = (k, v) => k === 'categories'
  ? false : hashOf(v) === hashOf(S.DEFAULT_SETTINGS[k]);
const isBuiltin = (c) => S.DEFAULT_SETTINGS.categories.some((d) => d.id === c.id && d.name === c.name && d.color === c.color && (d.icon || '') === (c.icon || ''));
export function sharedDirty(state) { return hashOf(sharedOf(state.settings)) !== state.settings.sharedHash; }
function encodeShared(obj, rev) {
  const json = JSON.stringify(obj), out = { tempoSettings: '1', sRev: String(rev) };
  const n = Math.ceil(json.length / SHARED_PART);
  for (let i = 0; i < n; i++) out['s_' + i] = json.slice(i * SHARED_PART, (i + 1) * SHARED_PART);
  out.sN = String(n);
  return out;
}
function decodeShared(p) {
  const n = +p.sN; if (!n) return null;
  let json = ''; for (let i = 0; i < n; i++) { if (p['s_' + i] == null) return null; json += p['s_' + i]; }
  try { return JSON.parse(json); } catch { return null; }
}
const mergeHistory = (a = [], b = []) => {
  const m = new Map();
  for (const h of [...a, ...b]) if (h?.id) m.set(h.id, h);
  return [...m.values()].sort((x, y) => (x.at || 0) - (y.at || 0)).slice(-250);
};
// Merge Google's copy into this device's. `base` = what both had at the last sync (null if never synced).
export function mergeShared(local, remote, base) {
  const out = {};
  let keptLocal = false;
  for (const k of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    const l = local[k], r = remote[k];
    if (r === undefined) { out[k] = l; if (l !== undefined) keptLocal = true; continue; }
    if (l === undefined) { out[k] = r; continue; }
    if (k === 'history') { out[k] = mergeHistory(r, l); if (hashOf(out[k]) !== hashOf(r)) keptLocal = true; continue; }
    const changedHere = base ? hashOf(l) !== hashOf(base[k]) : false;
    if (k === 'categories') {
      if (!base) {
        // first sync: keep this device's customised categories where Google only has built-in/no-icon ones
        const cats = r.map((rc) => { const lc = l.find((c) => c.id === rc.id); if (lc && hashOf(lc) !== hashOf(rc) && ((isBuiltin(rc) && !isBuiltin(lc)) || (!rc.icon && lc.icon))) { keptLocal = true; return lc; } return rc; });
        const extra = l.filter((c) => !r.some((rc) => rc.id === c.id || rc.name.toLowerCase() === c.name.toLowerCase()));
        if (extra.length) keptLocal = true;
        out[k] = [...cats, ...extra];
      } else if (changedHere) {
        const byId = new Map(r.map((c) => [c.id, c]));
        const baseIds = new Set((base[k] || []).map((c) => c.id));
        for (const c of l) byId.set(c.id, c);
        for (const c of base[k] || []) if (!l.some((x) => x.id === c.id)) byId.delete(c.id); // deleted here
        for (const c of r) if (!baseIds.has(c.id) && !byId.has(c.id)) byId.set(c.id, c); // added elsewhere
        out[k] = [...byId.values()]; keptLocal = true;
      } else out[k] = r;
      continue;
    }
    if (changedHere || (!base && isDefault(k, r) && !isDefault(k, l))) { out[k] = l; if (hashOf(l) !== hashOf(r)) keptLocal = true; }
    else out[k] = r;
  }
  return { merged: out, push: keptLocal };
}
// Returns { changed } — true when this device took on settings from Google.
export async function syncShared(state, { force = false } = {}) {
  const s = state.settings;
  if (!connected(state) || (!force && !sharedDirty(state))) return { changed: false };
  const cal = primaryId(state);
  const found = await G.findByProperty(cal, 'tempoSettings=1');
  const ev = found.sort((a, b) => (+b.extendedProperties.private.sRev || 0) - (+a.extendedProperties.private.sRev || 0))[0];
  const remote = ev ? decodeShared(ev.extendedProperties.private) : null;
  const remoteRev = ev ? +ev.extendedProperties.private.sRev || 0 : 0;
  const local = sharedOf(s);
  const base = s.sharedBase || null;
  let next = local, push = false;
  if (!remote) push = true;
  else if (remoteRev > (s.sharedRev || 0) || !base) ({ merged: next, push } = mergeShared(local, remote, base));
  else push = hashOf(local) !== hashOf(base);
  const changed = hashOf(next) !== hashOf(local);
  if (changed) for (const k of Object.keys(next)) s[k] = next[k];
  let rev = remoteRev;
  if (push) {
    rev = Math.max(Date.now(), remoteRev + 1);
    const priv = encodeShared(next, rev);
    const body = {
      summary: 'Tempo settings — please keep', description: 'Used by Tempo Calendar to share your categories, work hours and other settings between devices.',
      start: { date: '2000-01-01' }, end: { date: '2000-01-02' }, transparency: 'transparent', visibility: 'private',
      reminders: { useDefault: false, overrides: [] }, extendedProperties: { private: priv },
    };
    if (ev) await G.patchEvent(cal, ev.id, { summary: body.summary, extendedProperties: { private: { ...Object.fromEntries(Object.keys(ev.extendedProperties.private).filter((k) => k.startsWith('s_')).map((k) => [k, ''])), ...priv } } });
    else await G.insertEvent(cal, body);
    for (const extraEv of found.filter((x) => x !== ev)) await G.deleteEvent(cal, extraEv.id); // stray duplicates
  }
  s.sharedRev = rev;
  s.sharedBase = sharedOf(s);
  s.sharedHash = hashOf(s.sharedBase);
  s.sharedSyncedAt = Date.now();
  return { changed };
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
      const mins = N.taskRules(t, s).filter((r) => r.method === 'popup' && +r.minutes >= 0).map((r) => +r.minutes);
      if (!mins.length) continue;
      for (const c of S.sessions(t)) {
        if (c.kind === 'done' || c.start > until || c.start < now) continue;
        for (const rem of mins) q.push({ id: `t:${c.id}:${c.start}:${rem}`, when: c.start - rem * T.MIN, title: c.label, body: `${T.fmtTime(c.start, tz, s.h12)}–${T.fmtTime(c.end, tz, s.h12)}` });
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
      notificationSettings: c.notificationSettings || null,
    })).sort((a, b) => (b.primary - a.primary) || a.summary.localeCompare(b.summary)),
  };
  return state.gmeta.calendars;
}
