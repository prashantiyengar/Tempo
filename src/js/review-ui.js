// Weekly review (the newspaper) and the Goals view.
import * as T from './tz.js';
import * as E from './engine.js';
import * as D from './dialogs.js';
import * as A from './analysis.js';
import * as C from './categories.js';
import { ext, get as storeGet, set as storeSet } from './storage.js';
import { $, $$, esc, el, toast as uiToast, choose, modal, setHTML } from './ui.js';
import * as RV from './review.js';
import * as NP from './paper.js';
import * as XT from './extras.js';
import * as GL from './goals.js';
import * as SC from './scopes.js';
import * as P from './projects.js';
import * as HB from './habits.js';
import * as GM from './game.js';
import { app, set, st, tz } from './core.js';
import { calColor, closeDrawer, collectItems, render, syncSharedSoon, toast } from './app.js';
import { drainLines, gameLevel, gameOn, gameRefresh, gameTotals } from './game-ui.js';
import { renderHabits } from './habits-ui.js';
import { projectEventDone } from './sidebar.js';
import { editTask, pushUndo, undoStack } from './undo.js';

// ======================================================================================
// Weekly review
// ======================================================================================
export function openReview() {
  storeSet({ lastReviewWeek: T.startOfWeek(T.dayKey(Date.now(), tz()), set().weekStart) });
  app.view = 'review'; app.paperWeek = null; closeDrawer(); render();
}
// The period the review shows (week, two weeks, month, quarter, year), chosen with ‹ ›. By default the current
// one — or, on its first two days, the one that just ended.
export const paperPeriod = () => (NP.PERIODS[set().paperPeriod] ? set().paperPeriod : 'week');
function periodStartOf(k, per) {
  const ws = set().weekStart, { y, m } = T.parseKey(k);
  if (per === 'week') return T.startOfWeek(k, ws);
  if (per === 'fortnight') { const w = T.startOfWeek(k, ws); return Math.floor(T.daysBetween('2024-01-01', w) / 7) % 2 ? T.addDays(w, -7) : w; }
  if (per === 'month') return T.keyOf(y, m, 1);
  if (per === 'quarter') return T.keyOf(y, Math.floor((m - 1) / 3) * 3 + 1, 1);
  return T.keyOf(y, 1, 1);
}
export function periodShift(k, per, n) {
  if (per === 'week') return T.addDays(k, 7 * n);
  if (per === 'fortnight') return T.addDays(k, 14 * n);
  if (per === 'month') return T.addMonths(k, n);
  if (per === 'quarter') return T.addMonths(k, 3 * n);
  return T.addMonths(k, 12 * n);
}
export function paperWeek() {
  const per = paperPeriod();
  if (app.paperWeek && app.paperPer === per) return app.paperWeek;
  const z = tz(), today = T.dayKey(Date.now(), z), cur = periodStartOf(today, per);
  return T.daysBetween(cur, today) <= 1 ? periodShift(cur, per, -1) : cur;
}
export const paperEnd = (k) => periodShift(k, paperPeriod(), 1);
export async function renderPaperView(seq) {
  const s = set(), z = tz(), wk = paperWeek(), end = paperEnd(wk), per = paperPeriod();
  const view = $('#view');
  const fresh = !$('.np-wrap', view); // just arrived on the Review tab: the paper spins into view
  if (fresh) { setHTML(view, '<div class="np-wrap"><p class="muted">Printing…</p></div>'); app.npSpin = true; }
  // a new picture, joke, quote and masthead ornaments for each visit (kept while you stay on the page)
  const visit = app.npVisit ||= { orn: XT.ornaments(), quote: XT.randomQuote(), joke: { text: XT.JOKES[Math.floor(Math.random() * XT.JOKES.length)] }, pic: undefined, horo: {} };
  const days = [];
  for (let k = T.addDays(wk, -7); k < end; k = T.addDays(k, 1)) days.push(k);
  const allItems = await collectItems(days);
  if (seq !== app.renderSeq) return;
  // categories left out of the paper (Settings → Review & goals, or "Categories" above the paper)
  const incl = paperIncluded(s);
  const items = allItems.filter((it) => incl(it.kind === 'chunk' ? it.task?.categoryId : it.catId));
  const from = T.dayStart(wk, z), to = T.dayStart(end, z);
  const events = items.filter((it) => it.kind !== 'chunk');
  const stF = { ...st(), tasks: st().tasks.filter((t) => incl(t.categoryId)), settings: { ...s, history: (s.history || []).filter((h) => incl(h.cat)) } };
  const r = RV.weeklyReview(stF, Date.now(), { weekKey: wk, endKey: end, events });
  // time use over the extended day (day bounds + evenings/weekends), by category
  const actx = { settings: s, gmeta: st().gmeta, calColor };
  const groups = {};
  const occ = items.filter((it) => A.isOccupying(it, s) && it.end > from && it.start < to).map((it) => {
    const g = A.groupOf(it, 'maincat', actx); groups[g.key] ||= g;
    return { start: it.start, end: it.end, group: g.key, prio: it.kind === 'chunk' ? 1 : 0, title: it.title, kind: it.kind, uid: it.key };
  });
  const scope = s.paperScope && (A.SCOPES[s.paperScope] || (s.periods || []).some((p) => 'period:' + p.id === s.paperScope)) ? s.paperScope : 'waking';
  const upTo = Math.min(to, Math.max(from + T.DAY, r.isCurrent ? T.dayStart(T.addDays(T.dayKey(Date.now(), z), 1), z) : to));
  if (scope === 'full' && s.sleepAssume !== false) { const sl = A.assumedSleep(occ, from, upTo, s); if (sl.blocks.length) { const sg = A.sleepGroup(s, 'maincat'); occ.push(...A.sleepItems(sl, sg)); groups[sg.key] ||= sg; } }
  const data = A.compute(occ, A.scopeWindows(scope, from, upTo, s), z);
  let busiest = null;
  for (const [k, d] of Object.entries(data.days)) { const used = d.available - d.free - (d.gaps || 0); if (used > 0 && (!busiest || used > busiest.m)) busiest = { k, m: used }; }
  const use = {
    groups: Object.entries(data.totals.groups).map(([k, m]) => ({ label: groups[k]?.label || k, color: groups[k]?.color || '#888', m })).sort((a, b) => b.m - a.m),
    occupied: data.totals.available - data.totals.free - (data.totals.gaps || 0), free: data.totals.free, available: data.totals.available, busiest,
    scope: `${scope === 'waking' ? `between ${s.overflowBounds.start} and ${s.overflowBounds.end}` : scope === 'full' ? 'around the clock' : scope === 'bounds' ? `within day bounds (${s.bounds.start}–${s.bounds.end})` : scope === 'outside' ? 'outside day bounds' : `in “${(s.periods || []).find((p) => 'period:' + p.id === scope)?.name || 'period'}”`}${r.isCurrent ? ' so far' : ''}`,
  };
  const hsrc = s.horoscopeSource || 'community';
  const tools = `<div class="np-tools">
    <label class="field inline np-per"><span>Period</span><select data-np="period">${Object.entries(NP.PERIODS).map(([k, v]) => `<option value="${k}" ${k === per ? 'selected' : ''}>${v.label}</option>`).join('')}</select></label>
    <label class="field inline np-per"><span>Hours</span><select data-np="scope">${[...Object.entries(A.SCOPES), ...(s.periods || []).map((p) => ['period:' + p.id, p.name])].map(([k, v]) => `<option value="${esc(k)}" ${k === scope ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
    <label class="chk"><input type="checkbox" data-np="all" ${s.reviewAllEvents ? 'checked' : ''}> Include all events <span class="muted small">(not ones repeating daily or 3+ times a week)</span></label>
    <span class="grow"></span><button type="button" class="btn small ghost np-cats" title="Which categories the paper covers">Categories: ${esc(paperCatsLabel(s))}</button><button type="button" class="btn small ghost np-hsrc" title="Where the horoscope text comes from">Horoscope: ${hsrc === 'off' ? 'off' : hsrc === 'apiverve' ? 'APIVerve' : 'online'}</button><button type="button" class="btn small ghost np-hist">Plan vs actual history</button><button type="button" class="btn small ghost np-print">Print</button></div>`;
  const root = $('.np-wrap', view) || view.appendChild(el('<div class="np-wrap"></div>'));
  const scrollY = root.scrollTop;
  const goalsP = await paperGoals(wk, end, per, items);
  if (seq !== app.renderSeq) return;
  const spin = app.npSpin; app.npSpin = false;
  setHTML(root, tools + NP.renderPaper({ r, s, use, signId: s.zodiac || null, period: per, extras: visit, pics: XT.pictureHistory(), goals: goalsP, projects: paperProjects(items, r.from, r.weekEnd), habits: paperHabits(r.from, r.weekEnd), game: paperGame(r.from, r.weekEnd) }));
  NP.layoutPaper(root);
  if (!app.npLayoutWired) {
    app.npLayoutWired = true;
    let tm = 0; const again = () => { clearTimeout(tm); tm = setTimeout(() => { if (app.view === 'review') NP.layoutPaper($('.np-wrap')); }, 150); };
    window.addEventListener('resize', again); window.addEventListener('beforeprint', () => NP.layoutPaper($('.np-wrap'))); window.addEventListener('afterprint', again);
  }
  if (spin && !matchMedia('(prefers-reduced-motion: reduce)').matches) { const np = $('.np', root); np?.classList.add('np-spin'); np?.addEventListener('animationend', () => np.classList.remove('np-spin'), { once: true }); }
  root.scrollTop = scrollY;
  $('[data-np=all]', root).onchange = async (e) => { s.reviewAllEvents = e.target.checked; await E.persist(st(), ['settings']); render(); };
  $('[data-np=scope]', root).onchange = async (e) => { s.paperScope = e.target.value; await E.persist(st(), ['settings']); syncSharedSoon(); render(); };
  $('[data-np=period]', root).onchange = async (e) => { s.paperPeriod = e.target.value; app.paperWeek = null; await E.persist(st(), ['settings']); render(); };
  $('[data-np=sign]', root).onchange = async (e) => { s.zodiac = e.target.value || null; await E.persist(st(), ['settings']); render(); };
  $('.np-hist', root).onclick = () => { app.view = 'analysis'; app.anMode = 'history'; render(); };
  $('.np-print', root).onclick = () => window.print();
  $('.np-hsrc', root).onclick = horoscopeSourceDialog;
  $('.np-cats', root).onclick = paperCatsDialog;
  $$('.rv-open', root).forEach((b) => (b.onclick = () => editTask(st().tasks.find((t) => t.id === b.dataset.task))));
  // picture: fetched once per visit; "Another picture" fetches a new one
  const showPic = () => {
    const box = $('.np-pic', root); if (!box || visit.pic === undefined) return;
    setHTML(box, NP.pictureHTML(visit.pic));
    // if the image itself won't load, try another one (twice at most per visit)
    const img = $('img', box);
    if (img) img.onerror = () => { if ((visit.picFails = (visit.picFails || 0) + 1) <= 2) { visit.picLoad = null; loadPic(); } else setHTML(box, NP.pictureHTML(null)); };
  };
  const loadPic = () => { visit.pic = undefined; const box = $('.np-pic', root); if (box) setHTML(box, '<p class="np-small np-mute">Fetching a picture from the 19th century…</p>'); return (visit.picLoad = XT.fetchPicture({ sources: set().picSources }).then((p) => { visit.pic = p; if (app.npVisit === visit && app.view === 'review') render(); })); };
  if (visit.pic === undefined && !visit.picLoad) loadPic(); else showPic();
  $('.np-pic-new', root).onclick = () => { visit.picLoad = null; loadPic(); };
  $('.np-pic-hist', root)?.addEventListener('click', () => { const d = $('.np-archive', root); if (d) { d.open = true; d.scrollIntoView({ behavior: 'smooth', block: 'start' }); } });
  // joke: an online one when available (once per visit), otherwise from our own list
  const setJoke = (j) => { visit.joke = j; const host = $('.np-joke', root); if (host) { host.textContent = j.text; const src = host.nextElementSibling?.classList.contains('np-small') ? host.nextElementSibling : null; if (src) src.remove(); if (j.link) host.insertAdjacentHTML('afterend', `<p class="np-small np-mute">From <a href="${esc(j.link)}" target="_blank" rel="noopener">${esc(j.source)}</a></p>`); } NP.layoutPaper(root); };
  if (!visit.jokeLoaded) { visit.jokeLoaded = true; XT.getJoke().then((j) => { if (app.npVisit === visit) setJoke(j); }); }
  $('.np-joke-new', root).onclick = () => XT.getJoke().then(setJoke);
  $('.np-quote-new', root).onclick = () => { visit.quote = XT.randomQuote(); const q = $('.np-quote', root); if (q) setHTML(q, `“${esc(visit.quote.text)}”<cite>— ${esc(visit.quote.by)}</cite>`); };
  // horoscope paragraph from an online source (for the sign shown)
  const sign = (NP.SIGNS.find((x) => x[0] === s.zodiac) || NP.signOfDate(T.dayKey(Date.now(), z)))[0];
  const showHoro = (h) => {
    const box = $('.np-horo-live', root); if (!box) return;
    if (hsrc === 'off') return setHTML(box, '');
    setHTML(box, h ? `<p class="np-small np-horo-txt"><b>Today, from the astrologers:</b> ${esc(h.text)}</p><p class="np-small np-mute">Source: <a href="${esc(h.link)}" target="_blank" rel="noopener">${esc(h.source)}</a></p>`
      : `<p class="np-small np-mute">Today's horoscope from the web couldn't be loaded. <button type="button" class="link np-hsrc2">Choose a source</button></p>`);
    $('.np-hsrc2', box)?.addEventListener('click', horoscopeSourceDialog);
  };
  if (hsrc !== 'off') {
    const hk = `${sign}|${hsrc}`;
    if (hk in visit.horo) showHoro(visit.horo[hk]);
    else XT.fetchHoroscope(sign, { apiKey: hsrc === 'apiverve' ? apiverveKey() : '' }).then((h) => { visit.horo[hk] = h; if (app.npVisit === visit) showHoro(h); });
  }
}
// Goal progress for the paper: weekly and monthly (or the months / year for longer periods).
// Habits in the paper: what was kept in the period, against the habit's frequency; score and streak
// Game news for the paper: XP, level-ups, clean streak and drains in [from, to)
function paperGame(from, to) {
  if (!gameOn()) return null;
  const s = set(), g = s.game || {}, z = tz(), today = T.dayKey(Date.now(), z), a = T.dayKey(from, z), b = T.dayKey(to - 1, z);
  const tot = gameTotals(), lv = gameLevel(tot), tier = GM.tierOf(lv.level);
  const lab = (k) => T.fmtDate(T.dayStart(k, z), z);
  let xp = 0, clean = 0, best = null, drain = 0; const what = {};
  const addDrain = (ls) => { const x = ls.reduce((y, l) => y + l[1], 0); xp -= x; drain += x; for (const l of ls) what[l[0].split(':')[0]] = 1; };
  for (let k = a; k <= b && k <= today; k = T.addDays(k, 1)) {
    const d = k === today ? (app.gameToday ? { net: app.gameToday.net } : null) : g.ledger?.[k];
    if (d) {
      const dl = drainLines(k), dr = dl.day.reduce((x, l) => x + l[1], 0);
      const n = d.net - dr; xp += d.net; clean += d.cb || 0; addDrain(dl.day);
      if (!best || n > best.xp) best = { label: lab(k), xp: n };
    }
    const wk = T.startOfWeek(k, s.weekStart ?? 1), w = T.addDays(wk, 6) === k ? g.weeks?.[wk] : null;
    if (w) { xp += (w.b || 0) + (w.cb || 0); clean += w.cb || 0; addDrain(drainLines(k).week); }
    else if (k === today && app.gameDrain) addDrain(drainLines(k).week);
  }
  const ups = Object.entries(app.gameLevelUps || {}).filter(([k]) => k >= a && k <= b && k < today).map(([k, L]) => ({ k, level: L, label: lab(k) }));
  if (today >= a && today <= b && lv.level > GM.levelAt(s, today, z)) ups.push({ k: today, level: lv.level, label: 'today' });
  const newRank = ups.some((u) => GM.tierOf(u.level).from > GM.tierOf(u.level - 1).from) ? tier.name : '';
  const ach = Object.entries(g.ach || {}).filter(([, at]) => at >= from && at < to).map(([id]) => GM.ACHIEVEMENTS.find((x) => x[0] === id)).filter(Boolean).map((x) => `${x[1]} ${x[2]}`);
  return { level: lv.level, rank: tier.name, emblem: GM.emblemSVG(lv.level, 54), total: tot.total, toNext: lv.max ? 0 : Math.max(0, lv.span - lv.into), xp, ups, newRank, clean, cleanOn: GM.hasDrains(s), cleanDays: app.gameClean?.days || 0, cleanWeeks: app.gameClean?.weeks || 0, drain, drainWhat: Object.keys(what).join(', '), ach, best };
}
function paperHabits(from, to) {
  const s = set(), z = tz(), a = T.dayKey(from, z), b = T.dayKey(to - 1, z), end = T.addDays(b, 1), today = T.dayKey(Date.now(), z);
  return HB.list(s).map((h) => {
    const sm = HB.summary(h, s, a, end), stk = HB.streaks(h, s, today);
    const days = T.daysBetween(a, end) <= 31 ? Array.from({ length: T.daysBetween(a, end) }, (_, i) => { const k = T.addDays(a, i); return { k, v: k > today ? null : HB.isNumber(h) ? (HB.isDone(h, k) ? 1 : HB.val(h, k) === -1 ? -1 : HB.val(h, k) > 0 ? 0.5 : 0) : HB.val(h, k) ?? 0 }; }) : [];
    return { name: h.name, color: h.color, number: HB.isNumber(h), unit: h.unit || '', done: HB.fmtNum(sm.done), expected: HB.fmtNum(sm.expected), pct: sm.pct, score: sm.score, change: sm.change, streak: stk.current, streakUnit: stk.unit, days };
  });
}
// Projects in the paper: time in the period, steps finished in it, overall progress and the next step
function paperProjects(items, from, to) {
  const s = set(), now = Date.now(), tm = P.timeByProject(items, s, from, to, now);
  return P.list(s).map((p) => {
    const pr = P.progress(p, st().tasks, now, projectEventDone);
    const fin = P.finishedIn(p, st().tasks, from, Math.min(to, now), now);
    return { name: p.name, pct: pr.pct, steps: `${pr.finished}/${pr.count} steps`, done: tm[p.id]?.done || 0, finished: fin.map((r) => r.st.title), complete: pr.complete, completedNow: pr.complete && fin.length > 0,
      next: pr.next ? { title: pr.next.st.title, at: pr.next.next } : null, late: pr.rows.some((r) => r.late) };
  }).filter((x) => !x.complete || x.completedNow);
}
async function paperGoals(wk, end, per, items) {
  const s = set(), z = tz(), blocks = [];
  { const keys = []; for (let w = T.startOfWeek(wk, s.weekStart ?? 1); w < T.addDays(end, 7); w = T.addDays(w, 7)) keys.push(GL.weekKey(w)); for (let m = T.keyOf(T.parseKey(wk).y, T.parseKey(wk).m, 1); m <= end; m = T.addMonths(m, 1)) keys.push(GL.monthKey(m));
    const g = GL.materialize(s, keys); if (g) { s.goals = g; await E.persist(st(), ['settings']); } }
  const mStart = (k) => T.keyOf(T.parseKey(k).y, T.parseKey(k).m, 1);
  const weekLbl = (k) => `Week of ${T.format(T.dayStart(k, z), z, { day: 'numeric', month: 'short' })}`;
  const monLbl = (k) => T.format(T.dayStart(k, z), z, { month: 'long', year: 'numeric' });
  let months = [];
  if (per === 'week' || per === 'fortnight') {
    for (let w = wk; w < end; w = T.addDays(w, 7)) blocks.push({ label: weekLbl(w), key: GL.weekKey(w), from: w, to: T.addDays(w, 7) });
    months = [mStart(T.addDays(wk, 3))];
  } else {
    if (per === 'month') for (let w = T.startOfWeek(wk, s.weekStart ?? 1); w < end; w = T.addDays(w, 7)) if (GL.list(s, GL.weekKey(w)).length) blocks.push({ label: weekLbl(w), key: GL.weekKey(w), from: w, to: T.addDays(w, 7) });
    for (let m = wk; m < end; m = T.addMonths(m, 1)) months.push(m);
  }
  const monthBlocks = months.map((m) => ({ label: monLbl(m), key: GL.monthKey(m), from: m, to: T.addMonths(m, 1) }));
  const ordered = per === 'week' || per === 'fortnight' ? [...blocks, ...monthBlocks] : [...monthBlocks, ...blocks];
  if (per === 'year' || per === 'quarter') ordered.push({ label: 'The next 12 months', key: GL.YEAR, from: wk, to: end });
  // items for the whole span (months can reach beyond the period shown)
  const a = ordered.reduce((x, b) => (b.from < x ? b.from : x), wk), bEnd = ordered.reduce((x, b) => (b.to > x ? b.to : x), end);
  const all = a < T.addDays(wk, -7) || bEnd > end ? await collectItems([a, T.addDays(bEnd, -1)]) : items;
  const out = ordered.map((b) => ({ label: b.label, prog: GL.progress(s, b.key, all, b.from, b.to) })).filter((b) => b.prog.some((p) => p.goals.length || (p.cats.length && p.spent)));
  return { blocks: out.slice(0, per === 'year' ? 14 : 8), next: GL.forPeriod(s, end, paperEnd(end), per) };
}
// Categories in the newspaper: everything except the ones you leave out (leaving out a main category leaves out
// its sub-categories too). "__none" = events and tasks without a category.
function paperIncluded(s) {
  const ex = new Set(s.paperCats?.exclude || []);
  if (!ex.size) return () => true;
  return (id) => { if (!id) return !ex.has('__none'); if (ex.has(id)) return false; const c = C.catById(s, id); return !(c?.parent && ex.has(c.parent)); };
}
function paperCatsLabel(s) {
  const ex = s.paperCats?.exclude || [];
  if (!ex.length) return 'all';
  const n = (s.categories || []).length + 1;
  return ex.length === 1 ? `all but ${ex[0] === '__none' ? 'uncategorized' : C.catById(s, ex[0])?.name || '1'}` : `${n - ex.length} of ${n}`;
}
async function paperCatsDialog() {
  const s = set(), ex = new Set(s.paperCats?.exclude || []);
  const r = await modal(`<form class="choice"><h2>Categories in the newspaper</h2>
      <p class="muted small">Untick a category to leave its events and tasks out of the paper (time use, what got done, events, books). Unticking a main category leaves out its sub-categories too. Goal progress always counts everything.</p>
      <div class="g-catlist">${C.ordered(s).map((c) => `<label class="chk ${c.parent ? 'sub' : ''}"><input type="checkbox" value="${esc(c.id)}" ${ex.has(c.id) ? '' : 'checked'}> <span class="sw-dot" style="background:${esc(c.color)}"></span> ${esc(C.catLabel(c))}</label>`).join('')}
        <label class="chk"><input type="checkbox" value="__none" ${ex.has('__none') ? '' : 'checked'}> Events and tasks without a category</label></div>
      <div class="actions"><button type="button" class="btn ghost pc-all">All</button><button type="button" class="btn ghost pc-none">None</button><span class="grow"></span><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">Apply</button></div></form>`,
  (dlg, close) => {
    $('.pc-all', dlg).onclick = () => $$('input[type=checkbox]', dlg).forEach((x) => (x.checked = true));
    $('.pc-none', dlg).onclick = () => $$('input[type=checkbox]', dlg).forEach((x) => (x.checked = false));
    $('form', dlg).onsubmit = (e) => { e.preventDefault(); close($$('input[type=checkbox]:not(:checked)', dlg).map((x) => x.value)); };
  }, { cls: 'narrow' });
  if (!r) return;
  set().paperCats = { exclude: r };
  await E.persist(st(), ['settings']); syncSharedSoon(); render();
}
function apiverveKey() { try { return localStorage.getItem('tempo:apiverveKey') || ''; } catch { return ''; } }
const HORO_ORIGINS = { community: 'https://horoscope-app-api.vercel.app/*', apiverve: 'https://api.apiverve.com/*' };
async function horoscopeSourceDialog() {
  const cur = set().horoscopeSource || 'community';
  const r = await modal(`<form class="choice"><h2>Horoscope source</h2>
      <p class="muted small">Besides the playful forecast from your own plan, the paper can print today's horoscope for your sign from the web.</p>
      <label class="chk"><input type="radio" name="src" value="community" ${cur === 'community' ? 'checked' : ''}> Horoscope API (free, no account) — texts from horoscope.com. May not work in the phone app.</label>
      <label class="chk"><input type="radio" name="src" value="apiverve" ${cur === 'apiverve' ? 'checked' : ''}> APIVerve (free account) — paste your API key:</label>
      <input name="key" placeholder="APIVerve API key" value="${esc(apiverveKey())}" autocomplete="off" spellcheck="false" style="width:100%">
      <p class="muted small">Get a free key at apiverve.com. The key stays on this device.</p>
      <label class="chk"><input type="radio" name="src" value="off" ${cur === 'off' ? 'checked' : ''}> Off — just the forecast from my plan</label>
      <div class="actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">Save</button></div></form>`,
  (dlg, close) => {
    const f = $('form', dlg);
    f.key.addEventListener('input', () => { f.querySelector('[value=apiverve]').checked = true; });
    f.onsubmit = async (e) => {
      e.preventDefault();
      const src = f.src.value;
      // the extension needs permission to reach the chosen service (asked here, while you click)
      if (HORO_ORIGINS[src] && ext?.permissions?.request) { try { await ext.permissions.request({ origins: [HORO_ORIGINS[src]] }); } catch { /* the web app has no permissions */ } }
      close({ src, key: f.key.value.trim() });
    };
  }, { cls: 'narrow' });
  if (!r) return;
  set().horoscopeSource = r.src;
  try { if (r.key) localStorage.setItem('tempo:apiverveKey', r.key); else localStorage.removeItem('tempo:apiverveKey'); } catch { /* ignore */ }
  try { localStorage.removeItem('tempo:npHoroscope'); } catch { /* ignore */ }
  if (app.npVisit) app.npVisit.horo = {};
  await E.persist(st(), ['settings']);
  render();
}
async function saveGoals(goals, label) {
  const before = set().goals || {};
  set().goals = GL.prune(goals, T.dayKey(Date.now(), tz()));
  // game mode: goals earn XP for the hours put in — days of the periods that changed are counted again
  if (gameOn() && set().game.ledger) {
    const z = tz(), changed = Object.keys({ ...before, ...set().goals }).filter((k) => JSON.stringify(before[k] || []) !== JSON.stringify(set().goals[k] || []) && !k.startsWith('y'));
    for (const k of changed) { const per = GM.goalPeriod(k, {}, z); for (const d of Object.keys(set().game.ledger)) if (d >= per.from && d < per.to) delete set().game.ledger[d]; }
    if (changed.length) setTimeout(() => gameRefresh(), 300);
  }
  await E.persist(st(), ['settings']);
  syncSharedSoon();
  if (label) pushUndo(label, async () => { set().goals = before; await E.persist(st(), ['settings']); render(); });
  render();
}
export async function renderGoalsView(seq) {
  const s = set(), z = tz(), today = T.dayKey(Date.now(), z), now = Date.now();
  const view = $('#view');
  if (!$('.goals', view)) setHTML(view, '<div class="goals"><p class="muted">Loading…</p></div>');
  const sec = GL.sections(s, today);
  { const g = GL.materialize(s, sec.list.map((x) => x.key)); if (g) { s.goals = g; await E.persist(st(), ['settings']); syncSharedSoon(); } }
  const last = sec.list[sec.list.length - 1].to;
  const wk0 = T.startOfWeek(today, s.weekStart ?? 1);
  const items = await collectItems([T.addDays(wk0, -7), T.addDays(last, -1)]);
  if (seq !== app.renderSeq) return;
  app.goalItems = items;
  const fmtD = (k) => T.format(T.dayStart(k, z), z, { day: 'numeric', month: 'short' });
  const monthName = (k) => T.format(T.dayStart(k, z), z, { month: 'long', year: T.parseKey(k).y !== T.parseKey(today).y ? 'numeric' : undefined });
  const catName = (id) => (id === '__none' ? 'No category' : C.catLabel(C.catById(s, id)) || id);
  const hrs = (m) => T.fmtDur(Math.round(m));
  // unfinished goals from periods that are over (or whose card isn't shown) can be moved forward
  const prevMonth = T.addMonths(sec.thisMonth, -1);
  const firstMonthCard = sec.list.find((x) => x.kind === 'month');
  const leftoverKeys = (x) => {
    if (x.key === GL.weekKey(wk0)) return [GL.weekKey(T.addDays(wk0, -7))];
    if (x === firstMonthCard) return [GL.monthKey(prevMonth), ...(sec.daysLeft <= 14 ? [GL.monthKey(sec.thisMonth)] : [])].filter((k) => k !== x.key);
    return [];
  };
  const card = (x) => {
    const trips = GL.travelIn(items, x.kind === 'year' ? today : x.from, x.to, s);
    const title = x.title || monthName(x.month);
    const sub = x.kind === 'week' ? `${fmtD(x.from)} – ${fmtD(T.addDays(x.to, -1))}` : x.kind === 'year' ? `${monthName(T.addMonths(sec.thisMonth, 1))} – ${monthName(T.addMonths(sec.thisMonth, 12))}` : x.title ? `${monthName(x.month)} · ${sec.daysLeft} days left` : '';
    const all = GL.list(s, x.key), reached = all.filter((g) => g.done).length;
    const prog = GL.progress(s, x.key, items, x.from, x.to, now);
    const left = leftoverKeys(x).flatMap((k) => GL.list(s, k).filter((g) => !g.done).map((g) => ({ g, k })));
    return `<section class="g-card ${x.kind === 'year' ? 'g-year' : ''}" data-key="${esc(x.key)}">
      <header><h3>${esc(title)}</h3><span class="muted small">${esc(sub)}</span>${all.length ? `<span class="g-count" title="Reached">${reached}/${all.length} reached</span>` : ''}</header>
      ${trips.length ? `<ul class="g-trips">${trips.slice(0, x.kind === 'year' ? 12 : 6).map((t, i) => `<li><span>✈ ${esc(t.title)} <span class="muted">· ${esc(GL.fmtTrip(t, s))}</span></span><button type="button" class="link g-trip-add" data-i="${i}" title="Add a goal for this trip">+ goal</button></li>`).join('')}</ul>` : ''}
      ${left.length ? `<div class="g-left"><b>Unfinished from ${esc(GL.keyLabel(s, left[0].k))}${new Set(left.map((l) => l.k)).size > 1 ? ' and before' : ''}</b>
        <ul>${left.map((l) => `<li><span>${GL.HEADS.find(([h]) => h === GL.headOf(l.g))[2]} ${esc(l.g.text)}</span><button type="button" class="link g-carry" data-from="${esc(l.k)}" data-id="${esc(l.g.id)}">→ move here</button></li>`).join('')}</ul>
        ${left.length > 1 ? '<button type="button" class="btn small g-carry-all">Move all here</button>' : ''}</div>` : ''}
      ${prog.map((p) => {
        const bar = p.budget ? `<div class="g-bar" title="${hrs(p.spent)} done${p.planned ? `, ${hrs(p.planned)} planned` : ''} of a ${hrs(p.budget)} budget"><i class="d" style="width:${Math.min(100, (p.spent / p.budget) * 100)}%"></i><i class="p" style="width:${Math.max(0, Math.min(100 - (p.spent / p.budget) * 100, (p.planned / p.budget) * 100))}%"></i></div>` : '';
        const tm = p.cats.length ? `${hrs(p.spent)}${p.planned ? ` + ${hrs(p.planned)} planned` : ''}${p.budget ? ` / ${hrs(p.budget)}` : ''}` : (p.budget ? `budget ${hrs(p.budget)}` : '');
        return `<div class="g-head" data-head="${p.head}">
          <div class="g-hh"><span class="g-hn">${p.icon} ${p.label}</span>${p.goals.length ? `<span class="muted small">${p.reached}/${p.goals.length}</span>` : ''}
            <button type="button" class="link g-cats" data-head="${p.head}" title="Which categories of events and tasks count towards ${p.label.toLowerCase()} goals (all periods)">${p.cats.length ? 'counts: ' + esc(p.cats.map(catName).join(', ')) : 'set categories that count'}</button>
            <span class="g-time">${esc(tm)}</span><button type="button" class="g-plus" data-head="${p.head}" title="Add a ${p.label.toLowerCase()} goal" aria-label="Add a ${p.label.toLowerCase()} goal to ${esc(title)}">+</button></div>
          ${bar}
          <ol class="g-list">${p.goals.map((g, i) => { const pg = p.perGoal.find((q) => q.id === g.id); return `<li class="g-row ${g.done ? 'done' : ''}" data-id="${esc(g.id)}" ${g.ruleState ? `data-auto="${g.ruleState.done ? 1 : 0}"` : ''}>
            <span class="g-rank">${i + 1}</span><input type="checkbox" class="g-done" ${g.done ? 'checked' : ''} aria-label="Reached">
            ${catBox(g.cats, p, false, GL.goalWords(g))}
            <button type="button" class="g-text" title="Edit">${esc(g.text)}${g.budget || pg ? ` <span class="g-bud" title="${pg ? `${hrs(pg.done)} done${pg.planned ? `, ${hrs(pg.planned)} scheduled` : ''} in this period` : ''}">⏱ ${pg ? `${hrs(pg.done)} done${pg.planned ? ` + ${hrs(pg.planned)} scheduled` : ''}${g.budget ? ' / ' : ''}` : ''}${g.budget ? hrs(g.budget) : ''}</span>` : ''}${g.movedFrom ? ' <span class="g-moved" title="Carried over">↪</span>' : ''}${g.repeatId ? ` <span class="g-rep" title="Repeats every ${GL.repeatOf(s, g)?.every || 'period'}">↻</span>` : ''}${gameOn() && !g.done ? (() => { const v = GM.goalValue(g, x.key, s); return ` <span class="g-xp" title="${esc(`Reaching it: +${v.reach} XP${v.progress ? ` (+${v.progress} bit by bit as you put in the ${+v.hours.toFixed(1)} h, +${v.final} when reached)` : ''}${v.ahead ? ' — ×1.5 for planning it ahead' : ''}${g.repeatId ? ' — repeating goals earn a little less' : ''}`)}">🎮 +${v.reach}</span>`; })() : ''}${g.ruleState ? ` <span class="g-rule-b ${g.ruleState.done ? 'ok' : g.ruleState.failed ? 'bad' : ''}" title="Reached automatically: ${esc(GL.ruleText(g.rule))}${g.override != null ? ' (you set it yourself)' : ''}">⚡ ${esc(g.ruleState.text)}</span>` : ''}</button>
            <span class="g-acts"><button type="button" class="icon-btn sm g-up" title="Rank higher" ${i ? '' : 'disabled'}>▲</button><button type="button" class="icon-btn sm g-down" title="Rank lower" ${i < p.goals.length - 1 ? '' : 'disabled'}>▼</button><button type="button" class="icon-btn sm g-mv" title="Move to another period">→</button><button type="button" class="icon-btn sm g-del" title="Remove">✕</button></span></li>`; }).join('')}</ol>

        </div>`;
      }).join('')}
    </section>`;
  };
  const weeks = sec.list.filter((x) => x.kind === 'week'), months = sec.list.filter((x) => x.kind === 'month'), year = sec.list.find((x) => x.kind === 'year');
  const root = $('.goals', view) || view.appendChild(el('<div class="goals"></div>'));
  const y0 = root.scrollTop;
  setHTML(root, `<p class="muted small g-intro">Goals under Work, Fitness and Personal: add one with <b>+</b> (optionally repeating every week or month). Rank them with ▲▼ (1 = most important), give them an optional time budget, and tick them off when reached. Time in the categories that count for each head (set once, used for every week, month and year) shows as progress. → moves a goal to another period. Trips on your calendar are listed as reminders.</p>
    <h2 class="g-h">Habits</h2><section class="g-habits"><div class="hb-host"></div></section>
    <h2 class="g-h">Weeks</h2><div class="g-grid">${weeks.map(card).join('')}</div>
    <h2 class="g-h">Months <span class="g-mtoggle"><button type="button" data-m="3" class="${s.goalsMonths === 12 ? '' : 'on'}">Next 3</button><button type="button" data-m="12" class="${s.goalsMonths === 12 ? 'on' : ''}">Next 12</button></span></h2>
    ${sec.daysLeft <= 14 ? `<p class="muted small">${esc(monthName(sec.thisMonth))} has ${sec.daysLeft} day${sec.daysLeft === 1 ? '' : 's'} left — this week's and next week's goals cover it.</p>` : ''}
    <div class="g-grid">${months.map(card).join('')}</div>
    <h2 class="g-h">The year ahead</h2><div class="g-grid">${card(year)}</div>`);
  root.scrollTop = y0;
  renderHabits($('.g-habits .hb-host', root), { days: 7 });
  $$('.g-mtoggle button', root).forEach((b) => (b.onclick = async () => { s.goalsMonths = +b.dataset.m; await E.persist(st(), ['settings']); render(); }));
  const targets = (exceptKey) => sec.list.filter((q) => q.key !== exceptKey).map((q) => ({ value: q.key, label: q.title || monthName(q.month), desc: q.kind === 'week' ? `${fmtD(q.from)} – ${fmtD(T.addDays(q.to, -1))}` : '' }));
  $$('.g-card', root).forEach((c) => {
    const key = c.dataset.key, x = sec.list.find((q) => q.key === key);
    const trips = GL.travelIn(items, x.kind === 'year' ? today : x.from, x.to, s);
    $$('.g-plus', c).forEach((b) => (b.onclick = () => addGoalDialog(key, b.dataset.head, x)));
    $$('.g-trip-add', c).forEach((b) => (b.onclick = () => { const t = trips[+b.dataset.i]; saveGoals(GL.add(set(), key, `Prepare for ${t.title} (${GL.fmtTrip(t, s)})`, { head: 'personal' }), 'add goal'); }));
    $$('.g-carry', c).forEach((b) => (b.onclick = () => saveGoals(GL.moveTo(set(), b.dataset.from, b.dataset.id, key), 'move goal')));
    $('.g-carry-all', c)?.addEventListener('click', () => { let gs = set().goals || {}; for (const b of $$('.g-carry', c)) gs = GL.moveTo({ ...set(), goals: gs }, b.dataset.from, b.dataset.id, key); saveGoals(gs, 'move goals'); });
    $$('.g-cats', c).forEach((b) => (b.onclick = () => editHeadCats(b.dataset.head)));
    $$('.g-row', c).forEach((r) => {
      const id = r.dataset.id;
      $('.g-done', r).onchange = (e) => {
        const ch = e.target.checked, auto = r.dataset.auto;
        // a goal with a rule: ticking it yourself overrides the rule; matching the rule again hands it back
        const extra = auto != null ? { override: (auto === '1') === ch ? null : ch } : {};
        saveGoals(GL.update(set(), key, id, { done: ch, doneAt: ch ? Date.now() : null, ...extra }), ch ? 'goal reached' : 'goal reopened');
      };
      $('.g-up', r).onclick = () => saveGoals(GL.move(set(), key, id, -1));
      $('.g-down', r).onclick = () => saveGoals(GL.move(set(), key, id, 1));
      $('.g-del', r).onclick = async () => {
        const g = GL.list(set(), key).find((q) => q.id === id);
        if (g?.repeatId && GL.repeatOf(set(), g)) {
          const rp = GL.repeatOf(set(), g);
          const v = await choose('Remove a repeating goal', `“${g.text}” repeats every ${rp.every}.`, [
            { value: 'one', label: `Only this ${rp.every}`, desc: 'It comes back next time.' },
            { value: 'stop', label: 'Stop repeating', desc: `Removes it from this and later ${rp.every}s (reached ones stay).`, danger: true },
          ]);
          if (!v) return;
          const before = set().goalRepeats;
          const res = GL.removeRepeating(set(), key, id, v === 'stop');
          set().goalRepeats = res.goalRepeats;
          await saveGoals(res.goals, v === 'stop' ? 'stop repeating goal' : 'remove goal');
          const u = undoStack[undoStack.length - 1]; if (u) { const f0 = u.undo; u.undo = async () => { set().goalRepeats = before; await f0(); }; }
          return;
        }
        saveGoals(GL.remove(set(), key, id), 'remove goal'); toast('Goal removed');
      };
      $('.g-mv', r).onclick = async () => { const to = await choose('Move this goal to…', GL.list(set(), key).find((g) => g.id === id)?.text, targets(key)); if (to) { saveGoals(GL.moveTo(set(), key, id, to), 'move goal'); toast(`Moved to ${GL.keyLabel(set(), to)}`); } };
      $('.g-text', r).onclick = () => editGoal(key, id);
      $('.g-catbox', r).onclick = async () => {
        const g = GL.list(set(), key).find((q) => q.id === id);
        const res = await pickGoalCats(g.cats || [], GL.HEADS.find(([h]) => h === GL.headOf(g)));
        if (res != null) saveGoals(GL.update(set(), key, id, { cats: res.length ? res : null }), 'goal categories');
      };
    });
  });

}
// "+" on a head: add a goal (text, head, time budget, categories, and optionally repeat it every week / month).
async function addGoalDialog(key, head0, x) {
  const s = set();
  const every = x.kind === 'week' ? 'week' : x.kind === 'month' ? 'month' : null;
  let cats = [];
  const r = await modal(`<form class="choice g-addform" novalidate><h2>New goal</h2>
      <label class="field"><span>Goal</span><input name="t" maxlength="200" autocomplete="off" placeholder="e.g. Call friends" autofocus></label>
      <div class="row">
        <label class="field grow"><span>Under</span><select name="h">${GL.HEADS.map(([h, l, ic]) => `<option value="${h}" ${h === head0 ? 'selected' : ''}>${ic} ${l}</option>`).join('')}</select></label>
        <label class="field"><span>Time budget (h)</span><input name="b" type="number" min="0" step="0.25" placeholder="none" style="width:110px"></label>
      </div>
      <div class="field"><span>Counts towards it</span><div class="row"><span class="g-addbox"></span><span class="muted small g-addbox-note">the head's categories</span></div></div>
      ${wordsFieldHTML([], 'either')}
      ${goalRuleHTML(null, every || 'year')}
      ${gameOn() ? '<p class="small g-xp-prev"></p>' : ''}
      ${every ? `<label class="chk"><input type="checkbox" name="rep"> Repeat every ${every}</label>` : ''}
      <div class="actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">Add goal</button></div></form>`,
  (dlg, close) => {
    const f = $('form', dlg);
    const drawBox = () => {
      const hd = GL.HEADS.find(([h]) => h === f.h.value);
      setHTML($('.g-addbox', dlg), catBox(cats, { label: hd[1], cats: GL.headCats(s, hd[0]) }, true));
      $('.g-addbox-note', dlg).textContent = cats.length ? cats.map((id) => C.fullLabel(s, C.catById(s, id))).join(', ') : `the ${hd[1]} categories`;
      $('.g-addbox .g-catbox', dlg).onclick = async () => { const res = await pickGoalCats(cats, hd); if (res != null) { cats = res; drawBox(); } };
    };
    const drawBox0 = drawBox;
    const drawAll = () => { drawBox0(); syncWordsField(dlg, cats.length); if (GL.parseWords(f.w.value).length && !cats.length) $('.g-addbox-note', dlg).textContent = 'only the text below'; };
    f.h.onchange = drawAll; f.w.oninput = drawAll; drawAll();
    $('.g-addbox', dlg).addEventListener('click', () => setTimeout(drawAll, 50), true);
    f.onsubmit = (e) => { e.preventDefault(); const t = f.t.value.trim(); if (!t) { f.t.focus(); return; } const b = parseFloat(f.b.value); close({ text: t, head: f.h.value, budget: b > 0 ? b * 60 : null, cats, words: GL.parseWords(f.w.value), wmode: f.wm?.value || 'either', rule: readGoalRule(dlg), rep: !!f.rep?.checked }); };
    D.wireSects(dlg, { 'g-rule': () => { const r = readGoalRule(dlg); return r ? `⚡ ${GL.ruleText(r)}` : 'Off'; } });
    wireGoalRule(dlg); wireGoalXP(dlg, key);
  }, { cls: 'narrow' });
  if (!r) return;
  if (r.rep && every) {
    const before = set().goalRepeats;
    set().goalRepeats = GL.addRepeat(set(), every, key, r).map((x, i, a) => (i === a.length - 1 && r.rule ? { ...x, rule: r.rule } : x));
    const g = GL.materialize(set(), [key]);
    await saveGoals(g || set().goals, 'add repeating goal');
    const u = undoStack[undoStack.length - 1]; if (u) { const f0 = u.undo; u.undo = async () => { set().goalRepeats = before; await f0(); }; }
    toast(`Added — repeats every ${every}`);
  } else {
    const gs = GL.add(set(), key, r.text, { head: r.head, budget: r.budget, cats: r.cats, words: r.words, wmode: r.wmode });
    if (r.rule) { const l = gs[key]; l[l.length - 1] = { ...l[l.length - 1], rule: r.rule }; }
    saveGoals(gs, 'add goal');
  }
}

// The icon box next to a goal: its own categories' icons, or a faint tag when it uses the head's categories.
function catBoxInner(cats, head) {
  const s = set();
  const list = (cats || []).map((id) => C.catById(s, id)).filter(Boolean);
  if (!list.length) return '<span class="g-cb-none">🏷</span>';
  return list.slice(0, 3).map((c) => `<span class="g-cb-ic" style="--c:${esc(c.color)}">${esc(c.icon || C.parentOf(s, c)?.icon || c.name.slice(0, 1))}</span>`).join('') + (list.length > 3 ? `<span class="g-cb-more">+${list.length - 3}</span>` : '');
}
// "Advanced: complete automatically" block of the goal dialogs (a rule on hours in categories).
function goalRuleHTML(r, every) {
  const s = set();
  return D.sect('g-rule', 'Advanced: complete automatically', `
    <label class="field"><span>Kind of rule</span><select name="rkind"><option value="hours" ${r?.kind !== 'timing' ? 'selected' : ''}>Hours spent in categories</option><option value="timing" ${r?.kind === 'timing' ? 'selected' : ''}>Something starts by / ends before a time</option></select></label>
    <div class="g-rule-timing">
      <div class="row"><label class="field"><span>Reached when it</span><select name="rwhich"><option value="">— off —</option><option value="endBy" ${r?.kind === 'timing' && r.which === 'endBy' ? 'selected' : ''}>ends before</option><option value="startBy" ${r?.kind === 'timing' && r.which === 'startBy' ? 'selected' : ''}>starts by</option></select></label>
        <label class="field"><span>Time</span><input type="time" name="rtime" value="${esc(r?.time || '07:00')}" step="300"></label>
        <label class="field"><span>On</span><select name="rdays"><option value="">every day</option>${[1, 2, 3, 4, 5, 6, 10, 15, 20].map((n) => `<option value="${n}" ${+r?.days === n ? 'selected' : ''}>at least ${n} day${n > 1 ? 's' : ''}</option>`).join('')}</select></label></div>
      <label class="field"><span>What counts: titles with these words <em class="muted">(and/or the categories below)</em></span><input name="rwords" value="${esc(r?.kind === 'timing' ? (r.words || []).join(', ') : '')}" placeholder="e.g. sleep — or: essay, report" autocomplete="off"></label>
    </div>
    <div class="row g-rule-hours"><label class="field"><span>Mark it reached when I spend</span><select name="rop"><option value="">— off —</option><option value="atLeast" ${r?.op === 'atLeast' ? 'selected' : ''}>at least</option><option value="atMost" ${r?.op === 'atMost' ? 'selected' : ''}>at most</option></select></label>
      <label class="field"><span>Hours</span><input type="number" name="rh" min="0" step="0.25" value="${r?.hours ?? 5}" class="num"></label>
      <label class="field"><span>Counted</span><select name="rper"><option value="period" ${!r?.per || r.per === 'period' ? 'selected' : ''}>in the whole ${every || 'period'}</option><option value="day" ${r?.per === 'day' ? 'selected' : ''}>every day</option>${every !== 'week' ? `<option value="week" ${r?.per === 'week' ? 'selected' : ''}>every week</option>` : ''}</select></label></div>
    <div class="field"><span>…in these categories <em class="muted">(none ticked = the goal's categories)</em></span><div class="g-catlist g-rcats">${C.ordered(s).map((c) => `<label class="chk ${c.parent ? 'sub' : ''}"><input type="checkbox" name="rcat" value="${esc(c.id)}" ${(r?.cats || []).includes(c.id) ? 'checked' : ''}> ${esc(C.catLabel(c))}</label>`).join('')}</div></div>
    <label class="field"><span>Only count what happens during <em class="muted">(e.g. reading “after hours”)</em></span><select name="rscope">${SC.scopeOptions(s).map(([v, l]) => `<option value="${esc(v)}" ${(r?.scope || '') === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
    <p class="muted small" style="margin:0">Only time that has passed counts. Times of day: “ends before 07:00” with <i>sleep</i> is kept on a day when your sleep ended by 7 (not when you were still asleep at 7); “starts by 09:00” when something that counts started by 9. “At least” is reached as soon as you get there; “at most” is reached when the period ends without going over (and shows as missed as soon as you do). Ticking or unticking the goal yourself overrides it.</p>`, { open: !!r });
}
// Live "what will this goal be worth" line in the goal dialogs (game mode)
function wireGoalXP(dlg, key, base = {}) {
  const box = $('.g-xp-prev', dlg); if (!box) return;
  const f = $('form', dlg);
  const upd = () => {
    const b = parseFloat(f.b?.value);
    const g = { ...base, at: base.at || Date.now(), budget: b > 0 ? b * 60 : null, rule: readGoalRule(dlg), repeatId: base.repeatId || (f.rep?.checked ? 'r' : null) };
    const v = GM.goalValue(g, key, set());
    setHTML(box, `🎮 Defining it: <b class="xp-a">+${v.define}</b> · reaching it: <b class="xp-l">+${v.reach}</b>${v.progress ? ` <span class="muted">(half bit by bit over ${+v.hours.toFixed(1)} h)</span>` : ''}${v.ahead ? ' <span class="muted">×1.5 — planned ahead</span>' : ''}<br><span class="muted">More hours, and planning ahead (not repeating), earn more.</span>`);
  };
  f.addEventListener('input', upd); f.addEventListener('change', upd); upd();
}
const readGoalRule = (dlg) => {
  const f = $('form', dlg), cats = $$('input[name=rcat]:checked', dlg).map((x) => x.value);
  const scope = f.rscope?.value ? { scope: f.rscope.value } : {};
  if (f.rkind?.value === 'timing') return f.rwhich.value ? { kind: 'timing', which: f.rwhich.value, time: f.rtime.value || '07:00', days: f.rdays.value ? +f.rdays.value : null, words: f.rwords.value.split(/[,;\n]/).map((w) => w.trim()).filter(Boolean), cats, ...scope } : null;
  return f.rop?.value ? { op: f.rop.value, hours: Math.max(0, +f.rh.value || 0), per: f.rper.value, cats, ...scope } : null;
};
// show the fields of the chosen kind of rule
function wireGoalRule(dlg) {
  const f = $('form', dlg); if (!f.rkind) return;
  const sync = () => { const t = f.rkind.value === 'timing'; $('.g-rule-timing', dlg).style.display = t ? '' : 'none'; $('.g-rule-hours', dlg).style.display = t ? 'none' : ''; };
  f.rkind.addEventListener('change', sync); sync();
}
// The "look for this text" field of the goal dialogs.
function wordsFieldHTML(words, mode) {
  return `<label class="field"><span>…and/or text in event and task titles</span><input name="w" value="${esc((words || []).join(', '))}" placeholder="e.g. Moby Dick (several: separate with commas)" autocomplete="off"></label>
    <label class="field g-wm"><span>When both are set, count</span><select name="wm"><option value="either">Either: the categories or the text</option><option value="both" ${mode === 'both' ? 'selected' : ''}>Both: only that text within those categories</option></select></label>`;
}
function syncWordsField(dlg, nCats) { const f = $('form', dlg); const wm = $('.g-wm', dlg); if (wm) wm.style.display = nCats && GL.parseWords(f.w.value).length ? '' : 'none'; }
function catBox(cats, p, add = false, words = []) {
  const s = set(), names = (cats || []).map((id) => C.fullLabel(s, C.catById(s, id))).filter(Boolean);
  if (words?.length) return `<button type="button" class="g-catbox set" title="${esc(`Counts ${names.length ? names.join(', ') + ' and/or ' : ''}titles containing “${words.join('”, “')}” — click to change categories`)}" aria-label="What counts for this goal">${names.length ? catBoxInner(cats, p) : ''}<span class="g-cb-ic g-cb-txt">🔎</span></button>`;
  const title = names.length ? `Counts: ${names.join(', ')} — click to change` : `Counts the ${p.label} categories${p.cats.length ? ` (${p.cats.map((id) => C.catLabel(C.catById(s, id)) || 'No category').join(', ')})` : ''} — click to pick categories for this goal`;
  return `<button type="button" class="g-catbox ${names.length ? 'set' : ''}" title="${esc(title)}" aria-label="${add ? 'Categories for the new goal' : 'Categories for this goal'}">${catBoxInner(cats, p)}</button>`;
}
// Popup: which categories count for one goal. Returns the chosen ids ([] = use the head's), or null if cancelled.
async function pickGoalCats(current, head) {
  const s = set(), [hid, label, icon] = head, hc = GL.headCats(s, hid), cur = new Set(current || []);
  return modal(`<form class="choice"><h2>Categories for this goal</h2>
      <p class="muted small">Time in events and task sessions of these categories counts towards the goal. Picking a main category includes its sub-categories.</p>
      <div class="g-pick">${C.treeChipsHTML(s, (c) => `<button type="button" class="cat-chip ${c.parent ? 'sub' : ''} ${cur.has(c.id) ? 'on' : ''}" data-cat="${esc(c.id)}" style="--c:${esc(c.color)}" title="${esc(C.fullLabel(s, c))}"><i></i>${c.parent ? '<span class="cat-sub">↳</span>' : ''}${c.icon ? `<span class="cat-ic">${esc(c.icon)}</span>` : ''}${esc(c.name)}</button>`)}</div>
      <p class="muted small">None picked = use the ${icon} ${esc(label)} categories${hc.length ? ` (${esc(hc.map((id) => C.catLabel(C.catById(s, id)) || 'No category').join(', '))})` : ' (none set yet)'}.</p>
      <div class="actions"><button type="button" class="btn ghost g-pick-clear">Use ${esc(label)}'s</button><span class="grow"></span><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">Apply</button></div></form>`,
  (dlg, close) => {
    $$('.g-pick .cat-chip', dlg).forEach((b) => (b.onclick = () => b.classList.toggle('on')));
    $('.g-pick-clear', dlg).onclick = () => close([]);
    $('form', dlg).onsubmit = (e) => { e.preventDefault(); close($$('.g-pick .cat-chip.on', dlg).map((b) => b.dataset.cat)); };
  }, { cls: 'narrow' }).then((r) => (r === undefined ? null : r));
}

// Categories that count towards a head (one setting for every week, month and year).
async function editHeadCats(head) {
  const s = set(), [, label, icon] = GL.HEADS.find(([h]) => h === head), cur = new Set(GL.headCats(s, head));
  const r = await modal(`<form class="choice"><h2>${icon} What counts as ${esc(label.toLowerCase())}?</h2>
      <p class="muted small">Time in events and task sessions of these categories shows as progress on your ${esc(label.toLowerCase())} goals — in every week, month and the year.</p>
      <div class="g-catlist">${C.ordered(s).map((c) => `<label class="chk ${c.parent ? 'sub' : ''}"><input type="checkbox" value="${esc(c.id)}" ${cur.has(c.id) ? 'checked' : ''}> <span class="sw-dot" style="background:${esc(c.color)}"></span> ${esc(C.catLabel(c))}</label>`).join('')}
        <label class="chk"><input type="checkbox" value="__none" ${cur.has('__none') ? 'checked' : ''}> Events and tasks without a category</label></div>
      <div class="actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">Save</button></div></form>`,
  (dlg, close) => { $('form', dlg).onsubmit = (e) => { e.preventDefault(); close($$('input[type=checkbox]:checked', dlg).map((x) => x.value)); }; }, { cls: 'narrow' });
  if (!r) return;
  const before = s.goalHeads;
  s.goalHeads = GL.withHeadCats(s, head, r);
  await E.persist(st(), ['settings']); syncSharedSoon();
  pushUndo(`categories for ${label}`, async () => { set().goalHeads = before; await E.persist(st(), ['settings']); render(); });
  render();
}
export async function editGoal(key, id) {
  const s = set(), g = GL.list(s, key).find((q) => q.id === id); if (!g) return;
  const own = new Set(g.cats || []);
  const r = await modal(`<form class="choice"><h2>Goal</h2>
      <label class="field"><span>Goal</span><input name="t" value="${esc(g.text)}" maxlength="200" autofocus></label>
      <div class="row">
        <label class="field grow"><span>Head</span><select name="h">${GL.HEADS.map(([h, l, ic]) => `<option value="${h}" ${GL.headOf(g) === h ? 'selected' : ''}>${ic} ${l}</option>`).join('')}</select></label>
        <label class="field"><span>Time budget (h)</span><input name="b" type="number" min="0" step="0.25" value="${g.budget ? +(g.budget / 60).toFixed(2) : ''}" placeholder="none" style="width:110px"></label>
      </div>
      <details ${own.size ? 'open' : ''}><summary class="small">Count only these categories for this goal (otherwise the head's)</summary>
        <div class="g-catlist">${C.ordered(s).map((c) => `<label class="chk ${c.parent ? 'sub' : ''}"><input type="checkbox" name="c" value="${esc(c.id)}" ${own.has(c.id) ? 'checked' : ''}> ${esc(C.catLabel(c))}</label>`).join('')}</div></details>
      ${wordsFieldHTML(GL.goalWords(g), g.wmode)}
      ${goalRuleHTML(g.rule, key.startsWith('w:') ? 'week' : key.startsWith('m:') ? 'month' : 'year')}
      ${gameOn() ? '<p class="small g-xp-prev"></p>' : ''}
      ${(() => { const every = key.startsWith('w:') ? 'week' : key.startsWith('m:') ? 'month' : null; return every ? `<label class="chk"><input type="checkbox" name="rep" ${GL.repeatOf(s, g) ? 'checked' : ''}> Repeat every ${every}</label>` : ''; })()}
      <label class="chk"><input type="checkbox" name="d" ${g.done ? 'checked' : ''}> Reached</label>
      <div class="actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">Save</button></div></form>`,
  (dlg, close) => {
    const f = $('form', dlg);
    const upd = () => syncWordsField(dlg, $$('input[name=c]:checked', dlg).length); f.addEventListener('input', upd); f.addEventListener('change', upd); upd();
    f.onsubmit = (e) => { e.preventDefault(); const b = parseFloat(f.b.value); close({ text: f.t.value.trim() || g.text, head: f.h.value, budget: b > 0 ? Math.round(b * 60) : null, cats: $$('input[name=c]:checked', dlg).map((x) => x.value), words: GL.parseWords(f.w.value), wmode: f.wm.value, rule: readGoalRule(dlg), done: f.d.checked, rep: f.rep ? f.rep.checked : null }); };
    D.wireSects(dlg, { 'g-rule': () => { const r = readGoalRule(dlg); return r ? `⚡ ${GL.ruleText(r)}` : 'Off'; } });
    wireGoalRule(dlg); wireGoalXP(dlg, key, g);
  });
  if (!r) return;
  // repeat on / off (the copies already made stay)
  const rp = GL.repeatOf(set(), g);
  if (r.rep === false && rp) set().goalRepeats = GL.repeats(set()).filter((x) => x.id !== rp.id);
  if (r.rep === true && !rp) {
    const reps = GL.addRepeat(set(), key.startsWith('w:') ? 'week' : 'month', key, { text: r.text, head: r.head, budget: r.budget, cats: r.cats, words: r.words, wmode: r.wmode });
    set().goalRepeats = reps; r.repeatId = reps[reps.length - 1].id;
  }
  if (r.rep === true && rp) set().goalRepeats = GL.repeats(set()).map((x) => (x.id === rp.id ? { ...x, text: r.text.slice(0, 200), head: r.head, budget: r.budget || undefined, cats: r.cats.length ? r.cats : undefined, words: r.words.length ? r.words : undefined, wmode: r.words.length && r.cats.length && r.wmode === 'both' ? 'both' : undefined } : x));
  saveGoals(GL.update(set(), key, id, { text: r.text.slice(0, 200), head: r.head, budget: r.budget, cats: r.cats.length ? r.cats : null, words: r.words.length ? r.words : null, wmode: r.words.length && r.cats.length && r.wmode === 'both' ? 'both' : null, rule: r.rule, ...(r.rule ? (r.done !== !!g.done ? { override: r.done } : {}) : { override: null }), done: r.done, ...(r.repeatId ? { repeatId: r.repeatId } : r.rep === false ? { repeatId: null } : {}) }), 'edit goal');
}

// On the first day of the week, offer the review once.
// On the first day of a new week or month (from 9:00, or whenever the app is opened later that day — or in the
// first days if it wasn't opened), show this week's and this month's goals once. Snooze hides it for N hours.
let goalNoticeOpen = false;
export async function checkGoalNotice() {
  const s = set(), z = tz();
  if (s.goalNotice === false || goalNoticeOpen || document.querySelector('dialog[open]')) return;
  const now = Date.now(), today = T.dayKey(now, z), wk = T.startOfWeek(today, s.weekStart ?? 1);
  const { y, m } = T.parseKey(today), mStart = T.keyOf(y, m, 1);
  const at = s.goalNoticeAt || '09:00';
  const due = (start, graceDays) => { const d = T.daysBetween(start, today); return d > 0 ? d <= graceDays : now >= T.atTime(start, at, z); };
  const shown = s.goalNoticeShown || {};
  const keys = [];
  if (due(wk, 2) && !shown[GL.weekKey(wk)]) keys.push(GL.weekKey(wk));
  if (due(mStart, 3) && !shown[GL.monthKey(mStart)]) keys.push(GL.monthKey(mStart));
  if (!keys.length) return;
  let snooze = 0; try { snooze = +localStorage.getItem('tempo:goalSnooze') || 0; } catch { /* ignore */ }
  if (snooze > now) return;
  goalNoticeOpen = true;
  try {
    { const g = GL.materialize(s, [GL.weekKey(wk), GL.monthKey(mStart)]); if (g) { s.goals = g; await E.persist(st(), ['settings']); } }
    const isWeek = keys.some((k) => k.startsWith('w:')), isMonth = keys.some((k) => k.startsWith('m:'));
    const show = [GL.weekKey(wk), GL.monthKey(mStart)];
    const block = (k) => {
      const l = GL.list(s, k);
      const head = k.startsWith('w:') ? `This week · ${T.format(T.dayStart(wk, z), z, { day: 'numeric', month: 'short' })} – ${T.format(T.dayStart(T.addDays(wk, 6), z), z, { day: 'numeric', month: 'short' })}` : T.format(T.dayStart(mStart, z), z, { month: 'long', year: 'numeric' });
      if (!l.length) return `<h3 class="gn-h">${esc(head)}</h3><p class="muted small">No goals set yet.</p>`;
      return `<h3 class="gn-h">${esc(head)}</h3>${GL.HEADS.map(([h, label, icon]) => { const gs = l.filter((g) => GL.headOf(g) === h); return gs.length ? `<div class="gn-head"><b>${icon} ${label}</b><ol>${gs.map((g) => `<li class="${g.done ? 'done' : ''}">${esc(g.text)}${g.budget ? ` <span class="muted small">⏱ ${T.fmtDur(g.budget)}</span>` : ''}</li>`).join('')}</ol></div>` : ''; }).join('')}`;
    };
    let lastH = 2; try { lastH = +localStorage.getItem('tempo:goalSnoozeH') || 2; } catch { /* ignore */ }
    const r = await modal(`<div class="choice goal-notice"><h2>${isWeek && isMonth ? 'A new week and a new month' : isMonth ? 'A new month' : 'A new week'} — your goals</h2>
        <div class="gn-body">${show.map(block).join('')}</div>
        <div class="actions gn-actions"><button type="button" class="btn ghost gn-open">Open Goals</button><span class="grow"></span>
          <span class="gn-snooze">Snooze for <input type="number" class="gn-h-in" min="0.25" max="72" step="0.25" value="${lastH}" aria-label="Hours"> h <button type="button" class="btn gn-snz">Snooze</button></span>
          <button type="button" class="btn primary gn-ok">Got it</button></div></div>`, (dlg, close) => {
      $('.gn-open', dlg).onclick = () => close('open');
      $('.gn-ok', dlg).onclick = () => close('ok');
      $('.gn-snz', dlg).onclick = () => close({ snooze: Math.max(0.25, Math.min(72, +$('.gn-h-in', dlg).value || 2)) });
    }, { cls: 'narrow' });
    if (r && r.snooze) {
      try { localStorage.setItem('tempo:goalSnooze', String(Date.now() + r.snooze * T.HOUR)); localStorage.setItem('tempo:goalSnoozeH', String(r.snooze)); } catch { /* ignore */ }
      toast(`Goal reminder snoozed for ${T.fmtDur(Math.round(r.snooze * 60))}`, { noUndo: true });
      return;
    }
    // shown (dismissed or closed): don't show again for these periods, on any device
    const next = { ...(set().goalNoticeShown || {}) };
    for (const k of keys) next[k] = Date.now();
    set().goalNoticeShown = Object.fromEntries(Object.entries(next).sort((a, b) => b[1] - a[1]).slice(0, 12));
    await E.persist(st(), ['settings']); syncSharedSoon();
    if (r === 'open') { app.view = 'goals'; render(); }
  } finally { goalNoticeOpen = false; }
}

export async function maybeOfferReview() {
  const z = tz(), wk = T.startOfWeek(T.dayKey(Date.now(), z), set().weekStart);
  const { lastReviewWeek } = await storeGet('lastReviewWeek');
  if (lastReviewWeek === wk || T.daysBetween(wk, T.dayKey(Date.now(), z)) > 1 || !st().tasks.length) return;
  storeSet({ lastReviewWeek: wk });
  setTimeout(() => uiToast('Your weekly review is ready — what got done, what slipped, what’s at risk.', { action: 'Open', onAction: openReview, ms: 12000 }), 2500);
}
