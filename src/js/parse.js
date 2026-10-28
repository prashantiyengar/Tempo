// Plain-language task entry, e.g.
//   "Read Dune 200 pages by Friday, Study"         → reading task, 200 pages, due Friday end of work day, category Study
//   "Write report 6h by Oct 30 rank 1 #Work"        → 6-hour task
//   "Exercise 3h per week for 10 weeks, Personal"   → repeating weekly task
//   "Read 30 min daily until Dec 31"                → repeating daily task
//   "Polish slides 2h by tomorrow 5pm after Draft"  → waits for the task "Draft"
import * as T from './tz.js';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const monIdx = (w) => MONTHS.indexOf(w.slice(0, 3).toLowerCase());
const dayIdx = (w) => DAYS.indexOf(w.slice(0, 3).toLowerCase());

const DATE = String.raw`(?:today|tonight|tomorrow|tmrw|(?:next\s+)?(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*|end\s+of\s+(?:the\s+)?(?:day|week|month)|next\s+week|in\s+\d+\s+(?:days?|weeks?)|\d{4}-\d{2}-\d{2}|\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?|\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?)`;
const TIME = String.raw`(?:\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?`;

// Resolve a date phrase to a day key (and whether a time of day was given).
export function resolveDate(phrase, s, now = Date.now()) {
  const tz = s.tz, today = T.dayKey(now, tz);
  const p = phrase.toLowerCase().trim().replace(/\s+/g, ' ');
  const workDays = s.bounds?.days?.length ? s.bounds.days : [1, 2, 3, 4, 5];
  let m;
  if (p === 'today' || p === 'tonight' || p === 'end of day' || p === 'end of the day') return today;
  if (p === 'tomorrow' || p === 'tmrw') return T.addDays(today, 1);
  if (p === 'end of week' || p === 'end of the week' || p === 'next week') {
    const start = T.startOfWeek(today, s.weekStart ?? 1);
    const base = p === 'next week' ? T.addDays(start, 7) : start;
    const last = Math.max(...workDays.map((d) => (d - (s.weekStart ?? 1) + 7) % 7));
    return T.addDays(base, last);
  }
  if (p === 'end of month' || p === 'end of the month') { const { y, m: mo } = T.parseKey(today); return T.addDays(T.keyOf(mo === 12 ? y + 1 : y, mo === 12 ? 1 : mo + 1, 1), -1); }
  if ((m = p.match(/^in (\d+) (day|week)s?$/))) return T.addDays(today, +m[1] * (m[2] === 'week' ? 7 : 1));
  if ((m = p.match(/^(next )?([a-z]+)$/)) && dayIdx(m[2]) >= 0) {
    let k = T.addDays(today, 1);
    while (T.weekday(k) !== dayIdx(m[2])) k = T.addDays(k, 1);
    if (m[1]) k = T.addDays(k, 7);
    return k;
  }
  if ((m = p.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return T.keyOf(+m[1], +m[2], +m[3]);
  const year = (mo, d) => { const { y } = T.parseKey(today); const k = T.keyOf(y, mo, d); return k < today ? T.keyOf(y + 1, mo, d) : k; };
  if ((m = p.match(/^(\d{1,2})(?:st|nd|rd|th)? ([a-z]+)$/)) && monIdx(m[2]) >= 0) return year(monIdx(m[2]) + 1, +m[1]);
  if ((m = p.match(/^([a-z]+) (\d{1,2})(?:st|nd|rd|th)?$/)) && monIdx(m[1]) >= 0) return year(monIdx(m[1]) + 1, +m[2]);
  if ((m = p.match(/^(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?$/))) {
    const a = +m[1], b = +m[2];
    const [d, mo] = a > 12 ? [a, b] : b > 12 ? [b, a] : [a, b]; // day/month unless that's impossible
    if (m[3]) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; return T.keyOf(y, mo, d); }
    return year(mo, d);
  }
  return null;
}
function atTime(key, h, mi, ap, s) {
  if (h == null) return T.atTime(key, s.bounds?.end || '17:00', s.tz);
  let hh = +h;
  if (ap === 'pm' && hh < 12) hh += 12;
  if (ap === 'am' && hh === 12) hh = 0;
  return T.atTime(key, `${String(hh).padStart(2, '0')}:${mi || '00'}`, s.tz);
}

export function parseTask(text, s, tasks = [], now = Date.now()) {
  let rest = ` ${text.trim()} `;
  const chips = [];
  const d = {};
  const take = (re, fn) => { const m = rest.match(re); if (!m) return null; rest = rest.replace(m[0], ' '); fn?.(m); return m; };
  // category: "#Study" or a trailing ", Study"
  const cats = s.categories || [];
  const findCat = (name) => { const n = name.trim().toLowerCase(); return cats.find((c) => c.name.toLowerCase() === n) || cats.find((c) => c.name.toLowerCase().startsWith(n) && n.length >= 3); };
  take(/\s#([\p{L}\d_-]+)/u, (m) => { const c = findCat(m[1]); if (c) d.categoryId = c.id; else rest += ` #${m[1]}`; });
  if (!d.categoryId) { const m = rest.match(/,\s*([^,]+?)\s*$/); if (m && findCat(m[1])) { d.categoryId = findCat(m[1]).id; rest = rest.slice(0, m.index) + ' '; } }
  // rank
  take(/\s(?:rank|priority|prio)\s*(\d{1,2})\b/i, (m) => (d.rank = +m[1])) || take(/\s[!pP](\d)\b/, (m) => (d.rank = +m[1]));
  // safety margin
  take(/\s(\d+(?:\.\d+)?)\s*days?\s+early\b/i, (m) => (d.marginDays = +m[1]));
  // repeat
  take(/\s(?:on\s+)?weekdays\b/i, () => { d.repeatEvery = 'day'; d.repeatDays = [1, 2, 3, 4, 5]; });
  take(/\s(?:per|a|each|every)\s+week\b|\sweekly\b/i, () => (d.repeatEvery = 'week'));
  take(/\s(?:per|a|each|every)\s+day\b|\sdaily\b/i, () => (d.repeatEvery ||= 'day'));
  take(/\sfor\s+(\d+)\s+(weeks?|days?)\b/i, (m) => { d.repeatCount = +m[1]; d.repeatCountUnit = /^w/i.test(m[2]) ? 'week' : 'day'; });
  take(new RegExp(String.raw`\s(?:until|till|through)\s+(${DATE})`, 'i'), (m) => { const k = resolveDate(m[1], s, now); if (k) d.repeatUntil = T.atTime(k, '23:59', s.tz); });
  // reading
  take(/\s(\d+)\s*(?:pages|pp|p)\b/i, (m) => (d.pages = +m[1]));
  take(/\s(?:from|starting at)\s+(?:page|p\.?)\s*(\d+)/i, (m) => (d.startPage = +m[1]));
  take(/\s(?:at\s+)?(\d+(?:\.\d+)?)\s*(?:pages?\s*(?:\/|per|an?)\s*h(?:ou)?r?|pph|p\/h)\b/i, (m) => (d.speed = +m[1]));
  // duration
  take(/\s(\d+(?:\.\d+)?)\s*(?:h|hrs?|hours?)(?:\s*(\d+)\s*(?:m|mins?|minutes?))?\b/i, (m) => (d.minutes = Math.round(+m[1] * 60 + (+m[2] || 0))));
  if (d.minutes == null) take(/\s(\d+)\s*(?:m|mins?|minutes?)\b/i, (m) => (d.minutes = +m[1]));
  // deadline and start
  take(new RegExp(String.raw`\s(?:by|due|before)\s+(${DATE})${TIME}(?=\s|$)`, 'i'), (m) => { const k = resolveDate(m[1], s, now); if (k) d.deadline = atTime(k, m[2], m[3], m[4]?.toLowerCase(), s); });
  take(new RegExp(String.raw`\s(?:starting|start|from|not before)\s+(${DATE})${TIME}(?=\s|$)`, 'i'), (m) => { const k = resolveDate(m[1], s, now); if (k) d.earliestStart = m[2] != null ? atTime(k, m[2], m[3], m[4]?.toLowerCase(), s) : T.atTime(k, s.bounds?.start || '09:00', s.tz); });
  // after another task
  const active = tasks.filter((t) => !t.archived).sort((a, b) => b.title.length - a.title.length);
  const am = rest.match(/\s(?:after|once)\s+(.+?)\s*(?:is done)?\s*$/i);
  if (am) { const n = am[1].toLowerCase(); const hit = active.find((t) => t.title.toLowerCase() === n) || active.find((t) => t.title.toLowerCase().startsWith(n)); if (hit) { d.after = [hit.id]; rest = rest.slice(0, am.index) + ' '; chips.push(`after “${hit.title}”`); } }
  // period
  take(/\s(?:in the\s+)?(?:after hours|evenings?|after work)\b/i, () => { const p = (s.periods || []).find((x) => /after|evening/i.test(x.name)) || (s.periods || [])[0]; if (p) d.periodId = p.id; });
  // what's left is the title
  let title = rest.replace(/\s+/g, ' ').replace(/[\s,;:-]+$/, '').trim();
  const reading = d.pages != null || /^read(ing)?\b/i.test(title) && (d.pages != null || d.speed != null);
  if (reading) title = title.replace(/^read(ing)?\s+/i, '').trim();
  const draft = { title: title || (reading ? 'Reading' : 'Task'), kind: reading ? 'reading' : 'generic' };
  if (d.rank) { draft.rank = d.rank; chips.push(`rank ${d.rank}`); }
  if (reading) {
    draft.reading = { pages: d.pages || 100, startPage: d.startPage || 1, speed: d.speed || s.readingDefaults?.speed || 15, unit: 'pph', labels: 'actual' };
    chips.push(`📖 ${draft.reading.pages} pages${d.startPage ? ` from p. ${d.startPage}` : ''} at ${draft.reading.speed}/h`);
  }
  if (d.repeatEvery && !reading) {
    const every = d.repeatEvery;
    draft.repeat = { every, minutes: d.minutes || (every === 'week' ? 180 : 30) };
    if (d.repeatDays) draft.repeat.days = d.repeatDays;
    if (d.repeatUntil) draft.repeat.until = d.repeatUntil;
    else draft.repeat.count = d.repeatCount ? (d.repeatCountUnit === every ? d.repeatCount : every === 'week' ? Math.ceil(d.repeatCount / 7) : d.repeatCount * 7) : (every === 'week' ? 12 : 28);
    draft.repeatStart = d.earliestStart || now;
    chips.push(`↻ ${T.fmtDur(draft.repeat.minutes)} ${every === 'week' ? 'per week' : d.repeatDays ? 'on weekdays' : 'daily'}${draft.repeat.until ? ` until ${T.format(draft.repeat.until, s.tz, { day: 'numeric', month: 'short' })}` : ` for ${draft.repeat.count} ${every}s`}`);
  } else if (!reading) {
    draft.totalMinutes = d.minutes || 60;
    chips.push(`⏱ ${T.fmtDur(draft.totalMinutes)}${d.minutes ? '' : ' (default)'}`);
  }
  if (d.deadline && !draft.repeat) { draft.deadline = d.deadline; chips.push(`due ${T.format(d.deadline, s.tz, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: s.h12 })}`); }
  if (d.earliestStart) { draft.earliestStart = d.earliestStart; chips.push(`not before ${T.fmtDate(d.earliestStart, s.tz)}`); }
  if (d.marginDays) { draft.marginDays = d.marginDays; chips.push(`aim ${d.marginDays} day${d.marginDays === 1 ? '' : 's'} early`); }
  if (d.after) draft.after = d.after;
  if (d.periodId) { const p = (s.periods || []).find((x) => x.id === d.periodId); draft.periodId = p.id; draft.periodName = p.name; draft.periodRules = p.rules; chips.push(`🌙 ${p.name}`); }
  if (d.categoryId) { const c = cats.find((x) => x.id === d.categoryId); draft.categoryId = c.id; chips.unshift(`${c.icon ? c.icon + ' ' : ''}${c.name}`); }
  return { draft, chips, title: draft.title, hasDeadline: !!draft.deadline || !!draft.repeat };
}
