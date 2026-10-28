// Session timer: stopwatch, or focus timer with breaks (Pomodoro).
import * as T from './tz.js';
import * as S from './scheduler.js';
import * as E from './engine.js';
import * as EV from './events.js';
import * as D from './dialogs.js';
import { get as storeGet, set as storeSet } from './storage.js';
import { $, esc, toast as uiToast, choose, setHTML } from './ui.js';
import { set, st, tz } from './core.js';
import { ctx, cycle, replaceTask, saveTasks, toast } from './app.js';
import { handleError } from './status.js';
import { finishSession, partialSession } from './popovers.js';
import { deleteTask } from './undo.js';

// ======================================================================================
// Session timer — stopwatch, or focus timer with breaks (Pomodoro)
// ======================================================================================
export let timer = null, tickId = null;
// Forget the running timer (nothing is recorded)
export function dropTimer() { timer = null; saveTimer(); drawTimer(); }
const saveTimer = () => storeSet({ timer });
export const tmWork = () => (timer ? timer.acc + (timer.running && timer.phase === 'work' ? Date.now() - timer.since : 0) : 0);
const tmPhase = () => (timer ? timer.phaseAcc + (timer.running ? Date.now() - timer.phaseSince : 0) : 0);
const mmss = (ms) => { const t = Math.max(0, Math.round(ms / 1000)); const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), x = t % 60; return `${h ? h + ':' : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(x).padStart(2, '0')}`; };
export async function loadTimer() { timer = (await storeGet('timer')).timer || null; if (timer) startTick(); drawTimer(); }
export async function startTimer(task, sess, mode) {
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

export async function deleteDoneSession(task, sess) {
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
