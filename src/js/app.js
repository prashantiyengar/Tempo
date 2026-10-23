// Tempo Calendar — main UI: views, drag interactions, sidebar, sync loop.
import * as T from './tz.js';
import * as S from './scheduler.js';
import * as E from './engine.js';
import * as EV from './events.js';
import * as G from './gcal.js';
import * as D from './dialogs.js';
import * as X from './export.js';
import * as A from './analysis.js';
import { describe } from './rrule.js';
import * as C from './categories.js';
import * as AC from './accounts.js';
import { ext, isWeb, get as storeGet, set as storeSet } from './storage.js';
import { $, $$, esc, el, toast as uiToast, choose, popover, closePopover, download, modal, setHTML, setQuickTz } from './ui.js';
import * as RV from './review.js';
import { parseTask } from './parse.js';
import { createApi, AI_PROMPT } from './api.js';
import * as N from './notify.js';
import * as W from './weather.js';
import * as NP from './paper.js';
import * as XT from './extras.js';
import * as GL from './goals.js';
import * as P from './projects.js';

const LOCAL_COLOR = '#5b7c99';
const app = {
  state: null, view: 'week', cursor: null, miniCursor: null,
  items: new Map(), lastBusy: [], scrolled: false, status: { text: '', kind: '' },
  shownProblems: new Set(), renderSeq: 0,
};
const st = () => app.state;
const tz = () => app.state.settings.tz;
const set = () => app.state.settings;

// Context handed to dialogs
const ctx = {
  get state() { return app.state; },
  externalChanged() { AC.invalidateExternal(); render(); cycle(); },
  lastEventEnd: (o) => lastEventEnd(o),
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
  async saveSettings() { await E.persist(st(), ['settings']); },
  taskCalendars() { return E.connected(st()) ? (st().gmeta.calendars || []).filter((c) => ['owner', 'writer'].includes(c.accessRole)) : []; },
  defaultTaskCal() { return E.defaultTaskCal(st()); },
  async testNotification() { notify('Tempo Calendar', 'Notifications are working.'); },
  exportJson() {
    const { settings, tasks, localEvents } = st();
    download(new Blob([JSON.stringify({ app: 'tempo', version: 1, settings, tasks, localEvents }, null, 2)], { type: 'application/json' }), `tempo-backup-${T.dayKey(Date.now(), tz())}.json`);
  },
};

const returnState = (extra = {}) => ({ view: app.view, cursor: app.cursor, ...extra });

// Reconnect: in the web app, try a silent renew first and fall back to the Google prompt only if needed.
function reconnectGoogle() {
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
function range(view = app.view, cursor = app.cursor) {
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
function toast(msg, opts = {}) {
  const top = undoStack[undoStack.length - 1];
  if (!opts.action && !opts.noUndo && top && Date.now() - top.at < 2500) return uiToast(msg, { ...opts, action: 'Undo', onAction: undo, ms: Math.max(opts.ms || 0, 6000) });
  return uiToast(msg, opts);
}

function calColor(calId) {
  if (calId === E.LOCAL_CAL) return LOCAL_COLOR;
  return (st().gmeta.calendars || []).find((c) => c.id === calId)?.color || '#4f6bed';
}

function eventItem(ev) {
  const iv = E.interval(ev, tz());
  const me = ev.attendees?.find((a) => a.self);
  const item = {
    key: `${ev._calId}|${ev.id}`, kind: 'event', title: ev.summary || '(No title)', ...iv,
    color: ev._color || (ev.colorId ? G.EVENT_COLORS[ev.colorId] : calColor(ev._calId)), ev,
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
async function setEventDone(it, done, { quiet = false } = {}) {
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

async function collectItems(days) {
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
async function render() {
  const seq = ++app.renderSeq;
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

function segMinutes(it, k) {
  const z = tz();
  const ds = T.dayStart(k, z), de = T.dayStart(T.addDays(k, 1), z);
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

  const root = el(`<div class="tg" style="--hh:${hh}px;--ncol:${days.length}">
    <div class="tg-head">
      <div class="tg-gutter"><span class="tz-label" title="${esc(z)}">${esc(tzAbbr())}</span></div>
      ${days.map((k) => `<div class="tg-dayhead ${k === todayK ? 'today' : ''} ${k < todayK ? 'past' : ''} ${S.leaveOf(set(), k) ? 'on-leave lv-' + S.leaveOf(set(), k) : ''}" data-day="${k}">
        <button class="wd leave-menu" data-leave="${k}" title="Mark this day as on leave or sick leave">${esc(T.format(T.dayStart(k, z), z, { weekday: 'short' }))}</button><button class="dn" data-goto="${k}">${T.parseKey(k).d}</button>${W.dayHTML(set(), k, todayK)}${leaveTag(k)}</div>`).join('')}
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
    if (k === todayK) col.appendChild(el(`<div class="now" style="top:${(T.minutesOfDay(Date.now(), z) / 60) * hh}px"></div>`));
    colsEl.appendChild(col);
  }

  if (drawErrors.length) { console.error('Tempo: items not drawn', drawErrors); toast(`${drawErrors.length} item(s) couldn't be drawn: ${drawErrors[0][0]} — ${drawErrors[0][1].message}`, { ms: 8000 }); }

  $$('.dn', root).forEach((b) => b.addEventListener('click', () => { app.cursor = b.dataset.goto; app.view = 'day'; render(); }));
  $$('[data-leave]', root).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); leaveMenu(b.dataset.leave, b.getBoundingClientRect()); }));
  colsEl.addEventListener('pointerdown', onGridPointerDown);
  $('.ad-area', root).addEventListener('pointerdown', onAllDayPointerDown);
  return root;
}

function renderMonth({ days, monthKey }, items) {
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
      <button class="m-dn" data-goto="${k}">${T.parseKey(k).d}</button>${W.dayHTML(set(), k, todayK, { month: true })}${leaveTag(k, true)}
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
  grid.addEventListener('pointerdown', onMonthPointerDown);
  return root;
}

// ======================================================================================
// Sidebar
// ======================================================================================
function renderSidebar() {
  renderMini();
  const s = set(), hidden = new Set(s.hiddenCalendars || []);
  const cals = [
    ...(E.connected(st()) ? (st().gmeta.calendars || []) : []),
    { id: E.LOCAL_CAL, summary: 'Local (this browser)', color: LOCAL_COLOR },
    { id: 'tasks', summary: 'Task sessions', color: '#8a5cf6' },
    ...AC.extCalendars().map((c) => ({ id: c.key, summary: `${c.name} · ${c.account.label}`, color: c.color || '#888' })),
  ];
  { const shown = cals.filter((c) => !hidden.has(c.id)).length; const cc = $('.cal-count'); if (cc) cc.textContent = shown === cals.length ? `${cals.length}` : `${shown}/${cals.length}`; }
  setHTML($('#cal-list'), cals.map((c) => `<label class="cal-row" title="${esc(c.summary)}">
    <input type="checkbox" data-cal="${esc(c.id)}" ${hidden.has(c.id) ? '' : 'checked'}><i style="--c:${c.color}"></i><span>${esc(c.summary)}</span></label>`).join('')
    + (E.connected(st()) ? '' : `<button class="btn small ghost wide" id="connect-cta">${G.builtinAvailable() ? 'Sign in with Google' : 'Connect Google Calendar…'}</button>`));
  $$('#cal-list input').forEach((cb) => cb.addEventListener('change', async () => {
    const id = cb.dataset.cal;
    const h = new Set(set().hiddenCalendars || []);
    cb.checked ? h.delete(id) : h.add(id);
    set().hiddenCalendars = [...h];
    await E.persist(st(), ['settings']);
    render();
    if (id !== 'tasks' && !set().busyCalendars) cycle();
  }));
  $('#connect-cta')?.addEventListener('click', openConnect);

  const now = Date.now();
  const tasks = S.sortTasks(st().tasks.filter((t) => !t.archived));
  const row = (t) => {
    const p = S.progress(t, now);
    const ss = S.sessions(t);
    const doneN = ss.filter((c) => c.kind === 'done' || (c.kind === 'pinned' && c.end <= now)).length;
    const complete = !t.repeat && p.pct >= 100;
    const warn = !complete && t.lastPlan?.shortfall > 0;
    const late = !complete && !warn && t.lastPlan?.late > 0;
    const next = ss.find((c) => c.kind !== 'done' && c.end > now);
    const waiting = t.lastPlan?.waitingFor?.length ? st().tasks.filter((x) => t.lastPlan.waitingFor.includes(x.id)).map((x) => x.title) : [];
    const meta = t.repeat
      ? `↻ ${T.fmtDur(p.done)} of ${T.fmtDur(p.total)} ${t.repeat.every === 'week' ? 'this week' : 'today'}`
      : complete ? 'Done ✓' : `${doneN}/${ss.length} · due ${T.format(t.deadline, tz(), { weekday: 'short', day: 'numeric', month: 'short' })}`;
    return `<button class="task-row ${complete ? 'complete' : ''} ${t.projectId ? 'in-proj' : ''}" data-task="${t.id}" style="--c:${t.color}">
      <span class="rank" title="Rank ${t.rank}">${t.rank}</span>
      <span class="tr-main">
        <span class="tr-title">${t.categoryIcon ? esc(t.categoryIcon) + ' ' : (t.kind === 'reading' ? '📖 ' : '')}${esc(t.title)}${warn ? ' <span class="warn-ic" title="Not enough time before the deadline">⚠</span>' : ''}${late ? ' <span class="late-ic" title="Runs into the safety margin before the deadline">◔</span>' : ''}${timer?.taskId === t.id ? ' <span title="Timer running">⏱</span>' : ''}</span>
        <span class="tr-meta">${t.categoryId ? `<span class="tr-cat">${esc(C.catById(set(), t.categoryId)?.name || t.categoryName || '')}</span> · ` : ''}${esc(meta)}${waiting.length ? ` · ⏳ after ${esc(waiting.join(', '))}` : next && !complete ? ` · next ${esc(T.format(next.start, tz(), { weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: set().h12 }))}` : ''}</span>
        <span class="bar"><i style="width:${p.pct}%"></i></span>
      </span></button>`;
  };
  // Tasks of a project are grouped under it, in step order.
  const projects = set().projects || [];
  const html = [];
  const seen = new Set();
  for (const t of tasks) {
    if (seen.has(t.id)) continue;
    const proj = t.projectId && projects.find((p) => p.id === t.projectId);
    if (!proj) { html.push(row(t)); seen.add(t.id); continue; }
    const kids = st().tasks.filter((x) => x.projectId === proj.id && !x.archived).sort((a, b) => (a.projectStep ?? 1e9) - (b.projectStep ?? 1e9) || (a.created || 0) - (b.created || 0));
    const doneKids = kids.filter((x) => S.progress(x, now).pct >= 100).length;
    html.push(`<div class="proj-head" title="${proj.sequential ? 'Steps run in order' : 'Project'}">📁 <b>${esc(proj.name)}</b> <span class="muted small">${doneKids}/${kids.length} done${proj.sequential ? ' · in order' : ''}</span></div>`);
    for (const k of kids) { html.push(row(k)); seen.add(k.id); }
  }
  setHTML($('#task-list'), tasks.length ? html.join('') : `<p class="muted small empty">No tasks yet. Type one above, or use + Task — Tempo splits it into sessions around your calendar.</p>`);
  $$('#task-list .task-row').forEach((b) => b.addEventListener('click', () => editTask(st().tasks.find((t) => t.id === b.dataset.task))));
  renderLater();
}

// ---------- "Later": things to schedule, but not yet (synced with your other devices like settings) ----------
const laterList = () => set().later || [];
async function saveLater(list, label) {
  const before = laterList();
  set().later = list;
  await E.persist(st(), ['settings']);
  syncSharedSoon();
  if (label) pushUndo(label, async () => { set().later = before; await E.persist(st(), ['settings']); renderLater(); });
  renderLater();
}
// ---------- Projects: progress in the sidebar ----------
function projectEventDone(stp) {
  if (stp.kind !== 'event' || !stp.ref) return false;
  const k = stp.ref; return !!st().eventDone?.[k];
}
function renderProjects(tab = app.sideTab || 'tasks') {
  const box = $('#proj-list'); if (!box) return;
  box.hidden = tab !== 'projects';
  const z = tz(), now = Date.now(), list = P.list(set());
  const n = $('#proj-n'); if (n) n.textContent = list.length ? String(list.filter((p) => !P.progress(p, st().tasks, now, projectEventDone).complete).length || '') : '';
  if (tab !== 'projects') return;
  const fmt = (ms) => T.format(ms, z, { weekday: 'short', day: 'numeric', month: 'short' });
  setHTML(box, `<button type="button" class="btn small wide pj-new">+ New project</button>
    ${list.length ? list.map((p) => {
      const pr = P.progress(p, st().tasks, now, projectEventDone);
      const nx = pr.next;
      const late = pr.rows.some((r) => r.late);
      const last = pr.rows.reduce((a, r) => Math.max(a, r.finish || r.st.end || 0), 0);
      return `<button type="button" class="pj-card ${pr.complete ? 'complete' : ''}" data-id="${esc(p.id)}">
        <span class="pj-t">📁 ${esc(p.name)}${late ? ' <span class="warn-ic" title="A task in it doesn\'t fit before its end date">⚠</span>' : ''}</span>
        <span class="pj-meta">${pr.complete ? 'Done ✓' : `${pr.finished}/${pr.count} steps · ${T.fmtDur(pr.done)} of ${T.fmtDur(pr.total)}${last ? ` · done by ${esc(fmt(last))}` : ''}`}</span>
        <span class="bar"><i style="width:${pr.pct}%"></i></span>
        ${nx && !pr.complete ? `<span class="pj-next">Next: ${nx.st.kind === 'event' ? '📅' : '⧉'} ${esc(nx.st.title)}${nx.next ? ` · ${esc(fmt(nx.next))}` : ''}</span>` : ''}
        <span class="pj-dots">${pr.rows.map((r) => `<i class="${r.finished ? 'd' : r.pct ? 'p' : ''} ${r.st.kind}" title="${esc(r.st.title)} — ${r.finished ? 'done' : r.pct + '%'}"></i>`).join('')}</span>
      </button>`;
    }).join('') : '<p class="muted small empty">A project is a chain of tasks and events — e.g. a thesis: research, a meeting, writing, a deadline. Create one to see its progress here.</p>'}`);
  $('.pj-new', box).onclick = () => openProject(null);
  $$('.pj-card', box).forEach((b) => (b.onclick = () => openProject(P.byId(set(), b.dataset.id))));
}
async function openProject(p) {
  closeDrawer?.();
  const r = await D.projectDialog(ctx, p);
  if (!r) return;
  try { await saveProject(r, p); } catch (err) { handleError(err); }
}
// Create / update the steps' tasks and events, remove the ones taken out, and store the project.
async function saveProject(r, before) {
  const s = set(), z = tz();
  const evRef = (ref) => { const i = ref.indexOf('|'); return { _calId: ref.slice(0, i), id: ref.slice(i + 1) }; };
  setStatus('Saving project…', 'busy');
  for (const x of r.removed || []) {
    try {
      if (x.kind === 'task') { const t = st().tasks.find((y) => y.id === x.ref); if (t && (r.delete ? r.removeItems : true)) { st().orphanGids.push(...[...(t.planned || []), ...(t.frozen || [])].map((c) => c.gid).filter(Boolean), ...(t.orphanGids || [])); st().tasks = st().tasks.filter((y) => y.id !== t.id); st().tombstones = [...(st().tombstones || []), t.id].slice(-300); } else if (t) replaceTask({ ...t, projectId: null, projectName: null, projectStep: null }); }
      else if (x.ref && (r.delete ? r.removeItems : true)) await EV.deleteEvent(st(), evRef(x.ref), 'this');
    } catch (err) { if (!/not found|deleted|410/i.test(err.message)) handleError(err); }
  }
  if (r.delete) {
    s.projects = P.list(s).filter((x) => x.id !== before.id);
    st().tasks = st().tasks.map((t) => (t.projectId === before.id ? { ...t, projectId: null, projectName: null, projectStep: null, rev: Date.now() } : t));
    await E.persist(st(), ['settings']); syncSharedSoon(); await saveTasks('delete project'); await afterEventChange();
    toast(`Deleted project “${before.name}”`); return;
  }
  const p = r.project;
  const projectsBefore = JSON.parse(JSON.stringify(P.list(s))), createdEvents = [];
  let prevEventEnd = 0, made = 0;
  for (let i = 0; i < p.steps.length; i++) {
    const x = p.steps[i];
    const title = P.fullTitle(p, x.title);
    if (x.kind === 'task') {
      const fields = { title, earliestStart: Math.max(x.start || 0, p.sequential ? prevEventEnd : 0) || null, deadline: x.end, totalMinutes: Math.max(5, Math.round((+x.hours || 1) * 60)), projectId: p.id, projectName: p.name, projectStep: i + 1 };
      const t = x.ref && st().tasks.find((y) => y.id === x.ref);
      if (t) {
        const changed = Object.entries(fields).some(([k, v]) => (t[k] ?? null) !== (v ?? null));
        if (changed) replaceTask({ ...t, ...fields });
      } else {
        const nt = buildDraft(fields);
        st().tasks.push(nt); x.ref = nt.id; made++;
      }
    } else {
      const body = { summary: title, start: { dateTime: new Date(x.start).toISOString(), timeZone: z }, end: { dateTime: new Date(x.end).toISOString(), timeZone: z } };
      let done = false;
      if (x.ref) {
        try { await EV.updateEvent(st(), evRef(x.ref), body, 'this'); done = true; }
        catch (err) { if (!/not found|deleted|no longer exists|410/i.test(err.message)) throw err; }
      }
      if (!done) {
        const cal = ctx.defaultCalendar();
        const ev = await EV.createEvent(st(), cal, { ...body, reminders: { useDefault: true }, extendedProperties: { private: { tempoProject: p.id, tempoStep: x.id } } });
        x.ref = `${ev._calId || cal}|${ev.id}`; made++; createdEvents.push(x.ref);
      }
      prevEventEnd = Math.max(prevEventEnd, x.end);
    }
  }
  const exists = P.byId(s, p.id);
  s.projects = exists ? P.list(s).map((y) => (y.id === p.id ? p : y)) : [...P.list(s), p];
  await E.persist(st(), ['settings', 'localEvents']); syncSharedSoon();
  await saveTasks(exists ? `edit project “${p.name}”` : `new project “${p.name}”`);
  // undo also puts the project list back and removes the events it created
  const u = undoStack[undoStack.length - 1];
  if (u) { const f0 = u.undo; u.undo = async () => { await f0(); set().projects = projectsBefore; for (const ref of createdEvents) { try { await EV.deleteEvent(st(), evRef(ref), 'this'); } catch { /* already gone */ } } await E.persist(st(), ['settings', 'localEvents']); syncSharedSoon(); E.invalidate(); await render(); }; }
  E.invalidate();
  app.sideTab = 'projects'; try { localStorage.setItem('tempo:sideTab', 'projects'); } catch { /* storage blocked */ }
  await render();
  toast(exists ? `Project “${p.name}” saved` : `Project “${p.name}” created${made ? ` — ${made} step${made > 1 ? 's' : ''} planned` : ''}`);
  cycle();
}

function renderLater() {
  const box = $('#later-list'); if (!box) return;
  const tab = app.sideTab || 'tasks';
  $$('.side-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.st === tab));
  $('#task-list').hidden = tab !== 'tasks';
  box.hidden = tab !== 'later';
  renderProjects(tab);
  $('#btn-resched').hidden = tab !== 'tasks';
  const list = laterList();
  const n = $('#later-n'); if (n) n.textContent = list.length ? String(list.length) : '';
  const z = tz();
  const today = T.dayKey(Date.now(), z);
  const due = (x) => { if (!x.deadline) return ''; const k = T.dayKey(x.deadline, z), d = T.daysBetween(today, k); return `<span class="later-due ${d < 0 ? 'over' : d <= 3 ? 'soon' : ''}" title="Deadline">by ${esc(T.format(x.deadline, z, { weekday: 'short', day: 'numeric', month: 'short' }))}</span>`; };
  setHTML(box, `<form class="later-add"><input name="t" placeholder="Something to schedule later…" maxlength="300" autocomplete="off" aria-label="Add a note"><button class="btn small" type="submit">Add</button>
      <div class="later-more"><label title="How long it will likely take">⏱ <input name="h" type="number" min="0" step="0.25" placeholder="h" aria-label="Hours"></label><label title="Must be done by">by <input name="d" type="date" aria-label="Deadline"></label></div></form>
    ${list.length ? list.map((x) => `<div class="later-row" data-id="${esc(x.id)}">
      <button type="button" class="later-t" title="Edit">${esc(x.text)}<span class="later-meta">${x.minutes ? `<span class="later-dur">⏱ ${T.fmtDur(x.minutes)}</span>` : ''}${due(x)}<span class="muted small">added ${esc(T.format(x.created, z, { day: 'numeric', month: 'short' }))}</span></span></button>
      <span class="later-acts"><button type="button" class="icon-btn sm l-task" title="Make it a task (Tempo finds the time)">⧉</button><button type="button" class="icon-btn sm l-event" title="Put it on the calendar as an event">📅</button><button type="button" class="icon-btn sm l-del" title="Remove">✕</button></span>
    </div>`).join('') : '<p class="muted small empty">Jot down things you need to schedule, but not right away. Turn one into a task or an event when you\'re ready.</p>'}`);
  $('.later-add', box).onsubmit = async (e) => {
    e.preventDefault();
    const v = e.target.t.value.trim(); if (!v) return;
    const h = parseFloat(e.target.h.value), d = e.target.d.value;
    await saveLater([...laterList(), { id: S.newId('l'), text: v.slice(0, 300), created: Date.now(), ...(h > 0 ? { minutes: Math.round(h * 60) } : {}), ...(d ? { deadline: T.atTime(d, set().bounds?.end || '17:00', z) } : {}) }], `add “${v.slice(0, 30)}” to Later`);
    $('#later-list .later-add input')?.focus();
  };
  $$('.later-row', box).forEach((r) => {
    const item = laterList().find((x) => x.id === r.dataset.id); if (!item) return;
    const drop = () => saveLater(laterList().filter((x) => x.id !== item.id), `remove “${item.text.slice(0, 30)}” from Later`);
    $('.l-del', r).onclick = () => { drop(); toast('Removed from Later'); };
    $('.l-task', r).onclick = async () => { closeDrawer(); const before = st().tasks.length; await newTask({ kind: 'generic', title: item.text, ...(item.minutes ? { totalMinutes: item.minutes } : {}), ...(item.deadline ? { deadline: item.deadline } : {}) }); if (st().tasks.length > before) drop(); };
    $('.l-event', r).onclick = async () => {
      closeDrawer();
      const start = Math.ceil((Date.now() + 15 * T.MIN) / (15 * T.MIN)) * 15 * T.MIN;
      const n0 = createdEvents;
      await newEvent({ start, end: start + Math.min(8 * 60, item.minutes || set().defaultEventMinutes || 60) * T.MIN, title: item.text });
      if (createdEvents > n0) drop();
    };
    $('.later-t', r).onclick = async () => {
      const v = await modal(`<form class="choice"><h2>Edit note</h2><textarea name="v" rows="3" maxlength="300" style="width:100%">${esc(item.text)}</textarea>
        <div class="row"><label class="field"><span>Likely takes (hours)</span><input name="h" type="number" min="0" step="0.25" value="${item.minutes ? +(item.minutes / 60).toFixed(2) : ''}" placeholder="—"></label>
        <label class="field"><span>Must be done by</span><input name="d" type="date" value="${item.deadline ? T.dayKey(item.deadline, z) : ''}"></label></div>
        <div class="actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">Save</button></div></form>`,
      (dlg, close) => { const f = $('form', dlg); f.onsubmit = (e) => { e.preventDefault(); close({ text: f.v.value.trim(), h: parseFloat(f.h.value), d: f.d.value }); }; setTimeout(() => f.v.focus(), 30); }, { cls: 'narrow' });
      if (v == null) return;
      if (!v.text) return drop();
      const upd = { text: v.text.slice(0, 300), minutes: v.h > 0 ? Math.round(v.h * 60) : undefined, deadline: v.d ? T.atTime(v.d, set().bounds?.end || '17:00', z) : undefined };
      await saveLater(laterList().map((x) => (x.id === item.id ? { ...x, ...upd } : x)), 'edit note');
    };
  });
}

function renderMini() {
  const z = tz();
  const mk = app.miniCursor;
  const { y, m } = T.parseKey(mk);
  const first = T.keyOf(y, m, 1);
  const start = T.startOfWeek(first, set().weekStart);
  const todayK = T.dayKey(Date.now(), z);
  const { days } = range();
  const inRange = new Set(app.view === 'month' ? [] : days);
  setHTML($('#mini'), `
    <div class="mini-head"><span>${esc(T.format(T.dayStart(first, z), z, { month: 'long', year: 'numeric' }))}</span>
      <span><button class="icon-btn sm" data-mini="-1" aria-label="Previous month">‹</button><button class="icon-btn sm" data-mini="1" aria-label="Next month">›</button></span></div>
    <div class="mini-grid">
      ${Array.from({ length: 7 }, (_, i) => `<span class="mw">${esc(T.format(T.dayStart(T.addDays(start, i), z), z, { weekday: 'narrow' }))}</span>`).join('')}
      ${Array.from({ length: 42 }, (_, i) => { const k = T.addDays(start, i); return `<button class="md ${T.parseKey(k).m !== m ? 'out' : ''} ${k === todayK ? 'today' : ''} ${inRange.has(k) ? 'sel' : ''} ${k === app.cursor ? 'cur' : ''}" data-day="${k}">${T.parseKey(k).d}</button>`; }).join('')}
    </div>`);
  $$('#mini [data-mini]').forEach((b) => b.addEventListener('click', () => { app.miniCursor = T.addMonths(app.miniCursor, +b.dataset.mini); renderMini(); }));
  $$('#mini .md').forEach((b) => b.addEventListener('click', () => { app.cursor = b.dataset.day; if (app.view === 'analysis') app.view = 'week'; render(); }));
}

// ======================================================================================
// Pointer interactions
// ======================================================================================
const snapM = () => set().snapMinutes;
const floorSnap = (m) => Math.floor(m / snapM()) * snapM();
const roundSnap = (m) => Math.round(m / snapM()) * snapM();
const msAt = (k, min) => { const { y, m, d } = T.parseKey(k); return T.zonedMs(y, m, d, 0, min, tz()); };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function minuteAt(clientY, col) {
  const r = col.getBoundingClientRect();
  return clamp(((clientY - r.top) / set().hourHeight) * 60, 0, 1440);
}
function colAt(clientX) {
  return $$('.tg-col').find((c) => { const r = c.getBoundingClientRect(); return clientX >= r.left && clientX < r.right; });
}

function autoScroll(e) {
  const sc = $('.tg-scroll');
  if (!sc) return;
  const r = sc.getBoundingClientRect();
  if (e.clientY > r.bottom - 30) sc.scrollTop += 12;
  else if (e.clientY < r.top + 30) sc.scrollTop -= 12;
}

function track(onMove, onUp) {
  const move = (e) => { e.preventDefault(); onMove(e); };
  const up = (e) => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); onUp(e); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

function onGridPointerDown(e) {
  if (e.pointerType === 'touch' || e.pointerType === 'pen') return touchDown(e, 'grid');
  if (e.button !== 0) return;
  const col = e.target.closest('.tg-col');
  if (!col) return;
  const evEl = e.target.closest('.ev');
  if (e.target.closest('.deadline')) return;
  closePopover();
  e.preventDefault();
  if (evEl) return dragEvent(e, evEl, col);

  // Drag on empty space to create
  const day = col.dataset.day;
  const m0 = floorSnap(minuteAt(e.clientY, col));
  const ghost = el(`<div class="ev ghost-sel"><div class="ev-t">(New)</div><div class="ev-time"></div></div>`);
  col.appendChild(ghost);
  let a = m0, b = m0 + snapM(), moved = false;
  const y0 = e.clientY;
  const paint = () => {
    ghost.style.top = (a / 60) * set().hourHeight + 'px';
    ghost.style.height = Math.max(14, ((b - a) / 60) * set().hourHeight - 2) + 'px';
    $('.ev-time', ghost).textContent = `${T.fmtTime(msAt(day, a), tz(), set().h12)} – ${T.fmtTime(msAt(day, b), tz(), set().h12)}`;
  };
  paint();
  track((ev) => {
    if (Math.abs(ev.clientY - y0) > 4) moved = true;
    autoScroll(ev);
    const m = minuteAt(ev.clientY, col);
    if (m >= m0) { a = m0; b = Math.max(m0 + snapM(), Math.ceil(m / snapM()) * snapM()); }
    else { a = floorSnap(m); b = m0 + snapM(); }
    b = Math.min(b, 1440);
    paint();
  }, () => {
    if (!moved) { a = m0; b = Math.min(1440, m0 + set().defaultEventMinutes); paint(); }
    quickCreate(ghost.getBoundingClientRect(), { start: msAt(day, a), end: msAt(day, b), allDay: false });
  });
}


// ---------------- Touch: tap = open / quick add, long-press = drag to create or move, swipe = previous / next ----------------
const LONG_PRESS = 420;
function touchDown(e, where) {
  const x0 = e.clientX, y0 = e.clientY, t0 = Date.now();
  const target = e.target;
  const col = target.closest('.tg-col');
  const evEl = target.closest('.ev, .chip');
  const cell = target.closest('.m-cell');
  if (where === 'grid' && (!col || target.closest('.deadline'))) return;
  if (where === 'month' && (!cell || target.closest('[data-goto], [data-leave]'))) return;
  closePopover();
  e.preventDefault(); // no emulated mouse events; scrolling is still handled by the browser (touch-action: pan-y)
  let lx = x0, ly = y0, active = false, done = false;
  const pid = e.pointerId;
  const timer = setTimeout(() => {
    if (done || Math.hypot(lx - x0, ly - y0) > 10) return;
    active = true; cleanup(false);
    document.body.classList.add('touch-lock'); app.touchLock = true;
    navigator.vibrate?.(12);
    // Hand over to the mouse-style drag code, starting from the current finger position.
    const fake = { button: 0, pointerType: 'mouse', clientX: lx, clientY: ly, target, preventDefault() {}, _fromLongPress: true };
    if (where === 'grid') {
      if (evEl) { const it = app.items.get(evEl.dataset.key); if (it?.editable) dragEvent(fake, evEl, col); else unlock(); }
      else onGridPointerDown({ ...fake, target: col });
    } else {
      if (evEl) { onMonthPointerDown({ ...fake, target: evEl }); }
      else { unlock(); quickCreate(cell.getBoundingClientRect(), { start: T.dayStart(cell.dataset.day, tz()), end: T.dayStart(T.addDays(cell.dataset.day, 1), tz()), allDay: true }); }
    }
    const end = () => { window.removeEventListener('pointerup', end, true); window.removeEventListener('pointercancel', end, true); setTimeout(unlock, 0); };
    window.addEventListener('pointerup', end, true); window.addEventListener('pointercancel', end, true);
  }, LONG_PRESS);
  const move = (ev) => { if (ev.pointerId === pid) { lx = ev.clientX; ly = ev.clientY; } };
  const up = (ev) => {
    if (ev.pointerId !== pid) return;
    cleanup(true);
    if (active) return;
    const dx = lx - x0, dy = ly - y0, dt = Date.now() - t0;
    if (Math.abs(dx) > 40 && Math.abs(dx) > 1.3 * Math.abs(dy)) return; // a side swipe: handled by setupSwipe
    void dt;
    if (ev.type === 'pointercancel' || Math.hypot(dx, dy) > 10) return; // it was a scroll
    // Tap
    if (evEl) { const it = app.items.get(evEl.dataset.key); if (it) openItem(it, evEl.getBoundingClientRect()); return; }
    if (where === 'month') { app.cursor = cell.dataset.day; app.view = 'day'; render(); return; }
    const day = col.dataset.day;
    const m = Math.floor(minuteAt(y0, col) / 30) * 30;
    const a = Math.min(m, 1440 - 30), b = Math.min(1440, a + set().defaultEventMinutes);
    const ghost = el(`<div class="ev ghost-sel"><div class="ev-t">(New)</div></div>`);
    ghost.style.top = (a / 60) * set().hourHeight + 'px';
    ghost.style.height = Math.max(14, ((b - a) / 60) * set().hourHeight - 2) + 'px';
    col.appendChild(ghost);
    quickCreate(ghost.getBoundingClientRect(), { start: msAt(day, a), end: msAt(day, b), allDay: false });
  };
  function cleanup(all) {
    done = done || all;
    if (all) clearTimeout(timer);
    window.removeEventListener('pointermove', move, true);
    if (all || active) { window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', up, true); }
  }
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', up, true);
}
function unlock() { document.body.classList.remove('touch-lock'); app.touchLock = false; }
// While a long-press drag is active, stop the page from scrolling under the finger.
document.addEventListener('touchmove', (e) => { if (app.touchLock && e.cancelable) e.preventDefault(); }, { passive: false });

function onAllDayPointerDown(e) {
  if (e.button !== 0) return;
  const bar = e.target.closest('.ad-bar');
  closePopover();
  if (bar) {
    const it = app.items.get(bar.dataset.key);
    const rect = bar.getBoundingClientRect();
    track(() => {}, () => it && openItem(it, rect));
    return;
  }
  const cell = e.target.closest('.ad-cell');
  if (!cell) return;
  const cells = $$('.ad-cell');
  const i0 = cells.indexOf(cell);
  let i1 = i0;
  const paint = () => cells.forEach((c, i) => c.classList.toggle('sel', i >= Math.min(i0, i1) && i <= Math.max(i0, i1)));
  paint();
  track((ev) => {
    const c = cells.findIndex((x) => { const r = x.getBoundingClientRect(); return ev.clientX >= r.left && ev.clientX < r.right; });
    if (c >= 0) { i1 = c; paint(); }
  }, () => {
    const a = cells[Math.min(i0, i1)].dataset.day, b = cells[Math.max(i0, i1)].dataset.day;
    const rect = cells[Math.max(i0, i1)].getBoundingClientRect();
    quickCreate(rect, { start: T.dayStart(a, tz()), end: T.dayStart(T.addDays(b, 1), tz()), allDay: true }, () => cells.forEach((c) => c.classList.remove('sel')));
  });
}

function dragEvent(e, evEl, col) {
  const it = app.items.get(evEl.dataset.key);
  if (!it) return;
  const rect0 = evEl.getBoundingClientRect();
  const resize = e.target.classList.contains('ev-resize');
  const x0 = e.clientX, y0 = e.clientY;
  const colDay = col.dataset.day;
  const startMin = it.start < T.dayStart(colDay, tz()) ? -((T.dayStart(colDay, tz()) - it.start) / T.MIN) : T.minutesOfDay(it.start, tz());
  const grab = minuteAt(e.clientY, col) - startMin;
  const durMin = (it.end - it.start) / T.MIN;
  let dragging = false, ns = it.start, ne = it.end;
  track((ev) => {
    if (!dragging && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
    if (!it.editable) return;
    if (!dragging) { dragging = true; evEl.classList.add('dragging'); document.body.classList.add('is-dragging'); }
    autoScroll(ev);
    if (resize) {
      const m = Math.max(roundSnap(minuteAt(ev.clientY, col)), (it.start >= T.dayStart(colDay, tz()) ? T.minutesOfDay(it.start, tz()) : 0) + snapM());
      ne = msAt(colDay, m);
      evEl.style.height = Math.max(14, ((m - Math.max(0, startMin)) / 60) * set().hourHeight - 2) + 'px';
    } else {
      const target = colAt(ev.clientX) || col;
      const m = roundSnap(minuteAt(ev.clientY, target) - grab);
      ns = msAt(target.dataset.day, m);
      ne = ns + durMin * T.MIN;
      if (evEl.parentElement !== target) target.appendChild(evEl);
      evEl.style.top = (m / 60) * set().hourHeight + 'px';
      evEl.style.left = '1px'; evEl.style.width = 'calc(100% - 6px)';
    }
    $('.ev-time', evEl).textContent = `${T.fmtTime(ns, tz(), set().h12)} – ${T.fmtTime(ne, tz(), set().h12)}`;
  }, () => {
    document.body.classList.remove('is-dragging');
    if (!dragging) return openItem(it, rect0);
    if (ns === it.start && ne === it.end) return render();
    commitMove(it, ns, ne);
  });
}

function onMonthPointerDown(e) {
  if ((e.pointerType === 'touch' || e.pointerType === 'pen') && !e._fromLongPress) return touchDown(e, 'month');
  if (e.button !== 0 || e.target.closest('[data-goto], [data-leave]')) return;
  const chip = e.target.closest('.chip');
  const cell = e.target.closest('.m-cell');
  if (!cell) return;
  closePopover();
  e.preventDefault();
  const cells = $$('.m-cell');
  const cellAt = (ev) => cells.find((c) => { const r = c.getBoundingClientRect(); return ev.clientX >= r.left && ev.clientX < r.right && ev.clientY >= r.top && ev.clientY < r.bottom; });
  if (chip) {
    const it = app.items.get(chip.dataset.key);
    const rect = chip.getBoundingClientRect();
    let target = cell, dragging = false;
    const x0 = e.clientX, y0 = e.clientY;
    track((ev) => {
      if (!it?.editable) return;
      if (!dragging && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
      dragging = true; chip.classList.add('dragging');
      const c = cellAt(ev);
      if (c && c !== target) { target = c; $('.m-items', c).appendChild(chip); }
    }, () => {
      if (!dragging) return it && openItem(it, rect);
      const shift = T.daysBetween(cell.dataset.day, target.dataset.day);
      if (!shift) return render();
      if (it.allDay) commitMove(it, T.dayStart(T.addDays(it.startKey, shift), tz()), T.dayStart(T.addDays(it.endKey, shift), tz()));
      else {
        const p = T.partsOf(it.start, tz());
        const k = T.addDays(T.dayKey(it.start, tz()), shift);
        const ns = msAt(k, p.h * 60 + p.mi);
        commitMove(it, ns, ns + (it.end - it.start));
      }
    });
    return;
  }
  const i0 = cells.indexOf(cell);
  let i1 = i0;
  const paint = () => cells.forEach((c, i) => c.classList.toggle('sel', i >= Math.min(i0, i1) && i <= Math.max(i0, i1)));
  paint();
  track((ev) => { const c = cellAt(ev); if (c) { i1 = cells.indexOf(c); paint(); } }, () => {
    const a = cells[Math.min(i0, i1)].dataset.day, b = cells[Math.max(i0, i1)].dataset.day;
    quickCreate(cells[Math.max(i0, i1)].getBoundingClientRect(), { start: T.dayStart(a, tz()), end: T.dayStart(T.addDays(b, 1), tz()), allDay: true });
  });
}

async function askScope(verb) {
  return choose(`${verb} recurring event`, null, [
    { value: 'this', label: 'This event' },
    { value: 'following', label: 'This and following events' },
    { value: 'all', label: 'All events' },
  ]);
}

async function commitMove(it, start, end) {
  try {
    if (it.kind === 'chunk') {
      replaceTask(S.pinSession(it.task, it.sess.id, start, end));
      await saveTasks(`move “${it.task.title}” session`);
      toast('Session pinned — other sessions rescheduled around it.');
      return cycle();
    }
    let scope = 'this';
    if (it.ev.recurringEventId) { scope = await askScope('Change'); if (!scope) return render(); }
    setStatus('Saving…');
    await EV.moveEvent(st(), it.ev, start, end, scope);
    undoableEventChange(`move “${it.ev.summary || 'event'}”`, it.ev, scope);
    await afterEventChange();
  } catch (err) { handleError(err); render(); }
}

// ======================================================================================
// Quick create & item popovers
// ======================================================================================
function quickCreate(rect, sel, onClose) {
  const z = tz(), s = set();
  const when = sel.allDay
    ? (T.daysBetween(T.dayKey(sel.start, z), T.dayKey(sel.end, z)) > 1
      ? `${T.format(sel.start, z, { weekday: 'short', day: 'numeric', month: 'short' })} – ${T.format(sel.end - 1, z, { weekday: 'short', day: 'numeric', month: 'short' })}`
      : T.format(sel.start, z, { weekday: 'long', day: 'numeric', month: 'long' }))
    : `${T.format(sel.start, z, { weekday: 'long', day: 'numeric', month: 'long' })} · ${T.fmtTime(sel.start, z, s.h12)} – ${T.fmtTime(sel.end, z, s.h12)}`;
  const cals = ctx.writableCalendars();
  const def = ctx.defaultCalendar();
  const durMin = Math.round((sel.end - sel.start) / T.MIN);
  popover(rect, `
    <form class="qc" novalidate>
      <input name="title" placeholder="Add title" autofocus autocomplete="off">
      <div class="qc-when">${esc(when)}${sel.allDay ? ' · all day' : ''}</div>
      ${sel.allDay ? '' : (() => {
        return `<div class="qc-times">
          <div class="qc-t"><span class="qc-l">From</span><input type="time" name="qs" step="60"><button type="button" class="now-btn st-now" title="Start now">Now</button>${nudges('st-add')}</div>
          <div class="qc-t"><span class="qc-l">To</span><input type="time" name="qe" step="60"><button type="button" class="now-btn en-now" title="End now">Now</button>${nudges('dur-add')}</div>
          <div class="qc-fill"><button type="button" class="chip-btn since-last" title="Start when the previous event ended (up to 12 h earlier)">⤒ Since last event</button><button type="button" class="chip-btn till-next" title="End when the next event starts (up to 12 h later)">⤓ Till next event</button></div>
        </div>`;
      })()}
      <div class="qc-sels"><select name="cal" aria-label="Calendar">${cals.map((c) => `<option value="${esc(c.id)}" ${c.id === def ? 'selected' : ''}>${esc(c.summary)}</option>`).join('')}</select>
      <select name="np" class="qc-np" aria-label="Notifications" title="Notification profile">${N.profiles(s).map((pr) => `<option value="${esc(pr.id)}" ${pr.id === N.eventDefault(s)?.id ? 'selected' : ''} title="${esc(N.describeProfile(pr))}">🔔 ${esc(pr.name)}</option>`).join('')}</select></div>
      <div class="qc-cat"></div>
      <div class="qc-actions">
        <button type="button" class="btn small ghost more">More options</button>
        <span class="grow"></span>
        <button type="button" class="btn small ghost qc-cancel">Cancel</button>
        <button type="submit" class="btn small primary">Save</button>
      </div>
      <div class="qc-alt">
        <span class="muted small">Or turn this into</span>
        <button type="button" class="link as-task">a split task${sel.allDay ? '' : ` (${T.fmtDur(durMin)})`}</button>
        <button type="button" class="link as-reading">a reading plan</button>
      </div>
    </form>`, (p, close) => {
    const f = $('form', p);
    setTimeout(() => f.title.focus(), 0);
    // length shortcuts: each click extends the event
    const hhmm = (ms) => T.toDTInput(ms, z).slice(11, 16);
    const redraw = () => {
      if (f.qs) { f.qs.value = hhmm(sel.start); f.qe.value = hhmm(sel.end); }
      $('.qc-when', p).textContent = `${T.format(sel.start, z, { weekday: 'long', day: 'numeric', month: 'long' })} · ${T.fmtTime(sel.start, z, s.h12)} – ${T.fmtTime(sel.end, z, s.h12)} (${T.fmtDur(Math.round((sel.end - sel.start) / T.MIN))})`;
      const g = $('.ghost-sel'); if (g) g.style.height = (((sel.end - sel.start) / T.HOUR) * s.hourHeight) + 'px';
      f.title.focus();
    };
    $$('.dur-add', p).forEach((b) => (b.onclick = () => { sel.end = Math.max(sel.start + 5 * T.MIN, sel.end + +b.dataset.add * T.MIN); redraw(); }));
    $('.st-now', p)?.addEventListener('click', () => { const d = sel.end - sel.start; sel.start = nowMin(); sel.end = sel.start + d; $('.ghost-sel')?.remove(); redraw(); });
    $('.en-now', p)?.addEventListener('click', () => { sel.end = Math.max(sel.start + 5 * T.MIN, nowMin()); redraw(); });
    // From: move the start (the end stays, unless the event would get shorter than 5 minutes)
    $$('.st-add', p).forEach((b) => (b.onclick = () => { sel.start += +b.dataset.add * T.MIN; if (sel.end < sel.start + 5 * T.MIN) sel.end = sel.start + 5 * T.MIN; redraw(); }));
    // typed times: same day as the start; an end before the start means the next day
    const fromInputs = () => {
      const day = T.dayKey(sel.start, z);
      const st0 = T.atTime(day, f.qs.value || hhmm(sel.start), z);
      let en = T.atTime(day, f.qe.value || hhmm(sel.end), z);
      if (en <= st0) en = T.atTime(T.addDays(day, 1), f.qe.value || hhmm(sel.end), z);
      sel.start = st0; sel.end = en; redraw();
    };
    if (f.qs) { f.qs.addEventListener('change', fromInputs); f.qe.addEventListener('change', fromInputs); f.qs.value = hhmm(sel.start); f.qe.value = hhmm(sel.end); }
    $('.since-last', p)?.addEventListener('click', async () => {
      const ref = sel.start, nowish = Math.abs(ref - Date.now()) < 20 * T.MIN;
      const r = await lastEventEnd({ ref: nowish ? null : ref });
      if (!r.found && !nowish) { toast('No earlier event in the 12 hours before this slot.', { noUndo: true }); return; }
      sel.start = r.start;
      if (nowish) sel.end = Math.max(r.end, sel.start + 5 * T.MIN);
      else if (sel.end <= sel.start) sel.end = sel.start + 5 * T.MIN;
      $('.ghost-sel')?.remove(); redraw(); toast(r.note, { noUndo: true });
    });
    $('.qc-cancel', p)?.addEventListener('click', () => { close(); onClose?.(); });
    let qcCat = null;
    C.categoryPicker($('.qc-cat', p), { compact: true,
      settings: set(), selected: null,
      onChange: (c) => { qcCat = c; },
      onCreate: async (name, color, icon, parent) => { const c = C.newCategory(set(), name, color, icon, parent); await E.persist(st(), ['settings']); return c; },
    });
    $('.till-next', p)?.addEventListener('click', async () => {
      const r = await nextEventStart({ ref: sel.start });
      if (!r.found) { toast(r.note, { noUndo: true }); return; }
      sel.end = r.end; $('.ghost-sel')?.remove(); redraw(); toast(r.note, { noUndo: true });
    });
    let saving = false;
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (saving) return;
      // No title: use the category's name, or ask (picking a category in the prompt uses its name)
      let title = f.title.value.trim(), cat = qcCat;
      if (!title) {
        if (cat) title = cat.name;
        else {
          saving = true;
          const a = await D.askTitle(set(), { what: 'event', onCreate: async (name, color, icon, parent) => { const c = C.newCategory(set(), name, color, icon, parent); await E.persist(st(), ['settings']); return c; } });
          saving = false;
          if (!a) { f.title.focus(); return; }
          title = a.title; cat = a.cat || cat;
        }
      }
      const g = f.cal.value !== E.LOCAL_CAL, prof = N.profileById(set(), f.np.value);
      const body = { ...selBody(sel, title, f.cal.value), ...(cat ? C.eventCategoryChanges({}, cat) : {}) };
      if (prof) {
        body.reminders = { useDefault: false, overrides: N.overrides(prof.rules, { google: g }) };
        body.extendedProperties = { ...(body.extendedProperties || {}), private: { ...(body.extendedProperties?.private || {}), tempoNotify: prof.id } };
      }
      close(); onClose?.();
      await saveNewEvent(f.cal.value, body);
    });
    $('.more', p).onclick = () => { const v = { title: f.title.value, calId: f.cal.value, categoryId: qcCat?.id, notifyProfile: f.np.value }; close(); onClose?.(); newEvent({ ...sel, ...v }); };
    $('.as-task', p).onclick = () => { const title = f.title.value; close(); onClose?.(); newTask({ kind: 'generic', title, earliestStart: sel.allDay ? null : sel.start, totalMinutes: sel.allDay ? null : Math.round((sel.end - sel.start) / T.MIN) }); };
    $('.as-reading', p).onclick = () => { const title = f.title.value; close(); onClose?.(); newTask({ kind: 'reading', title, earliestStart: sel.allDay ? null : sel.start }); };
  });
}

// Compact −/+ time buttons: two joined groups, e.g. [−1h|−30|−10|−5] [+5|+15|+30|+1h]
function nudges(cls) {
  const b = (m, l) => `<button type="button" class="${cls} ${m < 0 ? 'minus' : ''}" data-add="${m}" title="${m < 0 ? '' : '+'}${m} min">${l}</button>`;
  return `<span class="nudges"><span class="nudge">${b(-60, '−1h')}${b(-30, '−30')}${b(-10, '−10')}${b(-5, '−5')}</span><span class="nudge">${b(5, '+5')}${b(15, '+15')}${b(30, '+30')}${b(60, '+1h')}</span></span>`;
}


function selBody(sel, title, calId) {
  const z = tz();
  const body = { summary: title };
  if (sel.allDay) { body.start = { date: T.dayKey(sel.start, z) }; body.end = { date: T.dayKey(sel.end, z) }; }
  else { body.start = { dateTime: new Date(sel.start).toISOString(), timeZone: z }; body.end = { dateTime: new Date(sel.end).toISOString(), timeZone: z }; }
  if (calId === E.LOCAL_CAL) body.reminders = { useDefault: false, overrides: [{ method: 'popup', minutes: set().defaultReminder }] };
  return body;
}

let createdEvents = 0;
async function saveNewEvent(calId, body, opts) {
  try {
    setStatus('Saving…');
    const created = await EV.createEvent(st(), calId, body, opts);
    createdEvents++;
    pushUndo(`create “${body.summary || 'event'}”`, async () => { await EV.deleteEvent(st(), created, 'this'); await afterEventChange(); });
    await afterEventChange();
    toast('Event created');
  } catch (err) { handleError(err); render(); }
}

async function afterEventChange() {
  await E.persist(st(), ['localEvents']);
  E.invalidate();
  setStatus('');
  await render();
  cycle(); // busy time changed -> tasks may need to move
}

function fmtWhen(it) {
  const z = tz(), s = set();
  if (it.allDay) {
    const last = T.addDays(it.endKey, -1);
    const a = T.format(T.dayStart(it.startKey, z), z, { weekday: 'long', day: 'numeric', month: 'long' });
    return last === it.startKey ? a : `${a} – ${T.format(T.dayStart(last, z), z, { weekday: 'long', day: 'numeric', month: 'long' })}`;
  }
  const sameDay = T.dayKey(it.start, z) === T.dayKey(it.end - 1, z);
  return sameDay
    ? `${T.format(it.start, z, { weekday: 'long', day: 'numeric', month: 'long' })} · ${T.fmtTime(it.start, z, s.h12)} – ${T.fmtTime(it.end, z, s.h12)}`
    : `${T.format(it.start, z, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: s.h12 })} – ${T.format(it.end, z, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: s.h12 })}`;
}

function openItem(it, rect) {
  if (it.kind === 'chunk') return openChunk(it, rect);
  const ev = it.ev;
  const cal = it.ev._calId === E.LOCAL_CAL ? { summary: 'Local (this browser)' } : ev._calName ? { summary: ev._calName } : (st().gmeta.calendars || []).find((c) => c.id === ev._calId);
  const rems = ev.reminders?.useDefault === false ? (ev.reminders.overrides || []) : null;
  const meet = ev.hangoutLink || ev.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri;
  const evTz = ev.start?.timeZone && ev.start.timeZone !== tz() ? ev.start.timeZone : null;
  const desc = (ev.description || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();
  popover(rect, `
    <div class="pop">
      <div class="pop-tools">
        ${it.editable ? '<button class="icon-btn edit" title="Edit">✎</button><button class="icon-btn del" title="Delete">🗑</button>' : ''}
        ${ev.htmlLink ? `<a class="icon-btn" href="${esc(ev.htmlLink)}" target="_blank" rel="noopener" title="Open in ${ev._ext === 'outlook' ? 'Outlook' : 'Google Calendar'}">↗</a>` : ''}
        <button class="icon-btn x" title="Close">✕</button>
      </div>
      <div class="pop-title"><i style="--c:${it.color}"></i><h3>${esc(it.title)}</h3>${it.evDone ? '<span class="pill ok">Done</span>' : ''}</div>
      <div class="pop-row small"><button class="cat-chip on pop-evcat" ${it.catId ? `style="--c:${esc(C.catById(set(), it.catId)?.color || it.color)}"` : ''}>${it.catId ? `<i></i>${esc(C.catLabel(C.catById(set(), it.catId)) || 'Category')}` : '+ Category'} ▾</button></div>
      ${ev.extendedProperties?.private?.tempoTask ? '<div class="pop-row warnbox small">This is a Tempo task session that isn’t loaded in this browser yet. <button class="link load-tasks">Load tasks from Google</button></div>' : ''}
      <div class="pop-row">${esc(fmtWhen(it))}${evTz ? `<div class="muted small">Event time zone: ${esc(evTz)}</div>` : ''}${ev.recurrence?.length ? `<div class="muted small">${esc(describe(ev.recurrence))}</div>` : ev.recurringEventId ? '<div class="muted small">↻ Repeating event</div>' : ''}</div>
      ${ev.location ? `<div class="pop-row">📍 ${esc(ev.location)}${E.hasPlace(ev) && set().travelMinutes ? `<div class="muted small">🚗 ${set().travelMinutes} min travel buffer before and after</div>` : ''}</div>` : ''}
      ${meet ? `<div class="pop-row"><a class="btn small primary" href="${esc(meet)}" target="_blank" rel="noopener">Join video call</a></div>` : ''}
      ${ev.attendees?.length ? `<div class="pop-row small">👥 ${ev.attendees.length} guest${ev.attendees.length > 1 ? 's' : ''}: ${esc(ev.attendees.slice(0, 4).map((a) => a.displayName || a.email).join(', '))}${ev.attendees.length > 4 ? '…' : ''}</div>` : ''}
      ${rems ? `<div class="pop-row small">🔔 ${rems.length ? esc(rems.map((r) => `${T.fmtDur(r.minutes)} before${r.method === 'email' ? ' (email)' : ''}`).join(', ')) : 'No notifications'}</div>` : ''}
      ${desc ? `<div class="pop-row desc">${esc(desc.slice(0, 400))}${desc.length > 400 ? '…' : ''}</div>` : ''}
      <div class="pop-row pop-actions">${it.evDone ? '<button class="btn small ev-undone">↺ Mark undone</button>' : '<button class="btn small ev-done">✓ Mark done</button>'}${it.editable && !it.allDay && it.start <= Date.now() && it.end > Date.now() ? '<button class="btn small fin-early">⏹ Finished early</button>' : ''}${!it.allDay ? '<button class="btn small ghost add-during" title="Record something else you did during this event, e.g. an hour of chores during childcare">＋ Add during this</button>' : ''}</div>
      <div class="pop-row muted small">📅 ${esc(cal?.summary || ev._calId)}${ev.transparency === 'transparent' ? ' · free' : ''}${!it.editable ? ' · read-only' : ''}</div>
    </div>`, (p, close) => {
    $('.x', p).onclick = close;
    $('.load-tasks', p)?.addEventListener('click', () => { close(); refreshFromServer(); });
    $('.fin-early', p)?.addEventListener('click', () => { close(); finishedEarly(it); });
    $('.add-during', p)?.addEventListener('click', () => { close(); addDuring(it); });
    const toggle = (done) => async () => { close(); try { await setEventDone(it, done); } catch (err) { handleError(err); } };
    $('.ev-done', p)?.addEventListener('click', toggle(true));
    $('.ev-undone', p)?.addEventListener('click', toggle(false));
    $('.pop-evcat', p).onclick = () => { close(); pickEventCategory(it); };
    $('.edit', p)?.addEventListener('click', () => { close(); editEvent(it); });
    $('.del', p)?.addEventListener('click', async () => {
      close();
      let scope = 'this';
      if (ev.recurringEventId) { scope = await askScope('Delete'); if (!scope) return; }
      try { setStatus('Deleting…'); await EV.deleteEvent(st(), ev, scope); undoableEventDelete(ev, scope); await afterEventChange(); toast('Event deleted'); }
      catch (err) { handleError(err); }
    });
  });
}

// Record an event that overlaps another one (e.g. 1 h of chores during 4 h of childcare): quick create for one hour
// inside it — from now when it's under way, else from its start. In Analysis the shorter entry counts for that time.
function addDuring(it) {
  const step = 15 * T.MIN, now = Date.now();
  let start = it.start <= now && it.end > now ? Math.max(it.start, Math.floor(now / step) * step - 60 * T.MIN) : it.start;
  if (start >= it.end) start = it.start;
  const end = Math.min(it.end, start + 60 * T.MIN);
  const node = document.querySelector(`.ev[data-key="${CSS.escape(it.key)}"]`);
  const r = node?.getBoundingClientRect() || { left: innerWidth / 2 - 150, top: innerHeight / 3, right: innerWidth / 2 + 150, bottom: innerHeight / 3 + 40, width: 300, height: 40 };
  quickCreate(r, { start, end: Math.max(end, start + 15 * T.MIN), allDay: false });
}

function openChunk(it, rect) {
  const { task, sess } = it;
  const z = tz(), s = set();
  const p = S.progress(task);
  const now = Date.now();
  const isDone = sess.kind === 'done' || (sess.kind === 'pinned' && sess.end <= now);
  const badge = sess.kind === 'done' ? '<span class="pill ok">Done</span>' : sess.kind === 'pinned' ? '<span class="pill">Pinned</span>' : it.overdue ? '<span class="pill bad">After deadline</span>' : '<span class="pill soft">Planned</span>';
  popover(rect, `
    <div class="pop">
      <div class="pop-tools"><button class="icon-btn x" title="Close">✕</button></div>
      <div class="pop-title"><i style="--c:${task.color}"></i><h3>${esc(sess.label)}</h3></div>
      <div class="pop-row">${badge} ${esc(fmtWhen(it))}</div>
      <div class="pop-row small"><button class="cat-chip on pop-cat" ${task.categoryId ? `style="--c:${esc(task.color)}"` : ''}>${task.categoryId ? `<i></i>${esc(C.catLabel(C.catById(s, task.categoryId)) || task.categoryName || 'Category')}` : '+ Category'} ▾</button></div>
      <div class="pop-row small">Part of <b>${esc(task.title)}</b> · rank ${task.rank} · due ${esc(T.format(task.deadline, z, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: s.h12 }))}</div>
      <div class="pop-row"><div class="bar"><i style="width:${p.pct}%;background:${task.color}"></i></div><div class="muted small">${T.fmtDur(p.done)} of ${T.fmtDur(p.total)} done</div></div>
      <div class="pop-row small">${!E.connected(st()) ? '<span class="muted">Only in this browser (Google not connected)</span>' : sess.gid ? '<span class="g-ok">✓ On Google Calendar</span>' : '<span class="g-bad">Not on Google Calendar yet</span> <button class="link sync-now">Sync now</button>'}</div>
      <div class="pop-actions">
        ${isDone ? '<button class="btn small undone">↺ Mark undone</button>' : '<button class="btn small primary done">✓ Mark done</button>'}
        <button class="btn small partial">◐ Partly done…</button>
        ${p.pct < 100 || !isDone ? `<button class="btn small fin-task" title="${task.kind === 'reading' ? 'Count this session up to the last page and remove the sessions not done yet' : 'Count all remaining work as done in this session and remove the sessions not done yet'}">🏁 Task finished here</button>` : ''}
        ${(!isDone || sess.auto) && sess.start <= now && sess.end > now ? '<button class="btn small fin-early">⏹ Finished early</button>' : ''}
        ${(!isDone || sess.auto) && sess.start < now && sess.end > now + T.MIN ? '<button class="btn small late">⏰ Started late…</button>' : ''}
        ${!isDone ? `<button class="btn small ghost tm-start" title="Time this session">▶ Timer</button><button class="btn small ghost tm-pomo" title="Focus timer with breaks (${set().pomodoro?.work || 25}/${set().pomodoro?.rest || 5} min)">🍅 Focus</button>` : ''}
        ${sess.kind === 'pinned' ? '<button class="btn small ghost unpin">Unpin</button>' : ''}
        <button class="btn small ghost del">Delete…</button>
        <button class="btn small ghost edit">Edit task</button>
        <button class="btn small ghost add-during" title="Record something else you did during this session">＋ Add during this</button>
      </div>
      <div class="muted small hint">Tip: drag a session to pin it to a specific time — the rest of the series shifts around it.</div>
    </div>`, (pop, close) => {
    $('.x', pop).onclick = close;
    const act = async (fn, msg, log) => { close(); replaceTask(fn(st().tasks.find((t) => t.id === task.id))); if (log) logHistory(log); await saveTasks(msg.split(' —')[0].toLowerCase()); toast(msg); cycle(); };
    $('.done', pop)?.addEventListener('click', () => { close(); finishSession(st().tasks.find((t) => t.id === task.id), sess, timer?.chunkId === sess.id ? tmWork() / T.MIN : null); if (timer?.chunkId === sess.id) { timer = null; saveTimer(); drawTimer(); } });
    $('.undone', pop)?.addEventListener('click', () => act((t) => (sess.kind === 'pinned' ? S.unpinSession(t, sess.id) : S.markUndone(t, sess.id)), 'Marked undone — remaining sessions shifted', { kind: 'undone', task, sess }));
    $('.unpin', pop)?.addEventListener('click', () => act((t) => S.unpinSession(t, sess.id), 'Unpinned'));
    $('.fin-task', pop)?.addEventListener('click', async () => {
      close();
      const cur = st().tasks.find((t) => t.id === task.id); if (!cur) return;
      const left = S.sessions(cur).filter((c) => c.kind === 'planned' && c.id !== sess.id).length;
      const ok = await choose(`Finish “${task.title}” with this session?`, `${task.kind === 'reading' ? `This session will count up to page ${(+cur.reading?.startPage || 1) + (+cur.reading?.pages || 0) - 1}` : 'All remaining work will count as done in this session'}${left ? `, and the ${left} session${left > 1 ? 's' : ''} not done yet will be removed` : ''}.`, [{ value: 'yes', label: 'Yes, the task is finished' }]);
      if (ok !== 'yes') return;
      if (timer?.chunkId === sess.id) { timer = null; saveTimer(); drawTimer(); }
      replaceTask(S.completeAt(st().tasks.find((t) => t.id === task.id), sess.id));
      await saveTasks('task finished'); toast(`🏁 ${task.title} finished${left ? ` — ${left} remaining session${left > 1 ? 's' : ''} removed` : ''}`, { ms: 6000 }); cycle();
    });
    $('.edit', pop).onclick = () => { close(); editTask(task); };
    $('.add-during', pop)?.addEventListener('click', () => { close(); addDuring(it); });
    $('.partial', pop).onclick = () => { close(); partialSession(task, sess); };
    $('.fin-early', pop)?.addEventListener('click', () => { close(); finishedEarly(it); });
    $('.late', pop)?.addEventListener('click', () => { close(); startedLate(it); });
    $('.tm-start', pop)?.addEventListener('click', () => { close(); startTimer(task, sess, 'stopwatch'); });
    $('.tm-pomo', pop)?.addEventListener('click', () => { close(); startTimer(task, sess, 'pomodoro'); });
    $('.sync-now', pop)?.addEventListener('click', () => { close(); openSyncPanel(); });
    $('.pop-cat', pop).onclick = () => { close(); pickCategory(task); };
    $('.del', pop).onclick = async () => {
      close();
      if (isDone) return deleteDoneSession(task, sess);
      const v = await choose('Delete session', `“${sess.label}”`, [
        { value: 'one', label: 'Delete this session', desc: 'Its work moves to the next free time; later sessions in the series shift down.' },
        { value: 'all', label: 'Delete the entire series', desc: `Removes “${task.title}” and all ${sess.count} sessions.`, danger: true },
      ]);
      if (v === 'one') { replaceTask(S.skipSession(st().tasks.find((t) => t.id === task.id), sess.id)); logHistory({ kind: 'skipped', task, sess }); await saveTasks('delete session'); toast('Session deleted — series shifted'); cycle(); }
      if (v === 'all') deleteTask(task.id);
    };
  });
}

// Tasks loaded from Google may use a time period this browser doesn't have yet: add it.
function adoptPeriodsFromTasks() {
  let changed = false;
  for (const t of st().tasks) {
    if (t.periodId && t.periodRules?.length && !(set().periods || []).some((p) => p.id === t.periodId)) {
      set().periods = [...(set().periods || []), { id: t.periodId, name: t.periodName || 'Period', rules: t.periodRules }];
      changed = true;
    }
  }
  return changed;
}

// A new task has no category: ask once, quickly (Skip keeps it uncategorised; "Don't ask again" turns this off).
async function askCategoryOnce(task) {
  let picked = null;
  const r = await modal(`<div class="choice ask-cat"><h2>Which category is “${esc(task.title)}”?</h2>
    <p class="muted small">Tap one, or add a new one. Categories color-code tasks and group your time in Analysis.</p>
    <div class="cat-host" style="margin:10px 0 4px"></div>
    <div class="actions"><button type="button" class="btn ghost link never">Don't ask again</button><span class="grow"></span><button type="button" class="btn ghost" data-close>Skip</button></div></div>`, (dlg, close) => {
    C.categoryPicker($('.cat-host', dlg), {
      settings: set(), selected: null, allowNone: false,
      onChange: (c) => { picked = c; close('ok'); },
      onCreate: async (name, color, icon, parent) => { const c = C.newCategory(set(), name, color, icon, parent); await E.persist(st(), ['settings']); return c; },
    });
    $('.never', dlg).onclick = () => close('never');
  }, { cls: 'narrow' });
  if (r === 'never') {
    set().askCategory = false;
    await E.persist(st(), ['settings']);
    toast('Won’t ask again. Turn it back on in Settings → Categories.');
  }
  return r === 'ok' && picked ? C.applyCategory(task, picked) : task;
}

// Quick classify: pick (or create) a category for a task.
async function pickCategory(task) {
  let picked;
  const r = await modal(`<div class="choice"><h2>Category for “${esc(task.title)}”</h2><div class="cat-host" style="margin:10px 0 4px"></div>
    <div class="actions"><button type="button" class="btn ghost" data-close>Close</button></div></div>`, (dlg, close) => {
    C.categoryPicker($('.cat-host', dlg), {
      settings: set(), selected: task.categoryId,
      onChange: (c) => { picked = c; close('ok'); },
      onCreate: async (name, color, icon, parent) => { const c = C.newCategory(set(), name, color, icon, parent); await E.persist(st(), ['settings']); return c; },
    });
  }, { cls: 'narrow' });
  if (r !== 'ok') return;
  const cur = st().tasks.find((t) => t.id === task.id);
  if (!cur) return;
  replaceTask(C.applyCategory(cur, picked));
  await saveTasks('change category');
  toast(picked ? `“${task.title}” is now ${picked.name}` : 'Category removed');
  cycle();
}

// Classify an event (new or old) into a category. Stored on the event in Google; events you can't edit keep
// their category in this browser.
async function pickEventCategory(it) {
  let picked, chosen = false;
  await modal(`<div class="choice"><h2>Category for “${esc(it.title)}”</h2><div class="cat-host" style="margin:10px 0 4px"></div>
    <div class="actions"><button type="button" class="btn ghost" data-close>Close</button></div></div>`, (dlg, close) => {
    C.categoryPicker($('.cat-host', dlg), {
      settings: set(), selected: it.catId,
      onChange: (c) => { picked = c; chosen = true; close(); },
      onCreate: async (name, color, icon, parent) => { const c = C.newCategory(set(), name, color, icon, parent); await E.persist(st(), ['settings']); return c; },
    });
  }, { cls: 'narrow' });
  if (!chosen) return;
  const ev = it.ev;
  const saveLocally = async () => {
    const k = C.eventKey(ev);
    if (picked) st().eventCats[k] = picked.id; else delete st().eventCats[k];
    await E.persist(st(), ['eventCats']);
  };
  try {
    if (!it.editable) {
      await saveLocally();
      toast(picked ? `Marked as ${picked.name} (saved on this device — you can't edit this event in Google)` : 'Category removed', { ms: 6000 });
      return render();
    }
    let scope = 'this';
    if (ev.recurringEventId) { scope = await askScope('Categorize'); if (!scope) return; }
    setStatus('Saving…');
    await EV.updateEvent(st(), ev, C.eventCategoryChanges(ev, picked), scope);
    undoableEventChange('change category', ev, scope);
    await afterEventChange();
    toast(picked ? `“${it.title}” is now ${picked.name}` : 'Category removed');
  } catch (err) {
    if (err instanceof G.PermissionError || /forbidden|permission|403/i.test(err.message)) { await saveLocally(); toast('Saved on this device only (Google didn’t allow changing this event)'); render(); }
    else handleError(err);
  }
}

// Deleting a session that was already done.
// Partly done: credit the work that was done, reschedule the rest, and optionally split the block in two.
async function partialSession(task, sess, opts = {}) {
  const r = await D.partialDialog(ctx, task, sess, opts);
  if (!r) return;
  const cur0 = st().tasks.find((t) => t.id === task.id);
  if (!cur0) return;
  if (r.allDone) return finishSession(cur0, sess, opts.actualMin);
  let cur = cur0;
  let start = sess.start, end = sess.end, other = null;
  if (r.split) {
    const cut = r.split.where === 'start' ? sess.start + r.split.minutes * T.MIN : sess.end - r.split.minutes * T.MIN;
    if (r.split.where === 'start') { start = cut; other = [sess.start, cut]; } else { end = cut; other = [cut, sess.end]; }
  }
  const spent = opts.actualMin != null ? opts.actualMin : (end - start) / T.MIN;
  let updated = S.markPartial(cur, sess.id, { credit: r.credit, start, end, squeeze: r.squeeze, pagesDone: r.pages, actualMin: opts.actualMin });
  logHistory({ kind: 'partial', task: cur, sess, act: Math.round(spent) });
  let msg = r.pages != null ? `${r.pages} page${r.pages === 1 ? '' : 's'} read` : `${r.pct}% done`;
  if (r.pages != null) { const sp = learnSpeed(updated, r.pages, spent); updated = sp.task; if (sp.msg) msg += ' · ' + sp.msg; }
  replaceTask(updated);
  msg += r.squeeze ? ' — the rest is spread over the remaining sessions' : ' — time added for the rest';
  try {
    if (other && r.split.kind === 'task') {
      const o = st().tasks.find((t) => t.id === r.split.taskId);
      if (o) { replaceTask(S.addDoneBlock(o, other[0], other[1])); msg += ` · ${r.split.minutes} min counted toward “${o.title}”`; }
    } else if (other) {
      const z = tz();
      await EV.createEvent(st(), r.split.calId, { summary: r.split.title, start: { dateTime: new Date(other[0]).toISOString(), timeZone: z }, end: { dateTime: new Date(other[1]).toISOString(), timeZone: z }, reminders: { useDefault: false, overrides: [] } });
      await E.persist(st(), ['localEvents']);
      E.invalidate();
      msg += ` · “${r.split.title}” added`;
    }
  } catch (err) { handleError(err); }
  await saveTasks('partly done');
  toast(msg, { ms: 6000 });
  cycle();
}

// Reading speed learned from reported pages and the time spent.
function learnSpeed(task, pages, minutes) {
  if (task.kind !== 'reading' || !(pages > 0) || !(minutes >= 5)) return { task };
  let t = { ...task, speedLog: [...(task.speedLog || []), { pages, minutes: Math.round(minutes), at: Date.now() }].slice(-8) };
  if (set().learnSpeed === false) return { task: t };
  const learned = S.learnedSpeed(t), cur = S.pagesPerHour(t.reading || {});
  if (!learned || Math.abs(learned - cur) / cur < 0.08) return { task: t };
  t = S.withReadingSpeed(t, { ...t.reading, speed: learned, unit: 'pph' });
  set().readingDefaults = { ...(set().readingDefaults || {}), speed: learned };
  E.persist(st(), ['settings']);
  return { task: t, msg: `reading speed now ${learned} pages/hour (was ${+cur.toFixed(1)}) — the plan is adjusted` };
}

// Timer stopped at (or past) the planned time, or "It's all done".
async function finishSession(task, sess, actualMin) {
  let t = S.markDone(task, sess.id, { actualMin });
  let msg = actualMin != null ? `Recorded ${T.fmtDur(Math.round(actualMin))} — marked done` : 'Marked done';
  if (actualMin != null && actualMin > sess.minutes + 5) logHistory({ kind: 'overrun', task, sess, act: Math.round(actualMin) });
  if (task.kind === 'reading' && actualMin != null && sess.pages) { const sp = learnSpeed(t, sess.pages[1] - sess.pages[0] + 1, actualMin); t = sp.task; if (sp.msg) msg += ' · ' + sp.msg; }
  replaceTask(t);
  await saveTasks('mark done');
  toast(msg, { ms: 6000 });
  cycle();
}

// ======================================================================================
// Session timer — stopwatch, or focus timer with breaks (Pomodoro)
// ======================================================================================
let timer = null, tickId = null;
const saveTimer = () => storeSet({ timer });
const tmWork = () => (timer ? timer.acc + (timer.running && timer.phase === 'work' ? Date.now() - timer.since : 0) : 0);
const tmPhase = () => (timer ? timer.phaseAcc + (timer.running ? Date.now() - timer.phaseSince : 0) : 0);
const mmss = (ms) => { const t = Math.max(0, Math.round(ms / 1000)); const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), x = t % 60; return `${h ? h + ':' : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(x).padStart(2, '0')}`; };
async function loadTimer() { timer = (await storeGet('timer')).timer || null; if (timer) startTick(); drawTimer(); }
async function startTimer(task, sess, mode) {
  if (timer && timer.chunkId !== sess.id) {
    const v = await choose('Replace the running timer?', `“${timer.label}” is being timed (${mmss(tmWork())}).`, [{ value: 'stop', label: 'Stop it and record it first' }, { value: 'drop', label: 'Discard it', danger: true }]);
    if (!v) return;
    if (v === 'stop') await stopTimer(); else timer = null;
  }
  const now = Date.now();
  timer = { taskId: task.id, chunkId: sess.id, label: sess.label, planMin: sess.minutes, mode, acc: 0, since: now, running: true, phase: 'work', phaseAcc: 0, phaseSince: now, pomos: 0, startedAt: now };
  saveTimer(); startTick();
  if (mode === 'pomodoro' && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
}
function startTick() { clearInterval(tickId); tickId = setInterval(tick, 1000); tick(); }
function tick() {
  if (!timer) { clearInterval(tickId); drawTimer(); return; }
  const p = set().pomodoro || { work: 25, rest: 5 }, now = Date.now();
  if (timer.mode === 'pomodoro' && timer.running) {
    if (timer.phase === 'work' && tmPhase() >= p.work * 60000) {
      timer.acc += now - timer.since; Object.assign(timer, { phase: 'rest', phaseAcc: 0, phaseSince: now, pomos: timer.pomos + 1 }); saveTimer();
      ping('Time for a break', `${p.rest} min break — ${timer.label}`);
    } else if (timer.phase === 'rest' && tmPhase() >= p.rest * 60000) {
      Object.assign(timer, { phase: 'work', phaseAcc: 0, phaseSince: now, since: now }); saveTimer();
      ping('Back to work', timer.label);
    }
  }
  if (!timer.notifiedEnd && tmWork() >= timer.planMin * 60000) { timer.notifiedEnd = true; saveTimer(); ping('Session time is up', `${timer.label} — stop the timer to record it, or keep going.`); }
  drawTimer();
}
function pauseTimer() {
  if (!timer) return;
  const now = Date.now();
  if (timer.running) { if (timer.phase === 'work') timer.acc += now - timer.since; timer.phaseAcc += now - timer.phaseSince; timer.running = false; }
  else { timer.running = true; timer.since = timer.phaseSince = now; }
  saveTimer(); drawTimer();
}
async function stopTimer() {
  if (!timer) return;
  const t0 = timer, workMin = tmWork() / T.MIN;
  timer = null; saveTimer(); drawTimer();
  const task = st().tasks.find((t) => t.id === t0.taskId);
  const sess = task && S.sessions(task).find((c) => c.id === t0.chunkId);
  if (!task || !sess) { toast('That session no longer exists — nothing recorded.'); return; }
  if (workMin < 1) { toast('Timer stopped (under a minute — nothing recorded)'); return; }
  if (workMin >= sess.minutes - 2) return finishSession(task, sess, workMin);
  return partialSession(task, sess, { actualMin: workMin }); // stopped early: fill in "Partly done"
}
function drawTimer() {
  const bar = $('#timer-bar');
  if (!bar) return;
  if (!timer) { bar.hidden = true; bar.replaceChildren(); return; }
  const p = set().pomodoro || { work: 25, rest: 5 };
  const work = tmWork(), plan = timer.planMin * 60000;
  const phaseTxt = timer.mode === 'pomodoro' ? (timer.phase === 'work' ? `Focus · ${mmss(p.work * 60000 - tmPhase())} left` : `Break · ${mmss(p.rest * 60000 - tmPhase())} left`) + (timer.pomos ? ` · ${'🍅'.repeat(Math.min(timer.pomos, 6))}` : '') : 'Stopwatch';
  bar.hidden = false;
  bar.className = `timer-bar ${timer.running ? '' : 'paused'} ${timer.phase === 'rest' ? 'rest' : ''} ${work > plan ? 'over' : ''}`;
  setHTML(bar, `<div class="tm-l"><b>${esc(timer.label)}</b><span class="muted small">${esc(phaseTxt)}${timer.running ? '' : ' · paused'}</span></div>
    <div class="tm-time">${mmss(work)} <span class="muted small">/ ${timer.planMin} min</span></div>
    <div class="tm-btns"><button class="btn small tm-pause">${timer.running ? '❚❚ Pause' : '▶ Resume'}</button><button class="btn small primary tm-stop">■ Stop</button><button class="icon-btn sm tm-drop" title="Discard timer" aria-label="Discard timer">✕</button></div>
    <i class="tm-prog" style="width:${Math.min(100, (work / plan) * 100)}%"></i>`);
  $('.tm-pause', bar).onclick = pauseTimer;
  $('.tm-stop', bar).onclick = stopTimer;
  $('.tm-drop', bar).onclick = async () => { if (await choose('Discard the timer?', 'Nothing will be recorded.', [{ value: true, label: 'Discard', danger: true }])) { timer = null; saveTimer(); drawTimer(); } };
}
function ping(title, body) {
  uiToast(`${title} — ${body}`, { ms: 8000 });
  try { const a = new (window.AudioContext || window.webkitAudioContext)(); const o = a.createOscillator(), g = a.createGain(); o.frequency.value = 880; g.gain.setValueAtTime(0.15, a.currentTime); g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + 0.6); o.connect(g).connect(a.destination); o.start(); o.stop(a.currentTime + 0.6); } catch { /* no audio */ }
  try { if ('Notification' in window && Notification.permission === 'granted' && document.hidden) new Notification(title, { body, icon: 'icons/icon128.png', tag: 'tempo-timer' }); } catch { /* ignore */ }
}

async function deleteDoneSession(task, sess) {
  const r = await D.deleteDoneDialog(ctx, task, sess);
  if (!r) return;
  if (r.action === 'all') {
    const v = await choose('Delete task', `“${task.title}”`, [{ value: true, label: 'Delete the entire series', desc: 'Removes the task and all its sessions (also from Google Calendar).', danger: true }]);
    if (v) deleteTask(task.id);
    return;
  }
  const cur = st().tasks.find((t) => t.id === task.id);
  if (!cur) return;
  const pinned = cur.frozen?.find((c) => c.id === sess.id)?.status === 'pinned';
  replaceTask(r.reschedule ? (pinned ? S.unpinSession(cur, sess.id) : S.markUndone(cur, sess.id)) : S.waiveSession(cur, sess.id));
  let msg = r.reschedule ? 'Session deleted — its work was rescheduled' : 'Session deleted (not rescheduled)';
  try {
    if (r.replace.kind === 'task') {
      const other = st().tasks.find((t) => t.id === r.replace.taskId);
      if (other) { replaceTask(S.addDoneBlock(other, sess.start, sess.end)); msg += ` · time counted toward “${other.title}”`; }
    } else if (r.replace.kind === 'event') {
      const z = tz();
      await EV.createEvent(st(), r.replace.calId, { summary: r.replace.title, start: { dateTime: new Date(sess.start).toISOString(), timeZone: z }, end: { dateTime: new Date(sess.end).toISOString(), timeZone: z }, reminders: { useDefault: false, overrides: [] } });
      await E.persist(st(), ['localEvents']);
      E.invalidate();
      msg += ` · “${r.replace.title}” added`;
    }
  } catch (err) { handleError(err); }
  await saveTasks('delete done session');
  toast(msg, { ms: 5000 });
  cycle();
}

// ======================================================================================
// Event & task editing
// ======================================================================================
async function newEvent(init) {
  const r = await D.eventDialog(ctx, { init });
  if (r?.action === 'save') await saveNewEvent(r.calId, r.body, { conference: r.conference });
}

async function editEvent(it) {
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

function replaceTask(t) { t = { ...t, rev: Date.now() }; st().tasks = st().tasks.map((x) => (x.id === t.id ? t : x)); }
// Every user change to tasks goes through saveTasks(label): the state before it is kept so it can be undone.
async function saveTasks(label = 'last change') {
  if (label !== false) recordTaskUndo(label);
  await E.persist(st(), ['tasks', 'orphanGids', 'acks', 'tombstones']);
}

// ======================================================================================
// Undo — tasks (snapshots), events (inverse operations) and settings
// ======================================================================================
const undoStack = [];
let baseline = null;
const snapTasks = () => JSON.stringify(st().tasks);
function markBaseline() { baseline = snapTasks(); }
function pushUndo(label, undo) {
  undoStack.push({ label, undo, at: Date.now() });
  if (undoStack.length > 40) undoStack.shift();
  app.lastUserChange = Date.now();
  app.lastChangeLabel = app.pendingWhy || label;
  app.pendingWhy = null;
  updateUndoBtn();
}
function recordTaskUndo(label) {
  const now = snapTasks();
  if (baseline && baseline !== now) { const before = baseline; pushUndo(label, () => restoreTasks(before)); }
  baseline = now;
}
function updateUndoBtn() {
  const b = $('#btn-undo');
  if (!b) return;
  const top = undoStack[undoStack.length - 1];
  b.disabled = !top;
  b.title = top ? `Undo: ${top.label} (Ctrl+Z)` : 'Nothing to undo';
}
async function undo() {
  const top = undoStack.pop();
  updateUndoBtn();
  if (!top) { toast('Nothing to undo'); return; }
  try {
    app.undoing = true;
    await top.undo();
    toast(`Undone: ${top.label}`, { noUndo: true });
  } catch (err) { handleError(err); }
  finally { app.undoing = false; }
}
// Bring tasks back to an earlier snapshot; Google is updated by the next sync (deleted sessions are re-created).
async function restoreTasks(beforeJson) {
  const before = JSON.parse(beforeJson), cur = st().tasks, now = Date.now();
  const gidsOf = (t) => [...(t?.planned || []), ...(t?.frozen || [])].map((c) => c.gid).filter(Boolean);
  const keep = new Set(before.flatMap(gidsOf));
  const orphans = [];
  for (const c of cur) {
    const b = before.find((x) => x.id === c.id);
    for (const g of gidsOf(c)) if (!keep.has(g)) orphans.push(g);
    if (!b) st().tombstones = [...(st().tombstones || []), c.id].slice(-300);
  }
  const restoredIds = new Set(before.map((t) => t.id));
  st().tombstones = (st().tombstones || []).filter((id) => !restoredIds.has(id) || cur.some((c) => c.id === id));
  st().orphanGids = [...(st().orphanGids || []).filter((g) => !keep.has(g)), ...orphans];
  st().tasks = before.map((b) => {
    const c = cur.find((x) => x.id === b.id);
    const same = c && JSON.stringify({ ...c, lastPlan: 0, rev: 0 }) === JSON.stringify({ ...b, lastPlan: 0, rev: 0 });
    return same ? c : { ...b, orphanGids: (b.orphanGids || []).filter((g) => !keep.has(g)), rev: now };
  });
  for (const t of st().tasks) for (const c of [...(t.planned || []), ...(t.frozen || [])]) c.syncHash = null; // re-verify on Google
  baseline = snapTasks();
  await E.persist(st(), ['tasks', 'orphanGids', 'acks', 'tombstones']);
  E.invalidate();
  await cycle();
}
const EV_FIELDS = ['summary', 'description', 'location', 'start', 'end', 'colorId', 'reminders', 'transparency', 'visibility', 'extendedProperties'];
const pick = (o, ks) => Object.fromEntries(ks.filter((k) => o[k] !== undefined).map((k) => [k, JSON.parse(JSON.stringify(o[k]))]));
function undoableEventChange(label, ev, scope) {
  // Only single events / single occurrences can be put back exactly.
  if (scope && scope !== 'this') return;
  const before = pick(ev, EV_FIELDS);
  pushUndo(label, async () => { await EV.updateEvent(st(), ev, before, 'this'); await afterEventChange(); });
}
function undoableEventDelete(ev, scope) {
  if (ev.recurringEventId || (scope && scope !== 'this')) return;
  const copy = JSON.parse(JSON.stringify(ev));
  pushUndo(`delete “${ev.summary || 'event'}”`, async () => { await EV.createEvent(st(), copy._calId, copy); await afterEventChange(); });
}

async function newTask(preset = {}) {
  const r = await D.taskDialog(ctx, null, preset);
  if (!r?.task) return;
  let t = { ...r.task };
  if (preset.title && !t.title) t.title = preset.title;
  if (!t.categoryId && set().askCategory !== false) t = await askCategoryOnce(t);
  t.rev = Date.now();
  st().tasks.push(t);
  app.pendingWhy = `you added “${t.title}” (rank ${t.rank})`;
  await saveTasks(`add “${t.title}”`);
  await cycle();
  const ss = S.sessions(st().tasks.find((x) => x.id === t.id));
  toast(`Scheduled ${ss.length} session${ss.length === 1 ? '' : 's'} for “${t.title}”`);
}

async function editTask(task) {
  if (!task) return;
  const r = await D.taskDialog(ctx, task);
  if (!r) return;
  if (r.delete) {
    const v = await choose('Delete task', `“${task.title}”`, [{ value: true, label: 'Delete the entire series', desc: 'Removes the task and all its sessions (also from Google Calendar).', danger: true }]);
    if (v) deleteTask(task.id);
    return;
  }
  delete st().acks[task.id];
  let nt = { ...r.task, frozen: task.frozen, planned: task.planned };
  // A new reading speed must not shift the pages already read.
  if (task.kind === 'reading' && nt.kind === 'reading' && S.pagesPerHour(task.reading || {}) !== S.pagesPerHour(nt.reading || {})) nt = S.withReadingSpeed({ ...nt, reading: task.reading }, nt.reading);
  replaceTask(nt);
  app.pendingWhy = task.rank !== nt.rank ? `you changed “${nt.title}” to rank ${nt.rank}` : `you edited “${nt.title}”`;
  await saveTasks(`edit “${nt.title}”`);
  await cycle();
  toast('Task updated and rescheduled');
}

async function deleteTask(id) {
  const t = st().tasks.find((x) => x.id === id);
  if (!t) return;
  st().orphanGids.push(...[...(t.planned || []), ...(t.frozen || [])].map((c) => c.gid).filter(Boolean), ...(t.orphanGids || []));
  st().tasks = st().tasks.filter((x) => x.id !== id);
  st().tombstones = [...(st().tombstones || []), id].slice(-300);
  delete st().acks[id];
  await saveTasks(`delete “${t.title}”`);
  toast(`Deleted “${t.title}”`);
  cycle();
}

// ======================================================================================
// Cycle: reschedule -> render -> sync -> prompts
// ======================================================================================
let cycling = null, again = false, pullPending = false;
function cycle(opts = {}) {
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
      else if (res.ok) setStatus(`Synced ${T.fmtTime(Date.now(), tz(), set().h12)}`, 'ok');
      else if (res.kind === 'local') setStatus('Local only', 'warn');
      else if (res.kind === 'off') setStatus('Not syncing tasks', 'warn');
      else setStatus('Sync problem', 'bad');
      if (res.changed) { E.invalidate(); await render(); }
    } catch (err) { handleError(err); }
    await E.persist(st(), ['tasks', 'orphanGids', 'syncInfo']);
    renderBanner();
  }
  markBaseline();
  await handleProblems(problems);
}

// ======================================================================================
// "Finished early" and "Fill time since last event"
// ======================================================================================
const nowMin = () => Math.floor(Date.now() / T.MIN) * T.MIN;
async function itemsToday() {
  const k = T.dayKey(Date.now(), tz());
  return collectItems([k]);
}
// Started a task session late: shorten it to start when you began; optionally record what filled the time
// before, and plan the missed minutes again later (or drop them).
async function startedLate(it0) {
  let it = it0;
  if (!it) {
    const now = Date.now();
    const list = (await itemsToday()).filter((x) => x.kind === 'chunk' && x.start < now && x.end > now + T.MIN && (x.status !== 'done' || x.sess.auto));
    if (!list.length) { toast('No task session is running right now.'); return; }
    if (list.length === 1) it = list[0];
    else {
      const k = await choose('Which session did you start late?', null, list.map((x) => ({ value: x.key, label: x.title, desc: `${T.fmtTime(x.start, tz(), set().h12)}–${T.fmtTime(x.end, tz(), set().h12)}` })));
      it = list.find((x) => x.key === k); if (!it) return;
    }
  }
  const cur = st().tasks.find((t) => t.id === it.task.id);
  const sess = S.sessions(cur).find((c) => c.id === it.sess.id);
  if (!sess) return;
  const r = await D.startedLateDialog(ctx, { task: cur, sess });
  if (!r) return;
  const missed = Math.round((r.start - sess.start) / T.MIN);
  try {
    replaceTask(S.startedLate(cur, sess.id, r.start, { reallocate: r.reallocate }));
    if (r.fill?.kind === 'task') {
      const o = st().tasks.find((t) => t.id === r.fill.taskId);
      if (o) replaceTask(S.addDoneBlock(o, sess.start, r.start));
    }
    app.pendingWhy = `you started “${cur.title}” ${T.fmtDur(missed)} late`;
    await saveTasks('started late');
    if (r.fill?.kind === 'event') {
      const cat = C.catById(set(), r.fill.catId);
      const g = r.fill.calId !== E.LOCAL_CAL;
      await saveNewEvent(r.fill.calId, { ...selBody({ start: sess.start, end: r.start }, r.fill.title, r.fill.calId), ...(cat ? C.eventCategoryChanges({}, cat) : {}), reminders: { useDefault: false, overrides: [] }, ...(g ? {} : {}) });
    }
    await cycle();
    toast(r.reallocate ? `Started ${T.fmtDur(missed)} late — the missed time is planned again later` : `Started ${T.fmtDur(missed)} late — the missed time was dropped`);
  } catch (err) { handleError(err); }
}

async function finishedEarly(it0, choice = null) {
  let it = it0;
  if (!it) {
    const now = Date.now();
    const list = (await itemsToday()).filter((x) => !x.allDay && x.start <= now && x.end > now && (x.kind === 'chunk' ? x.status !== 'done' || x.sess.auto : x.editable && A.isOccupying(x, set())));
    if (!list.length) { toast('Nothing is going on right now.'); return; }
    if (list.length === 1) it = list[0];
    else {
      const k = await choose('Which one did you finish?', null, list.map((x) => ({ value: x.key, label: x.title, desc: `${T.fmtTime(x.start, tz(), set().h12)}–${T.fmtTime(x.end, tz(), set().h12)}` })));
      it = list.find((x) => x.key === k);
      if (!it) return;
    }
  }
  const end = nowMin(), origEnd = it.end;
  if (end <= it.start || end >= origEnd) { toast('That isn’t running right now.'); return; }
  try {
    if (it.kind === 'chunk') {
      const cur = st().tasks.find((t) => t.id === it.task.id);
      replaceTask(S.finishEarly(cur, it.sess.id, end));
      await saveTasks('finish early');
    } else {
      const z = it.ev.end.timeZone || tz();
      await EV.updateEvent(st(), it.ev, { end: { dateTime: new Date(end).toISOString(), timeZone: z } }, 'this');
      undoableEventChange(`finish “${it.ev.summary || 'event'}” early`, it.ev, 'this');
      await E.persist(st(), ['localEvents']); E.invalidate();
    }
  } catch (err) { handleError(err); return; }
  const freeMin = Math.round((origEnd - end) / T.MIN);
  const until = T.fmtTime(origEnd, tz(), set().h12);
  const v = choice || await choose(`Finished ${T.fmtDur(freeMin)} early`, `“${it.title}” now ends at ${T.fmtTime(end, tz(), set().h12)}. What should happen until ${until}?`, [
    { value: 'fill', label: 'Move tasks up', desc: 'Pull your next task sessions into this time.' },
    { value: 'free', label: 'Leave it free', desc: `Nothing gets scheduled until ${until}.` },
  ], { cancel: 'Decide later' });
  if (v === 'fill') await fillGap(end, origEnd);
  else if (v === 'free') {
    set().holds = [...(set().holds || []).filter((h) => h.end > Date.now() - T.DAY), { id: S.newId('h'), start: end, end: origEnd }];
    await E.persist(st(), ['settings']);
    toast(`Kept free until ${until}`);
  }
  await cycle();
  return { finished: it.title, endedAt: T.toDTInput(end, tz()).replace('T', ' '), freedMinutes: freeMin, then: v || 'nothing' };
}
// Pull upcoming sessions (most important first) into [start, end).
async function fillGap(start, end) {
  const s = set(), brk = (+s.breakMinutes || 0) * T.MIN;
  let pos = start;
  const moved = [];
  for (const t0 of S.sortTasks(st().tasks.filter((t) => !t.archived))) {
    if (end - pos < 10 * T.MIN) break;
    const t = st().tasks.find((x) => x.id === t0.id);
    const next = S.sessions(t).filter((c) => c.kind === 'planned' && c.start >= start).sort((a, b) => a.start - b.start)[0];
    if (!next) continue;
    const len = Math.min(next.minutes, Math.floor((end - pos) / T.MIN));
    if (len < 10) continue;
    replaceTask(S.pinSession(t, next.id, pos, pos + len * T.MIN));
    moved.push(`${t.title} (${T.fmtDur(len)})`);
    pos += len * T.MIN + brk;
  }
  if (!moved.length) { toast('No upcoming task sessions to move up.'); return; }
  await saveTasks('move tasks up');
  toast(`Moved up: ${moved.join(', ')}`, { ms: 7000 });
}
// The end of your last event (today or yesterday, at most 12 hours ago) — e.g. at 6:00 you can record that you
// slept since 22:00 the evening before.
const LOOKBACK = 12 * T.HOUR;
// `ref` = the time to look back from (the start of the slot you're creating; default: now). The new start is that
// event's end plus the buffer from Settings (0–15 min).
async function lastEventEnd({ ref = null, exclude = null } = {}) {
  const now = nowMin(), z = tz();
  const at = ref ?? now, day = T.dayKey(at, z);
  const buf = Math.max(0, Math.min(15, +set().sinceLastBuffer || 0)) * T.MIN;
  const items = (await collectItems([T.addDays(day, -1), day])).filter((x) => !x.allDay && x.key !== exclude && x.end <= at && x.end > at - LOOKBACK && A.isOccupying(x, set()));
  if (!items.length) return { start: at - LOOKBACK, end: now, found: false, note: 'No event in the 12 hours before — starting 12 hours earlier; adjust the start as needed.' };
  const last = items.reduce((a, b) => (b.end > a.end ? b : a));
  const start = Math.min(last.end + buf, at - 5 * T.MIN);
  const when = T.dayKey(last.end, z) === day ? T.fmtTime(last.end, z, set().h12) : `${T.dayKey(last.end, z) === T.addDays(day, -1) ? 'the day before' : T.format(last.end, z, { weekday: 'short' })} ${T.fmtTime(last.end, z, set().h12)}`;
  return { start, end: now, found: true, note: `From “${last.title}” (ended ${when})${buf ? ` + ${buf / T.MIN} min` : ''}` };
}
// "Till next event": the start of the next event after `ref` (looking ahead up to 12 hours), minus the buffer.
async function nextEventStart({ ref, exclude = null } = {}) {
  const z = tz(), at = ref ?? nowMin(), day = T.dayKey(at, z);
  const buf = Math.max(0, Math.min(15, +(set().tillNextBuffer ?? set().sinceLastBuffer) || 0)) * T.MIN;
  const items = (await collectItems([day, T.addDays(day, 1)])).filter((x) => !x.allDay && x.key !== exclude && x.start > at && x.start <= at + LOOKBACK && A.isOccupying(x, set()));
  if (!items.length) return { found: false, note: 'No event in the 12 hours after this — set the end yourself.' };
  const next = items.reduce((a, b) => (b.start < a.start ? b : a));
  const end = Math.max(next.start - buf, at + 5 * T.MIN);
  const when = T.dayKey(next.start, z) === day ? T.fmtTime(next.start, z, set().h12) : `${T.format(next.start, z, { weekday: 'short' })} ${T.fmtTime(next.start, z, set().h12)}`;
  return { found: true, end, note: `Until “${next.title}” (starts ${when})${buf ? ` − ${buf / T.MIN} min` : ''}` };
}
// Work hours or a time period changed. Planned sessions are re-planned on every cycle anyway; this decides
// (setting, or asking) whether they should move: "move" also re-plans a session that is under way right now (assumed
// done) when it no longer fits the new hours; "keep" pins the affected tasks' upcoming sessions where they are.
// ======================================================================================
// Leave days (on leave / sick leave)
// ======================================================================================
function leaveTag(k, month = false) {
  const kind = S.leaveOf(set(), k); if (!kind) return '';
  const L = S.LEAVE_KINDS[kind];
  return `<button class="leave-tag lv-${kind} ${month ? 'm' : ''}" data-leave="${k}" title="${esc(L.label)} — click to change">${L.icon}${month ? '' : ` ${esc(L.label)}`}</button>`;
}
function leaveMenu(k, rect) {
  const cur = S.leaveOf(set(), k);
  const day = T.format(T.dayStart(k, tz()), tz(), { weekday: 'long', day: 'numeric', month: 'long' });
  popover(rect, `<div class="pop leave-pop"><h3 style="margin:0 0 8px">${esc(day)}</h3>
      ${Object.entries(S.LEAVE_KINDS).map(([id, L]) => `<button class="btn small ${cur === id ? 'primary' : ''} lv-set" data-kind="${id}">${L.icon} ${esc(L.label)}</button>`).join(' ')}
      ${cur ? '<button class="btn small ghost lv-clear">Not on leave</button>' : ''}
      <div class="row" style="margin-top:8px"><button class="link lv-day">Open this day</button><span class="grow"></span><button class="link lv-more">Several days…</button></div></div>`, (pop, close) => {
    $$('.lv-set', pop).forEach((b) => (b.onclick = () => { close(); setLeave([k], b.dataset.kind); }));
    $('.lv-clear', pop)?.addEventListener('click', () => { close(); setLeave([k], null); });
    $('.lv-day', pop).onclick = () => { close(); app.cursor = k; app.view = 'day'; render(); };
    $('.lv-more', pop).onclick = () => { close(); openSettings(); };
  });
}
// Mark (kind) or unmark (null) days; when new leave days already have events or task sessions, offer to move them.
async function setLeave(keys, kind, { ask = true, mode = null } = {}) {
  const before = { ...(set().leave || {}) };
  const leave = { ...before };
  for (const k of keys) { if (kind) leave[k] = kind; else delete leave[k]; }
  set().leave = leave;
  await E.persist(st(), ['settings']);
  pushUndo(kind ? 'leave day' : 'remove leave day', async () => { set().leave = before; await E.persist(st(), ['settings']); syncSharedSoon(); E.invalidate(); await render(); cycle(); });
  syncSharedSoon();
  const added = kind ? keys.filter((k) => !S.leaveOf({ leave: before }, k)) : [];
  if (added.length && (ask || mode)) { const r = await afterLeave(added, mode); if (r === 'back') { set().leave = before; await E.persist(st(), ['settings']); await render(); return; } }
  else { toast(kind ? `${S.LEAVE_KINDS[kind].icon} ${S.LEAVE_KINDS[kind].label}` : 'No longer marked as leave'); cycle(); }
}
// The next day that is a work day and not a leave day (for moving events off leave days).
function nextWorkDay(k) {
  const days = set().bounds?.days?.length ? set().bounds.days : [1, 2, 3, 4, 5];
  let d = T.addDays(k, 1);
  for (let i = 0; i < 60 && (!days.includes(T.weekday(d)) || S.leaveOf(set(), d)); i++) d = T.addDays(d, 1);
  return d;
}
async function afterLeave(keys, forced = null) {
  const items = (await collectItems(keys)).filter((it) => !it.allDay && keys.includes(T.dayKey(it.start, tz())));
  const sessions = items.filter((it) => it.kind === 'chunk' && it.status !== 'done' && !it.task?.onLeave && !(it.task && S.usesLeaveDays(it.task, set())));
  const events = items.filter((it) => it.kind === 'event' && it.editable && !it.declined && !it.ev?.extendedProperties?.private?.tempoTask);
  if (!sessions.length && !events.length) { toast(`Marked ${keys.length} day${keys.length > 1 ? 's' : ''} as leave`); cycle(); return 'none'; }
  const what = [events.length ? `${events.length} event${events.length > 1 ? 's' : ''}` : '', sessions.length ? `${sessions.length} task session${sessions.length > 1 ? 's' : ''}` : ''].filter(Boolean).join(' and ');
  const opts = [{ value: 'all', primary: true, label: 'Yes, reschedule them', desc: `${sessions.length ? 'Task sessions move to other days. ' : ''}${events.length ? 'Events move to the next working day at the same time.' : ''}` }];
  if (events.length && sessions.length) opts.push({ value: 'tasks', label: 'Only move the task sessions', desc: 'Your events stay where they are.' });
  opts.push({ value: 'keep', label: 'No, keep everything where it is', desc: sessions.length ? 'Task sessions on these days stay (they are pinned).' : 'Events stay where they are.' });
  const r = forced || await choose(`Reschedule ${keys.length > 1 ? 'these days’' : 'this day’s'} ${what}?`, `${keys.length > 1 ? 'These days are' : 'This day is'} now marked as leave.`, opts, { cancel: 'Back — don’t mark as leave' });
  if (!r) return 'back';
  if (r === 'keep') {
    for (const it of sessions) { const t = st().tasks.find((x) => x.id === it.task.id); if (t && it.status === 'planned') replaceTask(S.pinSession(t, it.sess.id, it.start, it.end)); }
    await saveTasks('keep sessions on leave day');
  } else {
    // pinned sessions on those days go back into the plan
    for (const it of sessions) { const t = st().tasks.find((x) => x.id === it.task.id); if (t && it.status === 'pinned') replaceTask(S.unpinSession(t, it.sess.id)); }
    await saveTasks('reschedule leave day');
    if (r === 'all' && events.length) {
      let moved = 0;
      setStatus('Moving events…', 'busy');
      for (const it of events) {
        try {
          const to = nextWorkDay(T.dayKey(it.start, tz())); // skips weekends (by your work days) and leave days
          const st0 = T.atTime(to, T.hhmm(T.minutesOfDay(it.start, tz())), tz());
          await EV.moveEvent(st(), it.ev, st0, st0 + (it.end - it.start), 'this');
          moved++;
        } catch (err) { handleError(err); }
      }
      E.invalidate();
      toast(`Moved ${moved} event${moved === 1 ? '' : 's'} to the next working day${sessions.length ? ' · task sessions re-planned' : ''}`, { ms: 6000 });
    } else toast(sessions.length ? 'Task sessions re-planned around your leave' : 'Marked as leave');
  }
  cycle();
  return r;
}

async function hoursChanged(before, after) {
  const bChanged = JSON.stringify(before.bounds) !== JSON.stringify(after.bounds);
  const perOld = new Map((before.periods || []).map((p) => [p.id, JSON.stringify(p.rules)]));
  const perChanged = new Set((after.periods || []).filter((p) => perOld.has(p.id) && perOld.get(p.id) !== JSON.stringify(p.rules)).map((p) => p.id));
  if (!bChanged && !perChanged.size) return;
  const now = Date.now();
  const affected = (t) => !t.archived && !t.ignoreBounds && !t.bounds && (t.periodId ? perChanged.has(t.periodId) : bChanged);
  const tasks = st().tasks.filter((t) => affected(t) && S.sessions(t).some((c) => c.end > now && c.kind !== 'done' && c.kind !== 'pinned' || (c.kind === 'done' && c.auto && c.end > now)));
  if (!tasks.length) return;
  let mode = after.hoursChange || 'ask';
  if (mode === 'ask') {
    const what = bChanged ? `work hours (${after.bounds.start}–${after.bounds.end})` : 'time period';
    mode = await choose('Move planned sessions?', `You changed your ${what}. ${tasks.length} task${tasks.length > 1 ? 's have' : ' has'} sessions planned with the old hours.`, [
      { value: 'move', label: 'Move them to fit the new hours', desc: 'Upcoming sessions are re-planned, including one that is under way now if it no longer fits.' },
      { value: 'keep', label: 'Keep them where they are', desc: 'Upcoming sessions stay put (pinned); only new planning uses the new hours.' },
    ], { cancel: 'Decide later (sessions follow the new hours)' });
    if (!mode) return;
  }
  const ids = new Set(tasks.map((t) => t.id));
  if (mode === 'move') {
    st().tasks = st().tasks.map((t) => (ids.has(t.id) ? S.refitOngoing(t, after, now) : t));
    app.pendingWhy = 'you changed your work hours';
  } else if (mode === 'keep') {
    st().tasks = st().tasks.map((t) => (ids.has(t.id) ? S.pinUpcoming(t, now) : t));
  }
  await saveTasks(mode === 'move' ? 'move sessions to new hours' : 'keep sessions at old hours');
  toast(mode === 'move' ? 'Sessions moved to fit the new hours' : 'Planned sessions kept where they were (pinned)');
}
async function fillSinceLast() {
  const r = await lastEventEnd();
  newEvent({ start: r.start, end: r.end, title: '' });
  setTimeout(() => toast(r.note, { noUndo: true }), 300);
}

// ======================================================================================
// Command interface for AI assistants and automation (window.tempo, AI console)
// ======================================================================================
async function freeSlots(from, to, minMin, within) {
  const s = set(), z = tz();
  const { busy } = await E.busyIntervals(st(), from, to);
  const sess = st().tasks.filter((t) => !t.archived).flatMap((t) => S.sessions(t).filter((c) => c.kind !== 'waived').map((c) => ({ start: c.start, end: c.end })));
  const wins = /any|all/i.test(within) ? [{ start: from, end: to }] : S.windows(from, to, s.bounds, z);
  return S.subtract(wins, S.merge([...busy, ...sess])).map((w) => ({ start: Math.max(w.start, Date.now()), end: w.end })).filter((w) => w.end - w.start >= minMin * T.MIN);
}
async function finishedEarlyApi(a) {
  const now = Date.now();
  const items = (await itemsToday()).filter((x) => !x.allDay && x.start <= now && x.end > now && (x.kind === 'chunk' ? x.status !== 'done' || x.sess.auto : x.editable && A.isOccupying(x, set())));
  let it = null;
  if (a.item) it = items.find((x) => x.key === a.item || x.sess?.id === a.item || x.key === `c|${a.item}` || (x.title || '').toLowerCase().includes(String(a.item).toLowerCase()));
  else if (items.length === 1) it = items[0];
  if (!it) { const e = new Error(items.length ? `Several things are running: ${items.map((x) => x.title).join(', ')} — give "item".` : 'Nothing is running right now.'); e.api = true; throw e; }
  const then = /move|fill|up/i.test(a.then || '') ? 'fill' : /free|keep/i.test(a.then || '') ? 'free' : 'later';
  return finishedEarly(it, then);
}
let api = null;
function setupApi() {
  api = createApi({
    setLeave, st, set, tz, cycle, saveTasks, replaceTask, deleteTask, buildDraft, collectItems, freeSlots, undo, pushUndo, undoStack, finishedEarlyApi, setEventDone, render,
    afterEventChange, defaultCalendar: () => ctx.defaultCalendar(), lastBusy: () => app.lastBusy, toast: (m) => toast(m),
  });
  window.tempo = api;
  if (new URLSearchParams(location.search).get('ai') === '1') setTimeout(openAiConsole, 600);
}
async function openAiConsole() {
  const example = JSON.stringify([{ cmd: 'today' }, { cmd: 'listTasks' }], null, 1);
  await modal(`<div class="ai-console"><header class="dlg-head"><h2>AI &amp; automation</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></header>
    <div class="dlg-body">
      <p class="small">An AI assistant that works in your browser (e.g. <b>Claude in Chrome</b>, included in your Claude subscription) can control Tempo through a command interface — no API key, no extra cost. Copy the instructions below into your chat with it, or paste commands here yourself.</p>
      <div class="row"><button type="button" class="btn small copy-prompt">Copy instructions for your AI</button><button type="button" class="btn small ghost show-help">Show all commands</button></div>
      <label class="field"><span>Commands (JSON — one object or a list)</span><textarea id="ai-input" class="mono" rows="7" spellcheck="false">${esc(example)}</textarea></label>
      <div class="row"><button type="button" class="btn primary run" id="ai-run">Run</button><button type="button" class="btn dry" id="ai-dry">Preview (dry run)</button><span class="grow"></span><span class="muted small ai-status"></span></div>
      <pre id="ai-output" class="ai-out" aria-live="polite"></pre>
    </div></div>`, (dlg) => {
    const out = $('#ai-output', dlg), status = $('.ai-status', dlg);
    const go = async (dryRun) => {
      let cmds;
      try { cmds = JSON.parse($('#ai-input', dlg).value); } catch (e) { out.textContent = JSON.stringify({ error: 'Not valid JSON: ' + e.message }, null, 2); return; }
      status.textContent = 'Running…';
      const r = await api.run(cmds, { dryRun });
      out.textContent = JSON.stringify(r, null, 2);
      status.textContent = dryRun ? 'Preview only — nothing changed' : 'Done';
    };
    $('#ai-run', dlg).onclick = () => go(false);
    $('#ai-dry', dlg).onclick = () => go(true);
    $('.show-help', dlg).onclick = () => { out.textContent = JSON.stringify(api.help(), null, 2); };
    $('.copy-prompt', dlg).onclick = async () => {
      const text = `${AI_PROMPT}\nThe app is open at ${location.origin + location.pathname}.`;
      try { await navigator.clipboard.writeText(text); status.textContent = 'Copied'; } catch { out.textContent = text; status.textContent = 'Copy this text:'; }
    };
  }, { cls: 'wide' });
}

// ======================================================================================
// Quick add in plain language
// ======================================================================================
function setupQuickAdd() {
  const inp = $('#quick-add'), pv = $('#quick-preview');
  if (!inp) return;
  let parsed = null;
  const show = () => {
    const v = inp.value.trim();
    if (!v) { pv.hidden = true; parsed = null; return; }
    parsed = parseTask(v, set(), st().tasks);
    pv.hidden = false;
    setHTML(pv, `<div class="qp-title">${esc(parsed.draft.title)}</div><div class="qp-chips">${parsed.chips.map((c) => `<span class="chip-btn on">${esc(c)}</span>`).join('')}${parsed.hasDeadline ? '' : '<span class="chip-btn">due in a week (default)</span>'}</div>
      <div class="qp-act"><span class="muted small">Enter to add</span><button class="link qp-edit">Edit details…</button></div>`);
    $('.qp-edit', pv).onclick = () => { const d = buildDraft(parsed.draft); inp.value = ''; show(); newTask({ draft: d, kind: d.kind }); };
  };
  inp.addEventListener('input', show);
  inp.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') { inp.value = ''; show(); inp.blur(); }
    if (e.key !== 'Enter' || !parsed) return;
    e.preventDefault();
    const t = buildDraft(parsed.draft);
    if (!(await D.checkTaskLimits(ctx, t))) return;
    inp.value = ''; show();
    let nt = { ...t, rev: Date.now() };
    if (!nt.categoryId && set().askCategory !== false) nt = await askCategoryOnce(nt);
    st().tasks.push(nt);
    app.pendingWhy = `you added “${nt.title}” (rank ${nt.rank})`;
    await saveTasks(`add “${nt.title}”`);
    await cycle();
    const ss = S.sessions(st().tasks.find((x) => x.id === nt.id) || nt);
    toast(`Added “${nt.title}” — ${ss.length} session${ss.length === 1 ? '' : 's'} planned`);
  });
}
// A full task from what the quick-add parser understood (same defaults as the task dialog).
function buildDraft(d) {
  const s = set(), z = tz(), now = Date.now();
  let t = {
    id: S.newId('t'), kind: 'generic', title: 'Task', rank: 3, totalMinutes: 60,
    reading: { pages: 100, startPage: 1, speed: s.readingDefaults?.speed || 15, unit: 'pph', labels: 'actual' },
    deadline: T.atTime(T.addDays(T.dayKey(now, z), 7), s.bounds.end, z), earliestStart: null,
    chunkMinutes: null, minChunkMinutes: null, maxPerDayMinutes: null, breakMinutes: null, bounds: null, ignoreBounds: false,
    color: D.TASK_COLORS_PUBLIC[st().tasks.length % D.TASK_COLORS_PUBLIC.length], reminderMinutes: null, notes: '', frozen: [], planned: [], skipped: [], created: now,
    ...d,
  };
  if (t.repeat) t.deadline = S.repeatEnd(t, s);
  if (t.categoryId) t = C.applyCategory(t, C.catById(s, t.categoryId));
  return t;
}

// ======================================================================================
// Weekly review
// ======================================================================================
function openReview() {
  storeSet({ lastReviewWeek: T.startOfWeek(T.dayKey(Date.now(), tz()), set().weekStart) });
  app.view = 'review'; app.paperWeek = null; closeDrawer(); render();
}
// The period the review shows (week, two weeks, month, quarter, year), chosen with ‹ ›. By default the current
// one — or, on its first two days, the one that just ended.
const paperPeriod = () => (NP.PERIODS[set().paperPeriod] ? set().paperPeriod : 'week');
function periodStartOf(k, per) {
  const ws = set().weekStart, { y, m } = T.parseKey(k);
  if (per === 'week') return T.startOfWeek(k, ws);
  if (per === 'fortnight') { const w = T.startOfWeek(k, ws); return Math.floor(T.daysBetween('2024-01-01', w) / 7) % 2 ? T.addDays(w, -7) : w; }
  if (per === 'month') return T.keyOf(y, m, 1);
  if (per === 'quarter') return T.keyOf(y, Math.floor((m - 1) / 3) * 3 + 1, 1);
  return T.keyOf(y, 1, 1);
}
function periodShift(k, per, n) {
  if (per === 'week') return T.addDays(k, 7 * n);
  if (per === 'fortnight') return T.addDays(k, 14 * n);
  if (per === 'month') return T.addMonths(k, n);
  if (per === 'quarter') return T.addMonths(k, 3 * n);
  return T.addMonths(k, 12 * n);
}
function paperWeek() {
  const per = paperPeriod();
  if (app.paperWeek && app.paperPer === per) return app.paperWeek;
  const z = tz(), today = T.dayKey(Date.now(), z), cur = periodStartOf(today, per);
  return T.daysBetween(cur, today) <= 1 ? periodShift(cur, per, -1) : cur;
}
const paperEnd = (k) => periodShift(k, paperPeriod(), 1);
async function renderPaperView(seq) {
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
  setHTML(root, tools + NP.renderPaper({ r, s, use, signId: s.zodiac || null, period: per, extras: visit, pics: XT.pictureHistory(), goals: goalsP, projects: paperProjects(items, r.from, r.weekEnd) }));
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
  const setJoke = (j) => { visit.joke = j; const host = $('.np-joke', root); if (host) { host.textContent = j.text; const src = host.nextElementSibling?.classList.contains('np-small') ? host.nextElementSibling : null; if (src) src.remove(); if (j.link) host.insertAdjacentHTML('afterend', `<p class="np-small np-mute">From <a href="${esc(j.link)}" target="_blank" rel="noopener">${esc(j.source)}</a></p>`); } };
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
// ---------- Goals ----------
// Shared settings (goals, Later notes…) go to Google a few seconds after the last edit.
let shareTimer = null;
function syncSharedSoon() { clearTimeout(shareTimer); shareTimer = setTimeout(() => { if (E.connected(st())) cycle({ sync: false }); }, 2500); }
async function saveGoals(goals, label) {
  const before = set().goals || {};
  set().goals = GL.prune(goals, T.dayKey(Date.now(), tz()));
  await E.persist(st(), ['settings']);
  syncSharedSoon();
  if (label) pushUndo(label, async () => { set().goals = before; await E.persist(st(), ['settings']); render(); });
  render();
}
async function renderGoalsView(seq) {
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
          <ol class="g-list">${p.goals.map((g, i) => { const pg = p.perGoal.find((q) => q.id === g.id); return `<li class="g-row ${g.done ? 'done' : ''}" data-id="${esc(g.id)}">
            <span class="g-rank">${i + 1}</span><input type="checkbox" class="g-done" ${g.done ? 'checked' : ''} aria-label="Reached">
            ${catBox(g.cats, p, false, GL.goalWords(g))}
            <button type="button" class="g-text" title="Edit">${esc(g.text)}${g.budget || pg ? ` <span class="g-bud">⏱ ${pg ? hrs(pg.done) + (g.budget ? ' / ' : '') : ''}${g.budget ? hrs(g.budget) : ''}</span>` : ''}${g.movedFrom ? ' <span class="g-moved" title="Carried over">↪</span>' : ''}${g.repeatId ? ` <span class="g-rep" title="Repeats every ${GL.repeatOf(s, g)?.every || 'period'}">↻</span>` : ''}</button>
            <span class="g-acts"><button type="button" class="icon-btn sm g-up" title="Rank higher" ${i ? '' : 'disabled'}>▲</button><button type="button" class="icon-btn sm g-down" title="Rank lower" ${i < p.goals.length - 1 ? '' : 'disabled'}>▼</button><button type="button" class="icon-btn sm g-mv" title="Move to another period">→</button><button type="button" class="icon-btn sm g-del" title="Remove">✕</button></span></li>`; }).join('')}</ol>

        </div>`;
      }).join('')}
    </section>`;
  };
  const weeks = sec.list.filter((x) => x.kind === 'week'), months = sec.list.filter((x) => x.kind === 'month'), year = sec.list.find((x) => x.kind === 'year');
  const root = $('.goals', view) || view.appendChild(el('<div class="goals"></div>'));
  const y0 = root.scrollTop;
  setHTML(root, `<p class="muted small g-intro">Goals under Work, Fitness and Personal: add one with <b>+</b> (optionally repeating every week or month). Rank them with ▲▼ (1 = most important), give them an optional time budget, and tick them off when reached. Time in the categories that count for each head (set once, used for every week, month and year) shows as progress. → moves a goal to another period. Trips on your calendar are listed as reminders.</p>
    <h2 class="g-h">Weeks</h2><div class="g-grid">${weeks.map(card).join('')}</div>
    <h2 class="g-h">Months <span class="g-mtoggle"><button type="button" data-m="3" class="${s.goalsMonths === 12 ? '' : 'on'}">Next 3</button><button type="button" data-m="12" class="${s.goalsMonths === 12 ? 'on' : ''}">Next 12</button></span></h2>
    ${sec.daysLeft <= 14 ? `<p class="muted small">${esc(monthName(sec.thisMonth))} has ${sec.daysLeft} day${sec.daysLeft === 1 ? '' : 's'} left — this week's and next week's goals cover it.</p>` : ''}
    <div class="g-grid">${months.map(card).join('')}</div>
    <h2 class="g-h">The year ahead</h2><div class="g-grid">${card(year)}</div>`);
  root.scrollTop = y0;
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
      $('.g-done', r).onchange = (e) => saveGoals(GL.update(set(), key, id, { done: e.target.checked, doneAt: e.target.checked ? Date.now() : null }), e.target.checked ? 'goal reached' : 'goal reopened');
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
    f.onsubmit = (e) => { e.preventDefault(); const t = f.t.value.trim(); if (!t) { f.t.focus(); return; } const b = parseFloat(f.b.value); close({ text: t, head: f.h.value, budget: b > 0 ? b * 60 : null, cats, words: GL.parseWords(f.w.value), wmode: f.wm?.value || 'either', rep: !!f.rep?.checked }); };
  }, { cls: 'narrow' });
  if (!r) return;
  if (r.rep && every) {
    const before = set().goalRepeats;
    set().goalRepeats = GL.addRepeat(set(), every, key, r);
    const g = GL.materialize(set(), [key]);
    await saveGoals(g || set().goals, 'add repeating goal');
    const u = undoStack[undoStack.length - 1]; if (u) { const f0 = u.undo; u.undo = async () => { set().goalRepeats = before; await f0(); }; }
    toast(`Added — repeats every ${every}`);
  } else saveGoals(GL.add(set(), key, r.text, { head: r.head, budget: r.budget, cats: r.cats, words: r.words, wmode: r.wmode }), 'add goal');
}

// The icon box next to a goal: its own categories' icons, or a faint tag when it uses the head's categories.
function catBoxInner(cats, head) {
  const s = set();
  const list = (cats || []).map((id) => C.catById(s, id)).filter(Boolean);
  if (!list.length) return '<span class="g-cb-none">🏷</span>';
  return list.slice(0, 3).map((c) => `<span class="g-cb-ic" style="--c:${esc(c.color)}">${esc(c.icon || C.parentOf(s, c)?.icon || c.name.slice(0, 1))}</span>`).join('') + (list.length > 3 ? `<span class="g-cb-more">+${list.length - 3}</span>` : '');
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
      <div class="g-pick">${C.ordered(s).map((c) => `<button type="button" class="cat-chip ${c.parent ? 'sub' : ''} ${cur.has(c.id) ? 'on' : ''}" data-cat="${esc(c.id)}" style="--c:${esc(c.color)}" title="${esc(C.fullLabel(s, c))}"><i></i>${c.parent ? '<span class="cat-sub">↳</span>' : ''}${c.icon ? `<span class="cat-ic">${esc(c.icon)}</span>` : ''}${esc(c.name)}</button>`).join('')}</div>
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
async function editGoal(key, id) {
  const s = set(), g = GL.list(s, key).find((q) => q.id === id); if (!g) return;
  const own = new Set(g.cats || []);
  const r = await modal(`<form class="choice"><h2>Goal</h2>
      <label class="field"><span>Goal</span><input name="t" value="${esc(g.text)}" maxlength="200" autofocus></label>
      <div class="row">
        <label class="field grow"><span>Head</span><select name="h">${GL.HEADS.map(([h, l, ic]) => `<option value="${h}" ${GL.headOf(g) === h ? 'selected' : ''}>${ic} ${l}</option>`).join('')}</select></label>
        <label class="field"><span>Time budget (h)</span><input name="b" type="number" min="0" step="0.25" value="${g.budget ? +(g.budget / 60).toFixed(2) : ''}" placeholder="none" style="width:110px"></label>
      </div>
      <details ${own.size ? 'open' : ''}><summary class="small">Count only these categories for this goal (otherwise the head's)</summary>
        <div class="g-catlist">${(s.categories || []).map((c) => `<label class="chk"><input type="checkbox" name="c" value="${esc(c.id)}" ${own.has(c.id) ? 'checked' : ''}> ${esc(C.catLabel(c))}</label>`).join('')}</div></details>
      ${wordsFieldHTML(GL.goalWords(g), g.wmode)}
      ${(() => { const every = key.startsWith('w:') ? 'week' : key.startsWith('m:') ? 'month' : null; return every ? `<label class="chk"><input type="checkbox" name="rep" ${GL.repeatOf(s, g) ? 'checked' : ''}> Repeat every ${every}</label>` : ''; })()}
      <label class="chk"><input type="checkbox" name="d" ${g.done ? 'checked' : ''}> Reached</label>
      <div class="actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">Save</button></div></form>`,
  (dlg, close) => {
    const f = $('form', dlg);
    const upd = () => syncWordsField(dlg, $$('input[name=c]:checked', dlg).length); f.addEventListener('input', upd); f.addEventListener('change', upd); upd();
    f.onsubmit = (e) => { e.preventDefault(); const b = parseFloat(f.b.value); close({ text: f.t.value.trim() || g.text, head: f.h.value, budget: b > 0 ? Math.round(b * 60) : null, cats: $$('input[name=c]:checked', dlg).map((x) => x.value), words: GL.parseWords(f.w.value), wmode: f.wm.value, done: f.d.checked, rep: f.rep ? f.rep.checked : null }); };
  }, { cls: 'narrow' });
  if (!r) return;
  // repeat on / off (the copies already made stay)
  const rp = GL.repeatOf(set(), g);
  if (r.rep === false && rp) set().goalRepeats = GL.repeats(set()).filter((x) => x.id !== rp.id);
  if (r.rep === true && !rp) {
    const reps = GL.addRepeat(set(), key.startsWith('w:') ? 'week' : 'month', key, { text: r.text, head: r.head, budget: r.budget, cats: r.cats, words: r.words, wmode: r.wmode });
    set().goalRepeats = reps; r.repeatId = reps[reps.length - 1].id;
  }
  if (r.rep === true && rp) set().goalRepeats = GL.repeats(set()).map((x) => (x.id === rp.id ? { ...x, text: r.text.slice(0, 200), head: r.head, budget: r.budget || undefined, cats: r.cats.length ? r.cats : undefined, words: r.words.length ? r.words : undefined, wmode: r.words.length && r.cats.length && r.wmode === 'both' ? 'both' : undefined } : x));
  saveGoals(GL.update(set(), key, id, { text: r.text.slice(0, 200), head: r.head, budget: r.budget, cats: r.cats.length ? r.cats : null, words: r.words.length ? r.words : null, wmode: r.words.length && r.cats.length && r.wmode === 'both' ? 'both' : null, done: r.done, ...(r.repeatId ? { repeatId: r.repeatId } : r.rep === false ? { repeatId: null } : {}) }), 'edit goal');
}

// On the first day of the week, offer the review once.
// On the first day of a new week or month (from 9:00, or whenever the app is opened later that day — or in the
// first days if it wasn't opened), show this week's and this month's goals once. Snooze hides it for N hours.
let goalNoticeOpen = false;
async function checkGoalNotice() {
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

async function maybeOfferReview() {
  const z = tz(), wk = T.startOfWeek(T.dayKey(Date.now(), z), set().weekStart);
  const { lastReviewWeek } = await storeGet('lastReviewWeek');
  if (lastReviewWeek === wk || T.daysBetween(wk, T.dayKey(Date.now(), z)) > 1 || !st().tasks.length) return;
  storeSet({ lastReviewWeek: wk });
  setTimeout(() => uiToast('Your weekly review is ready — what got done, what slipped, what’s at risk.', { action: 'Open', onAction: openReview, ms: 12000 }), 2500);
}

// ======================================================================================
// History log, "what moved and why"
// ======================================================================================
function logHistory({ kind, task, sess, ...rest }) {
  RV.logEntry(set(), { kind, taskId: task?.id, title: task?.title, cat: task?.categoryId || null, t: sess?.start, plan: sess ? Math.round((sess.end - sess.start) / T.MIN) : undefined, ...rest });
  E.persist(st(), ['settings']);
}
// After a re-plan: tell which tasks were pushed later, and why. Imminent sessions pushed by something other than
// your own change (a new meeting, time passing) are recorded as slips.
function handleMoves(moves) {
  if (!moves.length || app.undoing) return;
  const now = Date.now();
  const mine = app.lastUserChange && now - app.lastUserChange < 8000;
  if (!mine) {
    for (const m of moves) {
      if (m.nextFrom && m.nextFrom - now < T.DAY && m.nextFrom > now && m.nextTo - m.nextFrom >= 30 * T.MIN) {
        const task = st().tasks.find((t) => t.id === m.taskId);
        logHistory({ kind: 'moved', task, t: m.nextFrom, by: Math.round((m.nextTo - m.nextFrom) / T.MIN) });
      }
    }
    return;
  }
  // The task you just changed moving is expected; only report the others.
  moves = moves.filter((m) => (st().tasks.find((t) => t.id === m.taskId)?.rev || 0) < app.lastUserChange - 1500);
  if (!moves.length) return;
  // who took the old slots?
  for (const m of moves) {
    const takers = new Set();
    for (const t of st().tasks) if (t.id !== m.taskId) for (const c of t.planned || []) if (m.oldSlots.some((o) => c.start < o.end && c.end > o.start)) takers.add(t.title);
    m.takers = [...takers];
  }
  app.lastMoves = { moves, why: app.lastChangeLabel, at: now };
  const fmtShift = (m) => { const d = Math.max((m.finishTo || 0) - (m.finishFrom || 0), (m.nextTo || 0) - (m.nextFrom || 0)); return d >= T.DAY ? `+${Math.round(d / T.DAY)}d` : `+${T.fmtDur(Math.round(d / T.MIN))}`; };
  const txt = moves.slice(0, 3).map((m) => `${m.title} (${fmtShift(m)})`).join(', ') + (moves.length > 3 ? ` +${moves.length - 3} more` : '');
  setTimeout(() => uiToast(`Pushed later: ${txt}`, { action: 'Why?', onAction: showMoves, ms: 9000 }), 1200);
  const pill = $('#moved-pill');
  if (pill) { pill.hidden = false; pill.textContent = `↷ ${moves.length} moved`; pill.onclick = showMoves; clearTimeout(app.pillTimer); app.pillTimer = setTimeout(() => (pill.hidden = true), 120000); }
}
function showMoves() {
  const lm = app.lastMoves;
  if (!lm) return;
  const z = tz(), s = set();
  const f = (ms) => (ms ? T.format(ms, z, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: s.h12 }) : '—');
  modal(`<div class="choice moves"><h2>What moved and why</h2>
    <p class="muted small">${/^you /.test(lm.why || '') ? `Because ${esc(lm.why)}` : `After your change (${esc(lm.why || 'last change')})`}:</p>
    <ul class="mv-list">${lm.moves.map((m) => `<li><b>${esc(m.title)}</b>
      <div class="small">Next session ${esc(f(m.nextFrom))} → <b>${esc(f(m.nextTo))}</b> · finishes ${esc(f(m.finishFrom))} → <b>${esc(f(m.finishTo))}</b></div>
      ${m.takers?.length ? `<div class="muted small">Its time now goes to ${esc(m.takers.join(', '))} (higher rank or due sooner).</div>` : ''}</li>`).join('')}</ul>
    <div class="actions"><button type="button" class="btn ghost" data-close>Close</button></div></div>`, null, { cls: 'narrow' });
}

// Persistent notice under the toolbar for anything that stops tasks reaching Google.
function renderBanner() {
  const b = $('#banner');
  const info = st().syncInfo, a = st().auth || {};
  const hasTasks = st().tasks.some((t) => !t.archived);
  let html = '';
  if (!E.connected(st())) {
    if (hasTasks && !app.bannerDismissed) html = innerWidth < 600
      ? `<span>📍 Tasks are only saved on this device.</span><button class="btn small primary" data-b="connect">Connect Google</button><button class="icon-btn sm" data-b="x" title="Hide">✕</button>`
      : `<span>📍 Your task sessions are only saved in this browser — they won't appear in Google Calendar until you connect it.</span><button class="btn small primary" data-b="connect">Connect Google Calendar</button><button class="icon-btn sm" data-b="x" title="Hide">✕</button>`;
  } else if (a.needsReconnect || info?.kind === 'auth') {
    html = `<span>🔑 Google sign-in expired, so task sessions can't be synced.</span><button class="btn small primary" data-b="reconnect">Reconnect</button>`;
  } else if (info && !info.ok && ['permission', 'error', 'partial'].includes(info.kind)) {
    html = `<span>⚠ Task sessions aren't reaching Google Calendar: ${esc(info.error)}</span>${info.kind === 'permission' ? '<button class="btn small primary" data-b="reconnect">Reconnect</button>' : '<button class="btn small" data-b="retry">Retry</button>'}<button class="btn small ghost" data-b="details">Details</button>`;
  }
  setHTML(b, html);
  b.hidden = !html;
  $$('[data-b]', b).forEach((x) => (x.onclick = () => {
    const k = x.dataset.b;
    if (k === 'connect') openConnect();
    if (k === 'reconnect') { G.ensureHostPermission(); reconnectGoogle(); }
    if (k === 'retry') cycle();
    if (k === 'details') openSyncPanel();
    if (k === 'x') { app.bannerDismissed = true; renderBanner(); }
  }));
}

async function openSyncPanel() {
  const r = await D.syncDialog(ctx);
  if (r === 'sync') { E.invalidate(); await cycle(); toast(st().syncInfo?.ok ? `All ${st().syncInfo.total} sessions are on Google Calendar` : 'Sync finished with problems — see the notice'); }
  if (r === 'reconnect') reconnectGoogle();
  if (r === 'connect') openConnect();
  if (r === 'settings') openSettings();
}

async function handleProblems(problems) {
  for (const p of problems) {
    const task = st().tasks.find((t) => t.id === p.taskId);
    if (!task) continue;
    const key = Math.round(p.shortfall / 15);
    if (st().acks[task.id] === key || app.shownProblems.has(task.id + ':' + key)) continue;
    if (document.querySelector('dialog[open]') || document.hidden) continue;
    app.shownProblems.add(task.id + ':' + key);
    const r = await D.problemDialog(ctx, task, p);
    const cur = st().tasks.find((t) => t.id === task.id);
    if (!r || !cur) continue;
    if (r.action === 'deadline' && r.deadline) { replaceTask({ ...cur, deadline: r.deadline }); delete st().acks[task.id]; }
    else if (r.action === 'ignore') replaceTask({ ...cur, ignoreBounds: true });
    else if (r.action === 'keep') st().acks[task.id] = key;
    await saveTasks(r.action === 'keep' ? false : 'change deadline');
    if (r.action !== 'keep') { again = true; }
  }
}

function setStatus(text, kind = '') { app.status = { text, kind }; const s = $('#sync-status'); if (s) { s.textContent = text; s.className = 'status ' + kind; } }

function offlineStatus() {
  const since = E.offlineSince(st());
  setStatus(since ? `Offline · saved ${T.fmtTime(since, tz(), set().h12)}${T.dayKey(since, tz()) !== T.dayKey(Date.now(), tz()) ? ' ' + T.format(since, tz(), { day: 'numeric', month: 'short' }) : ''}` : 'Offline', 'warn');
}
function handleError(err) {
  // No connection: keep working quietly with saved data; it syncs again when you're back online.
  if (G.isOffline(err) || (navigator.onLine === false)) { offlineStatus(); return; }
  console.error(err);
  if (err instanceof G.AuthError || err instanceof G.PermissionError) {
    setStatus(err instanceof G.PermissionError ? 'Permission needed' : 'Google sign-in needed', 'bad');
    renderBanner();
    toast(err.message, { action: 'Reconnect', onAction: () => { G.ensureHostPermission(); reconnectGoogle(); }, ms: 9000 });
  } else {
    setStatus('Error', 'bad');
    toast(err.message || String(err), { ms: 7000 });
  }
}

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

function closeDrawer() { $('#side')?.classList.remove('open'); const sc = $('#scrim'); if (sc) sc.hidden = true; }

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
async function refreshFromServer() {
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
async function openConnect() {
  if (G.builtinAvailable()) { G.ensureHostPermission(); return connectGoogle('builtin'); }
  return openWizard();
}

async function openWizard() {
  const r = await D.setupWizard(ctx);
  if (r?.connected) renderBanner();
}

async function openSettings() {
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
    if (r.action === 'import') {
      const data = JSON.parse(await r.file.text());
      if (data.app !== 'tempo') throw new Error('Not a Tempo backup file');
      st().settings = { ...st().settings, ...data.settings };
      st().tasks = data.tasks || [];
      st().localEvents = data.localEvents || [];
      await E.persist(st());
      toast('Backup restored');
    }
  } catch (err) { handleError(err); }
  E.invalidate();
  cycle();
}


// ======================================================================================
// Analysis view
// ======================================================================================
app.anOpts = { period: 'next7', scope: 'bounds', by: 'category' };

async function renderAnalysisView(seq) {
  const s = set(), z = tz(), o = app.anOpts;
  const view = $('#view');
  const modeBar = `<div class="seg an-mode"><button data-mode="use" class="${app.anMode === 'history' ? '' : 'on'}">Time use</button><button data-mode="history" class="${app.anMode === 'history' ? 'on' : ''}">Plan vs actual</button><button data-mode="review">Weekly review…</button></div>`;
  const bindMode = (root) => $$('.an-mode button', root).forEach((b) => (b.onclick = () => { if (b.dataset.mode === 'review') return openReview(); app.anMode = b.dataset.mode; render(); }));
  if (app.anMode === 'history') {
    const weeks = app.histWeeks || 8;
    setHTML(view, `<div class="analysis">${modeBar}<div class="row an-ctl"><label class="field inline"><span>Show the last</span><select class="hist-w">${[4, 8, 12, 26].map((w) => `<option value="${w}" ${w === weeks ? 'selected' : ''}>${w} weeks</option>`).join('')}</select></label></div>${RV.renderHistory(st(), weeks)}</div>`);
    bindMode(view);
    $('.hist-w', view).onchange = (e) => { app.histWeeks = +e.target.value; render(); };
    bindTips(view);
    return;
  }
  if (!$('.analysis', view)) setHTML(view, '<div class="analysis"><p class="muted">Calculating…</p></div>');
  const rng = A.periodRange(o.period, s, Date.now(), { from: o.from, to: o.to });
  const days = [];
  for (let k = T.dayKey(rng.from, z); T.dayStart(k, z) < rng.to; k = T.addDays(k, 1)) days.push(k);
  // one extra day before, so a night that starts the evening before the range can see what's in it
  const items = await collectItems(o.scope === 'full' ? [T.addDays(days[0], -1), ...days] : days);
  if (seq !== app.renderSeq) return;
  const groups = {};
  const actx = { settings: s, gmeta: st().gmeta, calColor };
  const occ = items.filter((it) => A.isOccupying(it, s)).map((it) => {
    const g = A.groupOf(it, o.by, actx);
    const G0 = groups[g.key] ||= { ...g, contains: new Set() };
    G0.contains.add(it.kind === 'chunk' ? it.task.title : (it.title || '(No title)'));
    return { start: it.start, end: it.end, group: g.key, prio: it.kind === 'chunk' ? 1 : 0, title: it.kind === 'chunk' ? it.task.title : (it.title || '(No title)'), kind: it.kind, uid: it.key };
  });
  const wins = A.scopeWindows(o.scope, rng.from, rng.to, s);
  let sleep = null;
  if (o.scope === 'full' && s.sleepAssume !== false) {
    sleep = A.assumedSleep(occ, rng.from, rng.to, s);
    if (sleep.blocks.length) {
      const sg = A.sleepGroup(s, o.by);
      occ.push(...A.sleepItems(sleep, sg));
      (groups[sg.key] ||= { ...sg, contains: new Set() }).contains.add('Sleep (assumed)');
    }
  }
  const data = A.compute(occ, wins, z);
  for (const k of days) data.days[k] ||= { available: 0, free: 0, groups: {} };
  app.anLast = { data, groups };
  const root = $('.analysis', view) || view.appendChild(el('<div class="analysis"></div>'));
  setHTML(root, modeBar + A.renderAnalysis({ data, groups, opts: o, settings: s, rangeInfo: rng, sleep }));
  bindMode(root);
  $$('[data-sleep]', root).forEach((c) => (c.onchange = async () => {
    const k = c.dataset.sleep;
    if (k === 'on') s.sleepAssume = c.checked; else if (k === 'cat') s.sleepCategory = c.value || null; else if (c.value) s[k === 'start' ? 'sleepStart' : 'sleepEnd'] = c.value;
    await E.persist(st(), ['settings']); render();
  }));
  $$('[data-o]', root).forEach((c) => {
    if (c.dataset.o === 'csv') { c.onclick = () => { download(new Blob([A.toCsv(data, groups, z)], { type: 'text/csv' }), `tempo-analysis-${T.dayKey(rng.from, z)}.csv`); }; return; }
    c.onchange = () => {
      o[c.dataset.o] = c.value;
      if (o.period === 'custom' && !o.from) { o.from = T.dayKey(Date.now(), z); o.to = T.addDays(o.from, 13); }
      storeSet({ analysisOpts: o });
      render();
    };
  });
  $$('.lbl-edit', root).forEach((b) => (b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); renameColor(b.dataset.hex); }));
  bindTips(root);
}

async function renameColor(hex) {
  const cur = (set().colorLabels || {})[hex] || A.colorName(hex) || '';
  const v = await modal(`<form class="choice"><h2>Name this color category</h2>
      <p class="muted small">e.g. “Deep work”, “Meetings”, “Reading”. Used in the analysis.</p>
      <div class="row"><span class="sw-dot big" style="background:${esc(hex)}"></span><input name="v" value="${esc(cur)}" autofocus style="flex:1"></div>
      <div class="actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">Save</button></div></form>`,
  (dlg, close) => { $('form', dlg).onsubmit = (e) => { e.preventDefault(); close($('[name=v]', dlg).value.trim()); }; }, { cls: 'narrow' });
  if (v == null) return;
  set().colorLabels = { ...(set().colorLabels || {}), [hex]: v || undefined };
  await E.persist(st(), ['settings']);
  render();
}

function bindTips(root) {
  let tip = $('#chart-tip');
  if (!tip) { tip = el('<div id="chart-tip" class="chart-tip" hidden></div>'); document.body.appendChild(tip); }
  root.addEventListener('pointermove', (e) => {
    const t = e.target.closest('[data-tip]');
    if (!t) { tip.hidden = true; return; }
    tip.textContent = t.dataset.tip;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    tip.style.left = Math.min(innerWidth - r.width - 8, e.clientX + 14) + 'px';
    tip.style.top = Math.max(8, e.clientY - r.height - 10) + 'px';
  });
  root.addEventListener('pointerleave', () => (tip.hidden = true));
}

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
async function exportCustom() {
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
      const title = `${T.format(a, z, { weekday: 'short', day: 'numeric', month: 'short' })}${days.length > 1 ? ` – ${T.format(b, z, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}` : `, ${T.parseKey(days[0]).y}`}${r.label ? ` · ${r.label}` : ''}`;
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
    busiest: busiest && { label: T.format(T.dayStart(busiest.k, z), z, { weekday: 'short', day: 'numeric', month: 'short' }), m: busiest.m, of: busiest.of },
    sessions: { done: chunks.filter((c) => c.status === 'done').length, total: chunks.length },
  };
}

async function exportView(kind, fmt) {
  const { canvas, key } = await renderPage(kind, app.cursor);
  const name = `tempo-${kind}-${key}`;
  const blob = fmt === 'pdf' ? await X.canvasToPdf(canvas) : fmt === 'tiff' ? await X.canvasesToTiff([canvas]) : await X.canvasToBlob(canvas, fmt === 'jpeg' ? 'image/jpeg' : 'image/png');
  const ext = fmt === 'jpeg' ? 'jpg' : fmt === 'tiff' ? 'tif' : fmt;
  await download(blob, `${name}.${ext}`);
}

// Several weeks or months -> one multi-page PDF or TIFF
async function exportMulti() {
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
    { ic: '+', label: 'New event', run: () => $('#btn-new-event').click() },
    { ic: '⧉', label: 'New task (split into sessions)', run: () => newTask({ kind: 'generic' }) },
    { ic: '📖', label: 'New reading plan', run: () => newTask({ kind: 'reading' }) },
    { ic: '📁', label: 'New project (a chain of tasks and events)', run: () => openProject(null) },
    { ic: '⏰', label: 'Started late', run: () => startedLate() },
    { ic: '⏹', label: 'Finished early', run: () => finishedEarly() },
    { ic: '⤒', label: 'Fill time since last event', run: fillSinceLast },
  ]);
  $('#btn-more').onclick = () => sheetMenu([
    { ic: '⟳', label: 'Refresh from Google', run: refreshFromServer },
    { ic: '✓', label: 'Sync status', run: openSyncPanel },
    { ic: '⚙', label: 'Settings', run: openSettings },
    { ic: '↶', label: 'Undo last change', run: undo },
    { ic: '⏰', label: 'Started late', run: () => startedLate() },
    { ic: '⏹', label: 'Finished early', run: () => finishedEarly() },
    { ic: '⤒', label: 'Fill time since last event', run: fillSinceLast },
    { ic: '★', label: 'Weekly review', run: openReview },
    { ic: '✦', label: 'AI & automation', run: openAiConsole },
    '-', 'Export',
    { ic: 'W', label: 'This week as PDF', run: () => exportView('week', 'pdf').catch(handleError) },
    { ic: 'W', label: 'This week as image (PNG)', run: () => exportView('week', 'png').catch(handleError) },
    { ic: 'M', label: 'This month as PDF', run: () => exportView('month', 'pdf').catch(handleError) },
    { ic: '⧉', label: 'Several weeks or months…', run: exportMulti },
    { ic: '◷', label: 'Custom dates and hours…', run: exportCustom },
  ]);
  $('#btn-settings').onclick = openSettings;
  $('#btn-undo').onclick = undo;
  $('#btn-now').onclick = () => sheetMenu([
    { ic: '⏰', label: 'Started late', run: () => startedLate() },
    { ic: '⏹', label: 'Finished early', run: () => finishedEarly() },
    { ic: '⤒', label: 'Fill time since last event', run: fillSinceLast },
    '-',
    { ic: '✦', label: 'AI & automation…', run: openAiConsole },
  ]);
  $('#btn-review').onclick = openReview;
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
    if (e.target.closest('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open]') || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 't') $('#btn-today').click();
    else if (k === 'd' || k === 'w' || k === 'm' || k === 'y') { app.view = { d: 'day', w: 'week', m: 'month', y: 'analysis' }[k]; render(); }
    else if (k === 'arrowleft' || k === 'j') nav(-1);
    else if (k === 'arrowright' || k === 'k') nav(1);
    else if (k === 'c' || k === 'n') $('#btn-new-event').click();
    else if (k === 'a') newTask({ kind: 'generic' });
    else if (k === 'r') refreshFromServer();
    else if (k === 'q') { e.preventDefault(); if (innerWidth < 760) $('#btn-menu').click(); $('#quick-add')?.focus(); }
    else if (k === 'v') openReview();
    else if (k === 'g') { app.view = 'goals'; render(); }
    else if (k === 'f') finishedEarly();
    else if (k === 'l') fillSinceLast();
    else if (k === 'u') undo();
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
  if (redirect?.ok) sessionStorage.removeItem('tempo:silentTried');
  if (redirect && !redirect.ok && redirect.kind === 'silent' && redirect.ret?.autoInteractive && ['interaction_required', 'login_required', 'consent_required'].includes(redirect.code)) {
    return G.redirectToGoogle(G.clientFor(st().auth || {})?.id, st().auth || {}, 'interactive', { view: app.view, cursor: app.cursor });
  }
  if (!redirect && await G.needsSilentRenew() && !sessionStorage.getItem('tempo:silentTried')) {
    sessionStorage.setItem('tempo:silentTried', '1');
    document.body.classList.add('signing-in');
    return G.silentRenew({ view: app.view, cursor: app.cursor });
  }
  try { const ao = (await storeGet('analysisOpts')).analysisOpts; if (ao) Object.assign(app.anOpts, ao); } catch { /* ignore */ }
  bindToolbar();
  setStatus(E.connected(st()) ? 'Loading…' : 'Local mode');
  await render();
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
        toast(`Connected to Google Calendar${st().auth.email ? ' as ' + st().auth.email : ''}`);
      }
      await E.persist(st(), ['gmeta', 'settings']);
    } catch (err) { handleError(err); }
  }
  window.__tempo = { app, cycle, render, S, T, E, checkGoalNotice, checkGoogle: async () => { app.gCursors ||= {}; if (await E.googleChanged(st(), app.gCursors)) { E.invalidate(); await cycle({ pull: true }); return true; } return false; } }; // handy for debugging from the console
  markBaseline();
  setupApi();
  setupSwipe();
  loadTimer();
  await cycle({ pull: true });
  maybeOfferReview();
  setTimeout(checkGoalNotice, 3000);
  setInterval(checkGoalNotice, 60000);
  // Calendars list in the sidebar: fold away / unfold (remembered on this device)
  const calSec = $('.cal-sec'), calTg = $('#cal-toggle');
  const setCalsOpen = (open) => { calSec?.classList.toggle('collapsed', !open); calTg?.setAttribute('aria-expanded', String(open)); };
  try { setCalsOpen(localStorage.getItem('tempo:calsCollapsed') !== '1'); } catch { /* storage blocked */ }
  calTg?.addEventListener('click', () => { const open = calSec.classList.contains('collapsed'); setCalsOpen(open); try { localStorage.setItem('tempo:calsCollapsed', open ? '0' : '1'); } catch { /* storage blocked */ } });
  // weather: today's and tomorrow's forecasts change most — check again every 30 minutes, and on coming back
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
