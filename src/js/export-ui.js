// Export: pages as images / PDF, calendar files.
import * as T from './tz.js';
import * as S from './scheduler.js';
import * as D from './dialogs.js';
import * as X from './export.js';
import * as A from './analysis.js';
import { download } from './ui.js';
import { app, set, st, tz } from './core.js';
import { calColor, collectItems, ctx, range, toast } from './app.js';
import { handleError, setStatus } from './status.js';

// ======================================================================================
// Export
// ======================================================================================
async function renderPage(kind, cursorKey, scale = 2) {
  const r = range(kind === 'month' ? 'month' : 'week', cursorKey);
  const items = await collectItems(r.days);
  const z = tz();
  if (kind === 'month') {
    const inMonth = r.days.filter((k) => k.slice(0, 7) === r.monthKey.slice(0, 7));
    return { canvas: X.renderMonth({ monthKey: r.monthKey, gridStart: r.days[0], items, settings: set(), scale, title: T.format(T.dayStart(r.monthKey, z), z, { month: 'long', year: 'numeric' }), summary: pageSummary(inMonth, items) }), key: r.monthKey.slice(0, 7) };
  }
  const a = T.dayStart(r.days[0], z), b = T.dayStart(r.days[6], z);
  return { canvas: X.renderWeek({ days: r.days, items, settings: set(), scale, title: `Week of ${T.format(a, z, { day: 'numeric', month: 'long' })} – ${T.format(b, z, { day: 'numeric', month: 'long', year: 'numeric' })}`, summary: pageSummary(r.days, items) }), key: r.days[0] };
}

// Custom dates and hours → pages of up to 7 days
export async function exportCustom() {
  const r = await D.customExportDialog(ctx, { cursor: app.cursor });
  if (!r) return;
  const prev = { ...app.status }, z = tz();
  try {
    const all = Array.from({ length: r.n }, (_, i) => T.addDays(r.from, i));
    const pages = [];
    for (let i = 0; i < all.length; i += r.perPage) {
      setStatus(`Rendering page ${pages.length + 1}/${r.pages}…`, 'busy');
      const days = all.slice(i, i + r.perPage);
      const items = await collectItems(days);
      const a = T.dayStart(days[0], z), b = T.dayStart(days[days.length - 1], z);
      const title = `${T.fmtDate(a, z)}${days.length > 1 ? ` – ${T.format(b, z, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}` : `, ${T.parseKey(days[0]).y}`}${r.label ? ` · ${r.label}` : ''}`;
      const sum = r.summary ? pageSummary(days, items, r.hours ? { rules: r.hours.rules, label: r.hours.label } : null) : null;
      pages.push(X.renderWeek({ days, items, settings: set(), scale: r.scale, title, summary: sum, hours: r.hours }));
    }
    const prog = (n, N) => setStatus(`Encoding ${n}/${N}…`, 'busy');
    const blob = r.fmt === 'pdf' ? await X.canvasesToPdf(pages, prog) : r.fmt === 'tiff' ? await X.canvasesToTiff(pages, prog, r.scale === 1 ? 100 : 200) : await X.canvasToBlob(pages[0], 'image/png');
    const name = `tempo-${r.from}-to-${r.to}${r.label ? '-' + r.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : ''}.${r.fmt === 'tiff' ? 'tif' : r.fmt}`;
    await download(blob, name);
    toast(`Exported ${pages.length} page${pages.length > 1 ? 's' : ''} → ${name}`);
  } catch (err) { handleError(err); }
  setStatus(prev.text, prev.kind);
}

// The breakdown of time used for one printed page (same hours and grouping as the Analysis view).
function pageSummary(days, items, hours = null) {
  const s = set(), z = tz(), o = app.anOpts || { scope: 'bounds', by: 'category' };
  const from = T.dayStart(days[0], z), to = T.dayStart(T.addDays(days[days.length - 1], 1), z);
  const actx = { settings: s, gmeta: st().gmeta, calColor };
  const groups = {};
  const occ = items.filter((it) => A.isOccupying(it, s) && it.end > from && it.start < to).map((it) => {
    const g = A.groupOf(it, o.by, actx);
    groups[g.key] ||= g;
    return { start: it.start, end: it.end, group: g.key, prio: it.kind === 'chunk' ? 1 : 0, title: it.kind === 'chunk' ? it.task.title : (it.title || ''), kind: it.kind, uid: it.key };
  });
  const wins = hours ? S.windows(from, to, hours.rules, z) : A.scopeWindows(o.scope, from, to, s);
  if (!hours && o.scope === 'full' && s.sleepAssume !== false) { const sl = A.assumedSleep(occ, from, to, s); const sg = A.sleepGroup(s, o.by); occ.push(...A.sleepItems(sl, sg)); groups[sg.key] ||= sg; }
  const data = A.compute(occ, wins, z);
  const scopeName = hours ? hours.label : (A.SCOPES[o.scope] || (s.periods || []).find((p) => 'period:' + p.id === o.scope)?.name || '');
  let busiest = null;
  for (const [k, d] of Object.entries(data.days)) { const used = d.available - d.free - (d.gaps || 0); if (used > 0 && (!busiest || used > busiest.m)) busiest = { k, m: used, of: d.available }; }
  const chunks = items.filter((it) => it.kind === 'chunk' && it.start >= from && it.start < to && (!hours || wins.some((w) => it.start < w.end && it.end > w.start)));
  return {
    scope: scopeName.toLowerCase(), available: data.totals.available, free: data.totals.free, gaps: data.totals.gaps || 0,
    groups: Object.entries(data.totals.groups).map(([k, m]) => ({ label: groups[k]?.label || k, color: groups[k]?.color || '#9aa0aa', m })).sort((a, b) => b.m - a.m),
    busiest: busiest && { label: T.fmtDate(T.dayStart(busiest.k, z), z), m: busiest.m, of: busiest.of },
    sessions: { done: chunks.filter((c) => c.status === 'done').length, total: chunks.length },
  };
}

export async function exportView(kind, fmt) {
  const { canvas, key } = await renderPage(kind, app.cursor);
  const name = `tempo-${kind}-${key}`;
  const blob = fmt === 'pdf' ? await X.canvasToPdf(canvas) : fmt === 'tiff' ? await X.canvasesToTiff([canvas]) : await X.canvasToBlob(canvas, fmt === 'jpeg' ? 'image/jpeg' : 'image/png');
  const ext = fmt === 'jpeg' ? 'jpg' : fmt === 'tiff' ? 'tif' : fmt;
  await download(blob, `${name}.${ext}`);
}

// Several weeks or months -> one multi-page PDF or TIFF
export async function exportMulti() {
  const r = await D.exportDialog(ctx, { cursor: app.cursor, weekStart: set().weekStart });
  if (!r) return;
  const prevStatus = { ...app.status };
  const pages = [];
  let k = r.unit === 'month' ? T.addMonths(r.start, 0) : T.startOfWeek(r.start, set().weekStart);
  try {
    for (let i = 0; i < r.count; i++) {
      setStatus(`Rendering page ${i + 1}/${r.count}…`, 'busy');
      pages.push((await renderPage(r.unit, k, r.scale)).canvas);
      k = r.unit === 'month' ? T.addMonths(k, 1) : T.addDays(k, 7);
    }
    const prog = (n, N) => setStatus(`Encoding ${n}/${N}…`, 'busy');
    const blob = r.fmt === 'pdf' ? await X.canvasesToPdf(pages, prog) : await X.canvasesToTiff(pages, prog, r.scale === 1 ? 100 : 200);
    const first = r.unit === 'month' ? r.start.slice(0, 7) : T.startOfWeek(r.start, set().weekStart);
    const name = `tempo-${r.count}${r.unit === 'month' ? 'months' : 'weeks'}-from-${first}.${r.fmt === 'tiff' ? 'tif' : 'pdf'}`;
    download(blob, name);
    toast(`Exported ${r.count} page${r.count > 1 ? 's' : ''} → ${name} (${(blob.size / 1048576).toFixed(1)} MB)`);
  } catch (err) { handleError(err); }
  setStatus(prevStatus.text, prevStatus.kind);
}
