// Tempo Calendar — main UI: views, drag interactions, sidebar, sync loop.
import * as T from './tz.js';
import * as S from './scheduler.js';
import * as E from './engine.js';
import * as EV from './events.js';
import * as G from './gcal.js';
import * as D from './dialogs.js';
import * as X from './export.js';
import * as C from './categories.js';
import * as AC from './accounts.js';
import { ext, isWeb, get as storeGet, set as storeSet } from './storage.js';
import { $, $$, esc, el, toast as uiToast, closePopover, download, modal, setQuickTz } from './ui.js';
import * as W from './weather.js';
import * as GM from './game.js';
import { LOCAL_COLOR, app, set, st, tz } from './core.js';
import { currentToNow, extendToNow, lastEventEnd, nextEventStart, toNowItem, wireToNow } from './actions.js';
import { renderAnalysisView } from './analysis-ui.js';
import { setupApi, setupQuickAdd } from './assistant.js';
import { autoBlocks, scheduleAutoBlocks } from './autoblocks.js';
import { exportCustom, exportMulti, exportView } from './export-ui.js';
import { gameActive, gameDayChip, gameRefresh, levelFlag, renderGamePanel, xpBreakdown } from './game-ui.js';
import { autoHabits } from './habits-ui.js';
import { handleError, handleMoves, handleProblems, offlineStatus, openSyncPanel, renderBanner, setStatus } from './status.js';
import { askScope, msAt, onAllDayPointerDown, onGridPointerDown, onMonthPointerDown } from './interactions.js';
import { afterLeave, hoursChanged, leaveMenu, leaveTag } from './leave.js';
import { computeDayFill, dayMarks, wireDayMarks } from './notes.js';
import { adoptPeriodsFromTasks, afterEventChange, attachTitleSuggest, refreshTitleList, saveNewEvent } from './popovers.js';
import { checkGoalNotice, maybeOfferReview, openReview, paperEnd, paperPeriod, paperWeek, periodShift, renderGoalsView, renderPaperView } from './review-ui.js';
import { coverFor, openProject, projectEventDone, renderLater, renderSidebar } from './sidebar.js';
import { loadTimer } from './timer.js';
import { markBaseline, newTask, pushUndo, recordTaskUndo, undo, undoStack, undoableEventChange, undoableEventDelete } from './undo.js';
import { afterDriveGrant, applyBackup, backupData, backupNow, dailyBackup, ensureDrive, restoreFromDrive } from './backup.js';
import { commandForKey, menuItems, openCommandBar } from './commands.js';


// Context handed to dialogs
export const ctx = {
  get state() { return app.state; },
  externalChanged() { AC.invalidateExternal(); render(); cycle(); },
  lastEventEnd: (o) => lastEventEnd(o),
  titleSuggest: (inp) => attachTitleSuggest(inp),
  coverFor: (t) => coverFor(t),
  nextEventStart: (o) => nextEventStart(o),
  get lastBusy() { return app.lastBusy; },
  eventDone: (stp) => projectEventDone(stp),
  // New events go to the calendar chosen for task sessions (Settings → Google Calendar), else the primary one.
  defaultCalendar() {
    if (!E.connected(st())) return E.LOCAL_CAL;
    const cals = st().gmeta.calendars || [];
    const want = set().taskCalendarId && cals.find((c) => c.id === E.normCal(st(), set().taskCalendarId) && ['owner', 'writer'].includes(c.accessRole));
    const prim = cals.find((c) => c.primary);
    return want ? want.id : prim ? prim.id : E.LOCAL_CAL;
  },
  writableCalendars() {
    const g = E.connected(st()) ? (st().gmeta.calendars || []).filter((c) => ['owner', 'writer'].includes(c.accessRole)) : [];
    return [...g, { id: E.LOCAL_CAL, summary: 'Local (this browser)', color: LOCAL_COLOR }];
  },
  async saveAuth(patch = {}) {
    const cur = (await storeGet('auth')).auth || {};
    if ((patch.clientId && patch.clientId !== cur.clientId) || (patch.mode && patch.mode !== cur.mode)) patch = { ...patch, consented: false };
    st().auth = { ...cur, ...patch }; await storeSet({ auth: st().auth });
  },
  connect: (mode) => connectGoogle(mode),
  _openWizard: () => openWizard(),
  async saveSettings() { await E.persist(st(), ['settings']); },
  taskCalendars() { return E.connected(st()) ? (st().gmeta.calendars || []).filter((c) => ['owner', 'writer'].includes(c.accessRole)) : []; },
  defaultTaskCal() { return E.defaultTaskCal(st()); },
  async testNotification() { notify('Tempo Calendar', 'Notifications are working.'); },
  exportJson() {
    download(new Blob([JSON.stringify(backupData(), null, 2)], { type: 'application/json' }), `tempo-backup-${T.dayKey(Date.now(), tz())}.json`);
  },
};

export const returnState = (extra = {}) => ({ view: app.view, cursor: app.cursor, ...extra });

// Web app: Google's browser sign-ins last an hour. Renew it a few minutes before it runs out — by a quick silent trip
// to Google and back (no prompt, same view) at a moment you aren't using the app: no dialog open, not typing, no
// tap for 15 s, page visible. Only if Google refuses (e.g. you signed out of Google) does Tempo ask you to reconnect.
let lastInput = Date.now();
for (const evn of ['pointerdown', 'keydown', 'wheel', 'touchstart']) addEventListener(evn, () => { lastInput = Date.now(); }, { passive: true, capture: true });
const RENEW_GAP = 3 * T.MIN;
function quietMoment() {
  const ae = document.activeElement;
  return !document.hidden && !document.querySelector('dialog[open], .popover, .sheet.open') && !(ae && ae !== document.body && ae.matches?.('input, textarea, select, [contenteditable="true"]')) && Date.now() - lastInput > 15000 && !app.dragging;
}
export async function renewSoon(force = false) {
  if (!isWeb || !app.state || !E.connected(st())) return;
  clearTimeout(app.renewT);
  const exp = await G.tokenExpiry();
  if (!force && exp > Date.now() + 5 * T.MIN) return planRenew();
  const tried = +sessionStorage.getItem('tempo:silentAt') || 0;
  if (Date.now() - tried < RENEW_GAP) { app.renewT = setTimeout(() => renewSoon(force), RENEW_GAP - (Date.now() - tried) + 1000); return; }
  if (!quietMoment() && !(exp <= Date.now() && document.visibilityState === 'visible' && Date.now() - lastInput > 4000 && !document.querySelector('dialog[open]'))) { app.renewT = setTimeout(() => renewSoon(force), 5000); return; }
  sessionStorage.setItem('tempo:silentAt', String(Date.now()));
  document.body.classList.add('signing-in');
  G.silentRenew(returnState({ scroll: $('.tg-scroll')?.scrollTop ?? null }));
}
async function planRenew() {
  if (!isWeb || !app.state || !E.connected(st())) return;
  clearTimeout(app.renewT);
  const exp = await G.tokenExpiry();
  const wait = exp - 4 * T.MIN - Date.now();
  if (wait <= 0) return renewSoon();
  app.renewT = setTimeout(() => renewSoon(), Math.min(wait, 2 ** 31 - 1));
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && isWeb) renewSoon(); });

// Reconnect: in the web app, try a silent renew first and fall back to the Google prompt only if needed.
export function reconnectGoogle() {
  if (isWeb) return G.silentRenew(returnState({ autoInteractive: true }));
  return connectGoogle(st().auth?.mode || 'custom');
}

function notify(title, message) {
  if (ext?.notifications?.create) ext.notifications.create('', { type: 'basic', iconUrl: ext.runtime.getURL('icons/icon128.png'), title, message });
  else if ('Notification' in window) Notification.requestPermission().then(async (p) => {
    if (p !== 'granted') return toast('Notifications are blocked for this site — allow them in your browser settings.');
    const reg = await navigator.serviceWorker?.getRegistration?.().catch(() => null);
    if (reg) reg.showNotification(title, { body: message, icon: 'icons/icon192.png' });
    else new Notification(title, { body: message, icon: 'icons/icon192.png' });
  });
}

// ======================================================================================
// Ranges & items
// ======================================================================================
export function range(view = app.view, cursor = app.cursor) {
  const ws = set().weekStart;
  if (view === 'analysis' || view === 'review' || view === 'goals') view = 'week';
  if (view === 'day') return { days: [cursor] };
  if (view === '3day') return { days: [cursor, T.addDays(cursor, 1), T.addDays(cursor, 2)] };
  if (view === 'week') { const a = set().weekView === 'rolling' ? cursor : T.startOfWeek(cursor, ws); return { days: Array.from({ length: 7 }, (_, i) => T.addDays(a, i)) }; }
  const { y, m } = T.parseKey(cursor);
  const first = T.keyOf(y, m, 1);
  const a = T.startOfWeek(first, ws);
  return { days: Array.from({ length: 42 }, (_, i) => T.addDays(a, i)), monthKey: first };
}

// Toasts after a change offer Undo.
export function toast(msg, opts = {}) {
  const top = undoStack[undoStack.length - 1];
  if (!opts.action && !opts.noUndo && top && Date.now() - top.at < 2500) return uiToast(msg, { ...opts, action: 'Undo', onAction: undo, ms: Math.max(opts.ms || 0, 6000) });
  return uiToast(msg, opts);
}

export function calColor(calId) {
  if (calId === E.LOCAL_CAL) return LOCAL_COLOR;
  return (st().gmeta.calendars || []).find((c) => c.id === calId)?.color || '#4f6bed';
}

function eventItem(ev) {
  const iv = E.interval(ev, tz());
  const me = ev.attendees?.find((a) => a.self);
  const item = {
    key: `${ev._calId}|${ev.id}`, kind: 'event', title: ev.summary || '(No title)', ...iv,
    color: ev._color || (ev.colorId ? G.EVENT_COLORS[ev.colorId] : (C.catById(set(), C.eventCategoryId(ev, st().eventCats))?.color || calColor(ev._calId))), ev,
    editable: EV.canEdit(ev, st()), declined: me?.responseStatus === 'declined', tentative: me?.responseStatus === 'tentative',
    catId: C.eventCategoryId(ev, st().eventCats),
  };
  item.evDone = eventIsDone(ev);
  const icon = C.catById(set(), item.catId)?.icon;
  if (icon && !item.title.startsWith(icon)) item.title = `${icon} ${item.title}`;
  return item;
}

// Events can be ticked off too. Editable events keep the mark in Google (extendedProperties.private.tempoDone),
// read-only ones on this device.
function eventIsDone(ev) {
  const p = ev?.extendedProperties?.private?.tempoDone;
  if (p === '1') return true;
  if (p === '0') return false;
  return !!st().eventDone?.[`${ev._calId}|${ev.id}`];
}
export async function setEventDone(it, done, { quiet = false } = {}) {
  const ev = it.ev;
  if (!it.editable) {
    const k = `${ev._calId}|${ev.id}`; st().eventDone = st().eventDone || {};
    if (done) st().eventDone[k] = Date.now(); else delete st().eventDone[k];
    await E.persist(st(), ['eventDone']);
    pushUndo(`mark “${it.title}” ${done ? 'done' : 'undone'}`, async () => {
      if (done) delete st().eventDone[k]; else st().eventDone[k] = Date.now();
      await E.persist(st(), ['eventDone']); render();
    });
    render();
  } else {
    const priv = { ...(ev.extendedProperties?.private || {}), tempoDone: done ? '1' : '0' };
    await EV.updateEvent(st(), ev, { extendedProperties: { ...(ev.extendedProperties || {}), private: priv } }, 'this');
    undoableEventChange(`mark “${it.title}” ${done ? 'done' : 'undone'}`, ev, 'this');
    await afterEventChange();
  }
  if (!quiet) toast(done ? `“${it.title}” marked done` : `“${it.title}” marked undone`);
}

function chunkItems(from, to) {
  const out = [];
  for (const task of st().tasks.filter((t) => !t.archived)) {
    for (const s of S.sessions(task)) {
      if (s.end <= from || s.start >= to) continue;
      out.push({
        key: `c|${s.id}`, kind: 'chunk', title: s.label, start: s.start, end: s.end, allDay: false,
        startKey: T.dayKey(s.start, tz()), endKey: T.dayKey(s.end - 1, tz()),
        color: task.color || '#4f6bed', task, sess: s, status: s.kind, overdue: !!s.overdue, editable: true,
      });
    }
  }
  return out;
}

export async function collectItems(days) {
  const from = T.dayStart(days[0], tz()), to = T.dayStart(T.addDays(days[days.length - 1], 1), tz());
  let gev = [];
  try { gev = await E.googleEvents(st(), from, to); }
  catch (e) { handleError(e); }
  const hidden = new Set(set().hiddenCalendars || []);
  const local = hidden.has(E.LOCAL_CAL) ? [] : E.expandLocal(st().localEvents, from, to, tz());
  if (C.adoptCategoriesFromEvents(set(), gev)) E.persist(st(), ['settings']);
  let xev = [];
  try {
    // calendars shared between your accounts would show twice: drop copies of events already shown from Google
    const uids = new Set(gev.map((e) => e.iCalUID).filter(Boolean));
    xev = (await AC.externalEvents(st(), from, to)).filter((e) => e._show && !(e.iCalUID && uids.has(e.iCalUID)) && !e.extendedProperties?.private?.tempoTask);
  } catch (e) { console.warn(e); }
  const items = [...gev.map(eventItem), ...local.map(eventItem), ...xev.map(eventItem), ...(hidden.has('tasks') ? [] : chunkItems(from, to))];
  return items;
}

// ======================================================================================
// Rendering
// ======================================================================================
export async function render() {
  const seq = ++app.renderSeq;
  app.dataRev = seq; // things worked out from the data (e.g. the game's view) are rebuilt once per redraw
  document.body.classList.toggle('analysis-mode', app.view === 'analysis');
  document.body.classList.toggle('review-mode', app.view === 'review');
  if (app.view !== 'review') app.npVisit = null; // a new picture, joke and quote next time the paper is opened
  if (app.view === 'analysis') { renderToolbar(); renderSidebar(); return renderAnalysisView(seq); }
  if (app.view === 'review') { renderToolbar(); renderSidebar(); return renderPaperView(seq); }
  document.body.classList.toggle('goals-mode', app.view === 'goals');
  if (app.view === 'goals') { renderToolbar(); renderSidebar(); return renderGoalsView(seq); }
  const r = range();
  renderToolbar();
  renderSidebar();
  // weather: draw with what's cached; fetch in the background when stale and redraw once it arrives
  W.refresh(set()).then((fresh) => { if (fresh && app.view !== 'analysis') render(); });
  const items = await collectItems(r.days);
  if (seq !== app.renderSeq) return;
  app.items = new Map(items.map((i) => [i.key, i]));
  const view = $('#view');
  const scrollTop = $('.tg-scroll', view)?.scrollTop;
  view.replaceChildren();
  if (app.view === 'month') view.appendChild(renderMonth(r, items));
  else view.appendChild(renderTimeGrid(r.days, items));
  slideIn();
  const sc = $('.tg-scroll', view);
  if (sc) {
    if (scrollTop != null && app.scrolled) sc.scrollTop = scrollTop;
    else { sc.scrollTop = Math.max(0, (T.parseHHMM(set().bounds.start) / 60 - 1) * set().hourHeight); app.scrolled = true; }
  }
}

function renderToolbar() {
  const z = tz();
  let title;
  $$('#view-seg button, #bottombar button').forEach((b) => b.classList.toggle('on', b.dataset.view === app.view));
  if (app.view === 'analysis') { $('#range-title').textContent = 'Time analysis'; return; }
  if (app.view === 'goals') { $('#range-title').textContent = 'Goals'; return; }
  if (app.view === 'review') { const wk = paperWeek(); $('#range-title').textContent = innerWidth < 600 ? 'Weekly review' : `Review · ${T.format(T.dayStart(wk, z), z, { month: 'short', day: 'numeric' })} – ${T.format(T.dayStart(T.addDays(paperEnd(wk), -1), z), z, { month: 'short', day: 'numeric', ...(paperPeriod() === 'year' || paperPeriod() === 'quarter' ? { year: 'numeric' } : {}) })}`; return; }
  const { days, monthKey } = range();
  if (app.view === 'month') title = T.format(T.dayStart(monthKey, z), z, { month: 'long', year: 'numeric' });
  else if (app.view === 'day') title = T.format(T.dayStart(days[0], z), z, innerWidth < 600 ? { weekday: 'short', day: 'numeric', month: 'short' } : { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  else {
    const last = days[days.length - 1];
    const a = T.dayStart(days[0], z), b = T.dayStart(last, z);
    const sameMonth = T.parseKey(days[0]).m === T.parseKey(last).m;
    title = sameMonth
      ? `${T.format(a, z, { month: innerWidth < 600 ? 'short' : 'long' })} ${T.parseKey(days[0]).d} – ${T.parseKey(last).d}${innerWidth < 600 ? '' : ', ' + T.parseKey(last).y}`
      : `${T.format(a, z, { month: 'short', day: 'numeric' })} – ${T.format(b, z, innerWidth < 600 ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }
  $('#range-title').textContent = title;
  const s = $('#sync-status');
  s.textContent = app.status.text;
  s.className = 'status ' + app.status.kind;
}

function tzAbbr() {
  try { return new Intl.DateTimeFormat(undefined, { timeZone: tz(), timeZoneName: 'short' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value || ''; } catch { return ''; }
}

const hourLabel = (h) => (set().h12 ? (h === 0 ? '' : `${((h + 11) % 12) + 1} ${h < 12 ? 'AM' : 'PM'}`) : (h === 0 ? '' : `${T.pad(h)}:00`));

const dayBounds = new Map(); // "zone|day" -> [start, end] (the same few days are asked for over and over)
function dayRange(k, z = tz()) {
  const key = z + '|' + k;
  let r = dayBounds.get(key);
  if (!r) { r = [T.dayStart(k, z), T.dayStart(T.addDays(k, 1), z)]; if (dayBounds.size > 2000) dayBounds.clear(); dayBounds.set(key, r); }
  return r;
}
function segMinutes(it, k) {
  const z = tz();
  const [ds, de] = dayRange(k, z);
  if (it.end <= ds || it.start >= de) return null;
  const s = it.start <= ds ? 0 : T.minutesOfDay(it.start, z);
  const e = it.end >= de ? 1440 : T.minutesOfDay(it.end, z);
  return { s, e: Math.max(e, s + 1), startsHere: it.start >= ds, endsHere: it.end <= de };
}

function itemClasses(it) {
  return ['ev', it.kind === 'chunk' ? 'chunk' : '', it.status === 'done' || it.evDone ? 'done' : '', it.sess?.partial ? 'partial' : '', it.sess?.late && it.status === 'planned' && !it.overdue ? 'late' : '', it.task?.repeat ? 'rep' : '', it.status === 'pinned' ? 'pinned' : '',
    it.overdue ? 'overdue' : '', !it.editable ? 'ro' : '', it.declined ? 'declined' : '', it.tentative ? 'tentative' : ''].filter(Boolean).join(' ');
}

function renderTimeGrid(days, items) {
  const s = set(), z = tz(), hh = s.hourHeight;
  const todayK = T.dayKey(Date.now(), z);
  const allDay = items.filter((i) => i.allDay);
  const timed = items.filter((i) => !i.allDay);

  // all-day rows packing
  const rows = [];
  const bars = allDay.map((it) => {
    const a = it.startKey < days[0] ? 0 : days.indexOf(it.startKey);
    const lastK = T.addDays(it.endKey, -1);
    const b = lastK > days[days.length - 1] ? days.length - 1 : days.indexOf(lastK);
    return { it, a, b };
  }).filter((p) => p.a >= 0 && p.b >= p.a).sort((x, y) => (y.b - y.a) - (x.b - x.a) || x.a - y.a);
  for (const p of bars) {
    let r = rows.findIndex((row) => row.every((q) => q.b < p.a || q.a > p.b));
    if (r < 0) { r = rows.length; rows.push([]); }
    rows[r].push(p); p.row = r;
  }

  const deadlines = st().tasks.filter((t) => !t.archived && Number.isFinite(+t.deadline) && +t.deadline > 0 && S.progress(t).pct < 100);
  const drawErrors = [];
  const toNow = app.toNowIt = toNowItem(timed);
  app.dayFill = computeDayFill(days, items);
  $('#fab')?.classList.toggle('has-tonow', !!toNow && days.includes(todayK));

  const root = el(`<div class="tg" style="--hh:${hh}px;--ncol:${days.length}">
    <div class="tg-head">
      <div class="tg-gutter"><span class="tz-label" title="${esc(z)}">${esc(tzAbbr())}</span></div>
      ${days.map((k) => `<div class="tg-dayhead ${k === todayK ? 'today' : ''} ${k < todayK ? 'past' : ''} ${S.leaveOf(set(), k) ? 'on-leave lv-' + S.leaveOf(set(), k) : ''}" data-day="${k}">
        <button class="wd leave-menu" data-leave="${k}" title="Mark this day as on leave or sick leave">${esc(T.format(T.dayStart(k, z), z, { weekday: 'short' }))}</button><button class="dn" data-goto="${k}">${T.parseKey(k).d}</button>${W.dayHTML(set(), k, todayK)}${leaveTag(k)}${levelFlag(k)}${gameDayChip(k, items)}${dayMarks(k, todayK)}</div>`).join('')}
    </div>
    <div class="tg-allday">
      <div class="tg-gutter small muted">all-day</div>
      <div class="ad-area" style="grid-template-rows:repeat(${Math.max(1, rows.length)}, 24px)">
        ${days.map((k, i) => `<div class="ad-cell" data-day="${k}" style="grid-column:${i + 1};grid-row:1 / span ${Math.max(1, rows.length)}"></div>`).join('')}
        ${bars.map((p) => `<div class="ad-bar ${!p.it.editable ? 'ro' : ''}" data-key="${esc(p.it.key)}" style="grid-column:${p.a + 1} / ${p.b + 2};grid-row:${p.row + 1};--c:${p.it.color}">${esc(p.it.title)}</div>`).join('')}
      </div>
    </div>
    <div class="tg-scroll">
      <div class="tg-body" style="height:${24 * hh}px">
        <div class="tg-hours">${Array.from({ length: 24 }, (_, h) => `<div class="hr" style="top:${h * hh}px"><span>${hourLabel(h)}</span></div>`).join('')}</div>
        <div class="tg-cols"></div>
      </div>
    </div>
  </div>`);

  const colsEl = $('.tg-cols', root);
  for (const k of days) {
    const col = el(`<div class="tg-col ${k === todayK ? 'today' : ''} ${S.leaveOf(set(), k) ? 'on-leave lv-' + S.leaveOf(set(), k) : ''}" data-day="${k}"></div>`);
    // day-bound shading
    const b = s.bounds, wd = T.weekday(k);
    if (!b.days.includes(wd)) col.appendChild(el(`<div class="off" style="top:0;height:${24 * hh}px"></div>`));
    else {
      const bs = T.parseHHMM(b.start), be = T.parseHHMM(b.end);
      if (bs > 0) col.appendChild(el(`<div class="off" style="top:0;height:${(bs / 60) * hh}px"></div>`));
      if (be < 1440 && be > bs) col.appendChild(el(`<div class="off" style="top:${(be / 60) * hh}px;height:${((1440 - be) / 60) * hh}px"></div>`));
    }
    // events
    const segs = timed.map((it) => ({ it, seg: segMinutes(it, k) })).filter((x) => x.seg)
      .map(({ it, seg }) => ({ it, ...seg, s: seg.s, e: Math.max(seg.e, seg.s + 15) }));
    for (const g of X.layoutColumns(segs)) {
      const it = g.it;
      try {
      const top = (g.s / 60) * hh, h = Math.max(16, ((g.e - g.s) / 60) * hh - 2);
      const left = (g.col / g.cols) * 100, width = (1 / g.cols) * 100;
      const short = h < 36;
      const timeStr = `${T.fmtTime(it.start, z, s.h12)} – ${T.fmtTime(it.end, z, s.h12)}`;
      const node = el(`<div class="${itemClasses(it)} ${short ? 'short' : ''}" data-key="${esc(it.key)}" style="top:${top}px;height:${h}px;left:calc((100% - var(--free-strip)) * ${left / 100} + 1px);width:calc((100% - var(--free-strip)) * ${width / 100} - ${g.cols > 1 ? 3 : 2}px);--c:${it.color}">
        <div class="ev-t">${it.sess?.partial ? '<span class="tick" title="Partly done">◐</span>' : it.status === 'done' || it.evDone ? '<span class="tick">✓</span>' : ''}${it.status === 'pinned' ? '<span class="pin" title="Pinned">📌</span>' : ''}${esc(it.title)}</div>
        <div class="ev-time">${short ? '' : esc(timeStr)}${it.ev?.recurringEventId ? ' <span class="rep" title="Repeats">↻</span>' : ''}</div>
        ${it.editable && g.endsHere ? '<div class="ev-resize"></div>' : ''}
      </div>`);
      node.title = `${it.title}\n${timeStr}`;
      col.appendChild(node);
      } catch (err) { drawErrors.push([it.title, err]); }
    }
    // travel buffers around events at a place
    const trav = +set().travelMinutes || 0;
    if (trav) for (const it of timed) {
      if (it.kind !== 'event' || it.declined || !E.hasPlace(it.ev)) continue;
      for (const b of E.travelBlocks(it.ev, it, trav)) {
        const seg = segMinutes(b, k);
        if (seg) col.appendChild(el(`<div class="travel" style="top:${(seg.s / 60) * hh}px;height:${Math.max(4, ((seg.e - seg.s) / 60) * hh)}px" title="Travel buffer (${trav} min)"><span>🚗</span></div>`));
      }
    }
    // time kept free after finishing something early
    for (const hd of s.holds || []) {
      const seg = segMinutes(hd, k);
      if (seg) col.appendChild(el(`<div class="hold" style="top:${(seg.s / 60) * hh}px;height:${Math.max(6, ((seg.e - seg.s) / 60) * hh)}px" title="Kept free"><span>Kept free</span></div>`));
    }
    // deadline flags
    for (const t of deadlines) {
      try {
        if (T.dayKey(+t.deadline - 1, z) !== k) continue;
        const m = T.minutesOfDay(+t.deadline, z) || 1440;
        col.appendChild(el(`<div class="deadline" style="top:${(m / 60) * hh}px;--c:${t.color}" title="Deadline: ${esc(t.title)}"><span>⚑ ${esc(t.title)}</span></div>`));
      } catch (err) { drawErrors.push(['deadline of ' + t.title, err]); }
    }
    // on a computer, "extend until now" sits on the current-time line (on phones it's in the + menu)
    if (k === todayK) col.appendChild(el(`<div class="now" style="top:${(T.minutesOfDay(Date.now(), z) / 60) * hh}px">${toNow ? `<button type="button" class="tonow-btn" data-tonow="${esc(toNow.key)}" style="--c:${toNow.color}" title="Still going? Make “${esc(toNow.title)}” end now">⟶ Extend “${esc(toNow.title.length > 22 ? toNow.title.slice(0, 21) + '…' : toNow.title)}” until now</button>` : ''}</div>`));
    if (toNow && T.dayKey(toNow.end - 1, z) === k) {
      const m = T.minutesOfDay(toNow.end, z) || 1440;
      col.appendChild(el(`<div class="tonow-mark" style="top:${(m / 60) * hh}px;--c:${toNow.color}" title="“${esc(toNow.title)}” ended here"></div>`));
    }
    colsEl.appendChild(col);
  }

  // the "until now" button floats at the bottom centre of the calendar, easy to reach (also on phones)
  if (drawErrors.length) { console.error('Tempo: items not drawn', drawErrors); toast(`${drawErrors.length} item(s) couldn't be drawn: ${drawErrors[0][0]} — ${drawErrors[0][1].message}`, { ms: 8000 }); }

  $$('.dn', root).forEach((b) => b.addEventListener('click', () => { app.cursor = b.dataset.goto; app.view = 'day'; render(); }));
  wireDayMarks(root);
  wireToNow(root);
  $$('[data-leave]', root).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); leaveMenu(b.dataset.leave, b.getBoundingClientRect()); }));
  $$('[data-xpday]', root).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); xpBreakdown(b.dataset.xpday, b.getBoundingClientRect()); }));
  colsEl.addEventListener('pointerdown', onGridPointerDown);
  $('.ad-area', root).addEventListener('pointerdown', onAllDayPointerDown);
  return root;
}

function renderMonth({ days, monthKey }, items) {
  app.dayFill = computeDayFill(days, items);
  const z = tz(), todayK = T.dayKey(Date.now(), z), month = T.parseKey(monthKey).m;
  const root = el(`<div class="month">
    <div class="m-head">${days.slice(0, 7).map((k) => `<div>${esc(T.format(T.dayStart(k, z), z, { weekday: 'short' }))}</div>`).join('')}</div>
    <div class="m-grid"></div>
  </div>`);
  const grid = $('.m-grid', root);
  for (const k of days) {
    const ds = T.dayStart(k, z), de = T.dayStart(T.addDays(k, 1), z);
    const list = items.filter((it) => (it.allDay ? it.startKey <= k && it.endKey > k : it.end > ds && it.start < de))
      .sort((a, b) => (b.allDay - a.allDay) || a.start - b.start || a.title.localeCompare(b.title));
    const max = 4;
    const shown = list.length > max ? list.slice(0, max - 1) : list;
    const cell = el(`<div class="m-cell ${T.parseKey(k).m !== month ? 'out' : ''} ${k === todayK ? 'today' : ''} ${S.leaveOf(set(), k) ? 'on-leave lv-' + S.leaveOf(set(), k) : ''}" data-day="${k}">
      <button class="m-dn" data-goto="${k}">${T.parseKey(k).d}</button>${W.dayHTML(set(), k, todayK, { month: true })}${leaveTag(k, true)}${levelFlag(k)}${dayMarks(k, todayK)}
      <div class="m-items">
        ${shown.map((it) => it.allDay
          ? `<div class="chip allday ${!it.editable ? 'ro' : ''}" data-key="${esc(it.key)}" style="--c:${it.color}">${esc(it.title)}</div>`
          : `<div class="chip ${it.kind === 'chunk' ? 'chunk' : ''} ${it.status === 'done' || it.evDone ? 'done' : ''} ${!it.editable ? 'ro' : ''}" data-key="${esc(it.key)}" style="--c:${it.color}"><i></i><span class="ct">${esc(T.fmtTime(it.start, z, set().h12))}</span> ${esc(it.title)}</div>`).join('')}
        ${list.length > max ? `<button class="m-more" data-goto="${k}">+${list.length - shown.length} more</button>` : ''}
      </div></div>`);
    grid.appendChild(cell);
  }
  $$('[data-goto]', root).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); app.cursor = b.dataset.goto; app.view = 'day'; render(); }));
  $$('[data-leave]', root).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); leaveMenu(b.dataset.leave, b.getBoundingClientRect()); }));
  wireDayMarks(root);
  grid.addEventListener('pointerdown', onMonthPointerDown);
  return root;
}

// ======================================================================================
// Event & task editing
// ======================================================================================
export async function newEvent(init) {
  refreshTitleList();
  const r = await D.eventDialog(ctx, { init });
  if (r?.action === 'save') await saveNewEvent(r.calId, r.body, { conference: r.conference });
}

export async function editEvent(it) {
  refreshTitleList();
  const master = it.ev.recurringEventId ? await EV.getMaster(st(), it.ev) : null;
  const r = await D.eventDialog(ctx, { ev: it.ev, master });
  if (!r) return;
  let scope = 'this';
  if (it.ev.recurringEventId) {
    scope = await askScope(r.action === 'delete' ? 'Delete' : 'Edit');
    if (!scope) return;
    if (scope === 'this' && r.recurrenceChanged) scope = 'following';
  }
  try {
    setStatus('Saving…');
    if (r.action === 'delete') { await EV.deleteEvent(st(), it.ev, scope); undoableEventDelete(it.ev, scope); }
    else { await EV.updateEvent(st(), it.ev, r.body, scope, { conference: r.conference }); undoableEventChange(`edit “${it.ev.summary || 'event'}”`, it.ev, scope); }
    await afterEventChange();
    if (undoStack.length) toast(r.action === 'delete' ? 'Event deleted' : 'Event saved');
  } catch (err) { handleError(err); render(); }
}

export function replaceTask(t) { t = { ...t, rev: Date.now() }; st().tasks = st().tasks.map((x) => (x.id === t.id ? t : x)); }
// Every user change to tasks goes through saveTasks(label): the state before it is kept so it can be undone.
export async function saveTasks(label = 'last change') {
  if (label !== false) recordTaskUndo(label);
  await E.persist(st(), ['tasks', 'orphanGids', 'acks', 'tombstones']);
}

// ======================================================================================
// Cycle: reschedule -> render -> sync -> prompts
// ======================================================================================
export let cycling = null, again = false, pullPending = false;
// Ask the running cycle to go round once more (e.g. after a deadline changed in a dialog it showed)
export function cycleAgain() { again = true; }
export function cycle(opts = {}) {
  if (opts.pull) pullPending = true;
  if (cycling) { again = true; return cycling; }
  cycling = (async () => {
    do { again = false; const pull = pullPending; pullPending = false; await runCycle({ ...opts, pull }); } while (again);
  })().finally(() => { cycling = null; });
  return cycling;
}

async function runCycle({ sync = true, pull = false } = {}) {
  st().auth = (await storeGet('auth')).auth || {};
  let problems = [];
  let sharedChanged = false;
  if (E.connected(st()) && (pull || E.sharedDirty(st()))) {
    // Categories (with icons) and time periods are shared with your other devices through Google.
    try {
      sharedChanged = (await E.syncShared(st(), { force: pull })).changed;
      await E.persist(st(), ['settings']);
    } catch (err) { if (err instanceof G.AuthError || err instanceof G.PermissionError) handleError(err); else console.warn('Tempo: could not sync categories', err); }
  }
  if (pull && E.connected(st())) {
    try {
      const r = await E.pullTasks(st());
      app.lastPull = { at: Date.now(), ...r };
      if (r.adoptedCalendar | C.adoptCategoriesFromTasks(set(), st().tasks) | adoptPeriodsFromTasks()) await E.persist(st(), ['settings']);
      if (sharedChanged) {
        const rc = C.refreshTaskCategories(set(), st().tasks);
        if (rc.changed.length) { st().tasks = rc.tasks; await saveTasks(false); }
      }
      if (r.imported.length || r.updated.length || r.removed.length) {
        await E.persist(st(), ['tasks', 'orphanGids']);
        const parts = [];
        if (r.imported.length) parts.push(`loaded ${r.imported.length} task${r.imported.length > 1 ? 's' : ''} from Google (${r.imported.map((t) => t.title).slice(0, 3).join(', ')}${r.imported.length > 3 ? '…' : ''})`);
        if (r.updated.length) parts.push(`updated ${r.updated.length} changed elsewhere`);
        if (r.removed.length) parts.push(`removed ${r.removed.length} deleted elsewhere`);
        const msg = parts.join('; ');
        toast(msg[0].toUpperCase() + msg.slice(1), r.removed.length ? { action: 'Undo', ms: 9000, onAction: async () => { for (const t of r.removed) st().tasks.push({ ...t, rev: Date.now() }); await saveTasks(false); cycle(); } } : { ms: 5000 });
      }
    } catch (err) { handleError(err); }
  }
  try {
    const r = await E.reschedule(st());
    problems = r.problems;
    app.lastBusy = r.busy;
    await E.persist(st(), ['tasks', 'reminderQueue']);
    handleMoves(r.moves || []);
  } catch (err) {
    handleError(err);
  }
  await render();
  if (sync) {
    try {
      if (E.connected(st()) && set().syncTasksToGoogle) setStatus('Syncing…', 'busy');
      const res = await E.syncTasks(st(), (fn) => fn(st()), (n, total, phase) => setStatus(phase === 'verify' ? 'Checking Google…' : `Syncing ${n}/${total}…`, 'busy'));
      if (navigator.onLine === false || st().offline) offlineStatus();
      else if (res.ok) setStatus(`Synced ${T.fmtTime(Date.now(), tz(), set().h12)}${res.pending ? ` · ${res.pending} more soon` : ''}`, 'ok');
      else if (res.kind === 'local') setStatus('Local only', 'warn');
      else if (res.kind === 'off') setStatus('Not syncing tasks', 'warn');
      else setStatus('Sync problem', 'bad');
      if (res.changed) { E.invalidate(); await render(); }
      // a big backlog goes through in steps: carry on shortly with the next batch
      if (res.pending && !app.syncMoreT) app.syncMoreT = setTimeout(() => { app.syncMoreT = null; cycle(); }, 12000);
    } catch (err) { handleError(err); }
    await E.persist(st(), ['tasks', 'orphanGids', 'syncInfo']);
    renderBanner();
  }
  markBaseline();
  autoBlocks().then(() => { scheduleAutoBlocks(); return autoHabits(); }).then(() => gameRefresh()).then(() => dailyBackup());
  await handleProblems(problems);
}

// ---------- Goals ----------
// Shared settings (goals, Later notes…) go to Google a few seconds after the last edit.
let shareTimer = null;
export function syncSharedSoon() { clearTimeout(shareTimer); shareTimer = setTimeout(() => { if (E.connected(st())) cycle({ sync: false }); }, 2500); }
// ======================================================================================
// Settings / Google
// ======================================================================================
async function connectGoogle(mode = 'custom') {
  try {
    setStatus('Connecting…', 'busy');
    await G.connect(mode);
    st().auth = (await storeGet('auth')).auth;
    await E.refreshCalendars(st());
    const gtz = await G.getSettingTz().catch(() => null);
    if (gtz && T.isValidTz(gtz) && !st().settings._tzChosen) st().settings.tz = gtz;
    await E.persist(st(), ['gmeta', 'settings']);
    E.invalidate();
    app.bannerDismissed = false;
    toast(`Connected to Google Calendar${st().auth.email ? ' as ' + st().auth.email : ''}`);
    await cycle({ pull: true });
    return { ok: true, email: st().auth.email };
  } catch (err) {
    st().auth = (await storeGet('auth')).auth || {};
    handleError(err);
    return { ok: false, error: err.message };
  }
}

export function closeDrawer() { $('#side')?.classList.remove('open'); const sc = $('#scrim'); if (sc) sc.hidden = true; }

// A simple bottom-sheet menu (used by the phone layout).
function sheetMenu(items) {
  return modal(`<div class="choice"><div class="sheet-menu">${items.map((it, i) => it === '-' ? '<div class="sep"></div>'
    : typeof it === 'string' ? `<div class="lbl">${esc(it)}</div>`
      : `<button type="button" data-i="${i}"><span class="ic">${esc(it.ic)}</span>${esc(it.label)}</button>`).join('')}</div>
    <div class="actions"><button type="button" class="btn ghost" data-close>Cancel</button></div></div>`, (dlg, close) => {
    $$('[data-i]', dlg).forEach((b) => (b.onclick = () => { close(); items[+b.dataset.i].run(); }));
  }, { cls: 'narrow' });
}

// Manual "refresh from server": re-read calendars, events and task sessions from Google.
export async function refreshFromServer() {
  const btn = $('#btn-refresh');
  if (btn.classList.contains('spin')) return;
  btn.classList.add('spin');
  try {
    E.invalidate();
    st().auth = (await storeGet('auth')).auth || {};
    if (E.connected(st())) {
      setStatus('Refreshing…', 'busy');
      await E.refreshCalendars(st());
      await E.persist(st(), ['gmeta']);
    }
    await cycle({ pull: true });
    if (!E.connected(st())) toast('Not connected to Google — showing what is stored in this browser.', { action: 'Connect', onAction: openConnect });
    else if (st().syncInfo?.ok) {
      const p = app.lastPull;
      if (!(p && (p.imported.length || p.updated.length || p.removed.length))) toast('Up to date with Google Calendar');
    }
  } catch (err) { handleError(err); }
  finally { btn.classList.remove('spin'); }
}

// One-click if a built-in client exists, otherwise the setup wizard.
export async function openConnect() {
  if (G.builtinAvailable()) { G.ensureHostPermission(); return connectGoogle('builtin'); }
  return openWizard();
}

async function openWizard() {
  const r = await D.setupWizard(ctx);
  if (r?.connected) renderBanner();
}

export async function openSettings() {
  const before = { ...set() };
  const r = await D.settingsDialog(ctx);
  if (!r) return;
  if (r.settings) {
    if (r.settings.tz !== before.tz) r.settings._tzChosen = true;
    const agenda = r.settings._agendaEmail; delete r.settings._agendaEmail;
    if (agenda && agenda.want !== agenda.was && agenda.calId) {
      try {
        const cal = (st().gmeta.calendars || []).find((c) => c.id === agenda.calId);
        const others = (cal?.notificationSettings?.notifications || []).filter((n) => n.type !== 'agenda');
        await G.patchCalendarListEntry(agenda.calId, { notificationSettings: { notifications: agenda.want ? [...others, { type: 'agenda', method: 'email' }] : others } });
        await E.refreshCalendars(st()); await E.persist(st(), ['gmeta']);
        toast(agenda.want ? 'Google will email you a daily agenda each morning' : 'Daily agenda email turned off');
      } catch (err) { handleError(err); }
    }
    if ((r.settings.taskCalendarId || null) !== (before.taskCalendarId || null)) {
      const cal = E.normCal(st(), r.settings.taskCalendarId);
      st().tasks = st().tasks.map((t) => ({ ...t, calendarId: cal, rev: Date.now() }));
      await saveTasks(false);
    }
    const prevSettings = JSON.parse(JSON.stringify(before));
    st().settings = r.settings;
    await E.persist(st(), ['settings']);
    setQuickTz(r.settings.tz);
    if (JSON.stringify(prevSettings) !== JSON.stringify(r.settings)) pushUndo('settings change', async () => { st().settings = { ...prevSettings, sharedHash: null }; await E.persist(st(), ['settings']); E.invalidate(); await render(); await cycle(); });
    const ref = C.refreshTaskCategories(st().settings, st().tasks);
    if (ref.changed.length) st().tasks = ref.tasks;
    // keep each task's copy of its period's rules current (it syncs to other devices); deleted period -> work hours
    let perChanged = !!ref.changed.length;
    st().tasks = st().tasks.map((t) => {
      if (!t.periodId) return t;
      const per = (st().settings.periods || []).find((x) => x.id === t.periodId);
      if (!per) { perChanged = true; return { ...t, periodId: null, periodName: null, periodRules: null, rev: Date.now() }; }
      if (JSON.stringify(per.rules) !== JSON.stringify(t.periodRules) || per.name !== t.periodName) { perChanged = true; return { ...t, periodName: per.name, periodRules: per.rules, rev: Date.now() }; }
      return t;
    });
    if (perChanged) await saveTasks(false);
    if (r.settings.taskEmailReminderMinutes !== before.taskEmailReminderMinutes || r.settings.taskProfile !== before.taskProfile
      || JSON.stringify(r.settings.notifyProfiles) !== JSON.stringify(before.notifyProfiles)) st().tasks = st().tasks.map((t) => ({ ...t, rev: Date.now() }));
    await hoursChanged(before, r.settings);
    if (r.settings.sleepEvents && !before.sleepEvents) autoBlocks({ force: true });
    if (r.settings.game?.on && r.settings.game.started !== before.game?.started && before.game?.on) { app.gameToday = null; toast(`🎮 Counting XP from ${T.format(T.dayStart(r.settings.game.started, tz()), tz(), { day: 'numeric', month: 'long' })} — adding it up…`, { ms: 4000 }); gameRefresh(); }
    if (r.settings.game?.on && before.game?.on && GM.cfgHash(r.settings) !== GM.cfgHash(before) && r.settings.game.started === before.game?.started) { app.gameToday = null; toast('🎮 Recounting your XP from the start with the new settings…', { ms: 4000, noUndo: true }); gameRefresh(); }
    if (r.settings.game?.on !== before.game?.on) { app.gameToday = null; if (r.settings.game?.on) { toast('🎮 Game mode on — earn XP and level up!', { ms: 5000 }); gameRefresh(); } renderGamePanel(); render(); }
    const addedLeave = Object.keys(r.settings.leave || {}).filter((k) => S.leaveOf(r.settings, k) && !S.leaveOf(before, k));
    if (addedLeave.length && (await afterLeave(addedLeave)) === 'back') { for (const k of addedLeave) delete set().leave[k]; await E.persist(st(), ['settings']); await render(); }
    else if (JSON.stringify(before.leave || {}) !== JSON.stringify(r.settings.leave || {})) cycle();
    if (JSON.stringify(before.weather || null) !== JSON.stringify(r.settings.weather || null)) W.refresh(r.settings, { force: true }).then((ok) => { if (ok) render(); });
    app.miniCursor = T.dayKey(Date.now(), tz());
  }
  try {
    if (r.action === 'connect') return connectGoogle(r.mode || 'custom');
    if (r.action === 'wizard') return openWizard();
    if (r.action === 'syncPanel') return openSyncPanel();
    if (r.action === 'disconnect') {
      await G.disconnect();
      st().auth = { ...st().auth, connected: false, token: null, email: null };
      E.invalidate();
      toast('Disconnected from Google');
    }
    if (r.action === 'createCal') {
      const c = await G.createCalendar('Tempo Tasks', tz());
      await E.refreshCalendars(st());
      st().settings.taskCalendarId = c.id;
      await E.persist(st(), ['settings', 'gmeta']);
      toast('Created “Tempo Tasks” — task sessions will be written there');
    }
    if (r.action === 'cleanup') { const n = await E.cleanupOrphans(st()); toast(`Removed ${n} stray event${n === 1 ? '' : 's'}`); }
    if (r.action === 'import') { await applyBackup(JSON.parse(await r.file.text())); toast('Backup restored'); }
    if (r.settings?.driveBackup && !before.driveBackup) { if (await ensureDrive()) await backupNow(); else if (!isWeb) { set().driveBackup = false; await E.persist(st(), ['settings']); } }
    if (r.action === 'driveNow' && await ensureDrive()) await backupNow();
    if (r.action === 'driveRestore') await restoreFromDrive();
  } catch (err) { handleError(err); }
  E.invalidate();
  cycle();
}


// ======================================================================================
// Boot
// ======================================================================================
// Side swipe on phones: the view follows your finger; let go past a third of the screen (or flick) to go to the
// previous / next day, 3 days, week or month.
function setupSwipe() {
  const view = $('#view');
  let sx = 0, sy = 0, st0 = 0, tracking = false, horiz = null, el2 = null;
  const reset = () => { if (el2) { el2.style.transition = 'transform .18s ease-out, opacity .18s'; el2.style.transform = ''; el2.style.opacity = ''; } el2 = null; horiz = null; };
  view.addEventListener('touchstart', (e) => {
    tracking = false;
    if (e.touches.length !== 1 || app.view === 'analysis' || app.touchLock || document.querySelector('dialog[open], .popover')) return;
    if (e.target.closest('input, textarea, select')) return;
    const t = e.touches[0];
    sx = t.clientX; sy = t.clientY; st0 = Date.now(); tracking = true; horiz = null;
    el2 = view.firstElementChild;
  }, { passive: true });
  view.addEventListener('touchmove', (e) => {
    if (!tracking) return;
    if (app.touchLock) { tracking = false; reset(); return; } // a long-press drag took over
    const t = e.touches[0], dx = t.clientX - sx, dy = t.clientY - sy;
    if (horiz === null && Math.hypot(dx, dy) > 12) horiz = Math.abs(dx) > 1.3 * Math.abs(dy);
    if (horiz && el2) { el2.style.transition = 'none'; el2.style.transform = `translateX(${dx}px)`; el2.style.opacity = String(1 - Math.min(0.4, Math.abs(dx) / innerWidth)); }
  }, { passive: true });
  const end = (e) => {
    if (!tracking) return;
    tracking = false;
    const t = e.changedTouches[0], dx = t.clientX - sx, dt = Math.max(1, Date.now() - st0);
    if (horiz && !app.touchLock && e.type === 'touchend' && (Math.abs(dx) > innerWidth * 0.3 || (Math.abs(dx) > 45 && Math.abs(dx) / dt > 0.45))) {
      const dir = dx < 0 ? 1 : -1, node = el2;
      node.style.transition = 'transform .15s ease-in, opacity .15s';
      node.style.transform = `translateX(${dir > 0 ? -innerWidth : innerWidth}px)`; node.style.opacity = '0';
      el2 = null; horiz = null;
      app.swipeIn = dir;
      setTimeout(() => nav(dir), 140);
    } else reset();
  };
  view.addEventListener('touchend', end);
  view.addEventListener('touchcancel', end);
}
// After a swipe, the new day/week slides in from the side it came from.
function slideIn() {
  // never leave the page itself scrolled (it would push the bottom bar off screen on phones)
  if (document.scrollingElement && (document.scrollingElement.scrollTop || document.scrollingElement.scrollLeft)) document.scrollingElement.scrollTo(0, 0);
  const dir = app.swipeIn; app.swipeIn = 0;
  const node = $('#view')?.firstElementChild;
  if (!dir || !node) return;
  node.style.transition = 'none'; node.style.transform = `translateX(${dir > 0 ? 60 : -60}px)`; node.style.opacity = '0.4';
  requestAnimationFrame(() => requestAnimationFrame(() => { node.style.transition = 'transform .2s ease-out, opacity .2s'; node.style.transform = ''; node.style.opacity = ''; }));
}

function nav(dir) {
  if (app.view === 'review') { app.paperWeek = periodShift(paperWeek(), paperPeriod(), dir); app.paperPer = paperPeriod(); return render(); }
  if (app.view === 'day') app.cursor = T.addDays(app.cursor, dir);
  else if (app.view === '3day') app.cursor = T.addDays(app.cursor, 3 * dir);
  else if (app.view === 'week') app.cursor = T.addDays(app.cursor, 7 * dir);
  else app.cursor = T.addMonths(app.cursor, dir);
  app.miniCursor = app.cursor;
  render();
}

function bindToolbar() {
  $('#btn-today').onclick = () => { app.cursor = app.miniCursor = T.dayKey(Date.now(), tz()); app.paperWeek = null; render(); };
  $('#btn-prev').onclick = () => nav(-1);
  $('#btn-next').onclick = () => nav(1);
  $$('#view-seg button, #bottombar button').forEach((b) => (b.onclick = () => { app.view = b.dataset.view; closeDrawer(); render(); }));
  // Phone layout: drawer, add button, overflow menu
  $$('.side-tabs button').forEach((b) => (b.onclick = () => { app.sideTab = b.dataset.st; try { localStorage.setItem('tempo:sideTab', app.sideTab); } catch {} renderLater(); if (app.sideTab === 'later' && !matchMedia('(pointer: coarse)').matches) $('#later-list .later-add input')?.focus(); }));
  try { app.sideTab = localStorage.getItem('tempo:sideTab') || 'tasks'; } catch {}
  $('#btn-menu').onclick = () => { $('#side').classList.add('open'); $('#scrim').hidden = false; };
  $('#scrim').onclick = closeDrawer;
  $('#side').addEventListener('click', (e) => { if (e.target.closest('.md, .task-row, #connect-cta, .create .btn')) closeDrawer(); });
  $('#fab').onclick = () => sheetMenu([
    ...((tn) => (tn ? [{ ic: '⟶', label: `Extend “${tn.title.length > 30 ? tn.title.slice(0, 29) + '…' : tn.title}” until now`, run: () => extendToNow(tn) }] : []))(['day', '3day', 'week'].includes(app.view) ? currentToNow() : null),
    ...menuItems('fab'),
  ]);
  $('#btn-more').onclick = () => sheetMenu([{ ic: '🔍', label: 'Search and commands', run: () => openCommandBar() }, ...menuItems('more')]);
  $('#btn-settings').onclick = openSettings;
  $('#btn-undo').onclick = undo;
  $('#btn-now').onclick = () => sheetMenu(menuItems('now'));
  $('#btn-search')?.addEventListener('click', () => openCommandBar());
  $('#btn-review')?.addEventListener('click', openReview); // (the Review tab does the same)
  setupQuickAdd();
  $('#sync-status').onclick = openSyncPanel;
  $('#btn-refresh').onclick = refreshFromServer;
  $('#btn-new-project').onclick = () => openProject(null);
  $('#btn-new-event').onclick = () => {
    const now = Date.now(), z = tz();
    const k = app.cursor;
    const m = Math.ceil(T.minutesOfDay(now, z) / 30) * 30;
    const start = k === T.dayKey(now, z) ? msAt(k, m) : msAt(k, 9 * 60);
    newEvent({ start, end: start + set().defaultEventMinutes * T.MIN });
  };
  $('#btn-new-task').onclick = () => newTask({ kind: 'generic' });
  $('#btn-new-reading').onclick = () => newTask({ kind: 'reading' });
  $('#btn-resched').onclick = async () => { await cycle(); toast('Rescheduled'); };
  const menu = $('#export-menu');
  $('#btn-export').onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
  document.addEventListener('click', () => (menu.hidden = true));
  $$('#export-menu button[data-kind]').forEach((b) => (b.onclick = () => { menu.hidden = true; exportView(b.dataset.kind, b.dataset.fmt).catch(handleError); }));
  $('#export-multi').onclick = () => { menu.hidden = true; exportMulti(); };
  $('#export-custom').onclick = () => { menu.hidden = true; exportCustom(); };
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && !e.target.closest('input, textarea, select, [contenteditable]') && !document.querySelector('dialog[open]')) { e.preventDefault(); undo(); return; }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); openCommandBar(); return; }
    if (e.target.closest('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open]') || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    const cmd = commandForKey(k);
    if (cmd) { e.preventDefault(); cmd.run(); }
    else if (k === 'escape') { closePopover(); closeDrawer(); }
  });
}

async function init() {
  // A sign-in popup for another account landed here: hand the result back and close.
  if (AC.handlePopupReturn()) return;
  await AC.loadAccounts();
  // Web app: finish a Google sign-in that just came back in the URL, or renew an expired one silently.
  const redirect = await G.completeRedirect();
  app.state = await E.loadState();
  setQuickTz(set().tz);
  app.cursor = app.miniCursor = T.dayKey(Date.now(), tz());
  if (innerWidth < 760) app.view = 'day';
  { const v = new URLSearchParams(location.search).get('view'); if (['day', '3day', 'week', 'month', 'analysis', 'review', 'goals'].includes(v)) app.view = v; }
  if (redirect?.ret?.view) { app.view = redirect.ret.view; app.cursor = app.miniCursor = redirect.ret.cursor || app.cursor; }
  if (redirect?.ok) { sessionStorage.removeItem('tempo:silentTried'); sessionStorage.removeItem('tempo:silentAt'); }
  if (redirect && !redirect.ok && redirect.kind === 'silent' && redirect.ret?.autoInteractive && ['interaction_required', 'login_required', 'consent_required'].includes(redirect.code)) {
    return G.redirectToGoogle(G.clientFor(st().auth || {})?.id, st().auth || {}, 'interactive', { view: app.view, cursor: app.cursor });
  }
  if (!redirect && await G.needsSilentRenew() && Date.now() - (+sessionStorage.getItem('tempo:silentAt') || 0) > RENEW_GAP) {
    sessionStorage.setItem('tempo:silentAt', String(Date.now()));
    document.body.classList.add('signing-in');
    return G.silentRenew({ view: app.view, cursor: app.cursor });
  }
  try { const ao = (await storeGet('analysisOpts')).analysisOpts; if (ao) Object.assign(app.anOpts, ao); } catch { /* ignore */ }
  bindToolbar();
  setStatus(E.connected(st()) ? 'Loading…' : 'Local mode');
  await render();
  if (redirect?.ret?.scroll != null) { const sc = $('.tg-scroll'); if (sc) sc.scrollTop = redirect.ret.scroll; }
  planRenew();
  if (redirect && !redirect.ok) {
    if (redirect.kind === 'silent') renderBanner();
    else toast(redirect.error, { ms: 10000 });
  }
  if (E.connected(st())) {
    try {
      await E.refreshCalendars(st());
      if (redirect?.ok && redirect.kind === 'interactive') {
        const gtz = await G.getSettingTz().catch(() => null);
        if (gtz && T.isValidTz(gtz) && !st().settings._tzChosen) st().settings.tz = gtz;
        st().auth = (await storeGet('auth')).auth || {};
        if (redirect.ret?.after === 'driveBackup') afterDriveGrant();
        else toast(`Connected to Google Calendar${st().auth.email ? ' as ' + st().auth.email : ''}`);
      }
      await E.persist(st(), ['gmeta', 'settings']);
    } catch (err) { handleError(err); }
  }
  window.__tempo = { app, cycle, render, gameRefresh, S, T, E, checkGoalNotice, checkGoogle: async () => { app.gCursors ||= {}; if (await E.googleChanged(st(), app.gCursors)) { E.invalidate(); await cycle({ pull: true }); return true; } return false; } }; // handy for debugging from the console
  markBaseline();
  setupApi();
  setupSwipe();
  loadTimer();
  await cycle({ pull: true });
  maybeOfferReview();
  // First-time onboarding: show if not connected and user hasn't dismissed it before
  if (!E.connected(st())) {
    let seen = false;
    try { seen = localStorage.getItem('tempo:onboardDone') === '1'; } catch { /* storage blocked */ }
    if (!seen) {
      D.onboardingWizard(ctx).then((r) => {
        try { localStorage.setItem('tempo:onboardDone', '1'); } catch { /* storage blocked */ }
        if (r?.connected) { renderBanner(); render(); }
      });
    }
  }
  setTimeout(checkGoalNotice, 3000);
  setInterval(checkGoalNotice, 60000);
  // Calendars list in the sidebar: fold away / unfold (remembered on this device)
  const calSec = $('.cal-sec'), calTg = $('#cal-toggle');
  const setCalsOpen = (open) => { calSec?.classList.toggle('collapsed', !open); calTg?.setAttribute('aria-expanded', String(open)); };
  try { setCalsOpen(localStorage.getItem('tempo:calsCollapsed') !== '1'); } catch { /* storage blocked */ }
  calTg?.addEventListener('click', () => { const open = calSec.classList.contains('collapsed'); setCalsOpen(open); try { localStorage.setItem('tempo:calsCollapsed', open ? '0' : '1'); } catch { /* storage blocked */ } });
  // weather: today's and tomorrow's forecasts change most — check again every 30 minutes, and on coming back
  gameActive();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) gameActive(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) W.refresh(set()).then((fresh) => { if (fresh) render(); }); });
  if (isWeb) startWebReminders();
  if (isWeb && 'serviceWorker' in navigator && document.querySelector('link[rel=manifest]')) navigator.serviceWorker.register('sw.js').catch(() => {});
  addEventListener('offline', () => { offlineStatus(); toast('You’re offline — showing your saved calendar. Changes sync when you’re back.', { noUndo: true, ms: 5000 }); });
  addEventListener('online', () => { st().offline = null; E.invalidate(); cycle({ pull: true }); });
  setInterval(() => cycle({ pull: true }), 5 * 60 * 1000);
  // Auto-refresh: while the app is open, check Google every 45 s for changes made elsewhere (phone, Google Calendar,
  // another browser) and reload when something changed.
  setInterval(async () => {
    if (document.hidden || cycling || !E.connected(st()) || document.querySelector('dialog[open], .popover') || app.touchLock) return;
    try {
      app.gCursors ||= {};
      if (await E.googleChanged(st(), app.gCursors)) { E.invalidate(); await cycle({ pull: true }); }
    } catch { /* offline or signed out: the banner handles it */ }
  }, 45000);
  // Another tab of the web app changed your tasks: show them here too.
  window.addEventListener('storage', (e) => {
    if (e.key === 'tempo:tasks' && e.newValue && !cycling) { try { st().tasks = JSON.parse(e.newValue); render(); } catch { /* ignore */ } }
  });
  const beat = () => storeSet({ appHeartbeat: Date.now() });
  beat(); setInterval(beat, 30000);
  setInterval(() => {
    const n = $('.tg-col.today .now');
    if (n) n.style.top = (T.minutesOfDay(Date.now(), tz()) / 60) * set().hourHeight + 'px';
  }, 60000);
  let lastVisible = Date.now();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - lastVisible > 15000) { E.invalidate(); cycle({ pull: true }); }
    if (document.hidden) lastVisible = Date.now();
  });
}

// Web app: show reminders while the app is open (the Google Calendar app on your phone also notifies,
// because task sessions are written there with reminders).
function startWebReminders() {
  if (!('Notification' in window)) return;
  const fired = new Set();
  setInterval(async () => {
    if (Notification.permission !== 'granted') return;
    const now = Date.now();
    for (const r of st().reminderQueue || []) {
      if (r.when > now || now - r.when > 10 * 60000 || fired.has(r.id)) continue;
      fired.add(r.id);
      try {
        const reg = await navigator.serviceWorker?.getRegistration?.();
        if (reg) reg.showNotification(r.title, { body: r.body, icon: 'icons/icon192.png', tag: r.id });
        else new Notification(r.title, { body: r.body, icon: 'icons/icon192.png', tag: r.id });
      } catch { /* ignore */ }
    }
  }, 30000);
}

init().catch((e) => { console.error(e); const pre = document.createElement('pre'); pre.className = 'fatal'; pre.textContent = String(e.stack || e); document.body.appendChild(pre); });
