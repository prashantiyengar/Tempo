// Every action in one list: the command bar (Ctrl/⌘ K) shows and searches them, the phone's + and ⋯ menus and the
// "Now" menu are built from them, and their keyboard shortcuts come from here. Plus search across events, tasks,
// Later notes, notes, habits and goals, and "share my free time".
import * as T from './tz.js';
import * as I from './items.js';
import { app, st, set, tz } from './core.js';
import { $, $$, esc, modal, setHTML } from './ui.js';
import { dayNotes } from './notes.js';
import { collectItems, openSettings, refreshFromServer, render, toast } from './app.js';
import { freeSlots, openAiConsole } from './assistant.js';
import { fillSinceLast } from './leave.js';
import { editGoal, openReview } from './review-ui.js';
import { editTask, newTask, undo } from './undo.js';
import { openItem } from './popovers.js';
import { startedLate } from './scheduler.js';
import { habitDetail } from './habits-ui.js';
import { handleError, openSyncPanel } from './status.js';
import { backupNow, ensureDrive, restoreFromDrive } from './backup.js';
import { openProject, renderLater } from './sidebar.js';
import { exportCustom, exportMulti, exportView } from './export-ui.js';
import { finishedEarly } from './actions.js';

// { id, ic, label, keys (shortcut keys), menus ('fab' | 'more' | 'now'), run, hint }
export const COMMANDS = [
  { id: 'new-event', ic: '+', label: 'New event', keys: ['c', 'n'], menus: ['fab'], run: () => $('#btn-new-event').click() },
  { id: 'new-task', ic: '⧉', label: 'New task (one block or split into sessions)', keys: ['a'], menus: ['fab'], run: () => newTask({ kind: 'generic' }) },
  { id: 'new-reading', ic: '📖', label: 'New reading plan', menus: ['fab'], run: () => newTask({ kind: 'reading' }) },
  { id: 'new-project', ic: '📁', label: 'New project (a chain of tasks and events)', menus: ['fab'], run: () => openProject(null) },
  { id: 'habits', ic: '✓', label: 'Habits', menus: ['fab'], run: () => { app.view = 'goals'; render(); } },
  { id: 'late', ic: '⏰', label: 'Started late', menus: ['fab', 'more', 'now'], run: () => startedLate() },
  { id: 'early', ic: '⏹', label: 'Finished early', keys: ['f'], menus: ['fab', 'more', 'now'], run: () => finishedEarly() },
  { id: 'since', ic: '⤒', label: 'Fill time since last event', keys: ['l'], menus: ['fab', 'more', 'now'], run: () => fillSinceLast() },
  { id: 'share', ic: '📤', label: 'Share my free time…', menus: ['more', 'now'], run: () => shareFreeTime() },
  { id: 'today', ic: '◎', label: 'Go to today', keys: ['t'], run: () => $('#btn-today').click() },
  { id: 'v-day', ic: 'D', label: 'Day view', keys: ['d'], run: () => go('day') },
  { id: 'v-week', ic: 'W', label: 'Week view', keys: ['w'], run: () => go('week') },
  { id: 'v-month', ic: 'M', label: 'Month view', keys: ['m'], run: () => go('month') },
  { id: 'v-analysis', ic: '◔', label: 'Analysis', keys: ['y'], run: () => go('analysis') },
  { id: 'review', ic: '★', label: 'Weekly review', keys: ['v'], menus: ['more'], run: () => openReview() },
  { id: 'v-goals', ic: '◎', label: 'Goals', keys: ['g'], run: () => go('goals') },
  { id: 'prev', ic: '‹', label: 'Previous day / week / month', keys: ['arrowleft', 'j'], hidden: true, run: () => $('#btn-prev').click() },
  { id: 'next', ic: '›', label: 'Next day / week / month', keys: ['arrowright', 'k'], hidden: true, run: () => $('#btn-next').click() },
  { id: 'quick', ic: '✎', label: 'Quick add in plain language', keys: ['q'], run: () => { if (innerWidth < 760) $('#btn-menu').click(); $('#quick-add')?.focus(); } },
  { id: 'refresh', ic: '⟳', label: 'Refresh from Google', keys: ['r'], menus: ['more'], run: () => refreshFromServer() },
  { id: 'sync', ic: '✓', label: 'Sync status', menus: ['more'], run: () => openSyncPanel() },
  { id: 'settings', ic: '⚙', label: 'Settings', menus: ['more'], run: () => openSettings() },
  { id: 'undo', ic: '↶', label: 'Undo last change', keys: ['u'], menus: ['more'], run: () => undo() },
  { id: 'backup', ic: '☁', label: 'Back up to Google Drive now', menus: ['more'], run: async () => { try { if (await ensureDrive()) await backupNow(); } catch (err) { handleError(err); } } },
  { id: 'restore', ic: '⤓', label: 'Restore from Google Drive…', run: () => restoreFromDrive() },
  { id: 'ai', ic: '✦', label: 'AI & automation', menus: ['more', 'now'], run: () => openAiConsole() },
  { id: 'x-week-pdf', ic: 'W', label: 'Export this week as PDF', menus: ['more:Export'], run: () => exportView('week', 'pdf').catch(handleError) },
  { id: 'x-week-png', ic: 'W', label: 'Export this week as image (PNG)', menus: ['more:Export'], run: () => exportView('week', 'png').catch(handleError) },
  { id: 'x-month-pdf', ic: 'M', label: 'Export this month as PDF', menus: ['more:Export'], run: () => exportView('month', 'pdf').catch(handleError) },
  { id: 'x-multi', ic: '⧉', label: 'Export several weeks or months…', menus: ['more:Export'], run: () => exportMulti() },
  { id: 'x-custom', ic: '◷', label: 'Export custom dates and hours…', menus: ['more:Export'], run: () => exportCustom() },
  { id: 'search', ic: '🔍', label: 'Search and commands', keys: ['/'], hidden: true, run: () => openCommandBar() },
];
const go = (v) => { app.view = v; render(); };
const byId = (id) => COMMANDS.find((c) => c.id === id);
export const runCommand = (id) => byId(id)?.run();

// The entries of one menu ('fab', 'more', 'now'), with "-"/label separators for grouped parts ("more:Export")
export function menuItems(menu) {
  const out = [], groups = new Map();
  for (const c of COMMANDS) for (const m of c.menus || []) {
    const [name, group] = m.split(':');
    if (name !== menu) continue;
    if (group) { if (!groups.has(group)) groups.set(group, []); groups.get(group).push(c); } else out.push(c);
  }
  for (const [g, list] of groups) out.push('-', g, ...list);
  return out;
}
// Keyboard shortcuts (no modifier keys; not while typing or with a dialog open)
export function commandForKey(k) { return COMMANDS.find((c) => (c.keys || []).includes(k)); }

// ---------- search ----------
const words = (q) => I.fold(q).split(/\s+/).filter(Boolean);
const hit = (text, ws) => { const t = I.fold(text); return ws.every((w) => t.includes(w)); };
const score = (text, ws) => { const t = I.fold(text); return ws.every((w) => t.includes(w)) ? (t.startsWith(ws[0]) ? 2 : new RegExp(`(^|[^\\p{L}\\p{N}])${I.reEscape(ws[0])}`, 'u').test(t) ? 1 : 0) : -1; };
let pool = null; // events and sessions from 60 days back to 180 ahead, fetched when the bar opens
async function loadPool() {
  const z = tz(), today = T.dayKey(Date.now(), z);
  pool = (await collectItems([T.addDays(today, -60), T.addDays(today, 180)])).filter((it) => !it.declined && !I.isWaived(it));
  return pool;
}
// What matches the query: [{ kind, label, sub, at?, run }], best first
export function searchAll(q, items = pool || []) {
  const ws = words(q);
  if (!ws.length) return [];
  const s = set(), z = tz(), now = Date.now(), out = [];
  for (const c of COMMANDS) { const sc = score(c.label, ws); if (sc >= 0) out.push({ kind: 'Action', ic: c.ic, label: c.label, sub: c.keys?.length ? `shortcut ${c.keys[0].toUpperCase()}` : '', rank: 50 + sc, run: c.run }); }
  // events and task sessions: upcoming first (soonest), then past (most recent); one entry per repeating series nearby
  const seen = new Set();
  const evs = items.filter((it) => hit(`${I.titleOf(it)} ${it.ev?.location || ''} ${it.ev?.description || ''}`, ws));
  for (const it of evs.sort((a, b) => ((b.end >= now) - (a.end >= now)) || (a.end >= now ? a.start - b.start : b.start - a.start))) {
    const k = it.kind === 'chunk' ? `t:${it.task.id}` : `e:${it.ev?.recurringEventId || it.key}`;
    if (seen.has(k) && it.kind === 'chunk') continue;
    seen.add(k);
    out.push({ kind: it.kind === 'chunk' ? 'Session' : 'Event', ic: it.kind === 'chunk' ? '⧉' : '📅', label: it.title, sub: `${T.fmtDate(it.start, z)}${it.allDay ? '' : ' ' + T.fmtTime(it.start, z, s.h12)}${it.end < now ? ' · past' : ''}`, at: it.start, rank: 40 + score(it.title, ws) - (it.end < now ? 5 : 0), run: () => showItem(it) });
    if (out.length > 120) break;
  }
  for (const t of st().tasks) if (hit(`${t.title} ${t.notes || ''}`, ws)) out.push({ kind: 'Task', ic: t.kind === 'reading' ? '📖' : '⧉', label: t.title, sub: t.archived ? 'finished' : t.deadline ? `due ${T.fmtDate(t.deadline, z)}` : '', rank: 45 + score(t.title, ws) - (t.archived ? 10 : 0), run: () => editTask(t) });
  for (const x of s.later || []) if (hit(x.text, ws)) out.push({ kind: 'Later', ic: '🕓', label: x.text, sub: 'in Later', rank: 44 + score(x.text, ws), run: () => { app.sideTab = 'later'; renderLater(); if (innerWidth < 760) $('#btn-menu').click(); setTimeout(() => $(`.later-row[data-id="${CSS.escape(x.id)}"] .later-t`)?.click(), 50); } });
  for (const n of s.notes || []) if (hit(n.text, ws)) out.push({ kind: 'Note', ic: '🗒', label: n.text.split('\n')[0].slice(0, 80), sub: T.fmtDate(n.for ? T.dayStart(n.for, z) : n.at, z), rank: 43 + score(n.text, ws), run: () => dayNotes(n.for || T.dayKey(n.at, z)) });
  for (const h of s.habits || []) if (!h.archived && hit(h.name, ws)) out.push({ kind: 'Habit', ic: '✓', label: h.name, sub: 'habit', rank: 42 + score(h.name, ws), run: () => habitDetail(h.id) });
  for (const [key, list] of Object.entries(s.goals || {})) for (const g of list || []) if (hit(g.text || '', ws)) out.push({ kind: 'Goal', ic: '◎', label: g.text, sub: key.startsWith('w:') ? `week of ${T.fmtDate(T.dayStart(key.slice(2), z), z)}` : key.startsWith('m:') ? key.slice(2) : 'this year', rank: 41 + score(g.text, ws), run: () => editGoal(key, g.id) });
  return out.sort((a, b) => b.rank - a.rank).slice(0, 60);
}
// Go to an event or session and open it
async function showItem(it) {
  app.cursor = app.miniCursor = T.dayKey(it.start, tz());
  if (!['day', '3day', 'week'].includes(app.view)) app.view = innerWidth < 760 ? 'day' : 'week';
  await render();
  const live = app.items.get(it.key) || it;
  const node = document.querySelector(`.ev[data-key="${CSS.escape(it.key)}"]`);
  node?.scrollIntoView({ block: 'center' });
  const r = node?.getBoundingClientRect() || { left: innerWidth / 2 - 150, top: innerHeight / 3, right: innerWidth / 2 + 150, bottom: innerHeight / 3 + 40, width: 300, height: 40 };
  openItem(live, r);
}

export async function openCommandBar(initial = '') {
  if (document.querySelector('dialog[open] .cmd-bar')) return;
  let results = [], sel = 0;
  const loading = loadPool().catch(() => []);
  await modal(`<div class="cmd-bar"><div class="cmd-in"><span aria-hidden="true">🔍</span><input class="cmd-q" placeholder="Search events, tasks, notes… or type a command" aria-label="Search and commands" autocomplete="off" value="${esc(initial)}"><kbd class="muted small cmd-esc">Esc</kbd><button type="button" class="icon-btn cmd-x" data-close aria-label="Close">✕</button></div>
      <div class="cmd-list" role="listbox"></div><p class="muted small cmd-foot">↑ ↓ to choose · Enter to open · <b>Ctrl/⌘ K</b> or <b>/</b> opens this anywhere</p></div>`, (dlg, close) => {
    const q = $('.cmd-q', dlg), list = $('.cmd-list', dlg);
    const draw = () => {
      const v = q.value.trim();
      results = v ? searchAll(v) : COMMANDS.filter((c) => !c.hidden).slice(0, 14).map((c) => ({ kind: 'Action', ic: c.ic, label: c.label, sub: c.keys?.length ? `shortcut ${c.keys[0].toUpperCase()}` : '', run: c.run }));
      sel = Math.min(sel, Math.max(0, results.length - 1));
      setHTML(list, results.length ? results.map((r, i) => `<button type="button" class="cmd-row ${i === sel ? 'on' : ''}" data-i="${i}" role="option" aria-selected="${i === sel}"><span class="cmd-ic">${esc(r.ic || '')}</span><span class="cmd-l">${esc(r.label)}</span><span class="cmd-k">${esc(r.kind)}</span><span class="cmd-s muted small">${esc(r.sub || '')}</span></button>`).join('')
        : `<p class="muted small cmd-none">${pool ? 'Nothing found.' : 'Searching…'}</p>`);
      $$('.cmd-row', list).forEach((b) => (b.onclick = () => pick(+b.dataset.i)));
      list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
    };
    const pick = (i) => { const r = results[i]; if (!r) return; close(); setTimeout(() => r.run(), 0); };
    q.addEventListener('input', () => { sel = 0; draw(); });
    q.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(results.length - 1, sel + 1); draw(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); draw(); }
      else if (e.key === 'Enter') { e.preventDefault(); pick(sel); }
    });
    loading.then(() => { if (dlg.isConnected) draw(); });
    draw();
    setTimeout(() => { q.focus(); q.select(); }, 20);
  }, { cls: 'cmd-dlg' });
}

// ---------- share my free time ----------
// Free slots as text to paste into a message: "Thu 29 Oct: 10:00–11:30, 14:00–17:00".
export function freeTimeText(slots, { z, h12, tzName = true }) {
  const byDay = new Map();
  for (const w of slots) { const k = T.dayKey(w.start, z); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(w); }
  const lines = [...byDay].map(([k, ws]) => `${T.fmtDate(T.dayStart(k, z), z)}: ${ws.map((w) => `${T.fmtTime(w.start, z, h12)}–${T.fmtTime(w.end, z, h12)}`).join(', ')}`);
  return lines.length ? `I'm free:\n${lines.join('\n')}${tzName ? `\n(times in ${z.replace(/_/g, ' ')})` : ''}` : 'No free time in that period.';
}
export async function shareFreeTime() {
  const s = set(), z = tz();
  await modal(`<form class="choice share-free"><h2>📤 Share my free time</h2>
      <div class="row"><label class="field"><span>When</span><select name="span"><option value="3">Next 3 days</option><option value="5" selected>Next 5 days</option><option value="7">Next 7 days</option><option value="14">Next 2 weeks</option><option value="nw">Next week</option></select></label>
      <label class="field"><span>At least</span><select name="min"><option value="30">30 min</option><option value="60" selected>1 hour</option><option value="90">1½ hours</option><option value="120">2 hours</option></select></label>
      <label class="field"><span>Within</span><select name="within"><option value="work">Work hours (${esc(s.bounds.start)}–${esc(s.bounds.end)})</option><option value="waking">Waking hours (${esc(s.overflowBounds?.start || '07:00')}–${esc(s.overflowBounds?.end || '23:00')})</option></select></label></div>
      <textarea class="share-text" rows="8" readonly style="width:100%"></textarea>
      <p class="muted small share-note" style="margin:0">Task sessions count as busy (they can move, but they're your plan).</p>
      <div class="actions"><button type="button" class="btn ghost" data-close>Close</button>${navigator.share ? '<button type="button" class="btn share-go">Share…</button>' : ''}<button type="button" class="btn primary share-copy">Copy</button></div></form>`,
  (dlg) => {
    const f = $('form', dlg), out = $('.share-text', dlg);
    const upd = async () => {
      const today = T.dayKey(Date.now(), z);
      let from = Date.now(), to;
      if (f.span.value === 'nw') { const ws = T.addDays(T.startOfWeek(today, s.weekStart ?? 1), 7); from = T.dayStart(ws, z); to = T.dayStart(T.addDays(ws, 7), z); }
      else to = T.dayStart(T.addDays(today, +f.span.value), z);
      out.value = 'Looking…';
      try { out.value = freeTimeText(await freeSlots(from, to, +f.min.value, f.within.value === 'waking' ? 'waking' : 'work hours'), { z, h12: s.h12 }); }
      catch (err) { out.value = 'Could not work it out: ' + (err.message || err); }
    };
    f.addEventListener('change', upd); upd();
    $('.share-copy', dlg).onclick = async () => { try { await navigator.clipboard.writeText(out.value); toast('Copied — paste it into your message'); } catch { out.select(); document.execCommand?.('copy'); toast('Copied'); } };
    $('.share-go', dlg)?.addEventListener('click', () => navigator.share({ text: out.value }).catch(() => {}));
  }, { cls: 'narrow' });
}
