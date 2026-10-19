// Time analysis: how much of the chosen hours are free vs occupied, broken down by color / source / type.
import * as T from './tz.js';
import * as S from './scheduler.js';
import * as G from './gcal.js';
import { esc } from './ui.js';

const GOOGLE_NAMES = { 1: 'Lavender', 2: 'Sage', 3: 'Grape', 4: 'Flamingo', 5: 'Banana', 6: 'Tangerine', 7: 'Peacock', 8: 'Graphite', 9: 'Blueberry', 10: 'Basil', 11: 'Tomato' };
const TASK_NAMES = { '#4f6bed': 'Indigo', '#0f9d76': 'Green', '#e2683c': 'Orange', '#c2459b': 'Magenta', '#8a5cf6': 'Violet', '#d4a20a': 'Mustard', '#2a9bd6': 'Sky', '#d6455b': 'Rose', '#5c7a3a': 'Olive', '#6b7280': 'Gray' };
export function colorName(hex) {
  hex = (hex || '').toLowerCase();
  if (TASK_NAMES[hex]) return TASK_NAMES[hex];
  for (const [id, c] of Object.entries(G.EVENT_COLORS)) if (c.toLowerCase() === hex) return GOOGLE_NAMES[id];
  return null;
}

export const SCOPES = {
  bounds: 'Within day bounds',
  outside: 'Outside day bounds',
  waking: 'Extended hours (bounds + outside)',
  full: 'Full 24 hours',
};

export function scopeWindows(scope, from, to, s) {
  const tz = s.tz;
  if (scope === 'full') return [{ start: from, end: to }];
  const inB = S.windows(from, to, s.bounds, tz);
  if (scope === 'bounds') return inB;
  const ext = S.merge([...S.windows(from, to, s.overflowBounds, tz), ...inB]);
  if (scope === 'waking') return ext;
  return S.subtract(ext, inB); // outside
}

// Split windows at local midnight so we can report per day.
function splitByDay(wins, tz) {
  const out = [];
  for (const w of wins) {
    let a = w.start;
    while (a < w.end) {
      const k = T.dayKey(a, tz);
      const next = T.dayStart(T.addDays(k, 1), tz);
      const b = Math.min(w.end, next);
      out.push({ start: a, end: b, day: k });
      a = b;
    }
  }
  return out;
}

// items: [{start, end, group, prio}]  → minutes per group, per day, free minutes. Overlaps are counted once.
export function compute(items, windows, tz) {
  const days = {};
  const totals = { available: 0, free: 0, groups: {}, titles: {} }; // titles[group][title] = { m, ids:Set }
  const segs = splitByDay(windows, tz);
  const sorted = [...items].sort((a, b) => a.start - b.start);
  for (const w of segs) {
    const d = days[w.day] ||= { available: 0, free: 0, groups: {} };
    const len = (w.end - w.start) / T.MIN;
    d.available += len; totals.available += len;
    const hits = sorted.filter((it) => it.end > w.start && it.start < w.end);
    const cuts = new Set([w.start, w.end]);
    for (const it of hits) { cuts.add(Math.max(it.start, w.start)); cuts.add(Math.min(it.end, w.end)); }
    const pts = [...cuts].sort((a, b) => a - b);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const m = (b - a) / T.MIN;
      const cover = hits.filter((it) => it.start <= a && it.end >= b);
      if (!cover.length) { d.free += m; totals.free += m; continue; }
      cover.sort((x, y) => x.prio - y.prio || x.start - y.start);
      const g = cover[0].group;
      d.groups[g] = (d.groups[g] || 0) + m;
      totals.groups[g] = (totals.groups[g] || 0) + m;
      const tt = (totals.titles[g] ||= {});
      const rec = (tt[cover[0].title || '(untitled)'] ||= { m: 0, ids: new Set(), kind: cover[0].kind });
      rec.m += m; rec.ids.add(cover[0].uid ?? cover[0].start);
    }
  }
  return { days, totals };
}

export function groupOf(it, by, ctx) {
  const s = ctx.settings;
  if (by === 'category') {
    const id = it.kind === 'chunk' ? it.task.categoryId : it.catId;
    const c = (s.categories || []).find((x) => x.id === id);
    if (c) return { key: 'cat:' + c.id, label: c.name, color: c.color };
    return it.kind === 'chunk' ? { key: 'cat:none-t', label: 'Uncategorized tasks', color: '#c0c4cc' } : { key: 'cat:none-e', label: 'Uncategorized events', color: '#9aa0aa' };
  }
  if (by === 'type') return it.kind === 'chunk' ? { key: 'tasks', label: 'Task sessions', color: '#8a5cf6' } : { key: 'events', label: 'Calendar events', color: '#5b7c99' };
  if (by === 'source') {
    if (it.kind === 'chunk') return { key: 't:' + it.task.id, label: it.task.title, color: it.color, sub: 'task' };
    const cal = it.ev._calId;
    const name = cal === 'local' ? 'Local (this browser)' : ((ctx.gmeta.calendars || []).find((c) => c.id === cal)?.summary || cal);
    return { key: 'c:' + cal, label: name, color: ctx.calColor(cal), sub: 'calendar' };
  }
  const hex = (it.color || '#888888').toLowerCase();
  let fallback = hex;
  if (it.kind !== 'chunk' && !it.ev?.colorId) { // calendar's own color: name it after the calendar
    const cal = it.ev._calId;
    fallback = cal === 'local' ? 'Local calendar' : ((ctx.gmeta.calendars || []).find((c) => c.id === cal)?.summary || hex);
  }
  return { key: hex, label: (s.colorLabels || {})[hex] || (fallback !== hex ? fallback : colorName(hex) || hex), color: hex, editable: true };
}

export function isOccupying(it, s) {
  if (it.kind === 'chunk') return true;
  if (it.declined) return false;
  if (it.ev?.transparency === 'transparent') return false;
  if (it.allDay && !s.allDayBlocks) return false;
  return true;
}

export function periodRange(period, s, now, custom) {
  const tz = s.tz, today = T.dayKey(now, tz);
  switch (period) {
    case 'next7': return { from: now, to: T.dayStart(T.addDays(today, 7), tz), label: 'Next 7 days' };
    case 'next30': return { from: now, to: T.dayStart(T.addDays(today, 30), tz), label: 'Next 30 days' };
    case 'week': { const a = T.startOfWeek(today, s.weekStart); return { from: T.dayStart(a, tz), to: T.dayStart(T.addDays(a, 7), tz), label: 'This week' }; }
    case 'nextweek': { const a = T.addDays(T.startOfWeek(today, s.weekStart), 7); return { from: T.dayStart(a, tz), to: T.dayStart(T.addDays(a, 7), tz), label: 'Next week' }; }
    case 'month': { const a = T.addMonths(today, 0); return { from: T.dayStart(a, tz), to: T.dayStart(T.addMonths(a, 1), tz), label: 'This month' }; }
    case 'nextmonth': { const a = T.addMonths(today, 1); return { from: T.dayStart(a, tz), to: T.dayStart(T.addMonths(a, 1), tz), label: 'Next month' }; }
    case 'custom': {
      const a = custom?.from || today, b = custom?.to || T.addDays(today, 6);
      return { from: T.dayStart(a, tz), to: T.dayStart(T.addDays(b < a ? a : b, 1), tz), label: 'Custom range' };
    }
  }
  return periodRange('next7', s, now);
}

const h = (m) => (m / 60);
const fmtH = (m) => { const v = m / 60; return v >= 10 ? `${Math.round(v)}h` : `${(Math.round(v * 10) / 10).toString()}h`; };
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

// ---------------- rendering ----------------
export function renderAnalysis({ data, groups, opts, settings, rangeInfo }) {
  const tz = settings.tz;
  const { totals, days } = data;
  const occupied = totals.available - totals.free;
  const order = Object.entries(totals.groups).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  // Fold the long tail into "Other" so the chart stays readable (fixed order, no generated hues).
  const MAXG = 8;
  const main = order.slice(0, MAXG), rest = order.slice(MAXG);
  const meta = (k) => (k === '__other' ? { label: `Other (${rest.length})`, color: '#9aa0aa' } : groups[k]);
  const keyOf = (k) => (rest.includes(k) ? '__other' : k);
  const shown = rest.length ? [...main, '__other'] : main;
  const sumG = (obj) => { const o = {}; for (const [k, v] of Object.entries(obj)) o[keyOf(k)] = (o[keyOf(k)] || 0) + v; return o; };
  const T0 = sumG(totals.groups);
  const dayKeys = Object.keys(days).sort();
  const taskMin = Object.entries(totals.groups).filter(([k]) => groups[k]?.kind === 'chunk' || groups[k]?.sub === 'task' || k === 'tasks').reduce((a, [, v]) => a + v, 0);

  // ---- stat tiles
  const tiles = `
    <div class="an-tiles">
      <div class="tile"><span class="t-l">Hours in scope</span><span class="t-v">${fmtH(totals.available)}</span><span class="t-s">${esc(SCOPES[opts.scope].toLowerCase())}</span></div>
      <div class="tile"><span class="t-l">Occupied</span><span class="t-v">${fmtH(occupied)}</span><span class="t-s">${pct(occupied, totals.available)}% of scope</span></div>
      <div class="tile"><span class="t-l">Free</span><span class="t-v">${fmtH(totals.free)}</span><span class="t-s">${pct(totals.free, totals.available)}% of scope</span></div>
      <div class="tile"><span class="t-l">Busiest day</span><span class="t-v">${(() => { const b = dayKeys.map((k) => [k, days[k].available - days[k].free]).sort((a, b) => b[1] - a[1])[0]; return b && b[1] > 0 ? esc(T.format(T.dayStart(b[0], tz), tz, { weekday: 'short', day: 'numeric', month: 'short' })) : '—'; })()}</span><span class="t-s">${(() => { const b = dayKeys.map((k) => [k, days[k].available - days[k].free, days[k].available]).sort((a, b) => b[1] - a[1])[0]; return b && b[1] > 0 ? `${fmtH(b[1])} of ${fmtH(b[2])} occupied` : 'nothing scheduled'; })()}</span></div>
    </div>`;

  // ---- 100% bar
  let x = 0;
  const W = 1000;
  const barSegs = [...shown.map((k) => ({ k, m: T0[k] || 0, c: meta(k).color, l: meta(k).label })), { k: '__free', m: totals.free, c: null, l: 'Free' }].filter((s) => s.m > 0);
  const gap = 2;
  const bar = totals.available ? `<svg class="an-bar" viewBox="0 0 ${W} 36" preserveAspectRatio="none" role="img" aria-label="Share of time by category">
      <defs><pattern id="hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="7" height="7" class="free-bg"/><line x1="0" y1="0" x2="0" y2="7" class="free-line" stroke-width="2"/></pattern></defs>
      ${barSegs.map((s, i) => { const w = (s.m / totals.available) * W; const r = `<rect x="${x + (i ? gap / 2 : 0)}" y="0" width="${Math.max(0, w - (i ? gap / 2 : 0) - (i < barSegs.length - 1 ? gap / 2 : 0))}" height="36" rx="4" ${s.c ? `fill="${s.c}"` : 'fill="url(#hatch)"'} data-tip="${esc(s.l)}: ${fmtH(s.m)} · ${pct(s.m, totals.available)}%"/>`; x += w; return r; }).join('')}
    </svg>` : '<p class="muted">No hours in this scope for the selected period.</p>';
  const legend = `<div class="an-legend">${barSegs.map((s) => `<span><i ${s.c ? `style="background:${s.c}"` : 'class="free-sw"'}></i>${esc(s.l)} <b>${pct(s.m, totals.available)}%</b></span>`).join('')}</div>`;

  // ---- per-day stacked columns
  const maxAvail = Math.max(1, ...dayKeys.map((k) => days[k].available));
  const CH = 220, n = dayKeys.length, PADL = 40, CW = 1000 - PADL;
  const slot = CW / Math.max(1, n), bw = Math.max(4, Math.min(44, slot * 0.62));
  const yMaxH = Math.ceil(h(maxAvail));
  const step = yMaxH > 12 ? 4 : yMaxH > 6 ? 2 : 1;
  const ys = (m) => CH - (m / (yMaxH * 60)) * CH;
  let cols = '';
  dayKeys.forEach((k, i) => {
    const d = days[k];
    const gs = sumG(d.groups);
    const cx = PADL + i * slot + (slot - bw) / 2;
    let acc = 0;
    const parts = [...shown.map((g) => ({ m: gs[g] || 0, c: meta(g).color, l: meta(g).label })), { m: d.free, c: null, l: 'Free' }].filter((p) => p.m > 0);
    const dl = T.format(T.dayStart(k, tz), tz, { weekday: 'short', day: 'numeric', month: 'short' });
    parts.forEach((p, j) => {
      const y1 = ys(acc), y0 = ys(acc + p.m);
      const top = j === parts.length - 1;
      const hgt = Math.max(0, y1 - y0 - (j ? gap : 0));
      cols += `<rect x="${cx}" y="${y0}" width="${bw}" height="${hgt}" rx="${top ? 4 : 1}" ${p.c ? `fill="${p.c}"` : 'fill="url(#hatch)"'} data-tip="${esc(dl)} — ${esc(p.l)}: ${fmtH(p.m)}"/>`;
      acc += p.m;
    });
    if (!d.available) cols += `<text x="${cx + bw / 2}" y="${CH - 4}" class="ax" text-anchor="middle">–</text>`;
    const every = n > 16 ? Math.ceil(n / 10) : 1;
    if (i % every === 0) cols += `<text x="${cx + bw / 2}" y="${CH + 16}" class="ax" text-anchor="middle">${esc(n > 10 ? T.format(T.dayStart(k, tz), tz, { day: 'numeric', month: 'short' }) : T.format(T.dayStart(k, tz), tz, { weekday: 'short' }) + ' ' + T.parseKey(k).d)}</text>`;
  });
  let grid = '';
  for (let v = 0; v <= yMaxH; v += step) grid += `<line x1="${PADL}" x2="1000" y1="${ys(v * 60)}" y2="${ys(v * 60)}" class="gl"/><text x="${PADL - 8}" y="${ys(v * 60) + 4}" class="ax" text-anchor="end">${v}h</text>`;
  const chart = `<svg class="an-cols" viewBox="0 0 1000 ${CH + 24}" role="img" aria-label="Hours per day by category">
      <defs><pattern id="hatch2" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="7" height="7" class="free-bg"/><line x1="0" y1="0" x2="0" y2="7" class="free-line" stroke-width="2"/></pattern></defs>
      ${grid}${cols.replaceAll('url(#hatch)', 'url(#hatch2)')}</svg>`;

  // ---- table
  const titleList = (keys) => {
    const merged = {};
    for (const k of keys) for (const [t, r] of Object.entries(totals.titles[k] || {})) {
      const x = (merged[t] ||= { m: 0, n: 0, kind: r.kind }); x.m += r.m; x.n += r.ids.size;
    }
    const list = Object.entries(merged).sort((a, b) => b[1].m - a[1].m);
    if (!list.length) return '';
    return `<ul class="an-items">${list.map(([t, r]) => `<li><span class="an-it-k">${r.kind === 'chunk' ? 'Task' : 'Event'}</span><span class="an-it-t">${esc(t)}</span><span class="an-it-n">${r.kind === 'chunk' ? `${r.n} session${r.n === 1 ? '' : 's'}` : r.n > 1 ? `${r.n}×` : ''}</span><span class="an-it-h">${fmtH(r.m)}</span></li>`).join('')}</ul>`;
  };
  const rows = shown.map((k) => {
    const m = meta(k);
    const keys = k === '__other' ? rest : [k];
    const n = keys.reduce((a, x) => a + Object.keys(totals.titles[x] || {}).length, 0);
    const name = m.editable ? `<button type="button" class="link lbl-edit" data-hex="${esc(k)}" title="Rename this color">${esc(m.label)} ✎</button>` : esc(m.label);
    return `<tr><td><details class="an-det"><summary><span class="sw-dot" style="background:${m.color}"></span>${name}<span class="muted small an-count">${n} item${n === 1 ? '' : 's'} ▾</span></summary>${titleList(keys)}</details></td>
      <td class="num">${fmtH(T0[k] || 0)}</td><td class="num">${pct(T0[k] || 0, totals.available)}%</td><td class="num">${pct(T0[k] || 0, occupied)}%</td></tr>`;
  }).join('');
  const table = `<table class="an-table"><thead><tr><th>${opts.by === 'color' ? 'Color' : opts.by === 'category' ? 'Category' : opts.by === 'type' ? 'Type' : 'Task or calendar'}</th><th class="num">Hours</th><th class="num">% of scope</th><th class="num">% of occupied</th></tr></thead>
    <tbody>${rows}<tr class="free-row"><td><span class="sw-dot free-sw"></span>Free</td><td class="num">${fmtH(totals.free)}</td><td class="num">${pct(totals.free, totals.available)}%</td><td class="num">—</td></tr></tbody>
    <tfoot><tr><td>Total in scope</td><td class="num">${fmtH(totals.available)}</td><td class="num">100%</td><td></td></tr></tfoot></table>`;

  return `
    <div class="an-head">
      <div class="an-ctrls">
        <label class="field"><span>Period</span><select data-o="period">
          ${[['next7', 'Next 7 days'], ['next30', 'Next 30 days'], ['week', 'This week'], ['nextweek', 'Next week'], ['month', 'This month'], ['nextmonth', 'Next month'], ['custom', 'Custom…']].map(([v, l]) => `<option value="${v}" ${opts.period === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        ${opts.period === 'custom' ? `<label class="field"><span>From</span><input type="date" data-o="from" value="${opts.from || ''}"></label><label class="field"><span>To</span><input type="date" data-o="to" value="${opts.to || ''}"></label>` : ''}
        <label class="field"><span>Hours</span><select data-o="scope">${Object.entries(SCOPES).map(([v, l]) => `<option value="${v}" ${opts.scope === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="field"><span>Group by</span><select data-o="by">${[['category', 'Category'], ['color', 'Color'], ['source', 'Task or calendar'], ['type', 'Events vs tasks']].map(([v, l]) => `<option value="${v}" ${opts.by === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <span class="grow"></span>
        <button class="btn small ghost" data-o="csv">Download CSV</button>
      </div>
      <p class="muted small an-sub">${esc(rangeInfo.label)}: ${esc(T.format(rangeInfo.from, tz, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: settings.h12 }))} – ${esc(T.format(rangeInfo.to - 1, tz, { weekday: 'short', day: 'numeric', month: 'short' }))} · ${esc(scopeNote(opts.scope, settings))}${taskMin ? '' : ''}</p>
    </div>
    ${tiles}
    <section class="an-card"><h3>Where the time goes</h3>${bar}${legend}</section>
    <section class="an-card"><h3>Per day</h3>${n ? chart : '<p class="muted">No days in range.</p>'}${n ? legend : ''}</section>
    <section class="an-card"><h3>Breakdown</h3>${table}<p class="muted small">Overlapping items are counted once. Events marked “free”, declined invitations${settings.allDayBlocks ? '' : ' and all-day events'} don't count as occupied. Hidden calendars are left out.</p></section>`;
}

function scopeNote(scope, s) {
  const dn = (days) => (days.length === 7 ? 'every day' : days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d)) ? 'Mon–Fri' : `${days.length} days/week`);
  if (scope === 'bounds') return `day bounds ${s.bounds.start}–${s.bounds.end}, ${dn(s.bounds.days)}`;
  if (scope === 'outside') return `extended hours ${s.overflowBounds.start}–${s.overflowBounds.end} minus day bounds`;
  if (scope === 'waking') return `${s.overflowBounds.start}–${s.overflowBounds.end}, ${dn(s.overflowBounds.days)}`;
  return 'all 24 hours';
}

export function toCsv(data, groups, tz) {
  const keys = Object.keys(data.totals.groups);
  const head = ['Date', 'Hours in scope', 'Free', ...keys.map((k) => groups[k].label)];
  const lines = [head];
  for (const d of Object.keys(data.days).sort()) {
    const v = data.days[d];
    lines.push([d, h(v.available).toFixed(2), h(v.free).toFixed(2), ...keys.map((k) => h(v.groups[k] || 0).toFixed(2))]);
  }
  const t = data.totals;
  lines.push(['Total', h(t.available).toFixed(2), h(t.free).toFixed(2), ...keys.map((k) => h(t.groups[k] || 0).toFixed(2))]);
  return lines.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(',')).join('\n');
}
