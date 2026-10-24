// Habits, in the spirit of the Loop Habit Tracker ("Habits") on Android: a list of habits with a score ring and
// the last few days to tick off, and for each habit its score over time, history, calendar, streaks and
// weekdays. Stored in settings.habits (synced with your other devices like the rest of your settings):
//   { id, name, question, color, type: 'yesno' | 'number', target, unit, freq: { times, per: 'day' | 'week' | 'month' },
//     created, archived, log: { 'YYYY-MM-DD': 1 (done) | -1 (skipped) | <number> } }
// Yes/no habits: a day is done (✓), skipped (», doesn't break a streak) or not done. Number habits: the amount on
// each day, against a target per day, week or month (e.g. 8 glasses a day, 20 km a week).
import * as T from './tz.js';

export const COLORS = ['#d32f2f', '#e64a19', '#f57c00', '#ff8f00', '#f9a825', '#afb42b', '#7cb342', '#388e3c', '#00897b', '#00acc1', '#039be5', '#1976d2', '#303f9f', '#5e35b1', '#8e24aa', '#d81b60', '#5d4037', '#757575'];
export const PER_DAYS = { day: 1, week: 7, month: 30 };
export const newId = () => 'h' + Math.random().toString(36).slice(2, 9);
export const list = (s, { archived = false } = {}) => (s.habits || []).filter((h) => archived || !h.archived);
export const byId = (s, id) => (s.habits || []).find((h) => h.id === id) || null;
export const isNumber = (h) => h.type === 'number';
const freqOf = (h) => ({ times: Math.max(1, +h.freq?.times || 1), per: PER_DAYS[h.freq?.per] ? h.freq.per : 'day' });
// share of days the habit should be done (1 = every day, 3/7 = three times a week)
export const frequency = (h) => { const f = freqOf(h); return Math.min(1, f.times / PER_DAYS[f.per]); };
export function freqLabel(h) {
  const f = freqOf(h);
  if (isNumber(h)) return `${fmtNum(+h.target || 0)} ${h.unit || ''} per ${f.per}`.replace(/\s+/g, ' ');
  if (f.per === 'day') return 'Every day';
  if (f.per === 'week') return f.times === 7 ? 'Every day' : f.times === 1 ? 'Once a week' : `${f.times} times a week`;
  return f.times === 1 ? 'Once a month' : `${f.times} times a month`;
}
export const fmtNum = (v) => (Math.abs(v) >= 100 || Number.isInteger(+v) ? String(Math.round(v)) : String(+(+v).toFixed(1)));

export const val = (h, k) => h.log?.[k];
const goalOf = (h) => (isNumber(h) ? +h.target || 1 : freqOf(h).times);
export const isSkip = (h, k) => val(h, k) === -1;
// how much of the day's share was done (0..1): yes/no 1 when ticked; numbers relative to the daily share of the target
export function dayValue(h, k) {
  const v = val(h, k);
  if (v == null || v === -1) return 0;
  if (!isNumber(h)) return v === 1 ? 1 : 0;
  const f = freqOf(h), daily = (+h.target || 1) / PER_DAYS[f.per];
  return Math.min(1, Math.max(0, +v) / daily);
}
export const isDone = (h, k) => (isNumber(h) ? (+val(h, k) || 0) > 0 && dayValue(h, k) >= 1 : val(h, k) === 1);

// Next state when a day is tapped: yes/no cycles not done → done → not done; skip is set separately.
export function toggled(h, k) {
  const log = { ...(h.log || {}) };
  if (val(h, k) === 1 || val(h, k) === -1) delete log[k]; else log[k] = 1;
  return { ...h, log };
}
export function setValue(h, k, v) {
  const log = { ...(h.log || {}) };
  if (v == null || v === '' || (+v === 0 && v !== -1)) delete log[k]; else log[k] = v === -1 ? -1 : +v;
  return { ...h, log };
}
export const skipped = (h, k) => setValue(h, k, isSkip(h, k) ? null : -1);

const firstKey = (h, s) => {
  const logged = Object.keys(h.log || {}).sort()[0];
  const made = h.created ? T.dayKey(h.created, s.tz) : null;
  return [logged, made].filter(Boolean).sort()[0] || T.dayKey(Date.now(), s.tz);
};

// Habit strength 0..1, like Loop: every day the score decays a little and gains how well the habit is kept —
// measured over a rolling window of its period (for "3 times a week", how many of the last 7 days were done,
// out of 3), so a weekly habit isn't punished for the days in between. Skipped days keep the score.
export function scoreSeries(h, s, toKey = T.dayKey(Date.now(), s.tz)) {
  const f = freqOf(h), win = PER_DAYS[f.per], goal = goalOf(h);
  const m = Math.pow(0.5, Math.sqrt(1 / frequency(h)) / 13);
  const out = [];
  let sc = 0;
  const amount = (k) => { const v = val(h, k); return isNumber(h) ? (v > 0 ? +v : 0) : v === 1 ? 1 : 0; };
  const start = firstKey(h, s);
  let roll = 0; const q = [];
  for (let k = start, i = 0; k <= toKey && i < 4000; k = T.addDays(k, 1), i++) {
    const a = amount(k); q.push(a); roll += a; if (q.length > win) roll -= q.shift();
    if (isSkip(h, k)) { out.push({ k, sc }); continue; }
    const v = Math.min(1, roll / goal);
    sc = sc * m + v * (1 - m);
    out.push({ k, sc });
  }
  return out;
}
export const score = (h, s, toKey) => { const ser = scoreSeries(h, s, toKey); return ser.length ? ser[ser.length - 1].sc : 0; };

// Periods (day / week / month) the habit's frequency is counted in, containing day k
export function periodOf(h, s, k) {
  const f = freqOf(h);
  if (f.per === 'day') return { from: k, to: T.addDays(k, 1) };
  if (f.per === 'week') { const a = T.startOfWeek(k, s.weekStart ?? 1); return { from: a, to: T.addDays(a, 7) }; }
  const { y, m } = T.parseKey(k), a = T.keyOf(y, m, 1); return { from: a, to: T.addMonths(a, 1) };
}
// What was done in [from, to): days done (yes/no) or the total amount (numbers)
export function amountIn(h, from, to) {
  let n = 0;
  for (let k = from, i = 0; k < to && i < 400; k = T.addDays(k, 1), i++) {
    const v = val(h, k);
    if (isNumber(h)) n += v > 0 ? +v : 0; else if (v === 1) n++;
  }
  return n;
}
// Is the period met? (all days skipped counts as met)
function periodMet(h, from, to) {
  const n = amountIn(h, from, to);
  if (n >= goalOf(h)) return true;
  let all = true; for (let k = from; k < to; k = T.addDays(k, 1)) if (!isSkip(h, k)) { all = false; break; }
  return all;
}

// Streaks in days (daily habits) or periods (weekly / monthly): current and best, plus the longest runs for a chart.
export function streaks(h, s, todayKey = T.dayKey(Date.now(), s.tz)) {
  const f = freqOf(h), runs = [];
  let cur = null, k = periodOf(h, s, firstKey(h, s)).from;
  for (let i = 0; i < 2000 && k <= todayKey; i++) {
    const p = periodOf(h, s, k);
    const met = periodMet(h, p.from, p.to);
    const open = p.to > todayKey; // the current period isn't over yet
    if (met) { if (cur) { cur.n++; cur.to = p.to; } else { cur = { n: 1, from: p.from, to: p.to }; runs.push(cur); } }
    else if (!open) cur = null;
    k = p.to;
  }
  const last = runs[runs.length - 1];
  const lastP = periodOf(h, s, todayKey), prevP = periodOf(h, s, T.addDays(lastP.from, -1));
  const current = last && (last.to === lastP.to || last.to === lastP.from || (f.per === 'day' && last.to === prevP.to)) ? last.n : 0;
  const unit = f.per === 'day' ? 'day' : f.per;
  return { current, best: Math.max(0, ...runs.map((r) => r.n)), unit, top: [...runs].sort((a, b) => b.n - a.n).slice(0, 5) };
}

// Done per week (or month) for the history chart: [{ from, n, goal }]
export function history(h, s, count = 16, by = 'week', todayKey = T.dayKey(Date.now(), s.tz)) {
  const out = [];
  let a = by === 'week' ? T.startOfWeek(todayKey, s.weekStart ?? 1) : T.keyOf(T.parseKey(todayKey).y, T.parseKey(todayKey).m, 1);
  for (let i = 0; i < count; i++) {
    const b = by === 'week' ? T.addDays(a, 7) : T.addMonths(a, 1);
    out.unshift({ from: a, n: amountIn(h, a, b), goal: Math.round(goalOf(h) * (by === 'week' ? 7 : 30) / PER_DAYS[freqOf(h).per] * 10) / 10 });
    a = by === 'week' ? T.addDays(a, -7) : T.addMonths(a, -1);
  }
  return out;
}
// How often it's done on each weekday (0 = Sunday … 6), over the last `days`
export function byWeekday(h, s, days = 365, todayKey = T.dayKey(Date.now(), s.tz)) {
  const n = [0, 0, 0, 0, 0, 0, 0];
  for (let k = T.addDays(todayKey, -days + 1); k <= todayKey; k = T.addDays(k, 1)) if (isDone(h, k) || (isNumber(h) && val(h, k) > 0)) n[T.weekday(k)]++;
  return n;
}
// Summary for [from, to): what was done, what was expected, percentage, score change
export function summary(h, s, from, to) {
  const z = s.tz, today = T.dayKey(Date.now(), z), end = to > T.addDays(today, 1) ? T.addDays(today, 1) : to;
  const days = Math.max(0, T.daysBetween(from, end));
  // daily: the days so far; weekly / monthly: the whole periods in the range (a review week expects "3 of 3")
  const per = freqOf(h).per;
  const expected = per === 'day' ? goalOf(h) * days : goalOf(h) * Math.max(1, Math.round(T.daysBetween(from, to) / PER_DAYS[per]));
  const done = amountIn(h, from, end);
  const scEnd = score(h, s, T.addDays(end, -1)), scStart = score(h, s, T.addDays(from, -1));
  return { done, expected, pct: expected ? Math.min(100, Math.round((done / expected) * 100)) : 0, score: scEnd, change: scEnd - scStart, days };
}
