// Goals: ranked lists for this week, next week, this month, each of the next months, and the next 12 months.
// Stored in settings.goals (synced like your other settings) as { "<key>": [{ id, text, done, at }] }, ranked by order.
//   w:YYYY-MM-DD  week starting that day      m:YYYY-MM  calendar month      y  the next 12 months (rolling)
import * as T from './tz.js';

export const weekKey = (wk) => `w:${wk}`;
export const monthKey = (k) => `m:${k.slice(0, 7)}`;
export const YEAR = 'y';
export const list = (s, key) => (s.goals || {})[key] || [];
const newId = () => 'g' + Math.random().toString(36).slice(2, 9);

// Edits return a new goals object (the caller saves it).
export function add(s, key, text) { return { ...(s.goals || {}), [key]: [...list(s, key), { id: newId(), text: text.trim().slice(0, 200), done: false, at: Date.now() }] }; }
export function update(s, key, id, ch) { return { ...(s.goals || {}), [key]: list(s, key).map((g) => (g.id === id ? { ...g, ...ch } : g)) }; }
export function remove(s, key, id) { return { ...(s.goals || {}), [key]: list(s, key).filter((g) => g.id !== id) }; }
export function move(s, key, id, dir) {
  const l = [...list(s, key)], i = l.findIndex((g) => g.id === id), j = i + dir;
  if (i < 0 || j < 0 || j >= l.length) return s.goals || {};
  [l[i], l[j]] = [l[j], l[i]];
  return { ...(s.goals || {}), [key]: l };
}
// Drop lists for periods that ended more than a year ago (keeps the synced settings small).
export function prune(goals, todayKey) {
  const out = {};
  const cutoff = T.addDays(todayKey, -400);
  for (const [k, v] of Object.entries(goals || {})) {
    if (!v?.length) continue;
    const d = k.startsWith('w:') ? k.slice(2) : k.startsWith('m:') ? k.slice(2) + '-01' : null;
    if (d && d < cutoff) continue;
    out[k] = v;
  }
  return out;
}

// The sections shown on the Goals page, for "today".
export function sections(s, todayKey) {
  const ws = s.weekStart ?? 1;
  const wk = T.startOfWeek(todayKey, ws), nwk = T.addDays(wk, 7);
  const { y, m } = T.parseKey(todayKey);
  const mStart = T.keyOf(y, m, 1), mEnd = T.addMonths(mStart, 1);
  const daysLeft = T.daysBetween(todayKey, mEnd); // incl. today
  const out = [
    { key: weekKey(wk), kind: 'week', title: 'This week', from: wk, to: nwk },
    { key: weekKey(nwk), kind: 'week', title: 'Next week', from: nwk, to: T.addDays(nwk, 7) },
  ];
  if (daysLeft > 14) out.push({ key: monthKey(mStart), kind: 'month', title: 'This month', from: todayKey, to: mEnd, month: mStart });
  const n = s.goalsMonths === 12 ? 12 : 3;
  for (let i = 1; i <= n; i++) { const a = T.addMonths(mStart, i); out.push({ key: monthKey(a), kind: 'month', title: null, from: a, to: T.addMonths(a, 1), month: a }); }
  out.push({ key: YEAR, kind: 'year', title: 'Next 12 months', from: todayKey, to: T.addMonths(mStart, 13) });
  return { list: out, daysLeft, thisMonth: mStart };
}

// Travel in a period, to remind you while setting goals: events that look like trips (flights, trains, hotels,
// holidays…), events in a "travel" category, and multi-day all-day events with a place.
const TRAVEL = /✈|🧳|🏖|🚆|🛫|🛬|\b(flight|flug|fly(ing)? to|trip|travel|journey|vacation|holiday|urlaub|reise|ferien|hotel|airbnb|airport|check-?in|train to|drive to|road ?trip|visit(ing)?|conference|retreat|abroad)\b/i;
export function isTravel(it, s) {
  if (it.kind === 'chunk' || it.declined) return false;
  const cat = (s.categories || []).find((c) => c.id === it.catId);
  if (cat && (/travel|reise|trip|urlaub/i.test(cat.name) || /✈|🧳|🚆|🗺/.test(cat.icon || ''))) return true;
  const t = `${it.title || ''} ${it.ev?.location || ''}`;
  if (TRAVEL.test(it.title || '')) return true;
  if (it.allDay && it.ev?.location && it.endKey && T.daysBetween(it.startKey, it.endKey) >= 2) return true;
  return /\b(airport|flughafen|hauptbahnhof|station)\b/i.test(t) && /✈|flight|flug|train|zug/i.test(t);
}
export function travelIn(items, fromKey, toKey, s) {
  const z = s.tz, a = T.dayStart(fromKey, z), b = T.dayStart(toKey, z);
  const trips = [];
  for (const it of items) {
    if (!isTravel(it, s)) continue;
    const st = it.allDay ? T.dayStart(it.startKey, z) : it.start, en = it.allDay ? T.dayStart(it.endKey, z) : it.end;
    if (en <= a || st >= b) continue;
    // one line per trip: same title within a few days merges
    const same = trips.find((x) => x.title === it.title && st - x.end < 3 * T.DAY);
    if (same) { same.end = Math.max(same.end, en); same.start = Math.min(same.start, st); } else trips.push({ title: it.title, start: st, end: en, allDay: !!it.allDay, where: it.ev?.location || '' });
  }
  return trips.sort((x, y) => x.start - y.start);
}
export function fmtTrip(t, s) {
  const z = s.tz, d = (ms) => T.format(ms, z, { weekday: 'short', day: 'numeric', month: 'short' });
  const last = t.allDay ? t.end - 1 : t.end;
  const same = T.dayKey(t.start, z) === T.dayKey(last, z);
  return `${d(t.start)}${same ? (t.allDay ? '' : ' ' + T.fmtTime(t.start, z, s.h12)) : ' – ' + d(last)}`;
}

// Goals that belong to a review period [fromKey, toKey): weeks starting in it, months starting in it, and — for a
// year — the 12-month list. `next` = the following period's.
export function forPeriod(s, fromKey, toKey, period) {
  const ws = s.weekStart ?? 1, out = [];
  const label = (k) => (k === YEAR ? 'The next 12 months' : k.startsWith('w:') ? `Week of ${T.format(T.dayStart(k.slice(2), s.tz), s.tz, { day: 'numeric', month: 'short' })}` : T.format(T.dayStart(k.slice(2) + '-01', s.tz), s.tz, { month: 'long', year: 'numeric' }));
  const push = (k) => { const l = list(s, k); if (l.length) out.push({ key: k, label: label(k), list: l }); };
  if (period === 'week' || period === 'fortnight') {
    for (let w = T.startOfWeek(fromKey, ws); w < toKey; w = T.addDays(w, 7)) push(weekKey(w));
  } else {
    for (let mm = T.keyOf(T.parseKey(fromKey).y, T.parseKey(fromKey).m, 1); mm < toKey; mm = T.addMonths(mm, 1)) push(monthKey(mm));
    if (period === 'year') push(YEAR);
  }
  return out;
}
