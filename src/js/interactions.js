// Pointer interactions on the calendar: drag to move, resize, select to create, swipes.
import * as T from './tz.js';
import * as S from './scheduler.js';
import * as EV from './events.js';
import { $, $$, el, choose, closePopover } from './ui.js';
import { app, set, st, tz } from './core.js';
import { smartSlot } from './actions.js';
import { cycle, render, replaceTask, saveTasks, toast } from './app.js';
import { gameOn } from './game-ui.js';
import { handleError, logHistory, setStatus } from './status.js';
import { afterEventChange, openItem, quickCreate } from './popovers.js';
import { undoableEventChange } from './undo.js';

// ======================================================================================
// Pointer interactions
// ======================================================================================
const snapM = () => set().snapMinutes;
const floorSnap = (m) => Math.floor(m / snapM()) * snapM();
const roundSnap = (m) => Math.round(m / snapM()) * snapM();
export const msAt = (k, min) => { const { y, m, d } = T.parseKey(k); return T.zonedMs(y, m, d, 0, min, tz()); };
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

export function onGridPointerDown(e) {
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
    let sel = { start: msAt(day, a), end: msAt(day, b), allDay: false };
    if (!moved) {
      a = m0; b = Math.min(1440, m0 + set().defaultEventMinutes);
      sel = smartSlot(msAt(day, m0), { start: msAt(day, a), end: msAt(day, b), allDay: false });
      a = Math.round((sel.start - T.dayStart(day, tz())) / T.MIN); b = Math.round((sel.end - T.dayStart(day, tz())) / T.MIN); paint();
    }
    quickCreate(ghost.getBoundingClientRect(), sel);
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
    let a = Math.min(m, 1440 - 30), b = Math.min(1440, a + set().defaultEventMinutes);
    const sel = smartSlot(msAt(day, Math.floor(minuteAt(y0, col))), { start: msAt(day, a), end: msAt(day, b), allDay: false });
    a = Math.round((sel.start - T.dayStart(day, tz())) / T.MIN); b = Math.round((sel.end - T.dayStart(day, tz())) / T.MIN);
    const ghost = el(`<div class="ev ghost-sel"><div class="ev-t">(New)</div></div>`);
    ghost.style.top = (a / 60) * set().hourHeight + 'px';
    ghost.style.height = Math.max(14, ((b - a) / 60) * set().hourHeight - 2) + 'px';
    col.appendChild(ghost);
    quickCreate(ghost.getBoundingClientRect(), sel);
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
export function unlock() { document.body.classList.remove('touch-lock'); app.touchLock = false; }
// While a long-press drag is active, stop the page from scrolling under the finger.
document.addEventListener('touchmove', (e) => { if (app.touchLock && e.cancelable) e.preventDefault(); }, { passive: false });

export function onAllDayPointerDown(e) {
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

export function onMonthPointerDown(e) {
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

export async function askScope(verb) {
  return choose(`${verb} recurring event`, null, [
    { value: 'this', label: 'This event' },
    { value: 'following', label: 'This and following events' },
    { value: 'all', label: 'All events' },
  ]);
}

async function commitMove(it, start, end) {
  try {
    if (gameOn() && (it.kind === 'chunk' || it.end < start || it.start > end || Math.abs(start - it.start) >= 30 * T.MIN)) logHistory({ kind: 'resched', task: it.task, title: it.title, evId: it.kind === 'chunk' ? undefined : (it.ev?.recurringEventId || it.ev?.id), t: it.start });
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
