// Notes (sidebar tab, post-its under the dates) and day ratings.
import * as T from './tz.js';
import * as S from './scheduler.js';
import * as E from './engine.js';
import * as A from './analysis.js';
import { $, $$, esc, popover, modal, setHTML } from './ui.js';
import * as GM from './game.js';
import { app, set, st, tz } from './core.js';
import { render, syncSharedSoon, toast } from './app.js';
import { gameOn, gameRefresh } from './game-ui.js';
import { renderLater } from './sidebar.js';
import { pushUndo } from './undo.js';

// ======================================================================================
// Notes (thoughts, newest first; a post-it on the days that have some) and day ratings (0–5 smileys, with a reason)
// Both live in your settings, so they sync to your other devices.
// ======================================================================================
const SMILEYS = ['😫', '😞', '😕', '😐', '🙂', '😄'];
const RATE_WORDS = ['Awful', 'Bad', 'Meh', 'OK', 'Good', 'Great'];
export const notesList = () => set().notes || [];
// the day a note belongs to: the date it's for (a reminder for a future day), or the day it was written
const noteDay = (n) => n.for || T.dayKey(n.at, tz());
const notesOn = (k) => notesList().filter((n) => noteDay(n) === k).sort((a, b) => a.at - b.at);
// a note for a day that has come (today or before) and hasn't been read yet on that day
const noteDue = (n) => !!n.for && !n.read && n.for <= T.dayKey(Date.now(), tz());
async function saveNotes(list, label) {
  const before = notesList();
  set().notes = list;
  await E.persist(st(), ['settings']); syncSharedSoon();
  if (label) pushUndo(label, async () => { set().notes = before; await E.persist(st(), ['settings']); syncSharedSoon(); renderLater(); render(); });
  renderLater(); render();
}
async function rateDay(k, v, why) {
  const before = { ...(set().dayRatings || {}) }, r = { ...before };
  if (v == null) delete r[k]; else r[k] = { v, ...(why ? { why: why.slice(0, 200) } : {}), at: Date.now() };
  set().dayRatings = r;
  // game: rating a past day counts on that day, so count it again
  if (gameOn() && set().game?.ledger?.[k]) delete set().game.ledger[k];
  await E.persist(st(), ['settings']); syncSharedSoon();
  if (gameOn()) { const xp = v == null ? 0 : GM.cfg(set()).rateXP + (why ? GM.cfg(set()).rateWhyXP : 0); setTimeout(() => { gameRefresh(); if (xp) toast(`🎮 +${xp} XP for rating the day${why ? ' (with a reason)' : ''}`, { ms: 3500, noUndo: true }); }, 300); }
  pushUndo(v == null ? 'clear the day rating' : 'rate the day', async () => { set().dayRatings = before; await E.persist(st(), ['settings']); syncSharedSoon(); render(); });
  render();
}
// Under each date: the day's rating (or a faint smiley to rate it) and a post-it when the day has notes
export function dayMarks(k, todayK) {
  const r = set().dayRatings?.[k], on = notesOn(k), n = on.length, due = on.some(noteDue);
  const rate = k <= todayK ? `<button type="button" class="dm-rate ${r ? 'set' : ''}" data-rate="${k}" title="${esc(r ? `${RATE_WORDS[r.v]} day (${r.v}/5)${r.why ? ` — ${r.why}` : ''} · click to change` : 'Rate this day (0–5)')}">${r ? SMILEYS[r.v] : '☺'}</button>` : '';
  const note = n ? `<button type="button" class="dm-note ${due ? 'due' : ''}" data-dnotes="${k}" title="${n} note${n > 1 ? 's' : ''}${due ? ' — a note for this day you haven\'t read yet' : ''} — click to read">🗒<b>${n > 1 ? n : ''}</b></button>` : '';
  const fl = app.dayFill?.[k];
  const fill = fl ? `<span class="day-fill" title="${esc(`${fl[0]}% of the day is on the calendar${fl[1] != null ? ` · ${fl[1]}% of the work hours` : ''}`)}">${fl[0]}%${fl[1] != null ? `<small> (${fl[1]}%)</small>` : ''}</span>` : '';
  return rate || note || fill ? `<span class="day-marks">${rate}${note}${fill}</span>` : '';
}
// How full each day is: % of the 24 hours taken by events and sessions (overlaps once), and % of the work hours
export function computeDayFill(days, items) {
  const s = set(), z = tz(), out = {};
  const occ = items.filter((it) => !it.allDay && !it.declined && it.end > it.start && A.isOccupying(it, s));
  const inter = (iv, a, b) => { let m = 0, ce = -Infinity; for (const [x, y] of iv) { const p = Math.max(x, a, ce), q = Math.min(y, b); if (q > p) m += q - p; ce = Math.max(ce, Math.min(y, b)); } return m; };
  for (const k of days) {
    const a = T.dayStart(k, z), b = T.dayStart(T.addDays(k, 1), z);
    const iv = occ.filter((it) => it.end > a && it.start < b).map((it) => [Math.max(it.start, a), Math.min(it.end, b)]).sort((x, y) => x[0] - y[0]);
    if (!iv.length) continue;
    const dayPct = Math.round((inter(iv, a, b) / (b - a)) * 100);
    const wins = S.windows(a, b, s.bounds, z).filter((w) => T.dayKey(w.start, z) === k);
    const wMin = wins.reduce((t, w) => t + (w.end - w.start), 0);
    const workPct = wMin > 0 ? Math.min(100, Math.round((wins.reduce((t, w) => t + inter(iv, w.start, w.end), 0) / wMin) * 100)) : null;
    out[k] = [dayPct, workPct];
  }
  return out;
}
export function wireDayMarks(root) {
  $$('.day-marks button', root).forEach((b) => {
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    b.addEventListener('click', (e) => { e.stopPropagation(); if (b.dataset.rate) ratePopover(b.dataset.rate, b.getBoundingClientRect()); else dayNotes(b.dataset.dnotes); });
  });
}
function ratePopover(k, rect) {
  const r = set().dayRatings?.[k], z = tz();
  popover(rect, `<form class="pop rate-pop"><h3>How was ${esc(k === T.dayKey(Date.now(), z) ? 'today' : T.format(T.dayStart(k, z), z, { weekday: 'long', day: 'numeric', month: 'short' }))}?</h3>
      <div class="rate-row">${SMILEYS.map((sm, i) => `<button type="button" class="rate-b ${r?.v === i ? 'on' : ''}" data-v="${i}" title="${i} — ${RATE_WORDS[i]}"><span>${sm}</span><small>${i}</small></button>`).join('')}</div>
      <input name="why" class="rate-why" placeholder="Why? (optional) e.g. good run, tough meeting" maxlength="200" value="${esc(r?.why || '')}" autocomplete="off">
      ${gameOn() && !r ? `<p class="muted small" style="margin:4px 0 0">🎮 +${GM.cfg(set()).rateXP} XP for rating — +${GM.cfg(set()).rateWhyXP} more with a reason</p>` : ''}
      <div class="actions">${r ? '<button type="button" class="btn small ghost rate-clear">Clear</button>' : ''}<span class="grow"></span><button class="btn small primary" ${r ? '' : 'disabled'}>Save</button></div></form>`, (p, close) => {
    const f = $('form', p); let v = r?.v ?? null;
    $$('.rate-b', p).forEach((b) => (b.onclick = () => { v = +b.dataset.v; $$('.rate-b', p).forEach((x) => x.classList.toggle('on', x === b)); $('button.primary', p).disabled = false; f.why.focus(); }));
    $('.rate-clear', p)?.addEventListener('click', () => { close(); rateDay(k, null); });
    f.onsubmit = (e) => { e.preventDefault(); if (v == null) return; close(); rateDay(k, v, f.why.value.trim()); };
  });
}
// Formatting in notes (kept as plain text with marks): **bold**, *italic*, __underline__, ~~strike~~, `code`,
// lines starting with "- " as bullets, and links.
export function noteHTML(text) {
  const inline = (t) => esc(t)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_\n]+)__/g, '<u>$1</u>')
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<i>$2</i>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  const out = []; let list = null;
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*[-•*]\s+(.*)$/.exec(line);
    if (m) { (list ||= []).push(`<li>${inline(m[1])}</li>`); continue; }
    if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; }
    out.push(inline(line) + '<br>');
  }
  if (list) out.push(`<ul>${list.join('')}</ul>`);
  return out.join('').replace(/(<br>)+$/, '');
}
const NOTE_TOOLS = [['b', '**', '**', '<b>B</b>', 'Bold (Ctrl+B)'], ['i', '*', '*', '<i>I</i>', 'Italic (Ctrl+I)'], ['u', '__', '__', '<u>U</u>', 'Underline (Ctrl+U)'], ['s', '~~', '~~', '<s>S</s>', 'Strike through'], ['l', '- ', '', '•', 'Bullet list'], ['c', '`', '`', '<code>{}</code>', 'Code']];
const noteTools = () => `<div class="note-tools" role="toolbar" aria-label="Formatting">${NOTE_TOOLS.map(([k, , , lab, tip]) => `<button type="button" data-fmt="${k}" title="${tip}" aria-label="${tip}">${lab}</button>`).join('')}</div>`;
// wrap the selection in the marks (or put "- " in front of each selected line)
function wireNoteTools(root, ta) {
  const apply = (k) => {
    const [, a, b] = NOTE_TOOLS.find((x) => x[0] === k), v = ta.value, s0 = ta.selectionStart, s1 = ta.selectionEnd;
    if (k === 'l') {
      const ls = v.lastIndexOf('\n', s0 - 1) + 1, le = v.indexOf('\n', s1); const end = le < 0 ? v.length : le;
      const block = v.slice(ls, end).split('\n').map((x) => (/^\s*- /.test(x) ? x.replace(/^\s*- /, '') : '- ' + x)).join('\n');
      ta.value = v.slice(0, ls) + block + v.slice(end); ta.setSelectionRange(ls, ls + block.length);
    } else {
      const sel = v.slice(s0, s1) || 'text';
      ta.value = v.slice(0, s0) + a + sel + b + v.slice(s1); ta.setSelectionRange(s0 + a.length, s0 + a.length + sel.length);
    }
    ta.focus(); ta.dispatchEvent(new Event('input', { bubbles: true }));
  };
  $$('[data-fmt]', root).forEach((btn) => { btn.addEventListener('pointerdown', (e) => e.preventDefault()); btn.onclick = () => apply(btn.dataset.fmt); });
  ta.addEventListener('keydown', (e) => { if (!(e.ctrlKey || e.metaKey) || e.altKey) return; const k = { b: 'b', i: 'i', u: 'u' }[e.key.toLowerCase()]; if (k) { e.preventDefault(); apply(k); } });
}
const noteRow = (n, { day = true } = {}) => `<div class="note ${noteDue(n) ? 'due' : ''}" data-id="${esc(n.id)}"><div class="note-t">${noteHTML(n.text)}</div><div class="note-m"><span class="muted small">${n.for ? `<b class="note-for ${noteDue(n) ? 'due' : ''}" title="A note for this day">📅 ${esc(T.format(T.dayStart(n.for, tz()), tz(), { weekday: 'short', day: 'numeric', month: 'short' }))}</b> · written ` : ''}${esc(day || n.for ? T.fmtDate(n.at, tz()) + ' · ' : '')}${esc(T.fmtTime(n.at, tz(), set().h12))}</span><span class="grow"></span><button type="button" class="link small note-edit">Edit</button><button type="button" class="icon-btn sm note-del" title="Delete note" aria-label="Delete note">✕</button></div></div>`;
function wireNotes(box, after) {
  $$('.note', box).forEach((r) => {
    const n = notesList().find((x) => x.id === r.dataset.id); if (!n) return;
    $('.note-del', r).onclick = async () => { await saveNotes(notesList().filter((x) => x.id !== n.id), 'delete a note'); toast('Note deleted'); after?.(); };
    $('.note-edit', r).onclick = async () => {
      const v = await modal(`<form class="choice note-edit-f"><h2>Edit note</h2>${noteTools()}<textarea name="v" rows="6" maxlength="2000" style="width:100%">${esc(n.text)}</textarea>
          <label class="field"><span>For a day <em class="muted">(optional — it turns red on that day until you read it)</em></span><input type="date" data-quick="off" name="for" value="${esc(n.for || '')}"></label>
          <div class="actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">Save</button></div></form>`,
        (dlg, close) => { const f = $('form', dlg); wireNoteTools(f, f.v); f.onsubmit = (e) => { e.preventDefault(); close({ text: f.v.value.trim(), for: f.for.value || null }); }; setTimeout(() => f.v.focus(), 30); }, { cls: 'narrow' });
      if (v == null) return;
      await saveNotes(v.text ? notesList().map((x) => (x.id === n.id ? { ...x, text: v.text.slice(0, 2000), edited: Date.now(), ...(v.for !== (x.for || null) ? { for: v.for || undefined, read: undefined } : {}) } : x)) : notesList().filter((x) => x.id !== n.id), 'edit a note');
      after?.();
    };
  });
}
const noteForm = (ph, forVal = '') => `<form class="note-add">${noteTools()}<textarea name="t" rows="2" placeholder="${esc(ph)}" maxlength="2000" aria-label="New note"></textarea>
  <div class="note-add-row"><label class="note-for-in" title="Show it on a day in the future: its post-it turns red on that day until you read it">📅 <input type="date" data-quick="off" name="for" value="${esc(forVal)}" aria-label="For a day (optional)"></label><span class="grow"></span><button class="btn small" type="submit">Add note</button></div></form>`;
function newNote(text, forDay, at = Date.now()) { const today = T.dayKey(Date.now(), tz()); return { id: S.newId('n'), text: text.slice(0, 2000), at, ...(forDay && forDay !== T.dayKey(at, tz()) ? { for: forDay } : {}), ...(forDay && forDay === today ? { read: Date.now() } : {}) }; }
// The Notes tab: write a thought (optionally for a future day), read them all, newest first
export function renderNotes(box) {
  const list = [...notesList()].sort((a, b) => b.at - a.at);
  const z = tz(); let last = '';
  // a redraw (sync, refresh) keeps what you're typing
  const old = $('.note-add textarea', box), draft = old?.value || '', had = old && document.activeElement === old, sel = had ? [old.selectionStart, old.selectionEnd] : null, oldFor = $('.note-add [name=for]', box)?.value || '';
  const due = list.filter(noteDue);
  setHTML(box, `${noteForm('A thought, an idea, something to remember…', oldFor)}
    ${due.length ? `<div class="note-day due">📅 For today — not read yet</div>${due.map((n) => noteRow(n)).join('')}<button type="button" class="link small note-read-all">Mark as read</button>` : ''}
    ${list.length ? list.map((n) => { const k = T.dayKey(n.at, z), head = k !== last ? `<div class="note-day">${esc(T.format(n.at, z, { weekday: 'long', day: 'numeric', month: 'long' }))}</div>` : ''; last = k; return head + noteRow(n, { day: false }); }).join('') : '<p class="muted small empty">Jot down thoughts as they come — with **bold**, *italic* and lists. Each day with notes gets a little post-it under its date; a note for a future day turns its post-it red on that day until you read it.</p>'}`);
  const f = $('.note-add', box);
  wireNoteTools(f, f.t);
  if (draft) { f.t.value = draft; if (had) { f.t.focus(); f.t.setSelectionRange(...sel); } }
  f.onsubmit = async (e) => { e.preventDefault(); const v = f.t.value.trim(); if (!v) return; const fd = f.for.value; f.t.value = ''; f.for.value = ''; await saveNotes([...notesList(), newNote(v, fd)], fd ? 'add a note for a day' : 'add a note'); if (fd && fd > T.dayKey(Date.now(), z)) toast(`🗒 Note saved for ${T.format(T.dayStart(fd, z), z, { weekday: 'long', day: 'numeric', month: 'short' })} — its post-it turns red that day`); $('#note-list .note-add textarea')?.focus(); };
  f.t.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) f.requestSubmit(); });
  $('.note-read-all', box)?.addEventListener('click', () => markNotesRead(due.map((n) => n.id)));
  wireNotes(box);
}
async function markNotesRead(ids) {
  if (!ids.length) return;
  set().notes = notesList().map((n) => (ids.includes(n.id) ? { ...n, read: Date.now() } : n));
  await E.persist(st(), ['settings']); syncSharedSoon(); renderLater(); render();
}
// One day's notes (from its post-it), with a box to add another to that day. Opening it on (or after) the day a note
// is for counts as reading it.
export async function dayNotes(k) {
  const z = tz(), today = T.dayKey(Date.now(), z);
  const dueIds = notesOn(k).filter(noteDue).map((n) => n.id);
  await modal(`<div class="day-notes"><header class="dlg-head"><h2>🗒 ${esc(T.format(T.dayStart(k, z), z, { weekday: 'long', day: 'numeric', month: 'long' }))}</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></header><div class="dlg-body"><div class="dn-list"></div>
    ${noteForm(k > today ? 'A note for this day…' : 'Add a note to this day…')}</div></div>`, (dlg, close) => {
    const draw = () => { const l = notesOn(k); if (!dlg.isConnected) return; setHTML($('.dn-list', dlg), l.map((n) => noteRow(n, { day: false })).join('') || '<p class="muted small">No notes on this day.</p>'); wireNotes($('.dn-list', dlg), draw); };
    draw();
    const f = $('.note-add', dlg);
    wireNoteTools(f, f.t);
    $('.note-for-in', f).hidden = true;
    f.onsubmit = async (e) => { e.preventDefault(); const v = f.t.value.trim(); if (!v) return; const at = k === today || k > today ? Date.now() : T.atTime(k, '12:00', z); await saveNotes([...notesList(), newNote(v, k, at)], 'add a note'); f.t.value = ''; draw(); };
  }, { cls: 'narrow' });
  if (dueIds.length) markNotesRead(dueIds);
}
