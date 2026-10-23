// Projects: a named chain of steps — splittable tasks and calendar events — each with an ideal start, end and (for
// tasks) hours. Stored in settings.projects (synced like your other settings):
//   { id, name, sequential, titleMode: 'prefix' | 'suffix' | 'none', color?, created,
//     steps: [{ id, kind: 'task' | 'event', title, start, end, hours?, allDay?, ref }] }
// `ref` points to what the step created: a task id, or 'calId|eventId' for an event. Steps run in their list order;
// with `sequential`, each starts only after the previous one is done (tasks wait for tasks, and never start before
// an earlier event in the chain has ended).
import * as T from './tz.js';
import * as S from './scheduler.js';

export const newStepId = () => 'st' + Math.random().toString(36).slice(2, 9);
export const newProjectId = () => 'p' + Math.random().toString(36).slice(2, 9);
export const list = (s) => s.projects || [];
export const byId = (s, id) => list(s).find((p) => p.id === id) || null;

// "Thesis: Write chapter 2" / "Write chapter 2 — Thesis" / unchanged
export function fullTitle(p, title) {
  const t = String(title || '').trim() || 'Step';
  if (!p?.name || p.titleMode === 'none') return t;
  return p.titleMode === 'suffix' ? `${t} — ${p.name}` : `${p.name}: ${t}`;
}
// The step's own title, from a full title (when a task was renamed elsewhere)
export function bareTitle(p, title) {
  const t = String(title || '');
  if (!p?.name) return t;
  if (t.startsWith(p.name + ': ')) return t.slice(p.name.length + 2);
  if (t.endsWith(' — ' + p.name)) return t.slice(0, -(p.name.length + 3));
  return t;
}

// Steps of a project, with tasks that joined it some other way (the task dialog's "Part of project") added at the
// end, and task steps whose task is gone dropped.
export function steps(p, tasks) {
  const mine = tasks.filter((t) => t.projectId === p.id && !t.archived);
  const known = new Set(mine.map((t) => t.id));
  const out = (p.steps || []).filter((st) => st.kind !== 'task' || !st.ref || known.has(st.ref));
  const have = new Set(out.filter((x) => x.kind === 'task').map((x) => x.ref));
  for (const t of mine.sort((a, b) => (a.projectStep ?? 1e9) - (b.projectStep ?? 1e9) || (a.created || 0) - (b.created || 0))) {
    if (!have.has(t.id)) out.push({ id: newStepId(), kind: 'task', title: bareTitle(p, t.title), start: t.earliestStart || null, end: t.deadline || null, hours: +(S.totalMinutes(t) / 60).toFixed(2), ref: t.id });
  }
  return out;
}

// Progress: per step and overall (work-minutes done / planned; events count by their length once they're over or ticked off).
export function progress(p, tasks, now = Date.now(), eventDone = () => false) {
  const rows = steps(p, tasks).map((st) => {
    if (st.kind === 'task') {
      const t = tasks.find((x) => x.id === st.ref);
      if (!t) return { st, total: Math.round((+st.hours || 0) * 60), done: 0, pct: 0, finished: false, missing: true };
      const pr = S.progress(t, now);
      const next = S.sessions(t).find((c) => c.kind === 'planned' && c.end > now);
      return { st, task: t, total: pr.total, done: pr.done, pct: pr.pct, finished: pr.pct >= 100, next: next?.start || null, finish: t.lastPlan?.finish || null, late: !!(t.lastPlan?.shortfall > 0) };
    }
    const len = st.start && st.end ? Math.max(0, Math.round((st.end - st.start) / T.MIN)) : 0;
    const over = (st.end && st.end <= now) || eventDone(st);
    return { st, total: len, done: over ? len : 0, pct: over ? 100 : 0, finished: over, next: !over ? st.start : null };
  });
  const total = rows.reduce((a, r) => a + r.total, 0), done = rows.reduce((a, r) => a + Math.min(r.done, r.total), 0);
  const fin = rows.filter((r) => r.finished).length;
  const nextRow = rows.find((r) => !r.finished) || null;
  return { rows, total, done, pct: total ? Math.round((done / total) * 100) : rows.length && fin === rows.length ? 100 : 0, finished: fin, count: rows.length, next: nextRow, complete: rows.length > 0 && fin === rows.length };
}

// Which project an item (event or task session) belongs to
export function projectOf(it, s) {
  const id = it.kind === 'chunk' ? it.task?.projectId : it.ev?.extendedProperties?.private?.tempoProject;
  return id ? byId(s, id) : null;
}
// Minutes per project in [from, to) — done (before now) and planned (after now)
export function timeByProject(items, s, from, to, now = Date.now()) {
  const out = {};
  for (const it of items) {
    if (it.allDay || it.declined) continue;
    const p = projectOf(it, s); if (!p) continue;
    if (it.kind === 'chunk' && (it.status === 'waived' || it.sess?.kind === 'waived')) continue;
    const a = Math.max(it.start, from), b = Math.min(it.end, to); if (b <= a) continue;
    const o = (out[p.id] ||= { done: 0, planned: 0 });
    o.done += Math.max(0, Math.min(b, now) - a) / T.MIN;
    o.planned += Math.max(0, b - Math.max(a, now)) / T.MIN;
  }
  for (const o of Object.values(out)) { o.done = Math.round(o.done); o.planned = Math.round(o.planned); }
  return out;
}
// Steps finished in [from, to): task steps whose last done session ended then, event steps that ended then
export function finishedIn(p, tasks, from, to, now = Date.now()) {
  return progress(p, tasks, now).rows.filter((r) => {
    if (!r.finished) return false;
    if (r.task) { const last = Math.max(0, ...(r.task.frozen || []).filter((c) => c.status === 'done').map((c) => c.end)); return last >= from && last < to; }
    return r.st.end >= from && r.st.end < to;
  });
}
