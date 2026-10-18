// Time-zone helpers built only on Intl (no dependencies).
// "Day keys" are 'YYYY-MM-DD' strings; all instants are epoch milliseconds.

const fmtCache = new Map();
function fmt(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export const pad = (n) => String(n).padStart(2, '0');
export const MIN = 60000;
export const HOUR = 3600000;
export const DAY = 86400000;

export function systemTz() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

export function allTimezones() {
  try { return Intl.supportedValuesOf('timeZone'); } catch {
    return ['UTC', 'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'America/New_York', 'America/Chicago',
      'America/Denver', 'America/Los_Angeles', 'Asia/Tokyo', 'Asia/Kolkata', 'Asia/Shanghai', 'Australia/Sydney'];
  }
}

export function isValidTz(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

export function partsOf(ms, tz) {
  const o = {};
  for (const p of fmt(tz).formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = +p.value;
  if (o.hour === 24) o.hour = 0;
  return { y: o.year, m: o.month, d: o.day, h: o.hour, mi: o.minute, s: o.second };
}

export function offsetMin(ms, tz) {
  const p = partsOf(ms, tz);
  return (Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000) / MIN;
}

// Wall-clock time in `tz` -> epoch ms. Overflowing fields (d=32, h=24) roll over like Date.UTC.
export function zonedMs(y, m, d, h = 0, mi = 0, tz = 'UTC') {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const o1 = offsetMin(guess, tz);
  let ms = guess - o1 * MIN;
  const o2 = offsetMin(ms, tz);
  if (o2 !== o1) ms = guess - o2 * MIN;
  return ms;
}

export function keyOf(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}
export function parseKey(k) { const [y, m, d] = k.split('-').map(Number); return { y, m, d }; }
export function addDays(k, n) { const { y, m, d } = parseKey(k); return keyOf(y, m, d + n); }
export function addMonths(k, n) { const { y, m } = parseKey(k); return keyOf(y, m + n, 1); }
export function weekday(k) { const { y, m, d } = parseKey(k); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
export function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
export function daysBetween(a, b) {
  const A = parseKey(a), B = parseKey(b);
  return Math.round((Date.UTC(B.y, B.m - 1, B.d) - Date.UTC(A.y, A.m - 1, A.d)) / DAY);
}
export function dayKey(ms, tz) { const p = partsOf(ms, tz); return keyOf(p.y, p.m, p.d); }
export function dayStart(k, tz) { const { y, m, d } = parseKey(k); return zonedMs(y, m, d, 0, 0, tz); }
export function atTime(k, hhmm, tz) {
  const [h, mi] = hhmm.split(':').map(Number);
  const { y, m, d } = parseKey(k);
  return zonedMs(y, m, d, h, mi || 0, tz);
}
export function minutesOfDay(ms, tz) { const p = partsOf(ms, tz); return p.h * 60 + p.mi; }
export function startOfWeek(k, weekStart = 1) {
  const wd = weekday(k);
  return addDays(k, -((wd - weekStart + 7) % 7));
}

// <input type="datetime-local"> helpers
export function toDTInput(ms, tz) {
  const p = partsOf(ms, tz);
  return `${keyOf(p.y, p.m, p.d)}T${pad(p.h)}:${pad(p.mi)}`;
}
export function fromDTInput(str, tz) {
  if (!str) return null;
  const [k, t] = str.split('T');
  return atTime(k, t || '00:00', tz);
}
export function hhmm(min) { return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`; }
export function parseHHMM(s) { const [h, m] = s.split(':').map(Number); return h * 60 + (m || 0); }

// Display formatting
const dispCache = new Map();
export function format(ms, tz, opts) {
  const key = tz + JSON.stringify(opts);
  let f = dispCache.get(key);
  if (!f) { f = new Intl.DateTimeFormat(undefined, { timeZone: tz, ...opts }); dispCache.set(key, f); }
  return f.format(new Date(ms));
}
export function fmtTime(ms, tz, h12) {
  return format(ms, tz, { hour: 'numeric', minute: '2-digit', hour12: !!h12 });
}
export function fmtDur(min) {
  min = Math.round(min);
  const h = Math.floor(min / 60), m = min % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}
