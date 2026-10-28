// Undo: tasks (snapshots), events (inverse operations) and settings.
import * as S from './scheduler.js';
import * as E from './engine.js';
import * as EV from './events.js';
import * as D from './dialogs.js';
import { $, choose } from './ui.js';
import { app, set, st } from './core.js';
import { ctx, cycle, replaceTask, saveTasks, toast } from './app.js';
import { projectCategory } from './assistant.js';
import { handleError } from './status.js';
import { afterEventChange, askCategoryOnce } from './popovers.js';

// ======================================================================================
// Undo — tasks (snapshots), events (inverse operations) and settings
// ======================================================================================
export const undoStack = [];
let baseline = null;
const snapTasks = () => JSON.stringify(st().tasks);
export function markBaseline() { baseline = snapTasks(); }
export function pushUndo(label, undo) {
  undoStack.push({ label, undo, at: Date.now() });
  if (undoStack.length > 40) undoStack.shift();
  app.lastUserChange = Date.now();
  app.lastChangeLabel = app.pendingWhy || label;
  app.pendingWhy = null;
  updateUndoBtn();
}
export function recordTaskUndo(label) {
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
export async function undo() {
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
export function undoableEventChange(label, ev, scope) {
  // Only single events / single occurrences can be put back exactly.
  if (scope && scope !== 'this') return;
  const before = pick(ev, EV_FIELDS);
  pushUndo(label, async () => { await EV.updateEvent(st(), ev, before, 'this'); await afterEventChange(); });
}
export function undoableEventDelete(ev, scope) {
  if (ev.recurringEventId || (scope && scope !== 'this')) return;
  const copy = JSON.parse(JSON.stringify(ev));
  pushUndo(`delete “${ev.summary || 'event'}”`, async () => { await EV.createEvent(st(), copy._calId, copy); await afterEventChange(); });
}

export async function newTask(preset = {}) {
  const r = await D.taskDialog(ctx, null, preset);
  if (!r?.task) return;
  let t = { ...r.task };
  if (preset.title && !t.title) t.title = preset.title;
  t = projectCategory(t);
  if (!t.categoryId && set().askCategory !== false) t = await askCategoryOnce(t);
  t.rev = Date.now();
  st().tasks.push(t);
  app.pendingWhy = `you added “${t.title}” (rank ${t.rank})`;
  await saveTasks(`add “${t.title}”`);
  await cycle();
  const ss = S.sessions(st().tasks.find((x) => x.id === t.id));
  toast(`Scheduled ${ss.length} session${ss.length === 1 ? '' : 's'} for “${t.title}”`);
}

export async function editTask(task) {
  if (!task) return;
  const r = await D.taskDialog(ctx, task);
  if (!r) return;
  if (r.delete) {
    const v = await choose('Delete task', `“${task.title}”`, [{ value: true, label: 'Delete the entire series', desc: 'Removes the task and all its sessions (also from Google Calendar).', danger: true }]);
    if (v) deleteTask(task.id);
    return;
  }
  delete st().acks[task.id];
  let nt = projectCategory({ ...r.task, frozen: task.frozen, planned: task.planned });
  // A new reading speed must not shift the pages already read.
  if (task.kind === 'reading' && nt.kind === 'reading' && S.pagesPerHour(task.reading || {}) !== S.pagesPerHour(nt.reading || {})) nt = S.withReadingSpeed({ ...nt, reading: task.reading }, nt.reading);
  replaceTask(nt);
  app.pendingWhy = task.rank !== nt.rank ? `you changed “${nt.title}” to rank ${nt.rank}` : `you edited “${nt.title}”`;
  await saveTasks(`edit “${nt.title}”`);
  await cycle();
  toast('Task updated and rescheduled');
}

export async function deleteTask(id) {
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
