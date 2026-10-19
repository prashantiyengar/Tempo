// Small DOM helpers shared by the views and dialogs.
// All markup built from strings goes through DOMPurify (the official, unmodified library in /vendor) before it
// touches the DOM. Values interpolated into those strings are additionally escaped with esc().
import DOMPurify from '../vendor/purify.es.mjs';

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
    dlg.addEventListener('mousedown', (e) => { if (e.target === dlg) close(undefined); });
    $$('[data-close]', dlg).forEach((b) => b.addEventListener('click', () => close(undefined)));
    setup?.(dlg, close);
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

export function popover(anchorRect, html, setup) {
  closePopover();
  const p = el(`<div class="popover" role="dialog">${html}</div>`);
  document.body.appendChild(p);
  const r = p.getBoundingClientRect();
  const vw = innerWidth, vh = innerHeight;
  let left = anchorRect.right + 8;
  if (left + r.width > vw - 8) left = anchorRect.left - r.width - 8;
  if (left < 8) left = Math.max(8, Math.min(vw - r.width - 8, anchorRect.left));
  let top = Math.min(Math.max(8, anchorRect.top), vh - r.height - 8);
  p.style.left = left + 'px';
  p.style.top = Math.max(8, top) + 'px';
  setup?.(p, closePopover);
  setTimeout(() => {
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', escKey, true);
  });
  return p;
}
function outside(e) { const p = $('.popover'); if (p && !p.contains(e.target) && !e.target.closest('dialog')) closePopover(); }
function escKey(e) { if (e.key === 'Escape' && !document.querySelector('dialog[open]')) closePopover(); }
export function closePopover() {
  $$('.popover').forEach((p) => p.remove());
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
