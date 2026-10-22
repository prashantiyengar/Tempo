// Planned vs actual history and the weekly review.
// Sources: done / partly done sessions stored on tasks (with the time actually spent when a timer was used), plus
// a small shared log of slips: deleted (skipped) sessions, sessions marked undone, imminent sessions that got
// pushed later, and overruns.
import * as T from './tz.js';
import * as S from './scheduler.js';
import { esc } from './ui.js';

const dur = (c) => Math.round((c.end - c.start) / T.MIN);
const catOf = (settings, id) => (settings.categories || []).find((c) => c.id === id);

export function logEntry(settings, e) {
  const h = { id: S.newId('h'), at: Date.now(), ...e };
  settings.history = [...(settings.history || []), h].slice(-250);
  return h;
}

// Records of what happened between from and to.
export function records(state, from, to) {
  const out = [];
  for (const t of state.tasks) {
    for (const c of t.frozen || []) {
      if (c.start < from || c.start >= to || (c.status !== 'done' && c.status !== 'waived')) continue;
      const plan = +c.slotMin || dur(c);
      const workMin = S.work(c, t);
      out.push({ kind: c.partial ? 'partial' : 'done', t: c.start, taskId: t.id, title: t.title, cat: t.categoryId || null,
        plan, act: c.actualMin != null ? +c.actualMin : (c.partial ? dur(c) : plan), work: Math.min(workMin, c.partial ? workMin : plan), timed: c.actualMin != null, auto: !!c.auto });
    }
  }
  for (const h of state.settings.history || []) {
    const when = h.t || h.at;
    if (when < from || when >= to || h.kind === 'partial' || h.kind === 'done') continue; // those come from the tasks
    out.push({ ...h, t: when });
  }
  return out.sort((a, b) => a.t - b.t);
}

export function summarize(state, from, to) {
  const rs = records(state, from, to);
  const s = state.settings;
  const sum = { done: 0, partial: 0, skipped: 0, undone: 0, moved: 0, overrun: 0, planMin: 0, actMin: 0, workMin: 0, cats: {}, weeks: {} };
  const catRow = (id) => (sum.cats[id || '—'] ||= { id, name: catOf(s, id) ? `${catOf(s, id).icon ? catOf(s, id).icon + ' ' : ''}${catOf(s, id).name}` : 'No category', color: catOf(s, id)?.color || '#9aa0a6', plan: 0, act: 0, slips: 0, sessions: 0, over: 0 });
  for (const r of rs) {
    const wk = T.startOfWeek(T.dayKey(r.t, s.tz), s.weekStart);
    const w = (sum.weeks[wk] ||= { done: 0, partial: 0, slipped: 0 });
    const c = catRow(r.cat);
    if (r.kind === 'done' || r.kind === 'partial') {
      sum[r.kind]++; w[r.kind]++;
      sum.planMin += r.plan; sum.actMin += r.act; sum.workMin += r.work;
      c.plan += r.plan; c.act += r.act; c.sessions++;
      if (r.act > r.plan + 5) { c.over += r.act - r.plan; sum.overrun++; }
    } else if (r.kind === 'overrun') {
      // counted with the session itself
    } else {
      sum[r.kind] = (sum[r.kind] || 0) + 1; w.slipped++; c.slips++;
      if (r.kind !== 'moved') { c.plan += r.plan || 0; sum.planMin += r.plan || 0; }
    }
  }
  const scheduled = sum.done + sum.partial + sum.skipped + sum.undone;
  sum.completion = scheduled ? Math.round((sum.done / scheduled) * 100) : null;
  sum.slipped = sum.skipped + sum.undone + sum.moved;
  sum.records = rs;
  return sum;
}

const h = (m) => T.fmtDur(Math.round(m));

export function renderHistory(state, weeks = 8, now = Date.now()) {
  const s = state.settings, z = s.tz;
  const thisWeek = T.startOfWeek(T.dayKey(now, z), s.weekStart);
  const fromK = T.addDays(thisWeek, -7 * (weeks - 1));
  const sum = summarize(state, T.dayStart(fromK, z), T.dayStart(T.addDays(thisWeek, 7), z)); // incl. sessions done early this week
  const wkKeys = Array.from({ length: weeks }, (_, i) => T.addDays(fromK, 7 * i));
  const maxW = Math.max(1, ...wkKeys.map((k) => { const w = sum.weeks[k] || {}; return (w.done || 0) + (w.partial || 0) + (w.slipped || 0); }));
  const cats = Object.values(sum.cats).sort((a, b) => b.plan - a.plan);
  const maxC = Math.max(1, ...cats.map((c) => Math.max(c.plan, c.act)));
  const timedN = sum.records.filter((r) => r.timed).length;
  return `
    <div class="hist">
      <div class="an-tiles">
        <div class="tile"><span>Sessions done as planned</span><b>${sum.completion == null ? '—' : sum.completion + '%'}</b><em>${sum.done} done · ${sum.partial} partly</em></div>
        <div class="tile"><span>Slipped</span><b>${sum.slipped}</b><em>${sum.skipped} deleted · ${sum.undone} undone · ${sum.moved} pushed later</em></div>
        <div class="tile"><span>Planned vs actual</span><b>${h(sum.actMin)} / ${h(sum.planMin)}</b><em>${sum.overrun} session${sum.overrun === 1 ? '' : 's'} ran over</em></div>
      </div>
      <h3 class="an-h">Per week</h3>
      <div class="hist-weeks">${wkKeys.map((k) => {
        const w = sum.weeks[k] || { done: 0, partial: 0, slipped: 0 };
        const bar = (n, cls, label) => n ? `<i class="${cls}" style="height:${(n / maxW) * 100}%" data-tip="${label}: ${n}"></i>` : '';
        return `<div class="hw"><div class="hw-bar">${bar(w.slipped, 'sl', 'Slipped')}${bar(w.partial, 'pa', 'Partly done')}${bar(w.done, 'dn', 'Done')}</div><span>${esc(S.periodLabel(k, 'week').replace('week of ', ''))}</span></div>`;
      }).join('')}</div>
      <div class="hist-legend"><span><i class="dn"></i>Done</span><span><i class="pa"></i>Partly done</span><span><i class="sl"></i>Slipped</span></div>
      <h3 class="an-h">By category — planned vs actual time</h3>
      <table class="an-table hist-table"><thead><tr><th>Category</th><th>Planned</th><th>Actual</th><th></th><th>Ran over</th><th>Slips</th></tr></thead><tbody>
        ${cats.map((c) => `<tr><td><i class="sw-dot" style="background:${esc(c.color)}"></i> ${esc(c.name)}</td><td>${h(c.plan)}</td><td>${h(c.act)}</td>
          <td class="pva"><span class="pl" style="width:${(c.plan / maxC) * 100}%"></span><span class="ac ${c.act > c.plan ? 'over' : ''}" style="width:${(c.act / maxC) * 100}%"></span></td>
          <td>${c.over ? '+' + h(c.over) : '—'}</td><td>${c.slips || '—'}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Nothing recorded yet.</td></tr>'}
      </tbody></table>
      <p class="muted small">Actual time is measured when you use the session timer (${timedN} session${timedN === 1 ? '' : 's'} so far); otherwise a done session counts as planned and a partly done one by its time on the calendar. Sessions in the past count as done unless you mark them undone (Settings → Scheduling).</p>
    </div>`;
}

// ---------- Weekly review ----------
// `events`: calendar event items (as the views draw them) for the review week and the week before (the week before
// is only used to tell how often a repeating event occurs).
export function weeklyReview(state, now = Date.now(), { weekKey = null, events = [] } = {}) {
  const s = state.settings, z = s.tz;
  const thisWeek = T.startOfWeek(T.dayKey(now, z), s.weekStart);
  // On the first days of a week, review the week that just ended.
  const reviewWeek = weekKey || (T.daysBetween(thisWeek, T.dayKey(now, z)) <= 1 ? T.addDays(thisWeek, -7) : thisWeek);
  const weekEnd = T.dayStart(T.addDays(reviewWeek, 7), z);
  const from = T.dayStart(reviewWeek, z), to = Math.min(now, weekEnd);
  const sum = summarize(state, from, to);
  const nextFrom = T.dayStart(reviewWeek >= thisWeek ? T.addDays(reviewWeek, 7) : thisWeek, z), nextTo = nextFrom + 7 * T.DAY;
  const active = state.tasks.filter((t) => !t.archived);
  const completed = state.tasks.filter((t) => !t.repeat && S.progress(t, now).pct >= 100 && (t.frozen || []).some((c) => c.end >= from && c.end < to));
  const inWeek = (e) => (e.allDay ? T.dayStart(e.startKey, z) : e.start) >= from && (e.allDay ? T.dayStart(e.startKey, z) : e.start) < weekEnd;
  const evs = events.filter((e) => e.kind !== 'chunk' && !e.declined);
  // events you ticked off count as finished
  const doneEvents = evs.filter((e) => e.evDone && inWeek(e)).sort((a, b) => a.start - b.start);
  // optionally all events — except ones repeating daily or 3+ times a week
  const freq = {};
  for (const e of evs) if (e.ev?.recurringEventId) { const k = `${e.ev._calId}|${e.ev.recurringEventId}|${T.startOfWeek(T.dayKey(e.start, z), s.weekStart)}`; freq[k] = (freq[k] || 0) + 1; }
  const frequent = (e) => {
    if (!e.ev?.recurringEventId) return false;
    const wk = T.startOfWeek(T.dayKey(e.start, z), s.weekStart);
    const n = (w) => freq[`${e.ev._calId}|${e.ev.recurringEventId}|${w}`] || 0;
    return n(wk) >= 3 || n(T.addDays(wk, -7)) >= 3 || /FREQ=DAILY/.test((e.ev.recurrence || []).join(';'));
  };
  const allEvents = s.reviewAllEvents ? evs.filter((e) => inWeek(e) && !frequent(e)).sort((a, b) => (a.allDay ? T.dayStart(a.startKey, z) : a.start) - (b.allDay ? T.dayStart(b.startKey, z) : b.start)) : [];
  const skippedFrequent = s.reviewAllEvents ? new Set(evs.filter((e) => inWeek(e) && frequent(e)).map((e) => e.ev.recurringEventId)).size : 0;
  // pages read: done reading sessions this week (reported pages, or what the session covered)
  const reading = [];
  for (const t of state.tasks.filter((x) => x.kind === 'reading')) {
    const pph = S.pagesPerHour(t.reading || {});
    let pages = 0, minutes = 0;
    for (const c of t.frozen || []) {
      if (c.status !== 'done' || c.start < from || c.start >= to) continue;
      pages += c.pagesDone != null && c.pagesDone !== '' ? +c.pagesDone : (S.work(c, t) / 60) * pph;
      minutes += (c.end - c.start) / T.MIN;
    }
    if (pages >= 0.5) reading.push({ t, pages: Math.round(pages), minutes: Math.round(minutes), total: t.reading?.pages || null });
  }
  reading.sort((a, b) => b.pages - a.pages);
  const risks = [];
  for (const t of active) {
    const lp = t.lastPlan || {};
    if (lp.shortfall > 0 && !t.repeat) risks.push({ t, why: `not enough time before the deadline (${T.fmtDur(lp.shortfall)} short)` });
    else if (t.repeat && lp.periods?.length) risks.push({ t, why: `not enough free time in ${lp.periods.length} upcoming ${t.repeat.every === 'day' ? 'day' : 'week'}${lp.periods.length > 1 ? 's' : ''}` });
    else if (lp.late > 0) risks.push({ t, why: `eats into its safety margin — finishes ${T.format(lp.finish, z, { weekday: 'short', day: 'numeric', month: 'short' })}` });
    else if (t.deadline >= nextFrom && t.deadline < nextTo && S.progress(t, now).pct < 100) risks.push({ t, why: `due ${T.format(t.deadline, z, { weekday: 'short', day: 'numeric', month: 'short' })}`, soft: true });
  }
  // next week's load per day
  const load = {};
  for (const t of active) for (const c of S.sessions(t)) if (c.start >= nextFrom && c.start < nextTo && c.kind !== 'done') { const k = T.dayKey(c.start, z); load[k] = (load[k] || 0) + c.minutes; }
  const slips = sum.records.filter((r) => ['skipped', 'undone', 'moved'].includes(r.kind));
  return { reviewWeek, from, to, weekEnd, sum, completed, doneEvents, allEvents, skippedFrequent, reading, risks, load, slips, nextFrom, isCurrent: reviewWeek === thisWeek };
}

export function renderReview(state, now = Date.now()) {
  const r = weeklyReview(state, now);
  const s = state.settings, z = s.tz;
  const fmtD = (ms) => T.format(ms, z, { weekday: 'short', day: 'numeric', month: 'short' });
  const days = Array.from({ length: 7 }, (_, i) => T.addDays(T.dayKey(r.nextFrom, z), i));
  const maxL = Math.max(60, ...Object.values(r.load), +s.dailyCapMinutes || 0);
  const kindTxt = { skipped: 'deleted', undone: 'marked undone', moved: 'pushed later' };
  const cats = Object.values(r.sum.cats).filter((c) => c.act || c.plan).sort((a, b) => b.act - a.act);
  return `
    <div class="review">
      <section><h3>${r.to >= now ? 'This week so far' : 'Last week'} <span class="muted small">${esc(fmtD(r.from))} – ${esc(fmtD(r.to - 1))}</span></h3>
        <div class="an-tiles">
          <div class="tile"><span>Done</span><b>${r.sum.done + r.sum.partial}</b><em>${r.sum.partial} partly · ${T.fmtDur(Math.round(r.sum.actMin))} spent</em></div>
          <div class="tile"><span>Slipped</span><b>${r.sum.slipped}</b><em>${r.sum.skipped} deleted · ${r.sum.undone} undone · ${r.sum.moved} pushed</em></div>
          <div class="tile"><span>Tasks finished</span><b>${r.completed.length + r.doneEvents.length}</b><em>${esc([...r.completed.map((t) => t.title), ...r.doneEvents.map((e) => e.title)].slice(0, 3).join(', ')) || '—'}</em></div>
        </div>
        ${cats.length ? `<div class="rv-cats">${cats.map((c) => `<span class="rv-cat"><i class="sw-dot" style="background:${esc(c.color)}"></i>${esc(c.name)} <b>${T.fmtDur(Math.round(c.act))}</b>${c.plan && Math.abs(c.act - c.plan) > 10 ? ` <em class="muted">of ${T.fmtDur(Math.round(c.plan))}</em>` : ''}</span>`).join('')}</div>` : ''}
        ${r.slips.length ? `<details class="rv-slips"><summary>What slipped (${r.slips.length})</summary><ul>${r.slips.slice(-12).map((x) => `<li>${esc(x.title || 'Session')} — ${kindTxt[x.kind]}${x.by ? ` by ${T.fmtDur(x.by)}` : ''} <span class="muted small">${esc(fmtD(x.t))}</span></li>`).join('')}</ul></details>` : '<p class="muted small">Nothing slipped. 🎉</p>'}
      </section>
      <section><h3>At risk next week</h3>
        ${r.risks.length ? `<ul class="rv-risks">${r.risks.map((x) => `<li class="${x.soft ? '' : 'bad'}"><b>${esc(x.t.title)}</b> — ${esc(x.why)} <button class="link rv-open" data-task="${esc(x.t.id)}">Open</button></li>`).join('')}</ul>` : '<p class="muted small">Nothing looks at risk. ✓</p>'}
        <div class="rv-load">${days.map((k) => { const m = r.load[k] || 0; return `<div class="rl"><div class="rl-bar"><i style="height:${(m / maxL) * 100}%" class="${s.dailyCapMinutes && m > s.dailyCapMinutes ? 'over' : ''}" data-tip="${T.fmtDur(m)} of task time"></i></div><span>${esc(T.format(T.dayStart(k, z), z, { weekday: 'short' }))}</span><em>${m ? T.fmtDur(m) : ''}</em></div>`; }).join('')}</div>
        <p class="muted small">Task time planned per day next week${s.dailyCapMinutes ? ` (cap ${T.fmtDur(s.dailyCapMinutes)})` : ''}.</p>
      </section>
    </div>`;
}
