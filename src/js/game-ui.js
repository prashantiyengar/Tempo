// Game mode UI: the panel, XP chips and breakdowns, level-ups, road to 300, ledger upkeep.
import * as T from './tz.js';
import * as S from './scheduler.js';
import * as E from './engine.js';
import { $, $$, esc, popover, modal, setHTML } from './ui.js';
import * as GL from './goals.js';
import * as SC from './scopes.js';
import * as P from './projects.js';
import * as HB from './habits.js';
import * as GM from './game.js';
import { app, set, st, tz } from './core.js';
import { collectItems, render, syncSharedSoon, toast } from './app.js';
import { projectEventDone } from './sidebar.js';

// ======================================================================================
// Game mode: XP, levels, quests, achievements (see game.js)
// ======================================================================================
export const gameOn = () => !!set().game?.on;
// The game's view of the tasks, projects, goals and habits for a set of items — built once per set (a redraw asks for
// it for every day header) and thrown away with it.
const gameCtxCache = new WeakMap();
function gameCtx(items) {
  const hit = gameCtxCache.get(items);
  if (hit && hit.rev === app.dataRev) return hit.ctx;
  const ctx = buildGameCtx(items);
  gameCtxCache.set(items, { ctx, rev: app.dataRev });
  return ctx;
}
function buildGameCtx(items) {
  const s = set(), now = Date.now();
  const tasks = st().tasks.map((t) => {
    const pr = S.progress(t, now);
    const done = (t.frozen || []).filter((c) => c.status === 'done');
    return { ...t, _finishedAt: !t.repeat && pr.pct >= 100 && done.length ? Math.max(...done.map((c) => c.end)) : null, _sessions: S.sessions(t).length };
  });
  const projectsDone = P.list(s).map((p) => { const pr = P.progress(p, st().tasks, now, projectEventDone); return pr.complete ? { id: p.id, name: p.name, at: Math.max(0, ...pr.rows.map((r) => r.task?._finishedAt || r.st.end || 0), ...pr.rows.filter((r) => r.task).map((r) => Math.max(0, ...(r.task.frozen || []).filter((c) => c.status === 'done').map((c) => c.end)))) } : null; }).filter(Boolean);
  const goalsAll = Object.entries(s.goals || {}).flatMap(([key, l]) => (l || []).map((g) => ({ g, key })));
  // minutes that count towards a goal in [from, to): its "at least" hours rule, its own match, or its head's categories
  const clipped = {};
  const goalMinutes = (g, key, from, to) => {
    const r = g.rule && g.rule.kind !== 'timing' && g.rule.op !== 'atMost' ? g.rule : null;
    if (r) return GL.catMinutes(r.scope ? (clipped[r.scope] ||= SC.clipItems(items, r.scope, s)) : items, r.cats?.length ? r.cats : GL.goalCats(s, g), from, to, now, s);
    if (GL.hasOwnMatch(g)) { const m = GL.goalMatch(g); return GL.timeIn(items, m.cats, from, to, now, s, m).done; }
    return GL.timeIn(items, GL.headCats(s, GL.headOf(g)), from, to, now, s).done;
  };
  // life-growth minutes earlier in day k's week (from the settled days, else counted from the items)
  const lifeBefore = (k) => {
    let m = 0; const z = s.tz;
    for (let d = T.startOfWeek(k, s.weekStart ?? 1); d < k; d = T.addDays(d, 1)) {
      const led = s.game?.ledger?.[d];
      if (led && led.gm != null) { m += led.gm; continue; }
      const a = T.dayStart(d, z), b = T.dayStart(T.addDays(d, 1), z);
      for (const it of items) if (!it.allDay && it.start >= a && it.start < b) { const x = GM.itemXP(it, s, now); if (x.done && x.grow) m += Math.max(0, Math.min(it.end, now) - it.start) / T.MIN; }
    }
    return m;
  };
  return { items, tasks, projects: P.list(s), projectsDone, habits: HB.list(s), habitDone: (h, k) => HB.isDone(h, k), habitStreak: (h, k) => HB.streaks(h, s, k).current, goals: [], goalsAll, goalMinutes, history: s.history || [], lifeBefore };
}
// 🚩 on the day you reached a new level (today: as soon as it happens)
export function levelFlag(k) {
  if (!gameOn()) return '';
  const today = T.dayKey(Date.now(), tz());
  let L = app.gameLevelUps?.[k];
  if (k === today && app.gameToday) { const now = gameLevel(gameTotals()).level, before = GM.levelAt(set(), today, tz()); if (now > before) L = now; }
  if (!L) return '';
  const t = GM.tierOf(L), newRank = t.from === L;
  return `<span class="lv-flag" data-lvflag="${L}" title="${esc(newRank ? `Level ${L} reached — new rank: ${t.name}` : `Level ${L} reached`)}">🚩<b>${L}</b></span>`;
}
export function gameDayChip(k, items) {
  if (!gameOn()) return '';
  const today = T.dayKey(Date.now(), tz()), led = set().game?.ledger?.[k];
  const dr = drainLines(k).day.reduce((a, l) => a + l[1], 0) - (app.gameRecover?.byDay?.[k] || []).reduce((a, l) => a + l[1], 0);
  if (k < today && led) { const n = led.net - dr; return `<button type="button" class="xp-chip ${n < 0 ? 'neg' : ''}" data-xpday="${k}" title="XP that day: ${n >= 0 ? '+' : ''}${n}${dr ? ` (after −${dr} drained)` : ''} — click for the breakdown">${n >= 0 ? '+' : ''}${n} XP</button>`; }
  if (k < (set().game?.started || today)) return '';
  const d = GM.dayXP(k, set(), gameCtx(items));
  if (k > today) return d.potential.total ? `<button type="button" class="xp-chip pot" data-xpday="${k}" title="XP you can earn by completing this day's events and sessions — click for details">+${d.potential.total}<span class="xc-w"> possible</span></button>` : '';
  d.net -= dr;
  return `<button type="button" class="xp-chip ${d.net < 0 ? 'neg' : ''}" data-xpday="${k}" title="${esc(`${d.net >= 0 ? 'Earned' : 'Net'} ${d.net} XP so far${k === today && d.potential.total ? `, ${d.potential.total} more to earn today` : ''} — click for the breakdown`)}">${d.net >= 0 ? '+' : ''}${d.net}${k === today && d.potential.total ? ` <i>· +${d.potential.total} to go</i>` : ''}</button>`;
}
// Drain lines that belong to day k ([label, cost, dayKey|null]; null = the whole week)
export function drainLines(k) {
  const g = set().game || {}, wk = T.startOfWeek(k, set().weekStart ?? 1);
  const lines = g.weeks?.[wk]?.dl || (app.gameDrain?.wk === wk ? app.gameDrain.lines : []) || [];
  return { day: lines.filter((l) => l[2] === k), week: lines.filter((l) => l[2] == null) };
}
// Click a day's XP: how the number came about (and what's still to earn that day)
export async function xpBreakdown(k, rect) {
  const s = set(), z = tz(), today = T.dayKey(Date.now(), z);
  const items = await collectItems([[T.addDays(k, -1), T.startOfWeek(k, s.weekStart ?? 1)].sort()[0], T.addDays(k, 14)]);
  const d = GM.dayXP(k, s, gameCtx(items)), led = s.game?.ledger?.[k];
  const by = { busy: [], life: [], app: [], pen: [] };
  for (const [l, ty, x] of d.lines) (by[ty] || by.app).push([l, x]);
  const group = (ty, name, cls) => { const l = by[ty]; if (!l.length) return ''; const tot = l.reduce((a, [, x]) => a + x, 0); return `<div class="xb-g"><div class="xb-h ${cls}"><b>${name}</b><b>${tot > 0 ? '+' : ''}${tot}</b></div>${l.map(([t, x]) => `<div class="xb-l"><span>${esc(t)}</span><span>${x > 0 ? '+' : ''}${x}</span></div>`).join('')}</div>`; };
  const todo = items.filter((it) => !it.allDay && T.dayKey(it.start, z) === k).map((it) => ({ it, x: GM.itemXP(it, s) })).filter((o) => !o.x.done && GM.sumXP(o.x) > 0);
  popover(rect, `<div class="pop xb"><h3>🎮 ${esc(T.format(T.dayStart(k, z), z, { weekday: 'long', day: 'numeric', month: 'short' }))}</h3>
    <div class="xb-net ${d.net < 0 ? 'xp-p' : ''}">${k > today ? 'Nothing earned yet' : `${d.net >= 0 ? '+' : ''}${d.net} XP`}${led && k < today && led.net !== d.net ? ` <span class="muted small">(counted as ${led.net >= 0 ? '+' : ''}${led.net} when the day was settled)</span>` : ''}</div>
    ${group('busy', 'Busy', 'xp-b')}${group('life', 'Life', 'xp-l')}${group('app', 'App', 'xp-a')}${group('pen', 'Rescheduling', 'xp-p')}
    ${(() => { const dl = drainLines(k), all = [...dl.day, ...dl.week]; if (!all.length) return ''; const tot = all.reduce((a, l) => a + l[1], 0); return `<div class="xb-g"><div class="xb-h xp-p"><b>XP drains</b><b>−${tot}</b></div>${all.map(([t, x, dk]) => `<div class="xb-l"><span>${esc(t)}${dk ? '' : ' <span class="muted">(this week)</span>'}</span><span>−${x}</span></div>`).join('')}</div>`; })()}
    ${(() => { const wk = T.startOfWeek(k, s.weekStart ?? 1), w = T.addDays(wk, 6) === k ? s.game?.weeks?.[wk] : null, rows = [];
      if (led?.cb && k < today) rows.push([`Clean day — no XP drains (${led.cs} in a row)`, led.cb]);
      if (w?.cb) rows.push([`Clean week — no XP drains all week (${w.cs} in a row, ${w.cpct}%)`, w.cb]);
      for (const [t, x] of app.gameRecover?.byDay?.[k] || []) rows.push([t, x]);
      if (k === today && app.gameClean?.day) rows.push([`Keep today clean (day ${app.gameClean.days + 1} in a row): ${app.gameClean.dayPct}% of today's XP, added tonight`, app.gameClean.dayXP]);
      return rows.length ? `<div class="xb-g"><div class="xb-h xp-c"><b>🧹 Clean bonus and drained XP won back</b><b>${((n) => (n >= 0 ? '+' : '') + n)(rows.reduce((a, r) => a + r[1], 0))}</b></div>${rows.map(([t, x]) => `<div class="xb-l"><span>${esc(t)}</span><span>${x >= 0 ? '+' : ''}${x}</span></div>`).join('')}</div>` : ''; })()}
    ${todo.length ? `<div class="xb-g"><div class="xb-h"><b>Still to earn</b><b>+${todo.reduce((a, o) => a + GM.sumXP(o.x), 0)}</b></div>${todo.map((o) => `<div class="xb-l"><span>${esc(o.it.title)}</span><span><span class="xp-b">${o.x.busy ? '+' + o.x.busy : ''}</span> <span class="xp-l">${o.x.life ? '+' + o.x.life : ''}</span></span></div>`).join('')}</div>` : ''}
    ${d.quests?.length && k <= today ? `<div class="xb-g"><div class="xb-h"><b>Quests</b></div>${d.quests.map((q) => `<div class="xb-l"><span>${q.ok ? '✅' : '⬜'} ${esc(q.label)}</span><span class="xp-${q.type[0]}">+${q.xp}</span></div>`).join('')}</div>` : ''}
  </div>`, (p, close) => {});
}
// What an event / session is worth, for its popup
export function gameXPLine(it) {
  if (!gameOn()) return '';
  const x = GM.itemXP(it, set());
  const fl = it.kind !== 'chunk' ? GM.laterOfEvent(it) : it.task?.fromLater;
  const lb = fl?.at ? GM.laterBonus(set(), fl.created, fl.at) : null;
  const later = lb ? ` <span class="xp-l" title="It waited ${lb.days} days in Later">· from Later: +${lb.done} life when done</span>` : '';
  if (x.drain) return `<div class="pop-row small xp-line">🎮 <b class="xp-p">💧 ${esc(x.why[0])}</b> <span class="muted">— and it costs XP (Settings → Game mode)</span></div>`;
  const parts = [x.busy ? `<b class="xp-b">+${x.busy} busy</b>` : '', x.life ? `<b class="xp-l">+${x.life} life</b>` : '', x.app ? `<b class="xp-a">+${x.app} app</b>` : ''].filter(Boolean);
  if (!parts.length) return '';
  return `<div class="pop-row small xp-line">🎮 ${x.done ? 'Earned' : 'Completing this earns'} ${parts.join(' ')} <span class="muted">(${esc(x.why.join(', '))})</span>${later}</div>`;
}
const gameSave = async () => { await E.persist(st(), ['settings']); syncSharedSoon(); };
// Mark today as a day you used Tempo
export async function gameActive() {
  if (!gameOn()) return;
  const g = set().game, k = T.dayKey(Date.now(), tz());
  if (!(g.active || []).includes(k)) { g.active = [...(g.active || []), k].slice(-400); await gameSave(); }
}
// Settle past days (and finished weeks) into the ledger, work out today, check achievements and level-ups.
let gameBusy = false;
export async function gameRefresh() {
  if (!gameOn() || gameBusy) return;
  gameBusy = true;
  try {
    const s = set(), g = s.game, z = tz(), now = Date.now(), today = T.dayKey(now, z);
    g.started ||= today; g.ledger ||= {}; g.weeks ||= {}; g.ach ||= {};
    // new rules, or you adjusted them: count everything again
    let changed = false, recount = false;
    if (g.rulesV !== GM.RULES_V || g.cfgHash !== GM.cfgHash(s)) { g.ledger = {}; g.weeks = {}; g.rulesV = GM.RULES_V; g.cfgHash = GM.cfgHash(s); app.gameToday = null; changed = true; recount = true; }
    const first = [g.started, T.addDays(today, -180)].sort()[1];
    const open = []; for (let k = first; k < today; k = T.addDays(k, 1)) if (!g.ledger[k]) open.push(k);
    // (from the start of the earliest goal period still open, so progress on goals is counted right)
    const goalFrom = Object.entries(s.goals || {}).filter(([key, l]) => (l || []).length && !key.startsWith('y')).map(([key, l]) => GM.goalPeriod(key, l[0], z)).filter((p) => p.to > (open[0] || today)).map((p) => p.from);
    const itemsFrom = [T.startOfWeek(open[0] || today, s.weekStart ?? 1), ...goalFrom, T.startOfWeek(today, s.weekStart ?? 1), today].sort()[0];
    const items = await collectItems([itemsFrom, T.addDays(today, 30)]);
    const ctx = gameCtx(items);
    // the day each task / project was first finished: finishing XP is given that day only, never again
    g.doneOn ||= {};
    const firstDone = (key, at) => { if (g.doneOn[key]) return; const d = g.doneOn[key] = T.dayKey(at, z); changed = true; if (d < today && g.ledger[d] && d >= g.started && d >= itemsFrom) { delete g.ledger[d]; if (!open.includes(d)) open.push(d); } };
    for (const t of ctx.tasks) if (t._finishedAt) firstDone('t:' + t.id, t._finishedAt);
    for (const p of ctx.projectsDone) firstDone('p:' + p.id, p.at);
    open.sort();
    const drained = GM.hasDrains(s) ? GM.anyDrainHours(s, items, [open[0] || today, T.startOfWeek(today, s.weekStart ?? 1)].sort()[0], T.addDays(today, 1), now) : null;
    let cleanNews = null;
    // goals reached by their rule: remember when, so reaching them earns XP that day
    for (const [key, l] of Object.entries(s.goals || {})) for (const gl of l || []) {
      if (!gl.rule || gl.autoDoneAt || gl.override === false) continue;
      const per = GM.goalPeriod(key, gl, z);
      if (GL.ruleStatus(gl, s, items, per.from, per.to, now)?.done) { gl.autoDoneAt = now; changed = true; }
    }
    for (const k of open) {
      const d = GM.dayXP(k, s, ctx, now);
      const e = g.ledger[k] = { a: d.app, b: d.busy, l: d.life, p: d.pen, net: d.net, lg: d.lg, nl: d.nl, f: d.f, fill: +d.fill.toFixed(3), penN: d.penN, doneN: d.doneN, gm: d.growMin, top: d.lines.slice().sort((x, y) => Math.abs(y[2]) - Math.abs(x[2])).slice(0, 8) };
      // a day without any XP drain: a bonus that grows with each clean day in a row
      if (drained && drained[k] > 0) e.dr = 1;
      if (drained && drained[k] === 0) {
        e.cs = (g.ledger[T.addDays(k, -1)]?.cs || 0) + 1;
        const cb = GM.cleanDay(s, e, e.cs, GM.levelAt(s, k, z)); e.cb = cb.xp; e.net += cb.xp;
        if (cb.xp) e.top = [[`Clean day — no XP drains (${e.cs} in a row, +${cb.pct}%)`, 'app', cb.xp], ...e.top].slice(0, 8);
        if (k === T.addDays(today, -1)) cleanNews = { k, n: e.cs, xp: cb.xp };
      } else if (drained && drained[k] > 0) cleanNews = k === T.addDays(today, -1) ? { k, n: 0, broke: (g.ledger[T.addDays(k, -1)]?.cs || 0) } : cleanNews;
      changed = true;
    }
    // weeks that are over
    for (let wk = T.startOfWeek(g.started, s.weekStart ?? 1); T.addDays(wk, 7) <= today; wk = T.addDays(wk, 7)) {
      if (g.weeks[wk]) continue;
      const days = Array.from({ length: 7 }, (_, i) => g.ledger[T.addDays(wk, i)]).filter(Boolean);
      if (!days.length) continue;
      const w = GM.weekXP(wk, s, days);
      w.busy = Math.round(w.busy * GM.settleFactor(s, GM.usedDays(s, T.addDays(wk, 7)))); // settling in applies to the week bonus too
      const xps = {}; for (let i = 0; i < 7; i++) { const k = T.addDays(wk, i), l = g.ledger[k]; if (l) xps[k] = { app: l.a, busy: l.b, life: l.l }; }
      const dr = GM.weekDrains(s, wk, xps, items, now, GM.drainScale(s, GM.levelAt(s, wk, z)));
      const W = g.weeks[wk] = { b: w.busy, fill: +w.fill.toFixed(3), pens: w.pens, drain: dr.total, dl: dr.lines }; changed = true;
      if (drained && Array.from({ length: 7 }, (_, i) => drained[T.addDays(wk, i)]).every((h) => h === 0) && days.length >= 4) {
        W.cs = (g.weeks[T.addDays(wk, -7)]?.cs || 0) + 1;
        const cw = GM.cleanWeek(s, days, w.busy, W.cs, GM.levelAt(s, wk, z)); W.cb = cw.xp; W.cpct = cw.pct;
        if (T.addDays(wk, 14) > today) cleanNews = { k: 'w' + wk, ...(cleanNews || {}), week: W.cs, wxp: cw.xp };
      }
      if (w.fill >= 0.6) unlock('full-week'); if (w.pens === 0 && days.length >= 5) unlock('clean-week');
    }
    app.gameToday = GM.dayXP(today, s, ctx, now);
    // drains of the week under way (worked out live)
    { const wk = T.startOfWeek(today, s.weekStart ?? 1), xps = {};
      for (let i = 0; i < 7; i++) { const k = T.addDays(wk, i), l = g.ledger[k]; if (l) xps[k] = { app: l.a, busy: l.b, life: l.l }; }
      xps[today] = { app: app.gameToday.app, busy: app.gameToday.busy, life: app.gameToday.life };
      app.gameDrain = { wk, ...GM.weekDrains(s, wk, xps, items, now, GM.drainScale(s, GM.levelAt(s, wk, z))) };
      // today / this week still clean?
      app.gameClean = drained && today in drained ? { day: drained[today] === 0, week: Array.from({ length: 7 }, (_, i) => T.addDays(wk, i)).filter((k) => k <= today).every((k) => drained[k] === 0), days: g.ledger[T.addDays(today, -1)]?.cs || 0, weeks: g.weeks[T.addDays(wk, -7)]?.cs || 0 } : null;
      if (app.gameClean) { const c = GM.cfg(s), t = app.gameToday, cap = GM.cleanCap(s, GM.levelAt(s, today, z)); app.gameClean.cap = cap; app.gameClean.dayPct = GM.cleanPct(c.cleanDayPct, c.cleanDayStep, app.gameClean.days + 1, cap); app.gameClean.weekPct = GM.cleanPct(c.cleanWeekPct, c.cleanWeekStep, app.gameClean.weeks + 1, cap); app.gameClean.dayXP = Math.round(Math.max(0, t.app + t.busy + t.life) * app.gameClean.dayPct / 100); } }
    // winning back XP lost to drains (clean days in a row after a drain)
    {
      const lossBy = {}, addL = (k, x) => { lossBy[k] = (lossBy[k] || 0) + x; };
      const wkLines = (wk) => g.weeks[wk]?.dl || (app.gameDrain?.wk === wk ? app.gameDrain.lines : []);
      const days = [];
      for (let k = g.started; k < today; k = T.addDays(k, 1)) if (g.ledger[k]) days.push({ k, drain: !!g.ledger[k].dr, loss: 0 });
      if (drained?.[today] > 0) days.push({ k: today, drain: true, loss: 0 });
      const wks = [...new Set(days.map((d) => T.startOfWeek(d.k, s.weekStart ?? 1)))];
      for (const wk of wks) {
        const ls = wkLines(wk) || [], drainDays = days.filter((d) => d.drain && T.startOfWeek(d.k, s.weekStart ?? 1) === wk);
        for (const l of ls) { if (l[2]) addL(l[2], l[1]); else if (drainDays.length) addL(drainDays[drainDays.length - 1].k, l[1]); }
      }
      for (const d of days) d.loss = lossBy[d.k] || 0;
      app.gameRecover = GM.recovery(s, days);
    }
    app.gameLevelUps = GM.levelUps(s, z, s.weekStart ?? 1);
    // tell me about my clean streak (once per day)
    if (cleanNews && !recount) {
      let seen = ''; try { seen = localStorage.getItem('tempo:cleanSeen') || ''; } catch { /* storage blocked */ }
      if (seen !== cleanNews.k) {
        try { localStorage.setItem('tempo:cleanSeen', cleanNews.k); } catch { /* storage blocked */ }
        const msg = cleanNews.n ? `🧹 Clean day — no XP drains! ${cleanNews.n} day${cleanNews.n > 1 ? 's' : ''} in a row: +${cleanNews.xp} XP${cleanNews.week ? ` · clean week ${cleanNews.week} in a row: +${cleanNews.wxp} XP` : ''}` : cleanNews.week ? `🧹 Clean week ${cleanNews.week} in a row: +${cleanNews.wxp} XP` : cleanNews.broke ? `💧 Yesterday had an XP drain — your clean streak of ${cleanNews.broke} day${cleanNews.broke > 1 ? 's' : ''} starts again` : '';
        if (msg) setTimeout(() => toast(msg, { ms: 6000, noUndo: true }), 600);
      }
    }
    // achievements
    function unlock(id) { if (!g.ach[id]) { g.ach[id] = now; changed = true; const a = GM.ACHIEVEMENTS.find((x) => x[0] === id); if (a) setTimeout(() => toast(`🏆 Achievement: ${a[1]} ${a[2]} — ${a[3]} (+${GM.ACH_XP} XP)`, { ms: 6000, noUndo: true }), 300); } }
    const tot = gameTotals();
    let streak = 0; for (let d = today; (g.active || []).includes(d); d = T.addDays(d, -1)) streak++;
    if (st().tasks.length) unlock('first-task'); if (P.list(s).length) unlock('first-project');
    if (streak >= 7) unlock('streak-7'); if (streak >= 30) unlock('streak-30');
    const sessDone = st().tasks.reduce((a, t) => a + (t.frozen || []).filter((c) => c.status === 'done' && c.end >= T.dayStart(g.started, z)).length, 0);
    if (sessDone >= 25) unlock('sessions-25'); if (sessDone >= 100) unlock('sessions-100');
    if (tot.life >= 1000) unlock('life-1000'); if (tot.life >= 10000) unlock('life-10000');
    const lv = gameLevel(tot).level;
    if (lv >= 20) unlock('level-20'); if (lv >= 50) unlock('level-50'); if (lv >= 100) unlock('level-100');
    if (celebrateLevel(g, lv, recount)) changed = true;
    if (changed) await gameSave();
    renderGamePanel();
    // redraw the calendar when its level flags (🚩) changed
    const sig = JSON.stringify([app.gameLevelUps, lv]);
    if (app.gameLvSig !== sig) { const first = app.gameLvSig === undefined; app.gameLvSig = sig; if (!first || Object.keys(app.gameLevelUps).length || lv > GM.levelAt(s, today, z)) setTimeout(() => render(), 0); }
  } catch (err) { console.warn('Tempo: game', err); }
  finally { gameBusy = false; }
}
export const gameLevel = (tot) => { const c = GM.cfg(set()); return GM.levelOf(tot.total, tot.life, c.pace, c.lifeCap / 100); };
export function gameTotals() {
  const g = set().game || {}, t = { app: 0, busy: 0, life: 0, pen: 0, clean: 0 };
  for (const d of Object.values(g.ledger || {})) { t.app += d.a || 0; t.busy += d.b || 0; t.life += d.l || 0; t.pen += d.p || 0; t.clean += d.cb || 0; }
  t.drain = 0;
  for (const w of Object.values(g.weeks || {})) { t.busy += w.b || 0; t.drain += w.drain || 0; t.clean += w.cb || 0; }
  if (app.gameDrain && !g.weeks?.[app.gameDrain.wk]) t.drain += app.gameDrain.total || 0;
  t.pen += t.drain;
  t.app += Object.keys(g.ach || {}).length * GM.ACH_XP;
  const d = app.gameToday; if (d) { t.app += d.app; t.busy += d.busy; t.life += d.life; t.pen += d.pen; }
  t.rec = app.gameRecover?.total || 0;
  t.total = Math.max(0, t.app + t.busy + t.life + t.clean + t.rec - t.pen);
  return t;
}
// The sidebar panel: rank emblem, level, progress, XP by type, streak, today, quests
export function renderGamePanel() {
  const box = $('#game-panel'); if (!box) return;
  document.body.classList.toggle('game-on', gameOn());
  if (!gameOn()) { box.hidden = true; return; }
  box.hidden = false;
  const g = set().game, tot = gameTotals(), lv = gameLevel(tot), tier = GM.tierOf(lv.level), today = T.dayKey(Date.now(), tz());
  let streak = 0; for (let d = today; (g.active || []).includes(d); d = T.addDays(d, -1)) streak++;
  const d = app.gameToday;
  const pct = lv.max ? 100 : Math.min(100, (lv.into / Math.max(1, lv.span)) * 100);
  const share = (x) => (tot.app + tot.busy + tot.life ? (x / (tot.app + tot.busy + tot.life)) * 100 : 0);
  let collapsed = false; try { collapsed = localStorage.getItem('tempo:gameCollapsed') === '1'; } catch { /* storage blocked */ }
  box.classList.toggle('min', collapsed);
  setHTML(box, `<button type="button" class="gp-head" aria-expanded="${!collapsed}" title="${collapsed ? 'Expand the game panel' : 'Minimise the game panel'}">${GM.emblemSVG(lv.level, collapsed ? 22 : 46)}<span class="gp-t" title="${esc(tier.desc || '')}"><b>Level ${lv.level}</b><span>${esc(tier.name)}${tier.next ? ` · next: ${esc(tier.next.name)} at ${tier.next.from}` : ''}</span></span><span class="gp-today ${d && d.net < 0 ? 'neg' : ''}" title="XP today">${d ? `${d.net >= 0 ? '+' : ''}${d.net}` : ''}</span><span class="sec-caret">▾</span></button>
    <div class="gp-bar" title="${lv.into} / ${lv.span} XP to level ${lv.level + 1}"><i style="width:${pct}%;--tc:${tier.color}"></i></div>
    <div class="gp-body" ${collapsed ? 'hidden' : ''}>
      <div class="gp-sub">${lv.max ? 'Highest level reached!' : lv.capped ? `Enough XP for level ${lv.level + 1}` : `${lv.into.toLocaleString()} / ${lv.span.toLocaleString()} XP to level ${lv.level + 1}`}${lv.capped ? `<br><b class="xp-l">🔒 ${lv.lifeNeed.toLocaleString()} more life XP</b> to unlock level ${lv.level + 1}` : ''}</div>
      ${d && d.f < 1 ? `<div class="gp-settle" title="Busy, leisure, sleep and app XP count in full in your first week, then less and less. Life growth always counts in full.">Settled in: busy & leisure XP ×${d.f.toFixed(2)} · <b class="xp-l">life growth ×1</b></div>` : ''}
      <div class="gp-mix" title="Your XP by type"><i class="xp-a-bg" style="width:${share(tot.app)}%"></i><i class="xp-b-bg" style="width:${share(tot.busy)}%"></i><i class="xp-l-bg" style="width:${share(tot.life)}%"></i></div>
      <div class="gp-types"><span class="xp-a">● App ${tot.app.toLocaleString()}</span><span class="xp-b">● Busy ${tot.busy.toLocaleString()}</span><span class="xp-l">● Life ${tot.life.toLocaleString()}</span>${tot.pen - tot.drain ? `<span class="xp-p">− ${(tot.pen - tot.drain).toLocaleString()} rescheduling</span>` : ''}${tot.clean ? `<span class="xp-c" title="Bonuses for days and weeks without XP drains">+ ${tot.clean.toLocaleString()} clean</span>` : ''}${tot.rec ? `<span class="xp-c" title="Drained XP won back with clean days in a row">+ ${tot.rec.toLocaleString()} won back</span>` : ''}${tot.drain ? `<span class="xp-p" title="XP drains (Settings → Game mode)">− ${tot.drain.toLocaleString()} drained</span>` : ''}</div>
      ${(() => { const r = app.gameRecover?.active; if (!r) return ''; const c = GM.cfg(set()), left1 = r.N1 - r.n, left2 = r.N2 - r.n;
        return `<div class="gp-rec" title="XP lost to drains comes back with clean days in a row: ${c.recoverPct1}% after ${r.N1} days (paid a little each day, in trust until then), all of it after ${r.N2} days plus a ${c.recoverBonusPct}% bonus. A drain before day ${r.N1} takes back everything in trust. Each drain needs one more clean day next time.">✨ Win back <b>${r.loss} XP</b> lost to drains<br><span class="small">${r.n < r.N1 ? `${r.n} of ${r.N1} clean days → ${c.recoverPct1}% back (${r.part1} XP): <b>${left1} day${left1 === 1 ? '' : 's'} left</b>` : `${c.recoverPct1}% won back ✓ · ${r.n} of ${r.N2} days → all + ${c.recoverBonusPct}%: <b>${left2} day${left2 === 1 ? '' : 's'} left</b>`}${r.inTrust ? ` · <b class="xp-c">+${r.inTrust}</b> in trust — a drain now loses it` : ''}</span></div>`; })()}
      ${(() => { const c = app.gameClean; if (!c) return ''; return `<div class="gp-clean ${c.day ? '' : 'broke'}" title="A day (and a week) without any XP drain earns a bonus that grows with each one in a row">🧹 Clean streak: <b>${c.days} day${c.days === 1 ? '' : 's'}</b> · <b>${c.weeks} week${c.weeks === 1 ? '' : 's'}</b><br><span class="small">${c.day ? `Keep today clean: <b class="xp-c">+${c.dayXP} XP</b> (${c.dayPct}% of today)` : 'An XP drain today — the day streak starts again tomorrow'}${c.week ? ` · a clean week earns ${c.weekPct}%` : ''} · cap ${c.cap}% at your rank</span></div>`; })()}
      <div class="gp-row"><span title="Days in a row you used Tempo">🔥 ${streak} day${streak === 1 ? '' : 's'}</span><span title="Total XP">⭐ ${tot.total.toLocaleString()} XP</span>${d?.potential?.total ? `<span title="Still to earn today">🎯 +${d.potential.total} today</span>` : ''}</div>
      ${d?.quests?.length ? `<div class="gp-q"><b>Today's quests</b>${d.quests.map((q) => `<div class="gp-qi ${q.ok ? 'ok' : ''}"><span>${q.ok ? '✅' : '⬜'} ${esc(q.label)}</span><span class="xp-${q.type[0]}">+${q.xp}</span><i style="width:${Math.min(100, (q.have / q.goal) * 100)}%"></i></div>`).join('')}</div>` : ''}
      <div class="gp-row"><button type="button" class="link gp-more">Road to 300, ranks, achievements & XP log</button></div>
    </div>`);
  $('.gp-head', box).onclick = () => { try { localStorage.setItem('tempo:gameCollapsed', collapsed ? '0' : '1'); } catch { /* storage blocked */ } renderGamePanel(); };
  $('.gp-more', box)?.addEventListener('click', gameDetails);
}
// Fireworks once per new level: the highest level celebrated is kept with your settings (so other devices and
// reopening the app don't celebrate it again); a recount or the first count never celebrates.
function celebrateLevel(g, level, quiet) {
  const best = +g.celebrated || 0;
  if (level <= best) return false;
  g.celebrated = level;
  if (!best || quiet) return true;
  const tier = GM.tierOf(level), newTier = tier.from > GM.tierOf(best).from;
  fireworks(newTier ? 3600 : 2200);
  toast(newTier ? `🎉 New rank: ${tier.icon} ${tier.name} — level ${level}!` : `🎉 Level ${level}!`, { ms: 6000, noUndo: true });
  return true;
}
// The road to level 300: when you'd reach the major levels if the last weeks are what's normal (no drains)
// (the knobs: how many weeks of your data it goes by, extra life growth a week, and how much life growth / everything
// else you'd do compared to now — the chart is drawn again as you change them)
const roadOpts = { weeks: 4, extra: 2, lifeX: 100, restX: 100 };
function roadTo300() {
  return `<h3 class="gd-h">Road to level 300</h3>
    <div class="road-knobs">
      <label class="field"><span>Based on the last</span><select data-road="weeks">${[1, 2, 4, 8, 12, 26].map((w) => `<option value="${w}" ${roadOpts.weeks === w ? 'selected' : ''}>${w} week${w > 1 ? 's' : ''}</option>`).join('')}</select></label>
      <label class="field"><span>Extra life growth a week (h)</span><input type="number" data-road="extra" min="0" max="40" step="0.5" value="${roadOpts.extra}" class="num"></label>
      <label class="field"><span>Life growth vs now (%)</span><input type="number" data-road="lifeX" min="0" max="500" step="10" value="${roadOpts.lifeX}" class="num"></label>
      <label class="field"><span>Everything else vs now (%)</span><input type="number" data-road="restX" min="0" max="500" step="10" value="${roadOpts.restX}" class="num"></label>
    </div>
    <div class="road-out">${roadOut()}</div>`;
}
function wireRoad(root) {
  $$('[data-road]', root).forEach((inp) => inp.addEventListener('input', () => {
    const k = inp.dataset.road; roadOpts[k] = Math.max(0, +inp.value || 0); if (k === 'weeks') roadOpts.weeks = Math.max(1, roadOpts.weeks);
    clearTimeout(wireRoad.t); wireRoad.t = setTimeout(() => { const o = $('.road-out', root); if (o) setHTML(o, roadOut()); }, 150);
  }));
}
function roadOut() {
  const s = set(), z = tz(), today = T.dayKey(Date.now(), z), o = roadOpts;
  const common = { weeks: o.weeks, lifeX: o.lifeX / 100, restX: o.restX / 100 };
  const base = GM.projection(s, today, z, common), more = o.extra > 0 ? GM.projection(s, today, z, { ...common, extraLifeH: o.extra }) : null;
  const fmtD = (k, short) => T.format(T.dayStart(k, z), z, short ? { month: 'short' } : { month: 'short', year: 'numeric' });
  if (!base) return `<p class="muted small">After a few days of play, this shows when you'd reach the major levels at your pace.</p>`;
  if (more) more.extraH = o.extra;
  const row = (m) => { const a = base.hit[m], b = more?.hit[m]; const t = GM.tierOf(m); return `<tr class="${base.now >= m ? 'got' : ''}"><td>${GM.emblemSVG(m, 22)}</td><td><b>${m}</b> ${esc(t.name)}</td><td>${base.now >= m ? '✓ reached' : a ? `≈ ${esc(fmtD(a))}` : '<span class="muted">over 40 years</span>'}</td><td class="xp-l">${base.now >= m ? '' : b ? `≈ ${esc(fmtD(b))}` : '—'}</td></tr>`; };
  return `<p class="muted small" style="margin:0 0 2px">If the last ${o.weeks} week${o.weeks > 1 ? 's are' : ' is'} your normal pace${o.lifeX !== 100 || o.restX !== 100 ? ` (life growth at ${o.lifeX}%, everything else at ${o.restX}%)` : ''}, with no drains.</p>
    ${GM.projectionSVG(base, more, z, fmtD)}
    <p class="muted small" style="margin:2px 0 6px">Now: about <b class="xp-l">${base.perWeek.life} life-growth XP</b> and <b>${base.perWeek.rest}</b> other XP a week. Busy, leisure and app XP keep counting for less as you settle in; life growth never does — that's what moves you up in the long run.</p>
    <table class="gd-ms"><thead><tr><th></th><th>Level</th><th>At this pace</th><th class="xp-l">${more ? `+${o.extra} h life growth a week` : ''}</th></tr></thead><tbody>${GM.MILESTONES.map(row).join('')}</tbody></table>`;
}
// Ranks (with their emblems), achievements and the XP log of the last days
async function gameDetails() {
  const g = set().game, tot = gameTotals(), lv = gameLevel(tot);
  const days = Object.entries(g.ledger || {}).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 14);
  const t = app.gameToday;
  await modal(`<div class="g-details"><header class="dlg-head"><h2>🎮 Level ${lv.level} · ${esc(GM.tierOf(lv.level).name)}</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></header><div class="dlg-body">
    ${roadTo300()}
    <h3 class="gd-h">Ranks <span class="muted small">a new one every 5 levels</span></h3>
    ${GM.ERAS.map((era, i) => { const next = GM.ERAS[i + 1]?.from || 999; const rs = GM.RANKS.filter(([L]) => L >= era.from && L < next); return `<div class="gd-era" style="--ec:${era.color}">${esc(era.name)} <span class="muted small">levels ${era.from}–${Math.min(300, next - 1)}</span></div><div class="gd-tiers">${rs.map(([L, n, , dsc]) => `<div class="gd-tier ${lv.level >= L ? 'got' : ''} ${GM.tierOf(lv.level).from === L ? 'cur' : ''}" title="${esc(dsc)}">${GM.emblemSVG(L, 54)}<b>${esc(n)}</b><span class="gd-desc">${esc(dsc)}</span><span class="muted small">level ${L}${lv.level < L ? ` · ${Math.max(0, Math.round(GM.xpFor(L) * GM.cfg(set()).pace) - tot.total).toLocaleString()} XP to go` : ' ✓'}</span></div>`).join('')}</div>`; }).join('')}
    <h3 class="gd-h">Achievements <span class="muted small">${Object.keys(g.ach || {}).length}/${GM.ACHIEVEMENTS.length} · +${GM.ACH_XP} XP each</span></h3>
    <div class="gd-ach">${GM.ACHIEVEMENTS.map(([id, ic, n, d]) => `<div class="gd-a ${g.ach?.[id] ? 'got' : ''}" title="${esc(d)}"><span>${ic}</span><b>${esc(n)}</b><span class="muted small">${esc(d)}</span></div>`).join('')}</div>
    <h3 class="gd-h">XP log</h3>
    ${t ? `<details open class="gd-day"><summary><b>Today</b> <span class="${t.net < 0 ? 'xp-p' : ''}">${t.net >= 0 ? '+' : ''}${t.net} XP</span></summary>${t.lines.map(([l, ty, x]) => `<div class="gd-line"><span>${esc(l)}</span><b class="xp-${ty === 'pen' ? 'p' : ty[0]}">${x > 0 ? '+' : ''}${x}</b></div>`).join('') || '<p class="muted small">Nothing yet today.</p>'}</details>` : ''}
    ${days.map(([k, d]) => `<details class="gd-day"><summary><b>${esc(T.format(T.dayStart(k, tz()), tz(), { weekday: 'short', day: 'numeric', month: 'short' }))}</b> <span class="${d.net < 0 ? 'xp-p' : ''}">${d.net >= 0 ? '+' : ''}${d.net} XP</span> <span class="muted small">${Math.round((d.fill || 0) * 100)}% planned</span></summary>${(d.top || []).map(([l, ty, x]) => `<div class="gd-line"><span>${esc(l)}</span><b class="xp-${ty === 'pen' ? 'p' : ty[0]}">${x > 0 ? '+' : ''}${x}</b></div>`).join('')}</details>`).join('')}
    <h3 class="gd-h">How XP works</h3>
    <ul class="small gd-rules"><li><b class="xp-b">Busy</b>: events you attend (12 an hour; ticked off ×1.2), task sessions (15 an hour) you complete (each later session of a task is worth 8% more), finished tasks and projects, a full day (at least half of 7:00–23:00 planned), keeping to the plan, and a weekly bonus for how much of the week was planned.</li>
      <li><b class="xp-l">Why life XP matters</b>: life XP is for what transforms you or moves your life goals forward — learning, training, creating, deep practice. Most weeks leave little room for it, so even short spells are valued highly (half an hour earns well over half of an hour's XP) and it never wears off. Everything else — busy time, leisure, sleep, using the app — counts in full for your first week, then less and less (about a third after a month, down to 15%). After a month, moving up on busy time alone is slow: a higher level means you've grown, not just kept busy.</li>
      <li><b class="xp-l">Life</b>: time in your life-growth categories (set in Settings → General → Game mode) — with a <b>step bonus</b> each time your week's life growth passes another 5 hours (5 h: +25, 10 h: +50, 15 h: +75 …) — sleep, some leisure, habits ticked off (with small rewards for streaks that grow with your rank — a habit can be left out of the game in its settings) and goals reached. Going up levels needs a share of life XP — never more than a quarter.</li>
      <li><b class="xp-a">App</b>: opening Tempo each day (more for a streak), scheduling events and tasks (a fifth of what they're worth — the rest comes when you do them), starting projects, logging habits, achievements.</li>
      <li><b class="xp-p">Penalties</b>: rescheduling a session (moving, deleting, marking undone, or a session pushed later) costs 8 XP — once a day for each task or event, however often it moves that day; more if it slips again on later days within a week.</li>
      <li><b class="xp-p">XP drains</b> (Settings → Game mode): time on activities you want to cut down on costs a share of your XP — more the higher your rank. <b class="xp-c">Clean bonus</b>: a day without any drain earns a share of that day's XP, a week without any earns a share of the week's — growing slowly with each one in a row, up to a cap that rises with your rank. Drains and bonus activities can be set for a while only (the next week, two weeks, month, 3 months or your own dates); bonus activities earn extra XP, and anything that counts as a drain never scores. 🚩 on the calendar marks the days you went up a level.</li></ul>
  </div></div>`, (dlg) => wireRoad(dlg), { cls: 'wide' });
}
// A short burst of fireworks over the page
function fireworks(ms = 2200) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const c = document.createElement('canvas'); c.className = 'fireworks'; document.body.appendChild(c);
  const dpr = devicePixelRatio || 1; c.width = innerWidth * dpr; c.height = innerHeight * dpr;
  const x = c.getContext('2d'); x.scale(dpr, dpr);
  const parts = [], colors = ['#ffd54f', '#ff7043', '#4fc3f7', '#81c784', '#ba68c8', '#f06292', '#fff'];
  const burst = () => { const cx = innerWidth * (0.2 + Math.random() * 0.6), cy = innerHeight * (0.15 + Math.random() * 0.35), col = colors[Math.floor(Math.random() * colors.length)]; for (let i = 0; i < 70; i++) { const a = Math.random() * Math.PI * 2, v = 1.5 + Math.random() * 4.5; parts.push({ x: cx, y: cy, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 60 + Math.random() * 30, col }); } };
  const t0 = performance.now(); let last = 0;
  const step = (t) => {
    if (t - last > 350 && t - t0 < ms - 600) { burst(); last = t; }
    x.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of parts) { p.x += p.vx; p.y += p.vy; p.vy += 0.06; p.vx *= 0.985; p.life--; if (p.life > 0) { x.globalAlpha = Math.min(1, p.life / 40); x.fillStyle = p.col; x.beginPath(); x.arc(p.x, p.y, 2.2, 0, 7); x.fill(); } }
    for (let i = parts.length - 1; i >= 0; i--) if (parts[i].life <= 0) parts.splice(i, 1);
    if (t - t0 < ms || parts.length) requestAnimationFrame(step); else c.remove();
  };
  burst(); requestAnimationFrame(step);
}
