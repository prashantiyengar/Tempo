// The history log (what moved and why), the status line, the sync banner and error handling.
import * as T from './tz.js';
import * as E from './engine.js';
import * as G from './gcal.js';
import * as D from './dialogs.js';
import { isWeb } from './storage.js';
import { $, $$, esc, toast as uiToast, modal, setHTML } from './ui.js';
import * as RV from './review.js';
import { app, set, st, tz } from './core.js';
import { ctx, cycle, cycleAgain, openConnect, openSettings, reconnectGoogle, renewSoon, replaceTask, saveTasks, toast } from './app.js';

// ======================================================================================
// History log, "what moved and why"
// ======================================================================================
export function logHistory({ kind, task, sess, ...rest }) {
  RV.logEntry(set(), { kind, taskId: task?.id, title: task?.title, cat: task?.categoryId || null, t: sess?.start, plan: sess ? Math.round((sess.end - sess.start) / T.MIN) : undefined, ...rest });
  E.persist(st(), ['settings']);
}
// After a re-plan: tell which tasks were pushed later, and why. Imminent sessions pushed by something other than
// your own change (a new meeting, time passing) are recorded as slips.
export function handleMoves(moves) {
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
export function renderBanner() {
  const b = $('#banner');
  const info = st().syncInfo, a = st().auth || {};
  const hasTasks = st().tasks.some((t) => !t.archived);
  let html = '';
  if (!E.connected(st())) {
    if (hasTasks && !app.bannerDismissed) html = innerWidth < 600
      ? `<span>📍 Tasks are only saved on this device.</span><button class="btn small primary" data-b="connect">Connect Google</button><button class="icon-btn sm" data-b="x" title="Hide">✕</button>`
      : `<span>📍 Your task sessions are only saved in this browser — they won't appear in Google Calendar until you connect it.</span><button class="btn small primary" data-b="connect">Connect Google Calendar</button><button class="icon-btn sm" data-b="x" title="Hide">✕</button>`;
  } else if (a.needsReconnect || (info?.kind === 'auth' && !isWeb)) {
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

export async function openSyncPanel() {
  const r = await D.syncDialog(ctx);
  if (r === 'sync') { E.invalidate(); await cycle(); toast(st().syncInfo?.ok ? `All ${st().syncInfo.total} sessions are on Google Calendar` : 'Sync finished with problems — see the notice'); }
  if (r === 'reconnect') reconnectGoogle();
  if (r === 'connect') openConnect();
  if (r === 'settings') openSettings();
}

export async function handleProblems(problems) {
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
    if (r.action !== 'keep') cycleAgain();
  }
}

export function setStatus(text, kind = '') { app.status = { text, kind }; const s = $('#sync-status'); if (s) { s.textContent = text; s.className = 'status ' + kind; } }

export function offlineStatus() {
  const since = E.offlineSince(st());
  setStatus(since ? `Offline · saved ${T.fmtTime(since, tz(), set().h12)}${T.dayKey(since, tz()) !== T.dayKey(Date.now(), tz()) ? ' ' + T.format(since, tz(), { day: 'numeric', month: 'short' }) : ''}` : 'Offline', 'warn');
}
export function handleError(err) {
  // No connection: keep working quietly with saved data; it syncs again when you're back online.
  if (G.isOffline(err) || (navigator.onLine === false)) { offlineStatus(); return; }
  console.error(err);
  if (err?.renewable && isWeb && !st().auth?.needsReconnect) { setStatus('Renewing Google sign-in…', 'busy'); renewSoon(true); return; }
  if (err instanceof G.AuthError || err instanceof G.PermissionError) {
    setStatus(err instanceof G.PermissionError ? 'Permission needed' : 'Google sign-in needed', 'bad');
    renderBanner();
    toast(err.message, { action: 'Reconnect', onAction: () => { G.ensureHostPermission(); reconnectGoogle(); }, ms: 9000 });
  } else {
    setStatus('Error', 'bad');
    toast(err.message || String(err), { ms: 7000 });
  }
}
