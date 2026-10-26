// Create / edit / move / delete events on Google or in the local calendar, including recurring-series scopes
// ('this' | 'following' | 'all').
import * as T from './tz.js';
import * as G from './gcal.js';
import { parseRRule, buildRRule, untilFromMs, expand } from './rrule.js';
import { LOCAL_CAL, interval, invalidate, noteEdit } from './engine.js';
import { newId } from './scheduler.js';

const STRIP = ['id', 'etag', 'iCalUID', 'htmlLink', 'created', 'updated', 'creator', 'organizer', 'recurringEventId', 'originalStartTime',
  'sequence', 'kind', 'hangoutLink', '_calId', '_occ', 'status', 'conferenceData', 'exdates', 'privateCopy', 'eventType'];
const clean = (ev) => { const o = { ...ev }; for (const k of STRIP) delete o[k]; return o; };

export function canEdit(ev, state) {
  if (ev._calId === LOCAL_CAL) return true;
  const cal = (state.gmeta.calendars || []).find((c) => c.id === ev._calId);
  if (!cal || !['owner', 'writer'].includes(cal.accessRole)) return false;
  if (ev.organizer && !ev.organizer.self && !ev.guestsCanModify) return false;
  return true;
}

function localMaster(state, ev) { return state.localEvents.find((e) => e.id === (ev.recurringEventId || ev.id)); }

// Rule for the part of the series before `occStart`. Returns null when nothing remains.
function truncateRule(recurrence, master, occStart, tz) {
  const r = parseRRule(recurrence);
  if (!r) return recurrence;
  const iv = interval(master, tz);
  const others = recurrence.filter((l) => !l.startsWith('RRULE:'));
  if (r.count) {
    const before = expand({ rule: r, startMs: iv.start, startKey: iv.startKey, allDay: iv.allDay, tz: master.start.timeZone || tz }, -Infinity, occStart, tz).length;
    if (!before) return null;
    return [...others, buildRRule({ ...r, count: before, until: null })];
  }
  const until = iv.allDay ? T.addDays(T.dayKey(occStart, tz), -1).replace(/-/g, '') : untilFromMs(occStart - 1000);
  return [...others, buildRRule({ ...r, until, count: null })];
}

function remainingRule(recurrence, master, occStart, tz) {
  const r = parseRRule(recurrence);
  if (!r?.count) return recurrence;
  const iv = interval(master, tz);
  const before = expand({ rule: r, startMs: iv.start, startKey: iv.startKey, allDay: iv.allDay, tz: master.start.timeZone || tz }, -Infinity, occStart, tz).length;
  return [...recurrence.filter((l) => !l.startsWith('RRULE:')), buildRRule({ ...r, count: Math.max(1, r.count - before) })];
}

// Shift a master's start/end by the change made to one instance.
function shiftedTimes(master, inst, changes, tz) {
  const mi = interval(master, tz), ii = interval(inst, tz);
  const ni = interval({ ...inst, ...changes }, tz);
  if (ni.allDay !== mi.allDay) return { start: changes.start, end: changes.end }; // type change: use new times as-is
  if (mi.allDay) {
    const shift = T.daysBetween(ii.startKey, ni.startKey);
    const len = T.daysBetween(ni.startKey, ni.endKey);
    const s = T.addDays(mi.startKey, shift);
    return { start: { date: s }, end: { date: T.addDays(s, len) } };
  }
  const delta = ni.start - ii.start, len = ni.end - ni.start;
  const zone = changes.start?.timeZone || master.start.timeZone || tz;
  return {
    start: { dateTime: new Date(mi.start + delta).toISOString(), timeZone: zone },
    end: { dateTime: new Date(mi.start + delta + len).toISOString(), timeZone: changes.end?.timeZone || zone },
  };
}

function occStartOf(ev, tz) {
  const o = ev.originalStartTime;
  if (o?.date) return T.dayStart(o.date, tz);
  if (o?.dateTime) return Date.parse(o.dateTime);
  return interval(ev, tz).start;
}

// ---------- Create ----------
export async function createEvent(state, calId, body, { conference = false } = {}) {
  if (calId === LOCAL_CAL) {
    const ev = { ...clean(body), id: newId('l'), _local: true, created: Date.now() };
    if (!ev.recurrence?.length) delete ev.recurrence;
    state.localEvents.push(ev);
    return { ...ev, _calId: LOCAL_CAL };
  }
  const b = clean(body);
  if (conference) b.conferenceData = { createRequest: { requestId: newId('meet'), conferenceSolutionKey: { type: 'hangoutsMeet' } } };
  if (!b.recurrence?.length) delete b.recurrence;
  let ev = await G.insertEvent(calId, b, { conference });
  if (!b.recurrence?.length) ev = await G.confirmEvent(calId, ev.id, b);
  if (!b.recurrence?.length) noteEdit(calId, ev);
  invalidate();
  return { ...ev, _calId: calId };
}

// ---------- Update ----------
export async function updateEvent(state, ev, changes, scope = 'this', { conference = false } = {}) {
  const tz = state.settings.tz;
  const isInst = !!ev.recurringEventId;
  changes = { ...changes };
  if (ev._calId === LOCAL_CAL) {
    const master = localMaster(state, ev);
    if (!master) throw new Error('Event no longer exists');
    if (!isInst) { Object.assign(master, clean(changes)); if (!master.recurrence?.length) delete master.recurrence; return; }
    const occ = ev._occ;
    if (scope === 'this') {
      master.exdates = [...(master.exdates || []), occ];
      const { recurrence, ...rest } = changes;
      state.localEvents.push({ ...clean(ev), ...clean(rest), id: newId('l'), recurrence: undefined, _local: true });
    } else if (scope === 'all') {
      const times = (changes.start || changes.end) ? shiftedTimes(master, ev, changes, tz) : {};
      Object.assign(master, clean(changes), times);
      if (!master.recurrence?.length) delete master.recurrence;
    } else {
      const occMs = typeof occ === 'string' ? T.dayStart(occ, tz) : occ;
      const oldRule = truncateRule(master.recurrence, master, occMs, tz);
      const newRec = changes.recurrence?.length ? changes.recurrence : remainingRule(master.recurrence, master, occMs, tz);
      const next = { ...clean(master), ...clean(ev), ...clean(changes), id: newId('l'), recurrence: newRec, exdates: [], _local: true };
      if (oldRule) master.recurrence = oldRule; else state.localEvents = state.localEvents.filter((e) => e !== master);
      state.localEvents.push(next);
    }
    return;
  }
  // Google
  const calId = ev._calId;
  if (!isInst || scope === 'this') {
    if (isInst) delete changes.recurrence;
    if (conference && !ev.conferenceData) changes.conferenceData = { createRequest: { requestId: newId('meet'), conferenceSolutionKey: { type: 'hangoutsMeet' } } };
    if (!isInst && changes.recurrence && !changes.recurrence.length) changes.recurrence = null;
    let saved = await G.patchEvent(calId, ev.id, clean(changes), { conference: conference && !ev.conferenceData, notify: !!ev.attendees?.length });
    if (!changes.recurrence?.length) saved = (await G.confirmEvent(calId, ev.id, changes)) || saved;
    if (saved?.id && !saved.recurrence?.length) noteEdit(calId, saved);
  } else {
    const master = await G.getEvent(calId, ev.recurringEventId);
    if (scope === 'all') {
      const times = (changes.start || changes.end) ? shiftedTimes(master, ev, changes, master.start.timeZone || tz) : {};
      const body = { ...clean(changes), ...times };
      if (body.recurrence && !body.recurrence.length) body.recurrence = null;
      await G.patchEvent(calId, master.id, body, { notify: !!master.attendees?.length });
    } else {
      const occMs = occStartOf(ev, tz);
      const oldRule = truncateRule(master.recurrence, master, occMs, tz);
      const newRec = changes.recurrence?.length ? changes.recurrence : remainingRule(master.recurrence, master, occMs, tz);
      const body = { ...clean(master), ...clean(ev), ...clean(changes), recurrence: newRec };
      if (oldRule) {
        await G.patchEvent(calId, master.id, { recurrence: oldRule });
        // Occurrences you had changed individually after the split would otherwise stay as extra copies.
        try { for (const x of await G.listInstances(calId, master.id, occMs)) await G.deleteEvent(calId, x.id); } catch { /* best effort */ }
      } else await G.deleteEvent(calId, master.id);
      await G.insertEvent(calId, body);
    }
  }
  invalidate();
}

export async function moveEvent(state, ev, start, end, scope) {
  const tz = state.settings.tz;
  let changes;
  if (ev.start.date) {
    changes = { start: { date: T.dayKey(start, tz) }, end: { date: T.dayKey(end, tz) } };
  } else {
    const zone = ev.start.timeZone || tz;
    changes = { start: { dateTime: new Date(start).toISOString(), timeZone: zone }, end: { dateTime: new Date(end).toISOString(), timeZone: ev.end.timeZone || zone } };
  }
  return updateEvent(state, ev, changes, scope);
}

// ---------- Delete ----------
export async function deleteEvent(state, ev, scope = 'this') {
  const tz = state.settings.tz;
  const isInst = !!ev.recurringEventId;
  if (ev._calId === LOCAL_CAL) {
    const master = localMaster(state, ev);
    if (!master) return;
    if (!isInst || scope === 'all') { state.localEvents = state.localEvents.filter((e) => e !== master); return; }
    if (scope === 'this') { master.exdates = [...(master.exdates || []), ev._occ]; return; }
    const occMs = typeof ev._occ === 'string' ? T.dayStart(ev._occ, tz) : ev._occ;
    const rule = truncateRule(master.recurrence, master, occMs, tz);
    if (rule) master.recurrence = rule; else state.localEvents = state.localEvents.filter((e) => e !== master);
    return;
  }
  const calId = ev._calId;
  if (!isInst || scope === 'this') { await G.deleteEvent(calId, ev.id); if (!ev.recurrence?.length) noteEdit(calId, ev, true); }
  else if (scope === 'all') await G.deleteEvent(calId, ev.recurringEventId);
  else {
    const master = await G.getEvent(calId, ev.recurringEventId);
    const rule = truncateRule(master.recurrence, master, occStartOf(ev, tz), tz);
    if (rule) await G.patchEvent(calId, master.id, { recurrence: rule });
    else await G.deleteEvent(calId, master.id);
  }
  invalidate();
}

// Fetch the series master (for editing "all events" in the dialog)
export async function getMaster(state, ev) {
  if (!ev.recurringEventId) return ev;
  if (ev._calId === LOCAL_CAL) { const m = localMaster(state, ev); return m ? { ...m, _calId: LOCAL_CAL } : ev; }
  try { return { ...(await G.getEvent(ev._calId, ev.recurringEventId)), _calId: ev._calId }; } catch { return ev; }
}
