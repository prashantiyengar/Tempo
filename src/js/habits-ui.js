// Habits in the sidebar and their own page; automatic habits.
import * as T from './tz.js';
import * as E from './engine.js';
import * as D from './dialogs.js';
import * as C from './categories.js';
import { $, $$, esc, modal, setHTML } from './ui.js';
import * as GL from './goals.js';
import * as HB from './habits.js';
import { app, set, st, tz } from './core.js';
import { collectItems, ctx, render, syncSharedSoon, toast } from './app.js';
import { job } from './autoblocks.js';
import { renderLater } from './sidebar.js';
import { pushUndo } from './undo.js';

// ======================================================================================
// Habits (like the Loop Habit Tracker on Android): score ring, the last days to tick off, details with charts
// ======================================================================================
async function saveHabits(list, label) {
  const before = set().habits || [];
  set().habits = list;
  await E.persist(st(), ['settings']);
  syncSharedSoon();
  if (label) pushUndo(label, async () => { set().habits = before; await E.persist(st(), ['settings']); syncSharedSoon(); refreshHabits(); });
  refreshHabits();
}
const putHabit = (h, label) => saveHabits((set().habits || []).some((x) => x.id === h.id) ? set().habits.map((x) => (x.id === h.id ? h : x)) : [...(set().habits || []), h], label);
function refreshHabits() {
  const hl = $('#habit-list'); if (hl && !hl.hidden) renderHabits(hl, { days: 4 });
  const gw = $('.g-habits .hb-host'); if (gw) renderHabits(gw, { days: 7 });
  app.habitRedraw?.();
  if (app.view === 'review') render();
}
const ringSVG = (pct, color, size = 26) => { const r = size / 2 - 3, c = 2 * Math.PI * r; return `<svg class="hb-ring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="color-mix(in srgb, ${color} 18%, transparent)" stroke-width="4"/><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="4" stroke-dasharray="${(c * pct).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 ${size / 2} ${size / 2})" stroke-linecap="butt"/></svg>`; };
function habitCell(h, k) {
  const v = HB.val(h, k);
  if (HB.isNumber(h)) {
    const done = HB.isDone(h, k);
    return `<button type="button" class="hb-c num ${v > 0 ? 'on' : ''} ${done ? 'full' : ''} ${v === -1 ? 'skip' : ''}" data-k="${k}" style="--c:${h.color}" title="${esc(T.format(T.dayStart(k, tz()), tz(), { weekday: 'long', day: 'numeric', month: 'short' }))}">${v === -1 ? '»' : `<b>${v > 0 ? HB.fmtNum(v) : '0'}</b><small>${esc(h.unit || '')}</small>`}</button>`;
  }
  const auto = HB.isAuto(h, k), hit = h.autoHit?.[k];
  const why = auto && h.auto.mode === 'timing' ? ` — ${v === 1 ? 'ticked' : 'not ticked'} automatically (${GL.timingText(h.auto)}): ${hit || ''}` : !auto && h.auto?.mode === 'timing' && hit ? ` — ${hit}` : auto && h.auto.mode === 'hours' ? ` — ${v === 1 ? 'ticked' : 'not ticked'} automatically: ${hit || ''} (${h.auto.op === 'atMost' ? 'at most' : 'at least'} ${h.auto.hours} h per ${h.auto.per === 'week' ? 'week' : 'day'})` : auto ? (h.auto.mode === 'tick' ? (hit ? ` — ticked automatically: “${hit}”` : ' — nothing on the calendar matched') : (hit ? ` — unticked automatically: “${hit}”` : ' — ticked automatically: nothing matched')) : HB.autoOn(h) && HB.isManual(h, k) ? ' — set by hand' : '';
  return `<button type="button" class="hb-c ${v === 1 ? 'on' : v === -1 ? 'skip' : ''} ${auto ? 'auto' : ''}" data-k="${k}" style="--c:${h.color}" aria-pressed="${v === 1}" title="${esc(T.format(T.dayStart(k, tz()), tz(), { weekday: 'long', day: 'numeric', month: 'short' }))}${v === -1 ? ' — skipped' : ''}${esc(why)}">${v === 1 ? '✓' : v === -1 ? '»' : '✕'}</button>`;
}
export function renderHabits(box, { days = 5 } = {}) {
  const s = set(), z = tz(), today = T.dayKey(Date.now(), z);
  const keys = Array.from({ length: days }, (_, i) => T.addDays(today, -i)); // newest first, like Loop
  const habits = HB.list(s), archived = (s.habits || []).filter((h) => h.archived);
  setHTML(box, `<div class="hb-list" style="--hb-days:${days}">
      <div class="hb-row hb-headrow"><span class="hb-name"><button type="button" class="link hb-add" title="New habit">+ New${days > 4 ? ' habit' : ''}</button></span>${keys.map((k) => `<span class="hb-day"><b>${esc(T.format(T.dayStart(k, z), z, { weekday: 'short' }).slice(0, 3).toUpperCase())}</b>${T.parseKey(k).d}</span>`).join('')}</div>
      ${habits.map((h) => { const sc = HB.score(h, s, today); return `<div class="hb-row" data-id="${esc(h.id)}" style="--c:${h.color}">
        <button type="button" class="hb-name" title="${esc(h.question || h.name)} — ${Math.round(sc * 100)}% · ${esc(HB.freqLabel(h))}">${ringSVG(sc, h.color)}<span class="hb-n">${esc(h.name)}</span>${HB.autoOn(h) ? `<span class="hb-autoic" title="${esc(h.auto.mode === 'timing' ? `Ticked automatically when ${[...(h.auto.words || []), ...(h.auto.cats || []).map((id) => C.catLabel(C.catById(set(), id)) || id)].join(', ')} ${GL.timingText(h.auto)}` : h.auto.mode === 'hours' ? `Ticked automatically: ${h.auto.op === 'atMost' ? 'at most' : 'at least'} ${h.auto.hours} h per ${h.auto.per === 'week' ? 'week' : 'day'} in ${h.auto.cats.map((id) => C.catLabel(C.catById(set(), id)) || id).join(', ')}` : `Ticked automatically from your calendar: ${h.auto.mode === 'tick' ? 'when' : 'unless'} a title contains ${h.auto.words.join(', ')}`)}">⚡</span>` : ''}</button>
        ${keys.map((k) => habitCell(h, k)).join('')}</div>`; }).join('') || `<p class="muted small empty">Track habits like exercise, reading or water: tick each day off, and watch the score ring fill up. <button type="button" class="link hb-add">Add your first habit</button></p>`}
      ${archived.length ? `<details class="hb-arch-l"><summary class="muted small">Archived (${archived.length})</summary>${archived.map((h) => `<button type="button" class="link hb-open-a" data-id="${esc(h.id)}">${esc(h.name)}</button>`).join(' · ')}</details>` : ''}
    </div>`);
  $$('.hb-add', box).forEach((b) => (b.onclick = () => editHabit(null)));
  $$('.hb-open-a', box).forEach((b) => (b.onclick = () => habitDetail(b.dataset.id)));
  $$('.hb-row[data-id]', box).forEach((row) => {
    const id = row.dataset.id;
    $('.hb-name', row).onclick = () => habitDetail(id);
    $$('.hb-c', row).forEach((c) => wireHabitCell(c, id));
  });
}
// tap = tick / untick (or enter the amount); right-click or long-press = skip
function wireHabitCell(c, id) {
  let lp = null, long = false;
  const k = c.dataset.k;
  const skip = () => { const h = HB.byId(set(), id); if (h) putHabit(HB.skipped(h, k), 'skip a habit day'); };
  // long-press only for touch / pen (a mouse uses right-click); the cell may be redrawn meanwhile, so check it's still there
  c.addEventListener('pointerdown', (e) => { long = false; clearTimeout(lp); if (e.pointerType === 'mouse' || e.button !== 0) return; lp = setTimeout(() => { if (!c.isConnected) return; long = true; skip(); }, 550); });
  for (const t of ['pointerup', 'pointerleave', 'pointercancel']) c.addEventListener(t, () => clearTimeout(lp));
  c.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!long) skip(); long = true; });
  c.addEventListener('click', async () => {
    if (long) { long = false; return; }
    const h = HB.byId(set(), id); if (!h) return;
    if (!HB.isNumber(h)) return putHabit(HB.toggled(h, k), HB.val(h, k) === 1 ? 'untick a habit' : 'tick off a habit');
    const cur = HB.val(h, k) > 0 ? HB.val(h, k) : '';
    const v = await modal(`<form class="choice hb-amount"><h2>${esc(h.name)}</h2><p class="muted small">${esc(T.format(T.dayStart(k, tz()), tz(), { weekday: 'long', day: 'numeric', month: 'long' }))} · target ${esc(HB.freqLabel(h))}</p>
      <label class="field"><span>Amount${h.unit ? ` (${esc(h.unit)})` : ''}</span><input name="v" type="number" step="any" min="0" value="${cur}" autofocus></label>
      <div class="actions"><button type="button" class="btn ghost hb-sk">Skip this day</button><span class="grow"></span><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">Save</button></div></form>`,
    (dlg, close) => { const f = $('form', dlg); $('.hb-sk', dlg).onclick = () => close({ skip: true }); f.onsubmit = (e) => { e.preventDefault(); close({ v: f.v.value }); }; }, { cls: 'narrow' });
    if (!v) return;
    putHabit(v.skip ? HB.setValue(h, k, -1) : HB.setValue(h, k, v.v === '' ? null : +v.v), 'habit amount');
  });
}
// Automatic habits: look at the events and task sessions of the days since "from" (up to 60 days back each time)
// and tick / untick them. Runs after each refresh (at most every 2 minutes) and right after a habit is set up.
export const autoHabits = job(async () => {
  const auto = (set().habits || []).filter((h) => HB.autoOn(h) && !h.archived);
  if (!auto.length) return;
  {
    const z = tz(), today = T.dayKey(Date.now(), z), back = T.addDays(today, -60);
    const from = auto.reduce((a, h) => { const f = h.auto.from && h.auto.from > back ? h.auto.from : back; return f < a ? f : a; }, today);
    const keys = []; for (let k = from; k <= today; k = T.addDays(k, 1)) keys.push(k);
    const items = await collectItems([from, today]);
    let changed = false;
    const next = (set().habits || []).map((h) => {
      if (!HB.autoOn(h) || h.archived) return h;
      const nh = HB.applyAuto(h, items, keys, set(), Date.now());
      if (JSON.stringify(nh.autoLog) !== JSON.stringify(h.autoLog || {}) || JSON.stringify(nh.autoHit) !== JSON.stringify(h.autoHit || {})) changed = true;
      return nh;
    });
    if (changed) { set().habits = next; await E.persist(st(), ['settings']); syncSharedSoon(); refreshHabits(); }
  }
}, { quiet: true });
async function editHabit(h) {
  const r = await D.habitDialog(ctx, h);
  if (!r) return;
  if (r.delete) { await saveHabits((set().habits || []).filter((x) => x.id !== h.id), `delete habit “${h.name}”`); toast(`Deleted “${h.name}”`); return; }
  if (JSON.stringify(r.auto || null) !== JSON.stringify(h?.auto || null)) r.autoLog = {}; // set up afresh
  await putHabit(r, h ? `edit habit “${r.name}”` : `new habit “${r.name}”`);
  if (HB.autoOn(r)) await autoHabits({ force: true });
  if (!h) { app.sideTab = 'habits'; try { localStorage.setItem('tempo:sideTab', 'habits'); } catch { /* storage blocked */ } renderLater(); }
  return r;
}
// The habit's own page: overview, score, history, calendar, streaks, weekdays (the Loop layout)
export async function habitDetail(id) {
  const s = set(), z = tz(), today = T.dayKey(Date.now(), z);
  const draw = (dlg) => {
    const h = HB.byId(set(), id); if (!h) return;
    const ser = HB.scoreSeries(h, s, today), sc = ser.length ? ser[ser.length - 1].sc : 0;
    const at = (k) => { const x = ser.find((q) => q.k === k); return x ? x.sc : 0; };
    const dm = sc - at(T.addDays(today, -30)), dy = sc - at(T.addDays(today, -365));
    const total = [...new Set([...Object.keys(h.log || {}), ...Object.keys(h.autoLog || {})])].reduce((acc, k) => { const v = HB.val(h, k); return acc + (k > today ? 0 : HB.isNumber(h) ? (v > 0 ? +v : 0) : v === 1 ? 1 : 0); }, 0);
    const pctS = (v) => `${v >= 0 ? '+' : ''}${Math.round(v * 100)}%`;
    // score chart: last 26 weeks, one point a week
    const pts = []; for (let i = 26; i >= 0; i--) pts.push(at(T.addDays(today, -7 * i)));
    const W = 520, Hh = 120, x = (i) => 8 + (i * (W - 16)) / (pts.length - 1), y = (v) => Hh - 10 - v * (Hh - 24);
    const scoreSvg = `<svg class="hb-chart" viewBox="0 0 ${W} ${Hh}" preserveAspectRatio="none">${[0.25, 0.5, 0.75, 1].map((g) => `<line x1="0" x2="${W}" y1="${y(g)}" y2="${y(g)}" class="hb-grid"/>`).join('')}<polyline fill="none" stroke="${h.color}" stroke-width="2.5" points="${pts.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}"/>${pts.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3" fill="${h.color}"><title>${Math.round(v * 100)}%</title></circle>`).join('')}</svg>`;
    const hist = HB.history(h, s, 16, 'week', today), maxH = Math.max(1, ...hist.map((q) => Math.max(q.n, q.goal)));
    const histSvg = `<div class="hb-bars">${hist.map((q) => `<div class="hb-bar" title="Week of ${esc(T.format(T.dayStart(q.from, z), z, { day: 'numeric', month: 'short' }))}: ${HB.fmtNum(q.n)}${HB.isNumber(h) ? ' ' + esc(h.unit || '') : ''}"><span class="hb-bv">${q.n ? HB.fmtNum(q.n) : ''}</span><i style="height:${(q.n / maxH) * 100}%;background:${h.color}"></i><span class="hb-bl">${T.parseKey(q.from).d}</span></div>`).join('')}</div>`;
    // calendar: the last 20 weeks, a column per week, a row per weekday
    const wk0 = T.addDays(T.startOfWeek(today, s.weekStart ?? 1), -19 * 7);
    const cols = Array.from({ length: 20 }, (_, w) => Array.from({ length: 7 }, (_, d) => T.addDays(wk0, w * 7 + d)));
    const cal = `<div class="hb-cal" style="--c:${h.color}">${cols.map((c) => `<div class="hb-calw"><span class="hb-calm">${T.parseKey(c[0]).d <= 7 ? esc(T.format(T.dayStart(c[0], z), z, { month: 'short' })) : ''}</span>${c.map((k) => { const v = HB.val(h, k), dv = HB.dayValue(h, k); return `<button type="button" class="hb-cd ${k > today ? 'fut' : ''} ${v === -1 ? 'skip' : ''}" data-k="${k}" style="--o:${k > today ? 0 : v === -1 ? 0.25 : dv ? 0.35 + 0.65 * dv : 0}" title="${esc(T.fmtDate(T.dayStart(k, z), z))}${v != null ? ` — ${v === -1 ? 'skipped' : v === 1 && !HB.isNumber(h) ? 'done' : HB.fmtNum(v) + ' ' + (h.unit || '')}` : ''}" ${k > today ? 'disabled' : ''}>${T.parseKey(k).d}</button>`; }).join('')}</div>`).join('')}</div>`;
    const stk = HB.streaks(h, s, today), maxS = Math.max(1, ...stk.top.map((r) => r.n));
    const unit = (n) => `${n} ${stk.unit}${n === 1 ? '' : 's'}`;
    const wd = HB.byWeekday(h, s, 365, today), maxW = Math.max(1, ...wd);
    const order = [1, 2, 3, 4, 5, 6, 0].map((d) => (d + (s.weekStart ?? 1) - 1 + 7) % 7);
    setHTML($('.hb-detail-body', dlg), `
      <div class="hb-over">${ringSVG(sc, h.color, 64)}<div><b class="hb-big" style="color:${h.color}">${Math.round(sc * 100)}%</b><span class="muted small">Score</span></div>
        <div><b>${pctS(dm)}</b><span class="muted small">Month</span></div><div><b>${pctS(dy)}</b><span class="muted small">Year</span></div><div><b>${HB.fmtNum(total)}</b><span class="muted small">${HB.isNumber(h) ? esc(h.unit || 'Total') : 'Total'}</span></div></div>
      <h3 class="hb-h" style="color:${h.color}">Score</h3>${scoreSvg}
      <h3 class="hb-h" style="color:${h.color}">History <span class="muted small">per week</span></h3>${histSvg}
      <h3 class="hb-h" style="color:${h.color}">Calendar <span class="muted small">click a day to change it</span></h3>${cal}
      <h3 class="hb-h" style="color:${h.color}">Best streaks <span class="muted small">current: ${unit(stk.current)} · best: ${unit(stk.best)}</span></h3>
      <div class="hb-streaks">${stk.top.map((r) => `<div class="hb-st"><span class="muted small">${esc(T.format(T.dayStart(r.from, z), z, { day: 'numeric', month: 'short' }))}</span><i style="width:${Math.max(8, (r.n / maxS) * 100)}%;background:${h.color}">${r.n}</i><span class="muted small">${esc(T.format(T.dayStart(T.addDays(r.to, -1), z), z, { day: 'numeric', month: 'short' }))}</span></div>`).join('') || '<p class="muted small">No streak yet — tick off the first day.</p>'}</div>
      <h3 class="hb-h" style="color:${h.color}">Frequency <span class="muted small">by weekday, last year</span></h3>
      <div class="hb-wd">${order.map((d) => `<div><i style="width:${8 + (wd[d] / maxW) * 22}px;height:${8 + (wd[d] / maxW) * 22}px;background:${h.color};opacity:${wd[d] ? 0.35 + 0.65 * (wd[d] / maxW) : 0.12}" title="${wd[d]}"></i><span class="muted small">${esc(T.format(T.dayStart(T.addDays('2026-10-18', d), z), z, { weekday: 'short' }))}</span></div>`).join('')}</div>`);
    $('.hb-detail-head', dlg).style.setProperty('--c', h.color);
    $('.hb-detail-head h2', dlg).textContent = h.name;
    $('.hb-detail-head .hb-sub', dlg).textContent = [h.question, HB.freqLabel(h)].filter(Boolean).join(' · ');
    $$('.hb-cd', dlg).forEach((c) => wireHabitCell(c, id));
  };
  await modal(`<div class="hb-detail"><header class="dlg-head hb-detail-head"><div><h2></h2><div class="hb-sub small"></div></div><span class="grow"></span><button type="button" class="btn small hb-edit">Edit</button><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></header><div class="dlg-body hb-detail-body"></div></div>`, (dlg, close) => {
    draw(dlg);
    const redraw = () => { if (dlg.isConnected) draw(dlg); };
    app.habitRedraw = redraw;
    $('.hb-edit', dlg).onclick = async () => { await editHabit(HB.byId(set(), id)); if (!HB.byId(set(), id)) close(); else redraw(); };
  }, { cls: 'wide' });
  app.habitRedraw = null;
}
