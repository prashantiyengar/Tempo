// A small calendar for every date field (and the date of every date-and-time field), used instead of the browser's
// own picker so it looks the same everywhere and always has "Today". Clicking or tapping a date field opens it; on a
// computer you can still type into the field. Picking a day sets the field like typing would (input + change).
//   date fields:       a day sets the date and closes; Today = today; Clear empties (unless the field is required)
//   date-and-time:     a day sets the date and keeps the time; the time can be set in the calendar too; Done closes
import * as T from './tz.js';

let tz = T.systemTz(), weekStart = 1;
export function configureDatePicker(o = {}) {
  if (o.tz && T.isValidTz(o.tz)) tz = o.tz;
  if (o.weekStart != null) weekStart = +o.weekStart || 0;
}
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WD = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const isDateField = (el) => el instanceof HTMLInputElement && (el.type === 'date' || el.type === 'datetime-local') && !el.disabled && !el.readOnly && el.dataset.picker !== 'native';
const touchLike = () => matchMedia('(pointer: coarse)').matches;

let pop = null, field = null, view = null; // view: { y, m }

function fire(inp) {
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  inp.dispatchEvent(new CustomEvent('change', { bubbles: true, detail: 'user' }));
}
const dayOf = (inp) => (inp.value ? inp.value.slice(0, 10) : '');
const timeOf = (inp) => (inp.type === 'datetime-local' && inp.value ? inp.value.slice(11, 16) : '');
const todayKey = () => T.dayKey(Date.now(), tz);
const inRange = (inp, k) => (!inp.min || k >= inp.min.slice(0, 10)) && (!inp.max || k <= inp.max.slice(0, 10));
// a time for a date-and-time field that was empty: now, rounded up to the next 5 minutes
const nowTime = () => { const m = Math.ceil(T.minutesOfDay(Date.now(), tz) / 5) * 5; return T.hhmm(Math.min(m, 23 * 60 + 55)); };

function setDay(k) {
  if (!field) return;
  if (field.type === 'datetime-local') field.value = `${k}T${timeOf(field) || $t()?.value || nowTime()}`;
  else field.value = k;
  fire(field);
}
const $t = () => pop?.querySelector('.dp-time');

export function closeDatePicker() {
  pop?.remove(); pop = null;
  const f = field; field = null;
  if (f) f.classList.remove('dp-open');
}

export function openDatePicker(inp) {
  if (pop && field === inp) return;
  closeDatePicker();
  field = inp; inp.classList.add('dp-open');
  const k = dayOf(inp) || todayKey(), { y, m } = T.parseKey(k);
  view = { y, m };
  pop = document.createElement('div');
  pop.className = 'dp-pop'; pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', 'Pick a date');
  // inside the open dialog or popover (a modal dialog sits above everything else on the page)
  (inp.closest('dialog[open]') || inp.closest('.popover') || document.body).appendChild(pop);
  draw();
  place();
}

function draw() {
  if (!pop || !field) return;
  const sel = dayOf(field), today = todayKey(), dt = field.type === 'datetime-local';
  const first = T.keyOf(view.y, view.m, 1), lead = (T.weekday(first) - weekStart + 7) % 7;
  const start = T.addDays(first, -lead);
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const k = T.addDays(start, i), { m, d } = T.parseKey(k);
    if (i >= 35 && m !== view.m) break;
    cells.push(`<button type="button" class="dp-d${m !== view.m ? ' out' : ''}${k === today ? ' today' : ''}${k === sel ? ' on' : ''}" data-k="${k}" ${inRange(field, k) ? '' : 'disabled'} aria-label="${k}">${d}</button>`);
  }
  const heads = Array.from({ length: 7 }, (_, i) => `<span>${WD[(weekStart + i) % 7]}</span>`).join('');
  pop.innerHTML = `<div class="dp-head"><button type="button" class="dp-nav" data-n="-1" aria-label="Previous month">‹</button><b>${MONTHS[view.m - 1]} ${view.y}</b><button type="button" class="dp-nav" data-n="1" aria-label="Next month">›</button></div>
    <div class="dp-grid">${heads}${cells.join('')}</div>
    <div class="dp-foot">
      <button type="button" class="dp-today" ${inRange(field, today) ? '' : 'disabled'}>Today</button>
      ${dt ? `<input type="time" class="dp-time" step="300" value="${timeOf(field) || ''}" aria-label="Time">` : ''}
      <span class="dp-grow"></span>
      ${field.required ? '' : '<button type="button" class="dp-clear">Clear</button>'}
      ${dt ? '<button type="button" class="dp-done">Done</button>' : ''}
    </div>`;
  pop.querySelectorAll('.dp-nav').forEach((b) => (b.onclick = () => { const k = T.addMonths(T.keyOf(view.y, view.m, 1), +b.dataset.n); const p = T.parseKey(k); view = { y: p.y, m: p.m }; draw(); }));
  pop.querySelectorAll('.dp-d').forEach((b) => (b.onclick = () => { setDay(b.dataset.k); if (dt) draw(); else closeDatePicker(); }));
  pop.querySelector('.dp-today').onclick = () => {
    const k = todayKey(); setDay(k);
    const p = T.parseKey(k); view = { y: p.y, m: p.m };
    if (dt) draw(); else closeDatePicker();
  };
  pop.querySelector('.dp-clear')?.addEventListener('click', () => { field.value = ''; fire(field); closeDatePicker(); });
  pop.querySelector('.dp-done')?.addEventListener('click', () => closeDatePicker());
  const ti = $t();
  if (ti) ti.addEventListener('change', () => { if (!ti.value) return; field.value = `${dayOf(field) || todayKey()}T${ti.value}`; fire(field); });
}

function place() {
  if (!pop || !field) return;
  const r = field.getBoundingClientRect(), vw = innerWidth, vh = innerHeight;
  pop.style.left = '0px'; pop.style.top = '0px';
  // (inside a dialog with a transform, position: fixed is relative to the dialog: correct by where 0,0 ended up)
  const o = pop.getBoundingClientRect(), w = o.width, h = o.height;
  let left = Math.min(Math.max(8, r.left), vw - w - 8), top = r.bottom + 4;
  if (top + h > vh - 8) top = r.top - h - 4 >= 8 ? r.top - h - 4 : Math.max(8, vh - h - 8);
  pop.style.left = `${left - o.left}px`; pop.style.top = `${top - o.top}px`;
}

// One set of listeners for the whole page: date fields in dialogs, popovers and the page itself
export function initDatePicker() {
  // touch: stop the phone's own picker (it opens on the tap) and show ours
  document.addEventListener('touchend', (e) => {
    const inp = e.target; if (!isDateField(inp)) return;
    e.preventDefault(); openDatePicker(inp);
  }, { passive: false, capture: true });
  // mouse: the browser's popup would open on the click — show ours instead (typing into the field still works)
  document.addEventListener('click', (e) => {
    const inp = e.target;
    if (isDateField(inp)) { e.preventDefault(); if (touchLike() && pop && field === inp) return; openDatePicker(inp); return; }
    if (pop && !pop.contains(e.target)) closeDatePicker();
  }, true);
  // keyboard: Escape closes it; Enter / Space / Alt+↓ on a date field opens it (as the browser's picker would)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pop) { e.preventDefault(); e.stopPropagation(); closeDatePicker(); return; }
    if (isDateField(e.target) && (e.key === ' ' || (e.altKey && e.key === 'ArrowDown'))) { e.preventDefault(); openDatePicker(e.target); }
  }, true);
  // typing a date into the field moves the calendar to it
  document.addEventListener('input', (e) => {
    if (!pop || e.target !== field) return;
    const k = dayOf(field); if (!k) return;
    const p = T.parseKey(k); view = { y: p.y, m: p.m }; draw();
  }, true);
  addEventListener('resize', () => place());
  document.addEventListener('scroll', (e) => { if (pop && !pop.contains(e.target)) { if (field && !field.isConnected) closeDatePicker(); else place(); } }, true);
  // the field went away (its dialog closed): the calendar goes too
  new MutationObserver(() => { if (pop && field && !field.isConnected) closeDatePicker(); }).observe(document.body, { childList: true, subtree: true });
}
