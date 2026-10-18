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
import { ext, isWeb, get as storeGet, set as storeSet } from './storage.js';
import { $, $$, esc, el, toast, choose, popover, closePopover, download, modal, setHTML } from './ui.js';

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
  get lastBusy() { return app.lastBusy; },
  defaultCalendar() {
    const prim = (st().gmeta.calendars || []).find((c) => c.primary);
    return E.connected(st()) && prim ? prim.id : E.LOCAL_CAL;
  },
  writableCalendars() {
    const g = E.connected(st()) ? (st().gmeta.calendars || []).filter((c) => ['owner', 'writer'].includes(c.accessRole)) : [];
    return [...g, { id: E.LOCAL_CAL, summary: 'Local (this browser)', color: LOCAL_COLOR }];
  },
  async saveAuth(patch = {}) { const cur = (await storeGet('auth')).auth || {}; st().auth = { ...cur, ...patch }; await storeSet({ auth: st().auth }); },
  connect: (mode) => connectGoogle(mode),
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
  if (view === 'analysis') view = 'week';
  if (view === 'day') return { days: [cursor] };
  if (view === '3day') return { days: [cursor, T.addDays(cursor, 1), T.addDays(cursor, 2)] };
  if (view === 'week') { const a = set().weekView === 'rolling' ? cursor : T.startOfWeek(cursor, ws); return { days: Array.from({ length: 7 }, (_, i) => T.addDays(a, i)) }; }
  const { y, m } = T.parseKey(cursor);
  const first = T.keyOf(y, m, 1);
  const a = T.startOfWeek(first, ws);
  return { days: Array.from({ length: 42 }, (_, i) => T.addDays(a, i)), monthKey: first };
}

function calColor(calId) {
  if (calId === E.LOCAL_CAL) return LOCAL_COLOR;
  return (st().gmeta.calendars || []).find((c) => c.id === calId)?.color || '#4f6bed';
}

function eventItem(ev) {
  const iv = E.interval(ev, tz());
  const me = ev.attendees?.find((a) => a.self);
  return {
    key: `${ev._calId}|${ev.id}`, kind: 'event', title: ev.summary || '(No title)', ...iv,
    color: ev.colorId ? G.EVENT_COLORS[ev.colorId] : calColor(ev._calId), ev,
    editable: EV.canEdit(ev, st()), declined: me?.responseStatus === 'declined', tentative: me?.responseStatus === 'tentative',
  };
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
  const items = [...gev.map(eventItem), ...local.map(eventItem), ...(hidden.has('tasks') ? [] : chunkItems(from, to))];
  return items;
}

// ======================================================================================
// Rendering
// ======================================================================================
async function render() {
  const seq = ++app.renderSeq;
  document.body.classList.toggle('analysis-mode', app.view === 'analysis');
  if (app.view === 'analysis') { renderToolbar(); renderSidebar(); return renderAnalysisView(seq); }
  const r = range();
  renderToolbar();
  renderSidebar();
  const items = await collectItems(r.days);
  if (seq !== app.renderSeq) return;
  app.items = new Map(items.map((i) => [i.key, i]));
  const view = $('#view');
  const scrollTop = $('.tg-scroll', view)?.scrollTop;
  view.replaceChildren();
  if (app.view === 'month') view.appendChild(renderMonth(r, items));
  else view.appendChild(renderTimeGrid(r.days, items));
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
  return ['ev', it.kind === 'chunk' ? 'chunk' : '', it.status === 'done' ? 'done' : '', it.status === 'pinned' ? 'pinned' : '',
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
      ${days.map((k) => `<div class="tg-dayhead ${k === todayK ? 'today' : ''} ${k < todayK ? 'past' : ''}" data-day="${k}">
        <span class="wd">${esc(T.format(T.dayStart(k, z), z, { weekday: 'short' }))}</span><button class="dn" data-goto="${k}">${T.parseKey(k).d}</button></div>`).join('')}
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
    const col = el(`<div class="tg-col ${k === todayK ? 'today' : ''}" data-day="${k}"></div>`);
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
      const node = el(`<div class="${itemClasses(it)} ${short ? 'short' : ''}" data-key="${esc(it.key)}" style="top:${top}px;height:${h}px;left:calc(${left}% + 1px);width:calc(${width}% - ${g.cols > 1 ? 3 : 6}px);--c:${it.color}">
        <div class="ev-t">${it.status === 'done' ? '<span class="tick">✓</span>' : ''}${it.status === 'pinned' ? '<span class="pin" title="Pinned">📌</span>' : ''}${esc(it.title)}</div>
        <div class="ev-time">${short ? '' : esc(timeStr)}${it.ev?.recurringEventId ? ' <span class="rep" title="Repeats">↻</span>' : ''}</div>
        ${it.editable && g.endsHere ? '<div class="ev-resize"></div>' : ''}
      </div>`);
      node.title = `${it.title}\n${timeStr}`;
      col.appendChild(node);
      } catch (err) { drawErrors.push([it.title, err]); }
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
  // Nothing from your tasks in this range? Point to where the sessions are.
  const hasChunks = timed.some((i) => i.kind === 'chunk');
  if (!hasChunks && !set().hiddenCalendars?.includes('tasks')) {
    const from = T.dayStart(days[0], z), to = T.dayStart(T.addDays(days[days.length - 1], 1), z);
    const all = st().tasks.filter((t) => !t.archived).flatMap((t) => S.sessions(t).map((c) => ({ ...c, task: t })));
    const next = all.filter((c) => c.start >= to && c.kind !== 'done').sort((a, b) => a.start - b.start)[0];
    const prev = !next && all.filter((c) => c.end <= from).sort((a, b) => b.start - a.start)[0];
    const target = next || prev;
    if (target) {
      const when = T.format(target.start, z, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: s.h12 });
      const hint = el(`<div class="next-hint"><span>No task sessions ${days.length === 1 ? 'on this day' : 'in these days'}. ${next ? 'Next' : 'Last'}: <b>${esc(when)}</b> — ${esc(target.label)}</span><button class="btn small primary">${next ? 'Show it →' : '← Show it'}</button></div>`);
      $('button', hint).onclick = () => { app.cursor = T.dayKey(target.start, z); app.miniCursor = app.cursor; render(); };
      root.appendChild(hint);
    }
  }
  $$('.dn', root).forEach((b) => b.addEventListener('click', () => { app.cursor = b.dataset.goto; app.view = 'day'; render(); }));
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
    const cell = el(`<div class="m-cell ${T.parseKey(k).m !== month ? 'out' : ''} ${k === todayK ? 'today' : ''}" data-day="${k}">
      <button class="m-dn" data-goto="${k}">${T.parseKey(k).d}</button>
      <div class="m-items">
        ${shown.map((it) => it.allDay
          ? `<div class="chip allday ${!it.editable ? 'ro' : ''}" data-key="${esc(it.key)}" style="--c:${it.color}">${esc(it.title)}</div>`
          : `<div class="chip ${it.kind === 'chunk' ? 'chunk' : ''} ${it.status === 'done' ? 'done' : ''} ${!it.editable ? 'ro' : ''}" data-key="${esc(it.key)}" style="--c:${it.color}"><i></i><span class="ct">${esc(T.fmtTime(it.start, z, set().h12))}</span> ${esc(it.title)}</div>`).join('')}
        ${list.length > max ? `<button class="m-more" data-goto="${k}">+${list.length - shown.length} more</button>` : ''}
      </div></div>`);
    grid.appendChild(cell);
  }
  $$('[data-goto]', root).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); app.cursor = b.dataset.goto; app.view = 'day'; render(); }));
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
  ];
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
  setHTML($('#task-list'), tasks.length ? tasks.map((t) => {
    const p = S.progress(t, now);
    const ss = S.sessions(t);
    const doneN = ss.filter((c) => c.kind === 'done' || (c.kind === 'pinned' && c.end <= now)).length;
    const complete = p.pct >= 100;
    const warn = !complete && t.lastPlan?.shortfall > 0;
    const next = ss.find((c) => c.kind !== 'done' && c.end > now);
    return `<button class="task-row ${complete ? 'complete' : ''}" data-task="${t.id}" style="--c:${t.color}">
      <span class="rank" title="Rank ${t.rank}">${t.rank}</span>
      <span class="tr-main">
        <span class="tr-title">${t.kind === 'reading' ? '📖 ' : ''}${esc(t.title)}${warn ? ' <span class="warn-ic" title="Not enough time before the deadline">⚠</span>' : ''}</span>
        <span class="tr-meta">${complete ? 'Done ✓' : `${doneN}/${ss.length} · due ${esc(T.format(t.deadline, tz(), { weekday: 'short', day: 'numeric', month: 'short' }))}`}${next && !complete ? ` · next ${esc(T.format(next.start, tz(), { weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: set().h12 }))}` : ''}</span>
        <span class="bar"><i style="width:${p.pct}%"></i></span>
      </span></button>`;
  }).join('') : `<p class="muted small empty">No tasks yet. Add one and Tempo splits it into sessions around your calendar.</p>`);
  $$('#task-list .task-row').forEach((b) => b.addEventListener('click', () => editTask(st().tasks.find((t) => t.id === b.dataset.task))));
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
  if (where === 'month' && (!cell || target.closest('[data-goto]'))) return;
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
    if (Math.abs(dx) > 60 && Math.abs(dx) > 1.6 * Math.abs(dy) && dt < 800) return nav(dx < 0 ? 1 : -1);
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
  if (e.button !== 0 || e.target.closest('[data-goto]')) return;
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
      toast('Session pinned — other sessions rescheduled around it.');
      await saveTasks();
      return cycle();
    }
    let scope = 'this';
    if (it.ev.recurringEventId) { scope = await askScope('Change'); if (!scope) return render(); }
    setStatus('Saving…');
    await EV.moveEvent(st(), it.ev, start, end, scope);
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
    <form class="qc">
      <input name="title" placeholder="Add title" autofocus autocomplete="off">
      <div class="qc-when">${esc(when)}${sel.allDay ? ' · all day' : ''}</div>
      <select name="cal">${cals.map((c) => `<option value="${esc(c.id)}" ${c.id === def ? 'selected' : ''}>${esc(c.summary)}</option>`).join('')}</select>
      <div class="qc-actions">
        <button type="button" class="btn small ghost more">More options</button>
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
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = selBody(sel, f.title.value.trim() || '(No title)', f.cal.value);
      close(); onClose?.();
      await saveNewEvent(f.cal.value, body);
    });
    $('.more', p).onclick = () => { const v = { title: f.title.value, calId: f.cal.value }; close(); onClose?.(); newEvent({ ...sel, ...v }); };
    $('.as-task', p).onclick = () => { const title = f.title.value; close(); onClose?.(); newTask({ kind: 'generic', title, earliestStart: sel.allDay ? null : sel.start, totalMinutes: sel.allDay ? null : durMin }); };
    $('.as-reading', p).onclick = () => { const title = f.title.value; close(); onClose?.(); newTask({ kind: 'reading', title, earliestStart: sel.allDay ? null : sel.start }); };
  });
}

function selBody(sel, title, calId) {
  const z = tz();
  const body = { summary: title };
  if (sel.allDay) { body.start = { date: T.dayKey(sel.start, z) }; body.end = { date: T.dayKey(sel.end, z) }; }
  else { body.start = { dateTime: new Date(sel.start).toISOString(), timeZone: z }; body.end = { dateTime: new Date(sel.end).toISOString(), timeZone: z }; }
  if (calId === E.LOCAL_CAL) body.reminders = { useDefault: false, overrides: [{ method: 'popup', minutes: set().defaultReminder }] };
  return body;
}

async function saveNewEvent(calId, body, opts) {
  try {
    setStatus('Saving…');
    await EV.createEvent(st(), calId, body, opts);
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
  const cal = it.ev._calId === E.LOCAL_CAL ? { summary: 'Local (this browser)' } : (st().gmeta.calendars || []).find((c) => c.id === ev._calId);
  const rems = ev.reminders?.useDefault === false ? (ev.reminders.overrides || []) : null;
  const meet = ev.hangoutLink || ev.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri;
  const evTz = ev.start?.timeZone && ev.start.timeZone !== tz() ? ev.start.timeZone : null;
  const desc = (ev.description || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();
  popover(rect, `
    <div class="pop">
      <div class="pop-tools">
        ${it.editable ? '<button class="icon-btn edit" title="Edit">✎</button><button class="icon-btn del" title="Delete">🗑</button>' : ''}
        ${ev.htmlLink ? `<a class="icon-btn" href="${esc(ev.htmlLink)}" target="_blank" rel="noopener" title="Open in Google Calendar">↗</a>` : ''}
        <button class="icon-btn x" title="Close">✕</button>
      </div>
      <div class="pop-title"><i style="--c:${it.color}"></i><h3>${esc(it.title)}</h3></div>
      ${ev.extendedProperties?.private?.tempoTask ? '<div class="pop-row warnbox small">This is a Tempo task session that isn’t loaded in this browser yet. <button class="link load-tasks">Load tasks from Google</button></div>' : ''}
      <div class="pop-row">${esc(fmtWhen(it))}${evTz ? `<div class="muted small">Event time zone: ${esc(evTz)}</div>` : ''}${ev.recurrence?.length ? `<div class="muted small">${esc(describe(ev.recurrence))}</div>` : ev.recurringEventId ? '<div class="muted small">↻ Repeating event</div>' : ''}</div>
      ${ev.location ? `<div class="pop-row">📍 ${esc(ev.location)}</div>` : ''}
      ${meet ? `<div class="pop-row"><a class="btn small primary" href="${esc(meet)}" target="_blank" rel="noopener">Join video call</a></div>` : ''}
      ${ev.attendees?.length ? `<div class="pop-row small">👥 ${ev.attendees.length} guest${ev.attendees.length > 1 ? 's' : ''}: ${esc(ev.attendees.slice(0, 4).map((a) => a.displayName || a.email).join(', '))}${ev.attendees.length > 4 ? '…' : ''}</div>` : ''}
      ${rems ? `<div class="pop-row small">🔔 ${rems.length ? esc(rems.map((r) => `${T.fmtDur(r.minutes)} before${r.method === 'email' ? ' (email)' : ''}`).join(', ')) : 'No notifications'}</div>` : ''}
      ${desc ? `<div class="pop-row desc">${esc(desc.slice(0, 400))}${desc.length > 400 ? '…' : ''}</div>` : ''}
      <div class="pop-row muted small">📅 ${esc(cal?.summary || ev._calId)}${ev.transparency === 'transparent' ? ' · free' : ''}${!it.editable ? ' · read-only' : ''}</div>
    </div>`, (p, close) => {
    $('.x', p).onclick = close;
    $('.load-tasks', p)?.addEventListener('click', () => { close(); refreshFromServer(); });
    $('.edit', p)?.addEventListener('click', () => { close(); editEvent(it); });
    $('.del', p)?.addEventListener('click', async () => {
      close();
      let scope = 'this';
      if (ev.recurringEventId) { scope = await askScope('Delete'); if (!scope) return; }
      try { setStatus('Deleting…'); await EV.deleteEvent(st(), ev, scope); await afterEventChange(); toast('Event deleted'); }
      catch (err) { handleError(err); }
    });
  });
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
      <div class="pop-row small">Part of <b>${esc(task.title)}</b> · rank ${task.rank} · due ${esc(T.format(task.deadline, z, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: s.h12 }))}</div>
      <div class="pop-row"><div class="bar"><i style="width:${p.pct}%;background:${task.color}"></i></div><div class="muted small">${T.fmtDur(p.done)} of ${T.fmtDur(p.total)} done</div></div>
      <div class="pop-row small">${!E.connected(st()) ? '<span class="muted">Only in this browser (Google not connected)</span>' : sess.gid ? '<span class="g-ok">✓ On Google Calendar</span>' : '<span class="g-bad">Not on Google Calendar yet</span> <button class="link sync-now">Sync now</button>'}</div>
      <div class="pop-actions">
        ${isDone ? '<button class="btn small undone">↺ Mark undone</button>' : '<button class="btn small primary done">✓ Mark done</button>'}
        ${sess.kind === 'pinned' ? '<button class="btn small ghost unpin">Unpin</button>' : ''}
        <button class="btn small ghost del">Delete…</button>
        <button class="btn small ghost edit">Edit task</button>
      </div>
      <div class="muted small hint">Tip: drag a session to pin it to a specific time — the rest of the series shifts around it.</div>
    </div>`, (pop, close) => {
    $('.x', pop).onclick = close;
    const act = async (fn, msg) => { close(); replaceTask(fn(st().tasks.find((t) => t.id === task.id))); await saveTasks(); toast(msg); cycle(); };
    $('.done', pop)?.addEventListener('click', () => act((t) => S.markDone(t, sess.id), 'Marked done'));
    $('.undone', pop)?.addEventListener('click', () => act((t) => (sess.kind === 'pinned' ? S.unpinSession(t, sess.id) : S.markUndone(t, sess.id)), 'Marked undone — remaining sessions shifted'));
    $('.unpin', pop)?.addEventListener('click', () => act((t) => S.unpinSession(t, sess.id), 'Unpinned'));
    $('.edit', pop).onclick = () => { close(); editTask(task); };
    $('.sync-now', pop)?.addEventListener('click', () => { close(); openSyncPanel(); });
    $('.del', pop).onclick = async () => {
      close();
      const v = await choose('Delete session', `“${sess.label}”`, [
        { value: 'one', label: 'Delete this session', desc: 'Its work moves to the next free time; later sessions in the series shift down.' },
        { value: 'all', label: 'Delete the entire series', desc: `Removes “${task.title}” and all ${sess.count} sessions.`, danger: true },
      ]);
      if (v === 'one') { replaceTask(S.skipSession(st().tasks.find((t) => t.id === task.id), sess.id)); await saveTasks(); toast('Session deleted — series shifted'); cycle(); }
      if (v === 'all') deleteTask(task.id);
    };
  });
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
    if (r.action === 'delete') await EV.deleteEvent(st(), it.ev, scope);
    else await EV.updateEvent(st(), it.ev, r.body, scope, { conference: r.conference });
    await afterEventChange();
  } catch (err) { handleError(err); render(); }
}

function replaceTask(t) { t = { ...t, rev: Date.now() }; st().tasks = st().tasks.map((x) => (x.id === t.id ? t : x)); }
async function saveTasks() { await E.persist(st(), ['tasks', 'orphanGids', 'acks', 'tombstones']); }

async function newTask(preset = {}) {
  const r = await D.taskDialog(ctx, null, preset);
  if (!r?.task) return;
  const t = { ...r.task };
  if (preset.title && !t.title) t.title = preset.title;
  t.rev = Date.now();
  st().tasks.push(t);
  await saveTasks();
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
  replaceTask({ ...r.task, frozen: task.frozen, planned: task.planned });
  await saveTasks();
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
  await saveTasks();
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
  if (pull && E.connected(st())) {
    try {
      const r = await E.pullTasks(st());
      app.lastPull = { at: Date.now(), ...r };
      if (r.adoptedCalendar) await E.persist(st(), ['settings']);
      if (r.imported.length || r.updated.length || r.removed.length) {
        await E.persist(st(), ['tasks', 'orphanGids']);
        const parts = [];
        if (r.imported.length) parts.push(`loaded ${r.imported.length} task${r.imported.length > 1 ? 's' : ''} from Google (${r.imported.map((t) => t.title).slice(0, 3).join(', ')}${r.imported.length > 3 ? '…' : ''})`);
        if (r.updated.length) parts.push(`updated ${r.updated.length} changed elsewhere`);
        if (r.removed.length) parts.push(`removed ${r.removed.length} deleted elsewhere`);
        const msg = parts.join('; ');
        toast(msg[0].toUpperCase() + msg.slice(1), r.removed.length ? { action: 'Undo', ms: 9000, onAction: async () => { for (const t of r.removed) st().tasks.push({ ...t, rev: Date.now() }); await saveTasks(); cycle(); } } : { ms: 5000 });
      }
    } catch (err) { handleError(err); }
  }
  try {
    const r = await E.reschedule(st());
    problems = r.problems;
    app.lastBusy = r.busy;
    await E.persist(st(), ['tasks', 'reminderQueue']);
  } catch (err) {
    handleError(err);
  }
  await render();
  if (sync) {
    try {
      if (E.connected(st()) && set().syncTasksToGoogle) setStatus('Syncing…', 'busy');
      const res = await E.syncTasks(st(), (fn) => fn(st()), (n, total) => setStatus(`Syncing ${n}/${total}…`, 'busy'));
      if (res.ok) setStatus(`Synced ${T.fmtTime(Date.now(), tz(), set().h12)}`, 'ok');
      else if (res.kind === 'local') setStatus('Local only', 'warn');
      else if (res.kind === 'off') setStatus('Not syncing tasks', 'warn');
      else setStatus('Sync problem', 'bad');
      if (res.changed) E.invalidate();
    } catch (err) { handleError(err); }
    await E.persist(st(), ['tasks', 'orphanGids', 'syncInfo']);
    renderBanner();
  }
  await handleProblems(problems);
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
    await saveTasks();
    if (r.action !== 'keep') { again = true; }
  }
}

function setStatus(text, kind = '') { app.status = { text, kind }; const s = $('#sync-status'); if (s) { s.textContent = text; s.className = 'status ' + kind; } }

function handleError(err) {
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
    if ((r.settings.taskCalendarId || null) !== (before.taskCalendarId || null)) {
      const cal = E.normCal(st(), r.settings.taskCalendarId);
      st().tasks = st().tasks.map((t) => ({ ...t, calendarId: cal, rev: Date.now() }));
      await saveTasks();
    }
    st().settings = r.settings;
    await E.persist(st(), ['settings']);
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
app.anOpts = { period: 'next7', scope: 'bounds', by: 'color' };

async function renderAnalysisView(seq) {
  const s = set(), z = tz(), o = app.anOpts;
  const view = $('#view');
  if (!$('.analysis', view)) setHTML(view, '<div class="analysis"><p class="muted">Calculating…</p></div>');
  const rng = A.periodRange(o.period, s, Date.now(), { from: o.from, to: o.to });
  const days = [];
  for (let k = T.dayKey(rng.from, z); T.dayStart(k, z) < rng.to; k = T.addDays(k, 1)) days.push(k);
  const items = await collectItems(days);
  if (seq !== app.renderSeq) return;
  const groups = {};
  const actx = { settings: s, gmeta: st().gmeta, calColor };
  const occ = items.filter((it) => A.isOccupying(it, s)).map((it) => {
    const g = A.groupOf(it, o.by, actx);
    const G0 = groups[g.key] ||= { ...g, contains: new Set() };
    G0.contains.add(it.kind === 'chunk' ? it.task.title : (it.title || '(No title)'));
    return { start: it.start, end: it.end, group: g.key, prio: it.kind === 'chunk' ? 1 : 0 };
  });
  const wins = A.scopeWindows(o.scope, rng.from, rng.to, s);
  const data = A.compute(occ, wins, z);
  for (const k of days) data.days[k] ||= { available: 0, free: 0, groups: {} };
  app.anLast = { data, groups };
  const root = $('.analysis', view) || view.appendChild(el('<div class="analysis"></div>'));
  setHTML(root, A.renderAnalysis({ data, groups, opts: o, settings: s, rangeInfo: rng }));
  $$('[data-o]', root).forEach((c) => {
    if (c.dataset.o === 'csv') { c.onclick = () => { download(new Blob([A.toCsv(data, groups, z)], { type: 'text/csv' }), `tempo-analysis-${T.dayKey(rng.from, z)}.csv`); }; return; }
    c.onchange = () => {
      o[c.dataset.o] = c.value;
      if (o.period === 'custom' && !o.from) { o.from = T.dayKey(Date.now(), z); o.to = T.addDays(o.from, 13); }
      storeSet({ analysisOpts: o });
      render();
    };
  });
  $$('.lbl-edit', root).forEach((b) => (b.onclick = () => renameColor(b.dataset.hex)));
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
    return { canvas: X.renderMonth({ monthKey: r.monthKey, gridStart: r.days[0], items, settings: set(), scale, title: T.format(T.dayStart(r.monthKey, z), z, { month: 'long', year: 'numeric' }) }), key: r.monthKey.slice(0, 7) };
  }
  const a = T.dayStart(r.days[0], z), b = T.dayStart(r.days[6], z);
  return { canvas: X.renderWeek({ days: r.days, items, settings: set(), scale, title: `Week of ${T.format(a, z, { day: 'numeric', month: 'long' })} – ${T.format(b, z, { day: 'numeric', month: 'long', year: 'numeric' })}` }), key: r.days[0] };
}

async function exportView(kind, fmt) {
  const { canvas, key } = await renderPage(kind, app.cursor);
  const name = `tempo-${kind}-${key}`;
  const blob = fmt === 'pdf' ? await X.canvasToPdf(canvas) : fmt === 'tiff' ? await X.canvasesToTiff([canvas]) : await X.canvasToBlob(canvas, fmt === 'jpeg' ? 'image/jpeg' : 'image/png');
  const ext = fmt === 'jpeg' ? 'jpg' : fmt === 'tiff' ? 'tif' : fmt;
  download(blob, `${name}.${ext}`);
  toast(`Exported ${name}.${ext}`);
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
function nav(dir) {
  if (app.view === 'day') app.cursor = T.addDays(app.cursor, dir);
  else if (app.view === '3day') app.cursor = T.addDays(app.cursor, 3 * dir);
  else if (app.view === 'week') app.cursor = T.addDays(app.cursor, 7 * dir);
  else app.cursor = T.addMonths(app.cursor, dir);
  app.miniCursor = app.cursor;
  render();
}

function bindToolbar() {
  $('#btn-today').onclick = () => { app.cursor = app.miniCursor = T.dayKey(Date.now(), tz()); render(); };
  $('#btn-prev').onclick = () => nav(-1);
  $('#btn-next').onclick = () => nav(1);
  $$('#view-seg button, #bottombar button').forEach((b) => (b.onclick = () => { app.view = b.dataset.view; closeDrawer(); render(); }));
  // Phone layout: drawer, add button, overflow menu
  $('#btn-menu').onclick = () => { $('#side').classList.add('open'); $('#scrim').hidden = false; };
  $('#scrim').onclick = closeDrawer;
  $('#side').addEventListener('click', (e) => { if (e.target.closest('.md, .task-row, #connect-cta, .create .btn')) closeDrawer(); });
  $('#fab').onclick = () => sheetMenu([
    { ic: '+', label: 'New event', run: () => $('#btn-new-event').click() },
    { ic: '⧉', label: 'New task (split into sessions)', run: () => newTask({ kind: 'generic' }) },
    { ic: '📖', label: 'New reading plan', run: () => newTask({ kind: 'reading' }) },
  ]);
  $('#btn-more').onclick = () => sheetMenu([
    { ic: '⟳', label: 'Refresh from Google', run: refreshFromServer },
    { ic: '✓', label: 'Sync status', run: openSyncPanel },
    { ic: '⚙', label: 'Settings', run: openSettings },
    '-', 'Export',
    { ic: 'W', label: 'This week as PDF', run: () => exportView('week', 'pdf').catch(handleError) },
    { ic: 'W', label: 'This week as image (PNG)', run: () => exportView('week', 'png').catch(handleError) },
    { ic: 'M', label: 'This month as PDF', run: () => exportView('month', 'pdf').catch(handleError) },
    { ic: '⧉', label: 'Several weeks or months…', run: exportMulti },
  ]);
  $('#btn-settings').onclick = openSettings;
  $('#sync-status').onclick = openSyncPanel;
  $('#btn-refresh').onclick = refreshFromServer;
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
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open]') || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 't') $('#btn-today').click();
    else if (k === 'd' || k === 'w' || k === 'm' || k === 'y') { app.view = { d: 'day', w: 'week', m: 'month', y: 'analysis' }[k]; render(); }
    else if (k === 'arrowleft' || k === 'j') nav(-1);
    else if (k === 'arrowright' || k === 'k') nav(1);
    else if (k === 'c' || k === 'n') $('#btn-new-event').click();
    else if (k === 'a') newTask({ kind: 'generic' });
    else if (k === 'r') refreshFromServer();
    else if (k === 'escape') { closePopover(); closeDrawer(); }
  });
}

async function init() {
  // Web app: finish a Google sign-in that just came back in the URL, or renew an expired one silently.
  const redirect = await G.completeRedirect();
  app.state = await E.loadState();
  app.cursor = app.miniCursor = T.dayKey(Date.now(), tz());
  if (innerWidth < 760) app.view = 'day';
  { const v = new URLSearchParams(location.search).get('view'); if (['day', '3day', 'week', 'month', 'analysis'].includes(v)) app.view = v; }
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
  await cycle({ pull: true });
  if (isWeb) startWebReminders();
  if (isWeb && 'serviceWorker' in navigator && document.querySelector('link[rel=manifest]')) navigator.serviceWorker.register('sw.js').catch(() => {});
  setInterval(() => cycle({ pull: true }), 5 * 60 * 1000);
  const beat = () => storeSet({ appHeartbeat: Date.now() });
  beat(); setInterval(beat, 30000);
  setInterval(() => {
    const n = $('.tg-col.today .now');
    if (n) n.style.top = (T.minutesOfDay(Date.now(), tz()) / 60) * set().hourHeight + 'px';
  }, 60000);
  let lastVisible = Date.now();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - lastVisible > 60000) { E.invalidate(); cycle({ pull: true }); }
    if (document.hidden) lastVisible = Date.now();
  });
  window.__tempo = { app, cycle, render, S, T, E }; // handy for debugging from the console
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
