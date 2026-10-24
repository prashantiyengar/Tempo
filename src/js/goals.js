// Goals: ranked lists for this week, next week, this month, each of the next months, and the next 12 months.
// Stored in settings.goals (synced like your other settings) as { "<key>": [{ id, text, done, at }] }, ranked by order.
//   w:YYYY-MM-DD  week starting that day      m:YYYY-MM  calendar month      y  the next 12 months (rolling)
import * as T from './tz.js';

export const weekKey = (wk) => `w:${wk}`;
export const monthKey = (k) => `m:${k.slice(0, 7)}`;
export const YEAR = 'y';
export const list = (s, key) => (s.goals || {})[key] || [];
const newId = () => 'g' + Math.random().toString(36).slice(2, 9);

// Goals are grouped under three heads. Each head has categories whose events and task sessions count towards it
// (one setting for all periods); a goal can use its own categories instead.
export const HEADS = [['work', 'Work', '💼'], ['fitness', 'Fitness', '🏃'], ['personal', 'Personal', '🏠']];
const DEFAULT_CATS = { work: ['work', 'study'], fitness: [], personal: ['personal', 'leisure'] };
export const headOf = (g) => (HEADS.some(([h]) => h === g.head) ? g.head : 'personal');
export const headCats = (s, head) => (s.goalHeads?.[head]?.cats ?? DEFAULT_CATS[head] ?? []).filter((id) => id === '__none' || (s.categories || []).some((c) => c.id === id));
export const goalCats = (s, g) => (g.cats?.length ? g.cats : headCats(s, headOf(g)));
export const withHeadCats = (s, head, cats) => ({ ...(s.goalHeads || {}), [head]: { ...((s.goalHeads || {})[head] || {}), cats } });

// Text a goal looks for in the titles of events and tasks, e.g. "Moby Dick" (several: any of them).
export const goalWords = (g) => (Array.isArray(g?.words) ? g.words : []).map((w) => String(w).trim()).filter(Boolean);
export const parseWords = (str) => [...new Set(String(str || '').split(/[,;\n]/).map((w) => w.trim().replace(/^["“”']+|["“”']+$/g, '')).filter(Boolean))].slice(0, 10);
const fold = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
export const titleOf = (it) => (it.kind === 'chunk' ? `${it.task?.title || ''} ${it.title || ''}` : `${it.title || ''} ${it.ev?.summary || ''}`);
export const titleHas = (it, words) => { const t = fold(titleOf(it)); return words.some((w) => t.includes(fold(w))); };
// What counts for a goal: its own categories and/or text in titles ("either" = any match, "both" = category and text).
export const goalMatch = (g) => ({ cats: g.cats || [], words: goalWords(g), mode: g.wmode === 'both' ? 'both' : 'either' });
export const hasOwnMatch = (g) => !!(g.cats?.length || goalWords(g).length);

// Time spent (before now) and planned (after now) in [from, to) on events and task sessions in these categories
// (and/or whose titles contain one of `words`).
export function timeIn(items, cats, from, to, now = Date.now(), settings = null, { words = [], mode = 'either' } = {}) {
  // counting a main category also counts its sub-categories
  const set = new Set(cats || []);
  if (settings) for (const c of settings.categories || []) if (c.parent && set.has(c.parent)) set.add(c.id);
  let done = 0, planned = 0;
  if (!set.size && !words.length) return { done, planned };
  for (const it of items) {
    if (it.allDay || it.declined || it.ev?.transparency === 'transparent') continue;
    const cat = it.kind === 'chunk' ? it.task?.categoryId : it.catId;
    const byCat = set.size ? set.has(cat || '__none') : null, byText = words.length ? titleHas(it, words) : null;
    const ok = byCat == null ? byText : byText == null ? byCat : mode === 'both' ? byCat && byText : byCat || byText;
    if (!ok) continue;
    if (it.kind === 'chunk' && (it.status === 'waived' || it.sess?.kind === 'waived')) continue;
    const a = Math.max(it.start, from), b = Math.min(it.end, to);
    if (b <= a) continue;
    done += Math.max(0, Math.min(b, now) - a) / T.MIN;
    planned += Math.max(0, b - Math.max(a, now)) / T.MIN;
  }
  return { done: Math.round(done), planned: Math.round(planned) };
}
// ---------- Hours in categories (for automatic goals and habits) ----------
// Elapsed minutes (before `now`) in [from, to) spent on events and task sessions in these categories (sub-categories
// included); overlapping entries are counted once.
export function catMinutes(items, cats, from, to, now = Date.now(), settings = null) {
  const set = new Set(cats || []);
  if (settings) for (const c of settings.categories || []) if (c.parent && set.has(c.parent)) set.add(c.id);
  if (!set.size) return 0;
  const end = Math.min(to, now), iv = [];
  for (const it of items) {
    if (it.allDay || it.declined || it.ev?.transparency === 'transparent') continue;
    if (it.kind === 'chunk' && (it.status === 'waived' || it.sess?.kind === 'waived')) continue;
    if (!set.has((it.kind === 'chunk' ? it.task?.categoryId : it.catId) || '__none')) continue;
    const a = Math.max(it.start, from), b = Math.min(it.end, end);
    if (b > a) iv.push([a, b]);
  }
  iv.sort((x, y) => x[0] - y[0]);
  let m = 0, cs = -1, ce = -1;
  for (const [a, b] of iv) { if (a > ce) { if (ce > cs) m += ce - cs; cs = a; ce = b; } else ce = Math.max(ce, b); }
  if (ce > cs) m += ce - cs;
  return m / T.MIN;
}
// ---------- Time-of-day rules: something has to start by, or end before, a time ----------
// r = { which: 'startBy' | 'endBy', time: 'HH:MM', cats: [...], words: [...] } — what counts: events and task sessions in
// those categories and/or with one of the words in the title (words match at the start of a word, any case).
const foldW = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
export function wordMatcher(words) {
  const ws = (words || []).map((w) => foldW(String(w).trim())).filter(Boolean);
  if (!ws.length) return null;
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${ws.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'u');
  return (t) => re.test(foldW(t));
}
export function timingMatches(r, s) {
  const set = new Set(r.cats || []);
  for (const c of s.categories || []) if (c.parent && set.has(c.parent)) set.add(c.id);
  const wm = wordMatcher(r.words);
  return (it) => {
    if (it.allDay || it.declined) return false;
    if (it.kind === 'chunk' && (it.status === 'waived' || it.sess?.kind === 'waived')) return false;
    const byCat = set.size ? set.has((it.kind === 'chunk' ? it.task?.categoryId : it.catId) || '__none') : false;
    const byWord = wm ? wm(it.kind === 'chunk' ? `${it.task?.title || ''} ${it.title || ''}` : `${it.title || ''} ${it.ev?.summary || ''}`) : false;
    return byCat || byWord;
  };
}
export const timingText = (r) => `${r.which === 'endBy' ? 'ends before' : 'starts by'} ${r.time}`;
// Was the rule kept on day k? ok: true / false, or null when it can't be told yet (the time hasn't come).
//   startBy: something that counts started that day at or before the time
//   endBy:   something that counts ended that day by the time, and nothing that counts was still going on at it
//            (sleep blocks 23:00–02:00 and 03:00–07:00 → sleep ended at 07:00)
export function timingDay(items, k, r, s, now = Date.now()) {
  const z = s.tz, d0 = T.dayStart(k, z), d1 = T.dayStart(T.addDays(k, 1), z), at = T.atTime(k, r.time || '09:00', z);
  const m = timingMatches(r, s), mine = items.filter((it) => it.start <= now && m(it));
  const hm = (ms) => T.hhmm(T.minutesOfDay(ms, z));
  if (r.which === 'endBy') {
    const ends = mine.filter((it) => it.end > d0 && it.end <= d1 && it.end <= now).sort((a, b) => b.end - a.end);
    const over = mine.find((it) => it.start < at && it.end > at);
    if (over) return { ok: over.end <= now || now >= at ? false : null, why: `“${over.title || over.task?.title || ''}” until ${hm(over.end)}` };
    const before = ends.filter((it) => it.end <= at);
    if (before.length) return { ok: true, why: `“${before[0].title || before[0].task?.title || ''}” ended ${hm(before[0].end)}` };
    return { ok: now >= at ? false : null, why: now >= at ? 'nothing ended by then' : '' };
  }
  const starts = mine.filter((it) => it.start >= d0 && it.start < d1).sort((a, b) => a.start - b.start);
  if (starts.length && starts[0].start <= at) return { ok: true, why: `“${starts[0].title || starts[0].task?.title || ''}” started ${hm(starts[0].start)}` };
  return { ok: now >= at ? false : null, why: starts.length ? `first started ${hm(starts[0].start)}` : now >= at ? 'nothing started by then' : '' };
}

// A rule: { cats, op: 'atLeast' | 'atMost', hours, per: 'period' | 'day' | 'week' }
export const ruleText = (r, s) => r.kind === 'timing' ? `${timingText(r)}${r.days ? ` on ${r.days} days` : ' every day'}` : `${r.op === 'atMost' ? 'at most' : 'at least'} ${+r.hours} h ${r.per === 'day' ? 'every day' : r.per === 'week' ? 'every week' : 'in total'}`;
// Status of a goal's rule over [fromKey, toKey): done (reached), failed (can't be reached any more), value text.
export function ruleStatus(g, s, items, fromKey, toKey, now = Date.now()) {
  const r = g.rule; if (!r) return null;
  if (r.kind === 'timing') {
    // every day of the period, or on at least N days
    const today = T.dayKey(now, s.tz), total = T.daysBetween(fromKey, toKey);
    let okN = 0, badN = 0, left = 0;
    for (let k = fromKey; k < toKey; k = T.addDays(k, 1)) {
      if (k > today) { left++; continue; }
      const d = timingDay(items, k, { ...r, cats: r.cats?.length ? r.cats : (r.words?.length ? [] : goalCats(s, g)) }, s, now);
      if (d.ok === true) okN++; else if (d.ok === false) badN++; else left++;
    }
    const need = r.days ? Math.min(total, +r.days) : total;
    return { done: okN >= need, failed: okN + left < need, onTrack: okN + left >= need, text: `${okN}/${need} days ${timingText(r)}` };
  }
  if (!(+r.hours >= 0)) return null;
  const z = s.tz, cats = r.cats?.length ? r.cats : goalCats(s, g), lim = +r.hours * 60, today = T.dayKey(now, z);
  const over = T.dayStart(toKey, z) <= now;
  const span = (a, b) => catMinutes(items, cats, T.dayStart(a, z), T.dayStart(b, z), now, s);
  const fmt = (m) => (m >= 60 ? `${+(m / 60).toFixed(1)} h` : `${Math.round(m)} min`);
  if (r.per === 'day' || r.per === 'week') {
    const parts = [];
    for (let k = fromKey; k < toKey && k <= today; ) {
      const e = r.per === 'day' ? T.addDays(k, 1) : T.addDays(T.startOfWeek(k, s.weekStart ?? 1), 7);
      const stop = e < toKey ? e : toKey;
      parts.push({ m: span(k, stop), closed: T.dayStart(stop, z) <= now });
      k = stop;
    }
    const okP = (p) => (r.op === 'atMost' ? p.m <= lim : p.m >= lim);
    const bad = parts.filter((p) => (r.op === 'atMost' ? !okP(p) : p.closed && !okP(p))).length;
    const good = parts.filter(okP).length;
    const total = r.per === 'day' ? T.daysBetween(fromKey, toKey) : Math.ceil(T.daysBetween(fromKey, toKey) / 7);
    return { done: over && !bad, failed: bad > 0, onTrack: !bad, text: `${good}/${total} ${r.per === 'day' ? 'days' : 'weeks'} ${r.op === 'atMost' ? '≤' : '≥'} ${+r.hours} h` };
  }
  const m = span(fromKey, toKey);
  if (r.op === 'atMost') return { done: over && m <= lim, failed: m > lim, onTrack: m <= lim, text: `${fmt(m)} of ≤ ${+r.hours} h` };
  return { done: m >= lim, failed: over && m < lim, onTrack: true, text: `${fmt(m)} of ≥ ${+r.hours} h` };
}
// Done as shown: what you ticked yourself (override) wins over the rule, which wins over the stored flag.
export function effectiveDone(g, st) { if (g.override === true || g.override === false) return g.override; return st ? st.done : !!g.done; }

// Per head: goals reached, budget, time done/planned — for a section [fromKey, toKey).
export function progress(s, key, items, fromKey, toKey, now = Date.now()) {
  const z = s.tz, from = T.dayStart(fromKey, z), to = T.dayStart(toKey, z);
  return HEADS.map(([h, label, icon]) => {
    const goals = list(s, key).filter((g) => headOf(g) === h).map((g) => { if (!g.rule) return g; const rs = ruleStatus(g, s, items, fromKey, toKey, now); return { ...g, ruleState: rs, autoDone: rs?.done, done: effectiveDone(g, rs) }; });
    const budget = goals.reduce((a, g) => a + (+g.budget || 0), 0);
    const t = timeIn(items, headCats(s, h), from, to, now, s);
    return { head: h, label, icon, goals, reached: goals.filter((g) => g.done).length, budget, spent: t.done, planned: t.planned, cats: headCats(s, h),
      perGoal: goals.filter(hasOwnMatch).map((g) => { const m = goalMatch(g); return { id: g.id, ...timeIn(items, m.cats, from, to, now, s, m) }; }) };
  });
}

// Edits return a new goals object (the caller saves it).
const extra = ({ cats = null, words = null, wmode = null }) => ({ ...(cats?.length ? { cats } : {}), ...(words?.length ? { words } : {}), ...(words?.length && cats?.length && wmode === 'both' ? { wmode } : {}) });
export function add(s, key, text, { head = 'personal', budget = null, cats = null, words = null, wmode = null } = {}) {
  return { ...(s.goals || {}), [key]: [...list(s, key), { id: newId(), text: text.trim().slice(0, 200), done: false, at: Date.now(), head, ...(budget ? { budget: Math.round(budget) } : {}), ...extra({ cats, words, wmode }) }] };
}
// ---------- Repeating goals: a template in settings.goalRepeats, copied into each week / month it applies to ----------
//   { id, every: 'week' | 'month', head, text, budget, cats, from: '<first key>', skip: ['<key>'…] }
export const repeats = (s) => s.goalRepeats || [];
export function addRepeat(s, every, fromKey, { text, head, budget = null, cats = null, words = null, wmode = null }) {
  const r = { id: 'r' + Math.random().toString(36).slice(2, 9), every, from: fromKey, text: text.trim().slice(0, 200), head, ...(budget ? { budget: Math.round(budget) } : {}), ...extra({ cats, words, wmode }), skip: [] };
  return [...repeats(s), r];
}
const keyEvery = (k) => (k.startsWith('w:') ? 'week' : k.startsWith('m:') ? 'month' : null);
// Make sure each repeating goal has its copy in these periods. Returns new goals (or null when nothing changed).
export function materialize(s, keys) {
  let goals = null;
  for (const k of keys) {
    const every = keyEvery(k); if (!every) continue;
    for (const r of repeats(s)) {
      if (r.every !== every || k < r.from || (r.skip || []).includes(k)) continue;
      const l = (goals || s.goals || {})[k] || [];
      if (l.some((g) => g.repeatId === r.id)) continue;
      goals = { ...(goals || s.goals || {}), [k]: [...l, { id: newId(), text: r.text, head: r.head, done: false, at: Date.now(), repeatId: r.id, ...(r.budget ? { budget: r.budget } : {}), ...extra(r), ...(r.rule ? { rule: r.rule } : {}) }] };
    }
  }
  return goals;
}
// Remove one copy (this period only) or stop the repeat (this and later copies go).
export function removeRepeating(s, key, id, stop) {
  const g = list(s, key).find((x) => x.id === id);
  if (!g?.repeatId) return { goals: remove(s, key, id), goalRepeats: repeats(s) };
  if (!stop) return { goals: remove(s, key, id), goalRepeats: repeats(s).map((r) => (r.id === g.repeatId ? { ...r, skip: [...new Set([...(r.skip || []), key])] } : r)) };
  const goals = {};
  for (const [k, l] of Object.entries(s.goals || {})) goals[k] = k >= key ? l.filter((x) => x.repeatId !== g.repeatId || x.done) : l;
  goals[key] = (goals[key] || []).filter((x) => x.id !== id);
  return { goals, goalRepeats: repeats(s).filter((r) => r.id !== g.repeatId) };
}
export const repeatOf = (s, g) => (g?.repeatId ? repeats(s).find((r) => r.id === g.repeatId) || null : null);

// Move a goal to another period (e.g. carry an unfinished one over); it goes to the end of that list.
export function moveTo(s, fromKey, id, toKey) {
  const g = list(s, fromKey).find((x) => x.id === id);
  if (!g || fromKey === toKey) return s.goals || {};
  return { ...(s.goals || {}), [fromKey]: list(s, fromKey).filter((x) => x.id !== id), [toKey]: [...list(s, toKey), { ...g, done: false, movedFrom: fromKey }] };
}
export function keyLabel(s, k) {
  if (k === YEAR) return 'the next 12 months';
  if (k.startsWith('w:')) return `the week of ${T.format(T.dayStart(k.slice(2), s.tz), s.tz, { day: 'numeric', month: 'short' })}`;
  return T.format(T.dayStart(k.slice(2) + '-01', s.tz), s.tz, { month: 'long', year: 'numeric' });
}
export function update(s, key, id, ch) { return { ...(s.goals || {}), [key]: list(s, key).map((g) => (g.id === id ? { ...g, ...ch } : g)) }; }
export function remove(s, key, id) { return { ...(s.goals || {}), [key]: list(s, key).filter((g) => g.id !== id) }; }
export function move(s, key, id, dir) {
  const l = [...list(s, key)], i = l.findIndex((g) => g.id === id);
  if (i < 0) return s.goals || {};
  const h = headOf(l[i]);
  let j = i + dir;
  while (j >= 0 && j < l.length && headOf(l[j]) !== h) j += dir;
  if (j < 0 || j >= l.length) return s.goals || {};
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
