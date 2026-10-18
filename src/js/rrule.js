// Minimal RFC 5545 RRULE support: FREQ (DAILY/WEEKLY/MONTHLY/YEARLY), INTERVAL, BYDAY (with ordinals),
// BYMONTHDAY, BYMONTH, COUNT, UNTIL. Used to build rules for Google and to expand local recurring events.
import * as T from './tz.js';

export const WD = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

export function parseRRule(lines) {
  const line = (lines || []).find((l) => l.startsWith('RRULE:'));
  if (!line) return null;
  const o = { freq: 'DAILY', interval: 1, byday: [], bymonthday: [], bymonth: [], count: null, until: null, raw: line };
  for (const part of line.slice(6).split(';')) {
    const [k, v] = part.split('=');
    if (k === 'FREQ') o.freq = v;
    else if (k === 'INTERVAL') o.interval = Math.max(1, +v || 1);
    else if (k === 'COUNT') o.count = +v;
    else if (k === 'UNTIL') o.until = v;
    else if (k === 'BYDAY') o.byday = v.split(',').map((s) => {
      const m = s.match(/^([+-]?\d+)?([A-Z]{2})$/);
      return m ? { n: m[1] ? +m[1] : null, wd: WD.indexOf(m[2]) } : null;
    }).filter(Boolean);
    else if (k === 'BYMONTHDAY') o.bymonthday = v.split(',').map(Number);
    else if (k === 'BYMONTH') o.bymonth = v.split(',').map(Number);
  }
  return o;
}

export function buildRRule(o) {
  if (!o || !o.freq) return null;
  const p = [`FREQ=${o.freq}`];
  if (o.interval > 1) p.push(`INTERVAL=${o.interval}`);
  if (o.byday?.length) p.push('BYDAY=' + o.byday.map((b) => (b.n ? b.n : '') + WD[b.wd]).join(','));
  if (o.bymonthday?.length) p.push('BYMONTHDAY=' + o.bymonthday.join(','));
  if (o.bymonth?.length) p.push('BYMONTH=' + o.bymonth.join(','));
  if (o.count) p.push(`COUNT=${o.count}`);
  else if (o.until) p.push(`UNTIL=${o.until}`);
  return 'RRULE:' + p.join(';');
}

// UNTIL string -> epoch ms (end of that instant / day)
export function untilMs(u, tz) {
  if (!u) return Infinity;
  const m = u.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return Infinity;
  const [, y, mo, d, h, mi, s, z] = m;
  if (h == null) return T.zonedMs(+y, +mo, +d, 23, 59, tz) + 59999;
  if (z) return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  return T.zonedMs(+y, +mo, +d, +h, +mi, tz);
}
export function untilFromMs(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${T.pad(d.getUTCMonth() + 1)}${T.pad(d.getUTCDate())}T${T.pad(d.getUTCHours())}${T.pad(d.getUTCMinutes())}${T.pad(d.getUTCSeconds())}Z`;
}

function matches(r, k, startKey) {
  const { y, m, d } = T.parseKey(k);
  const S = T.parseKey(startKey);
  const wd = T.weekday(k);
  const dim = T.daysInMonth(y, m);
  if (r.bymonth.length && !r.bymonth.includes(m)) return false;
  switch (r.freq) {
    case 'DAILY': {
      if (T.daysBetween(startKey, k) % r.interval) return false;
      if (r.byday.length && !r.byday.some((b) => b.wd === wd)) return false;
      return true;
    }
    case 'WEEKLY': {
      const weeks = Math.floor(T.daysBetween(T.startOfWeek(startKey, 1), T.startOfWeek(k, 1)) / 7);
      if (weeks % r.interval) return false;
      const days = r.byday.length ? r.byday.map((b) => b.wd) : [T.weekday(startKey)];
      return days.includes(wd);
    }
    case 'MONTHLY': {
      const months = (y - S.y) * 12 + (m - S.m);
      if (months % r.interval) return false;
      return monthDayMatch(r, d, wd, dim, S.d);
    }
    case 'YEARLY': {
      if ((y - S.y) % r.interval) return false;
      if (!r.bymonth.length && m !== S.m) return false;
      return monthDayMatch(r, d, wd, dim, S.d);
    }
  }
  return false;
}

function monthDayMatch(r, d, wd, dim, startDay) {
  if (r.byday.length) {
    const nth = Math.ceil(d / 7);
    const nthEnd = -Math.ceil((dim - d + 1) / 7);
    const okDay = r.byday.some((b) => b.wd === wd && (b.n == null || b.n === nth || b.n === nthEnd));
    if (!okDay) return false;
    if (r.bymonthday.length) return r.bymonthday.some((v) => v === d || (v < 0 && dim + v + 1 === d));
    return true;
  }
  if (r.bymonthday.length) return r.bymonthday.some((v) => v === d || (v < 0 && dim + v + 1 === d));
  return d === startDay;
}

// Expand occurrences. Timed events: dtstart is epoch ms & tz is the event zone. All-day: startKey given.
// Returns array of occurrence start (ms for timed, day key for all-day) intersecting [rangeStart, rangeEnd).
export function expand({ rule, startMs, startKey, allDay, tz, durationMs = 0, exdates = [] }, rangeStart, rangeEnd, displayTz) {
  const r = typeof rule === 'string' || Array.isArray(rule) ? parseRRule([].concat(rule)) : rule;
  const sKey = allDay ? startKey : T.dayKey(startMs, tz);
  const sp = allDay ? null : T.partsOf(startMs, tz);
  const limit = untilMs(r?.until, tz);
  const ex = new Set(exdates);
  const out = [];
  if (!r) return out;
  let count = 0;
  let k = sKey;
  for (let i = 0; i < 40000; i++, k = T.addDays(k, 1)) {
    if (!matches(r, k, sKey) && k !== sKey) continue;
    if (k === sKey && !matches(r, k, sKey) && i > 0) continue;
    const { y, m, d } = T.parseKey(k);
    const occ = allDay ? T.dayStart(k, displayTz) : T.zonedMs(y, m, d, sp.h, sp.mi, tz);
    if (occ > limit) break;
    count++;
    if (r.count && count > r.count) break;
    if (occ >= rangeEnd) break;
    const id = allDay ? k : occ;
    if (occ + Math.max(durationMs, 1) > rangeStart && !ex.has(id)) out.push(id);
  }
  return out;
}

const ORD = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', '-1': 'last' };
const WDN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export function describe(lines) {
  const r = parseRRule(lines);
  if (!r) return '';
  const every = r.interval > 1 ? `Every ${r.interval} ` : 'Every ';
  let s;
  switch (r.freq) {
    case 'DAILY': s = r.interval > 1 ? `${every}days` : 'Daily'; break;
    case 'WEEKLY': {
      const days = r.byday.map((b) => WDN[b.wd].slice(0, 3)).join(', ');
      s = (r.interval > 1 ? `${every}weeks` : 'Weekly') + (days ? ` on ${days}` : ''); break;
    }
    case 'MONTHLY': {
      s = r.interval > 1 ? `${every}months` : 'Monthly';
      if (r.byday.length) s += ` on the ${ORD[r.byday[0].n] || ''} ${WDN[r.byday[0].wd]}`;
      else if (r.bymonthday.length) s += ` on day ${r.bymonthday.join(', ')}`;
      break;
    }
    case 'YEARLY': s = r.interval > 1 ? `${every}years` : 'Annually'; break;
  }
  if (r.count) s += `, ${r.count} times`;
  else if (r.until) s += `, until ${r.until.slice(0, 4)}-${r.until.slice(4, 6)}-${r.until.slice(6, 8)}`;
  return s;
}
