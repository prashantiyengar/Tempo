// Small DOM helpers shared by the views and dialogs.
// All markup built from strings goes through DOMPurify (the official, unmodified library in /vendor) before it
// touches the DOM. Values interpolated into those strings are additionally escaped with esc().
import DOMPurify from '../vendor/purify.es.mjs';
import * as T from './tz.js';

const PURIFY = {
  RETURN_DOM_FRAGMENT: true,
  SANITIZE_DOM: false, // our own form field names (title, start…) must survive; they are literals, not user data
  ADD_TAGS: ['dialog'],
  ADD_ATTR: ['target', 'autofocus', 'list', 'step', 'spellcheck', 'autocomplete', 'hidden', 'preserveAspectRatio',
    'patternTransform', 'patternUnits', 'text-anchor', 'stroke-width', 'stroke-linecap', 'stroke-linejoin'],
};
export function frag(html) { return DOMPurify.sanitize(String(html), PURIFY); }
export function setHTML(node, html) { node.replaceChildren(frag(html)); return node; }
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function el(html) {
  return frag(html.trim()).firstElementChild;
}

let toastTimer;
export function toast(msg, { action, onAction, ms = 3500 } = {}) {
  const t = $('#toast');
  setHTML(t, `<span>${esc(msg)}</span>${action ? `<button class="link">${esc(action)}</button>` : ''}`);
  t.classList.add('show');
  if (action) t.querySelector('button').onclick = () => { t.classList.remove('show'); onAction?.(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// Modal dialog. `build(dlg, close)` fills it; resolves with the value passed to close().
export function modal(html, setup, { cls = '' } = {}) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'modal ' + cls;
    setHTML(dlg, html);
    document.body.appendChild(dlg);
    let done = false;
    const close = (v) => { if (done) return; done = true; dlg.close(); dlg.remove(); resolve(v); };
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(undefined); });
    // ignore the phone's "ghost" click that follows the tap which opened this dialog
    guardGhost(dlg);
    dlg.addEventListener('mousedown', (e) => { if (e.target === dlg) close(undefined); });
    $$('[data-close]', dlg).forEach((b) => b.addEventListener('click', () => close(undefined)));
    setup?.(dlg, close);
    addDateShortcuts(dlg);
    dlg.showModal();
    const first = dlg.querySelector('[autofocus]');
    if (first) { first.focus(); first.select?.(); }
  });
}

// Choice dialog: options = [{value, label, desc, danger}]
export function choose(title, message, options, { cancel = 'Cancel' } = {}) {
  return modal(`
    <form method="dialog" class="choice">
      <h2>${esc(title)}</h2>
      ${message ? `<p class="muted">${esc(message)}</p>` : ''}
      <div class="choice-list">
        ${options.map((o, i) => `<button type="button" class="choice-btn ${o.danger ? 'danger' : ''}" data-i="${i}">
          <strong>${esc(o.label)}</strong>${o.desc ? `<span>${esc(o.desc)}</span>` : ''}</button>`).join('')}
      </div>
      <div class="actions"><button type="button" class="btn ghost" data-close>${esc(cancel)}</button></div>
    </form>`, (dlg, close) => {
    $$('.choice-btn', dlg).forEach((b) => b.addEventListener('click', () => close(options[+b.dataset.i].value)));
  }, { cls: 'narrow' });
}

export function confirmBox(title, message, okLabel = 'OK', danger = false) {
  return choose(title, message, [{ value: true, label: okLabel, danger }]);
}

// A click only counts if the press that started it happened after `el` appeared. The tap that opened a sheet or
// dialog on a phone is followed by emulated mouse events at the same spot; without this they'd hit whatever button
// is now under the finger (the category chip, ✕, the backdrop…).
function guardGhost(el, ms = 800) {
  const opened = performance.now();
  let pressed = false;
  el.addEventListener('pointerdown', () => { pressed = true; }, true);
  const block = (e) => { if (!pressed && performance.now() - opened < ms) { e.stopPropagation(); e.preventDefault(); } };
  for (const t of ['mousedown', 'mouseup', 'click']) el.addEventListener(t, block, true);
}

export function popover(anchorRect, html, setup) {
  closePopover();
  const p = el(`<div class="popover" role="dialog">${html}</div>`);
  document.body.appendChild(p);
  setup?.(p, closePopover);
  addDateShortcuts(p);
  // On phones the tap that opened this is followed by a "ghost" click at the same spot, which would land on whatever
  // button of the sheet is under the finger (e.g. the category chip, or ✕). Ignore clicks in the first moment.
  guardGhost(p); openedAt = performance.now(); pressedSinceOpen = false;
  // Place it after its contents are built, and again whenever it grows (More options, notes, a toast row…),
  // so the whole popup always stays on screen. If it is taller than the window it scrolls inside.
  const place = () => {
    if (!p.isConnected) return;
    const vw = innerWidth, vh = innerHeight;
    const r = p.getBoundingClientRect();
    let left = anchorRect.right + 8;
    if (left + r.width > vw - 8) left = anchorRect.left - r.width - 8;
    if (left < 8) left = Math.max(8, Math.min(vw - r.width - 8, anchorRect.left));
    const top = Math.max(8, Math.min(anchorRect.top, vh - r.height - 8));
    p.style.left = left + 'px';
    p.style.top = top + 'px';
  };
  place();
  if (typeof ResizeObserver === 'function') { const ro = new ResizeObserver(place); ro.observe(p); p._ro = ro; }
  p._place = place; addEventListener('resize', place);
  p._unplace = () => removeEventListener('resize', place);
  setTimeout(() => {
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', escKey, true);
  });
  return p;
}
let openedAt = 0;
function outside(e) {
  const p = $('.popover');
  // a ghost mousedown from the tap that opened the popover doesn't count as "tapping outside"
  if (!pressedSinceOpen && performance.now() - openedAt < 800) return;
  if (p && !p.contains(e.target) && !e.target.closest('dialog')) closePopover();
}
let pressedSinceOpen = false;
globalThis.document?.addEventListener('pointerdown', () => { pressedSinceOpen = true; }, true);
function escKey(e) { if (e.key === 'Escape' && !document.querySelector('dialog[open]')) closePopover(); }
export function closePopover() {
  $$('.popover').forEach((p) => { p._ro?.disconnect(); p._unplace?.(); p.remove(); });
  $$('.ghost-sel').forEach((g) => g.remove());
  document.removeEventListener('mousedown', outside, true);
  document.removeEventListener('keydown', escKey, true);
}

// Save a generated file. On phones a download must start from the user's own tap, so we show a small sheet
// with Save / Share / Open buttons instead of starting it automatically.
export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const phone = matchMedia('(pointer: coarse)').matches || innerWidth < 760;
  if (!phone) {
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 60000);
    return Promise.resolve();
  }
  const file = typeof File === 'function' ? new File([blob], name, { type: blob.type }) : null;
  const canShare = !!(file && navigator.canShare?.({ files: [file] }));
  const size = blob.size > 1048576 ? `${(blob.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(blob.size / 1024))} KB`;
  return modal(`<div class="choice save-sheet"><h2>Your file is ready</h2><p class="muted small">${esc(name)} · ${size}</p>
    <div class="actions-col">
      <a class="btn primary save-link">Save to device</a>
      ${canShare ? '<button type="button" class="btn share-btn">Share… (Drive, email, Files)</button>' : ''}
      <a class="btn ghost open-link" target="_blank" rel="noopener">Open</a>
    </div>
    <div class="actions"><button type="button" class="btn ghost" data-close>Done</button></div></div>`, (dlg, close) => {
    // blob: links are set directly (not via the HTML sanitizer, which would drop them)
    const save = dlg.querySelector('.save-link'); save.href = url; save.download = name;
    dlg.querySelector('.open-link').href = url;
    save.addEventListener('click', () => setTimeout(() => toast(`Saved ${name} to your downloads`), 300));
    dlg.querySelector('.share-btn')?.addEventListener('click', async () => {
      try { await navigator.share({ files: [file], title: name }); close(); } catch { /* cancelled */ }
    });
  }, { cls: 'narrow' }).then(() => setTimeout(() => URL.revokeObjectURL(url), 120000));
}

export const TASK_COLORS = ['#4f6bed', '#0f9d76', '#e2683c', '#c2459b', '#8a5cf6', '#d4a20a', '#2a9bd6', '#d6455b', '#5c7a3a', '#6b7280'];

// ---------- Quick date shortcuts next to every date / date-time field: Now, +1 hour, +1 day, +1 week ----------
// A date field followed by a time field (e.g. an event's start) is treated as one date-time. Moving an event's
// start moves its end by the same amount, so the length stays the same.
let quickTz = T.systemTz();
export function setQuickTz(tz) { if (tz && T.isValidTz(tz)) quickTz = tz; }
const QUICK = [['now', 'Now'], ['h', '+1 hour'], ['d', '+1 day'], ['w', '+1 week']];
export function addDateShortcuts(root) {
  for (const inp of root.querySelectorAll('input[type=datetime-local], input[type=date]')) {
    if (inp.dataset.quick === 'off' || inp.dataset.quickDone || inp.readOnly || inp.disabled) continue;
    inp.dataset.quickDone = '1';
    const sel = document.createElement('select');
    sel.className = 'dt-quick';
    sel.title = 'Quick set'; sel.setAttribute('aria-label', 'Quick set date');
    sel.add(new Option('⏱', ''));
    for (const [v, l] of QUICK) sel.add(new Option(l, v));
    const wrap = document.createElement('span');
    // carry the field's classes, so code that shows/hides the field (e.g. "Ends on") hides the shortcut too
    wrap.className = ['dt-wrap', ...[...inp.classList].filter((c) => c !== 'num')].join(' ');
    if (inp.style.display === 'none') { wrap.style.display = 'none'; inp.style.display = ''; }
    inp.replaceWith(wrap);
    wrap.append(inp, sel);
    sel.addEventListener('change', () => { const v = sel.value; sel.value = ''; if (v) applyQuick(inp, v); });
  }
}
function pairOf(inp) {
  // the time field that goes with a date field: the next time input in the same row/field, or by name (sDate→sTime)
  const f = inp.form;
  const byName = f && inp.name && /Date$/.test(inp.name) ? f.elements[inp.name.replace(/Date$/, 'Time')] : null;
  return byName && byName.type === 'time' ? byName : null;
}
function readMs(inp) {
  if (inp.type === 'datetime-local') return inp.value ? T.fromDTInput(inp.value, quickTz) : null;
  if (!inp.value) return null;
  const t = pairOf(inp);
  return T.atTime(inp.value, t?.value && !t.disabled && t.offsetParent !== null ? t.value : '09:00', quickTz);
}
function writeMs(inp, ms) {
  const dt = T.toDTInput(ms, quickTz);
  if (inp.type === 'datetime-local') inp.value = dt;
  else { inp.value = dt.slice(0, 10); const t = pairOf(inp); if (t && !t.disabled) { t.value = dt.slice(11, 16); fire(t); } }
  fire(inp);
}
const fire = (el2) => { el2.dispatchEvent(new Event('input', { bubbles: true })); el2.dispatchEvent(new Event('change', { bubbles: true })); };
function applyQuick(inp, v) {
  const now = Date.now();
  const base = readMs(inp);
  let ms;
  if (v === 'now') ms = Math.ceil(now / (5 * T.MIN)) * 5 * T.MIN;
  else {
    const from = base ?? now;
    ms = v === 'h' ? from + T.HOUR : v === 'd' ? T.atTime(T.addDays(T.dayKey(from, quickTz), 1), T.toDTInput(from, quickTz).slice(11, 16), quickTz)
      : T.atTime(T.addDays(T.dayKey(from, quickTz), 7), T.toDTInput(from, quickTz).slice(11, 16), quickTz);
  }
  // keep an event's length: moving the start moves the end too
  const f = inp.form;
  if (f && inp.name === 'sDate' && f.elements.eDate) {
    const end = readMs(f.elements.eDate), start0 = base;
    writeMs(inp, ms);
    if (end != null && start0 != null) writeMs(f.elements.eDate, end + (ms - start0));
    return;
  }
  writeMs(inp, ms);
}
