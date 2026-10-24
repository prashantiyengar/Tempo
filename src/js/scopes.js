// Time scopes for automatic tracking: only count events and task sessions (or the part of them) that fall in some
// hours — all the time, within the day bounds (work hours), outside them ("after hours"), the waking hours, or one of
// your time periods. Used by XP drains, automatic habits and goal rules.
import * as T from './tz.js';
import * as S from './scheduler.js';

export function scopeOptions(s) {
  return [['', 'All days and times'], ['bounds', `Within the day bounds (${s.bounds?.start || '09:00'}–${s.bounds?.end || '17:00'})`], ['outside', 'Outside the day bounds (“after hours”)'], ['waking', 'Waking hours (day bounds and extended hours)'],
    ...(s.periods || []).map((p) => ['period:' + p.id, `Time period: ${p.name}`])];
}
export const scopeLabel = (s, scope) => (scopeOptions(s).find(([v]) => v === (scope || ''))?.[1] || 'All days and times');
export function scopeWins(scope, from, to, s) {
  const tz = s.tz;
  if (!scope || scope === 'full') return [{ start: from, end: to }];
  if (scope.startsWith('period:')) { const p = (s.periods || []).find((x) => x.id === scope.slice(7)); return p ? S.windows(from, to, p.rules, tz) : []; }
  const inB = S.windows(from, to, s.bounds, tz);
  if (scope === 'bounds') return inB;
  const ext = S.merge([...S.windows(from, to, s.overflowBounds || { start: '07:00', end: '23:00', days: [0, 1, 2, 3, 4, 5, 6] }, tz), ...inB]);
  if (scope === 'waking') return ext;
  return S.subtract(ext, inB);
}
// Items cut down to the parts inside the scope (all-day items only count with no scope)
export function clipItems(items, scope, s) {
  if (!scope || scope === 'full') return items;
  const timed = items.filter((it) => !it.allDay && it.end > it.start);
  if (!timed.length) return [];
  const from = Math.min(...timed.map((it) => it.start)), to = Math.max(...timed.map((it) => it.end));
  const wins = scopeWins(scope, from, to, s), out = [];
  for (const it of timed) for (const w of wins) { const a = Math.max(it.start, w.start), b = Math.min(it.end, w.end); if (b > a) out.push({ ...it, start: a, end: b }); }
  return out;
}
