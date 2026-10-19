import * as S from '../src/js/scheduler.js';
import * as T from '../src/js/tz.js';
import { expand } from '../src/js/rrule.js';
import assert from 'node:assert/strict';

const tz = 'Europe/Berlin';
const settings = { ...S.DEFAULT_SETTINGS, tz };
const now = T.atTime('2026-10-19', '08:00', tz); // Monday
const f = (ms) => T.toDTInput(ms, tz).replace('T', ' ');

// 1. Reading task: 200 pages from p.47 at 20 pages/hour -> 10 one-hour sessions
const book = { id: 'b', title: 'Pride and Prejudice', kind: 'reading', rank: 3,
  reading: { pages: 200, startPage: 47, speed: 20, unit: 'pph' }, deadline: T.atTime('2026-10-30', '17:00', tz), created: 1 };
let { tasks, problems } = S.rescheduleAll([book], [], settings, now);
let ss = S.sessions(tasks[0]);
assert.equal(ss.length, 10);
assert.equal(ss[0].label, 'Pride and Prejudice page 47-66, task 1/10');
assert.equal(ss[9].label, 'Pride and Prejudice page 227-246, task 10/10');
console.log('reading:', ss.map((s) => `${f(s.start)} ${s.label}`).join('\n  '));

// 2. Busy meeting is avoided; day bounds respected
const busy = [{ start: T.atTime('2026-10-19', '10:00', tz), end: T.atTime('2026-10-19', '11:30', tz) }];
({ tasks } = S.rescheduleAll([book], busy, settings, now));
ss = S.sessions(tasks[0]);
for (const s of ss) {
  assert.ok(!(s.start < busy[0].end && s.end > busy[0].start), 'overlaps meeting');
  const m0 = T.minutesOfDay(s.start, tz), m1 = T.minutesOfDay(s.end, tz) || 1440;
  assert.ok(m0 >= 540 && m1 <= 1020, 'outside bounds ' + f(s.start));
}
console.log('with meeting first day:', ss.filter((s) => T.dayKey(s.start, tz) === '2026-10-19').map((s) => f(s.start) + '–' + T.toDTInput(s.end, tz).slice(11)).join(', '));

// 3. Rank: rank-2 task displaces rank-3 task from earliest slots
const urgent = { id: 'u', title: 'Report', kind: 'generic', rank: 2, totalMinutes: 300, deadline: T.atTime('2026-10-20', '17:00', tz), created: 2 };
({ tasks, problems } = S.rescheduleAll([book, urgent], [], settings, now));
const sU = S.sessions(tasks.find((t) => t.id === 'u'));
const sB = S.sessions(tasks.find((t) => t.id === 'b'));
assert.equal(f(sU[0].start), '2026-10-19 09:00');
assert.ok(sB[0].start >= sU[sU.length - 1].end, 'book should come after report');
console.log('rank: report', f(sU[0].start), '→', f(sU.at(-1).end), '; book starts', f(sB[0].start));

// 4. Infeasible -> shortfall + suggested deadline + ignore-bounds check
const tight = { id: 't', title: 'Thesis', kind: 'generic', rank: 1, totalMinutes: 600, deadline: T.atTime('2026-10-19', '20:00', tz), created: 3 };
({ tasks, problems } = S.rescheduleAll([tight], [], settings, now));
assert.equal(problems.length, 1);
console.log('infeasible:', problems[0].shortfall, 'min short; suggested', f(problems[0].suggestedDeadline), 'fitsIgnoringBounds', problems[0].fitsIgnoringBounds);
assert.equal(problems[0].shortfall, 155); // 7 one-hour sessions + 25 min (5-min breaks) inside 9–17 assert.equal(problems[0].fitsIgnoringBounds, true);
const tight2 = { ...tight, ignoreBounds: true };
({ problems } = S.rescheduleAll([tight2], [], settings, now));
assert.equal(problems.length, 0, 'ignoring bounds 7-23 should fit 10h');

// 5. Skip a session -> work shifts later, still 10 sessions; undone -> re-added
({ tasks } = S.rescheduleAll([book], [], settings, now));
let t = tasks[0];
const second = t.planned[1];
t = S.skipSession(t, second.id);
({ tasks } = S.rescheduleAll([t], [], settings, now));
ss = S.sessions(tasks[0]);
assert.equal(ss.length, 10);
assert.ok(!ss.some((s) => s.start === second.start), 'skipped slot reused');
console.log('after skip, session 2 at', f(ss[1].start), '(was', f(second.start) + ')');

// 6. Time passes -> past sessions frozen as done; mark one undone -> rescheduled
const later = T.atTime('2026-10-19', '12:00', tz);
({ tasks } = S.rescheduleAll(tasks, [], settings, later));
t = tasks[0];
assert.equal(t.frozen.filter((c) => c.status === 'done').length, 2);
const undone = t.frozen[0];
t = S.markUndone(t, undone.id);
({ tasks } = S.rescheduleAll([t], [], settings, later));
ss = S.sessions(tasks[0]);
assert.equal(ss.filter((s) => s.kind === 'done').length, 1);
assert.equal(ss.length, 10);
console.log('after undone: done', ss.filter((s) => s.kind === 'done').length, 'planned', ss.filter((s) => s.kind === 'planned').length, 'next at', f(ss.find((s) => s.kind === 'planned').start));

// 7. maxPerDay, chunk size
const daily = { id: 'd', title: 'Course', kind: 'generic', rank: 4, totalMinutes: 240, chunkMinutes: 45, maxPerDayMinutes: 90, deadline: T.atTime('2026-11-10', '17:00', tz), created: 4 };
({ tasks } = S.rescheduleAll([daily], [], settings, now));
ss = S.sessions(tasks[0]);
const per = {};
for (const s of ss) per[T.dayKey(s.start, tz)] = (per[T.dayKey(s.start, tz)] || 0) + s.minutes;
assert.ok(Object.values(per).every((v) => v <= 90));
assert.equal(ss.reduce((a, s) => a + s.minutes, 0), 240);
console.log('maxPerDay:', JSON.stringify(per));

// 8. rrule expansion
const occ = expand({ rule: ['RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=4'], startMs: T.atTime('2026-10-30', '15:00', tz), tz }, now, now + 400 * T.DAY, tz);
assert.deepEqual(occ.map((o) => T.dayKey(o, tz)), ['2026-10-30', '2026-11-27', '2026-12-25', '2027-01-29']);
const wk = expand({ rule: ['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH'], startMs: T.atTime('2026-10-19', '09:00', tz), tz }, now, T.atTime('2026-11-06', '00:00', tz), tz);
assert.deepEqual(wk.map((o) => T.dayKey(o, tz)), ['2026-10-19', '2026-10-22', '2026-11-02', '2026-11-05']);
// DST: 9:00 Berlin stays 9:00 across Oct 25 change
const daily9 = expand({ rule: ['RRULE:FREQ=DAILY;COUNT=10'], startMs: T.atTime('2026-10-22', '09:00', tz), tz }, now, now + 30 * T.DAY, tz);
assert.ok(daily9.every((o) => T.minutesOfDay(o, tz) === 540));
console.log('all scheduler tests passed');

// 9. analysis compute
import * as A from '../src/js/analysis.js';
{
  const from = T.atTime('2026-10-19', '00:00', tz), to = T.atTime('2026-10-21', '00:00', tz);
  const wins = A.scopeWindows('bounds', from, to, settings); // 2 days × 8h
  const items = [
    { start: T.atTime('2026-10-19', '10:00', tz), end: T.atTime('2026-10-19', '12:00', tz), group: 'a', prio: 0 },
    { start: T.atTime('2026-10-19', '11:00', tz), end: T.atTime('2026-10-19', '13:00', tz), group: 'b', prio: 1 }, // overlaps 1h
    { start: T.atTime('2026-10-20', '16:00', tz), end: T.atTime('2026-10-20', '19:00', tz), group: 'a', prio: 0 }, // 1h inside bounds
  ];
  const r = A.compute(items, wins, tz);
  assert.equal(r.totals.available, 960);
  assert.equal(r.totals.groups.a, 180);
  assert.equal(r.totals.groups.b, 60);
  assert.equal(r.totals.free, 720);
  const out = A.compute(items, A.scopeWindows('outside', from, to, settings), tz);
  assert.equal(out.totals.groups.a, 120); // 17-19 on Tue
  assert.equal(out.totals.available, 2 * 8 * 60); // 07-09 + 17-23 each day
  console.log('analysis tests passed');
}

// 10. New defaults: 5-min breaks between ALL task sessions; full-length sessions preferred, 15-min ones only when needed
{
  const s2 = { ...S.DEFAULT_SETTINGS, tz };
  assert.equal(s2.breakMinutes, 5); assert.equal(s2.minChunkMinutes, 15);
  const bk = { id: 'b', title: 'Book', kind: 'reading', rank: 3, reading: { pages: 200, startPage: 47, speed: 20, unit: 'pph' }, deadline: T.atTime('2026-10-30', '17:00', tz), created: 1 };
  const rp = { id: 'u', title: 'Report', kind: 'generic', rank: 2, totalMinutes: 120, deadline: T.atTime('2026-10-20', '17:00', tz), created: 2 };
  let { tasks } = S.rescheduleAll([bk, rp], [], s2, now);
  const ss = tasks.flatMap((t) => S.sessions(t)).sort((a, b) => a.start - b.start);
  for (let i = 1; i < ss.length; i++) if (T.dayKey(ss[i].start, tz) === T.dayKey(ss[i - 1].start, tz)) assert.ok(ss[i].start - ss[i - 1].end >= 5 * T.MIN, 'break between sessions');
  assert.ok(S.sessions(tasks[0]).every((c) => c.minutes === 60), 'book uses full hours when there is time');
  // tight: 3h due today 12:00 -> must use shorter sessions to fit (9:00-10:00, 10:05-11:05, 11:10-12:00 = 50)
  const tight = { id: 'x', title: 'Tight', kind: 'generic', rank: 1, totalMinutes: 170, deadline: T.atTime('2026-10-19', '12:00', tz), created: 3 };
  ({ tasks } = S.rescheduleAll([tight], [], s2, now));
  const st = S.sessions(tasks[0]);
  assert.deepEqual(st.map((c) => c.minutes), [60, 60, 50]);
  console.log('defaults: breaks ok; tight task sessions', st.map((c) => c.minutes));
}

// 11. Waive a done session (delete without redoing): pages of later sessions unchanged, not counted as a session
{
  const s2 = { ...S.DEFAULT_SETTINGS, tz };
  const bk = { id: 'b', title: 'Book', kind: 'reading', rank: 3, reading: { pages: 200, startPage: 47, speed: 20, unit: 'pph' }, deadline: T.atTime('2026-10-30', '17:00', tz), created: 1 };
  let { tasks } = S.rescheduleAll([bk], [], s2, now);
  const later = T.atTime('2026-10-19', '11:30', tz);
  ({ tasks } = S.rescheduleAll(tasks, [], s2, later));   // first 2 sessions now done
  let t = tasks[0];
  const first = t.frozen[0];
  const before = S.sessions(t).map((c) => c.label);
  t = S.waiveSession(t, first.id);
  ({ tasks } = S.rescheduleAll([t], [], s2, later));
  const after = S.sessions(tasks[0]);
  assert.equal(after.length, 9);
  assert.equal(after[0].label, 'Book page 67-86, task 1/9');
  assert.equal(S.progress(tasks[0], later).done, 180); // 3 sessions started by 11:30, one of them waived — all count as covered
  // undone instead -> work returns and gets rescheduled (10 sessions again)
  console.log('waive ok:', before[1], '->', after[0].label);
  // addDoneBlock credits another task
  const g = S.addDoneBlock({ id: 'g', title: 'G', kind: 'generic', totalMinutes: 120, deadline: T.atTime('2026-10-23', '17:00', tz), frozen: [], planned: [] }, T.atTime('2026-10-19', '09:00', tz), T.atTime('2026-10-19', '10:00', tz));
  assert.equal(S.progress(g, later).done, 60);
}
console.log('new tests passed');

// 12. Smart allocation: a 48-min gap is used for 60-min sessions with 15 min wiggle room; a 40-min gap is not
{
  const s2 = { ...S.DEFAULT_SETTINGS, tz };
  assert.equal(s2.wiggleMinutes, 15);
  const meetings = [
    { start: T.atTime('2026-10-19', '09:00', tz), end: T.atTime('2026-10-19', '10:00', tz) },
    { start: T.atTime('2026-10-19', '10:48', tz), end: T.atTime('2026-10-19', '12:00', tz) },   // gap 10:00–10:48
    { start: T.atTime('2026-10-19', '12:40', tz), end: T.atTime('2026-10-19', '17:00', tz) },   // gap 12:00–12:40
  ];
  const t = { id: 'w', title: 'Writing', kind: 'generic', rank: 1, totalMinutes: 180, deadline: T.atTime('2026-10-23', '17:00', tz), created: 1 };
  let { tasks } = S.rescheduleAll([t], meetings, s2, now);
  const ss = S.sessions(tasks[0]).map((c) => `${T.toDTInput(c.start, tz).slice(5)} ${c.minutes}m`);
  assert.equal(ss[0], '10-19T10:00 48m');
  assert.ok(!ss.some((x) => x.startsWith('10-19T12:00')), '40-min gap must not be used');
  // wiggle 0 -> only full hours
  ({ tasks } = S.rescheduleAll([{ ...t, wiggleMinutes: 0 }], meetings, s2, now));
  assert.ok(S.sessions(tasks[0]).every((c) => c.minutes === 60));
  assert.ok(!S.sessions(S.rescheduleAll([t], meetings, s2, now).tasks[0]).some((c) => c.minutes < 15), 'no tiny leftover session');
  console.log('smart allocation:', ss.join(', '));
}

// 13. Named period "After hours" with per-day rules (Mon, Wed, Thu evenings only)
{
  const s2 = { ...S.DEFAULT_SETTINGS, tz, periods: [{ id: 'ah', name: 'After hours', rules: [{ days: [1, 3, 4], start: '18:00', end: '21:00' }] }] };
  const t = { id: 'p', title: 'Side project', kind: 'generic', rank: 3, totalMinutes: 360, periodId: 'ah', deadline: T.atTime('2026-10-31', '23:00', tz), created: 1 };
  const { tasks } = S.rescheduleAll([t], [], s2, now);
  const ss = S.sessions(tasks[0]);
  for (const c of ss) {
    const wd = T.weekday(T.dayKey(c.start, tz)); const m0 = T.minutesOfDay(c.start, tz), m1 = T.minutesOfDay(c.end, tz);
    assert.ok([1, 3, 4].includes(wd) && m0 >= 18 * 60 && m1 <= 21 * 60, 'outside after-hours: ' + T.toDTInput(c.start, tz));
  }
  // falls back to the snapshot on a device that doesn't have the period
  const { tasks: t2 } = S.rescheduleAll([{ ...t, periodRules: s2.periods[0].rules }], [], { ...s2, periods: [] }, now);
  assert.equal(S.sessions(t2[0])[0].start, ss[0].start);
  console.log('periods:', ss.map((c) => T.toDTInput(c.start, tz).slice(5)).join(', '));
}

// 14. Partly done reading session: 7 of 15 pages, 20-min call at the start of the hour
{
  const s2 = { ...S.DEFAULT_SETTINGS, tz };
  const t = { id: 'b', title: 'Pride and Prejudice', kind: 'reading', rank: 1, reading: { pages: 90, startPage: 47, speed: 15, unit: 'pph', labels: 'actual' }, deadline: T.atTime('2026-10-30', '17:00', tz), created: 1 };
  let { tasks } = S.rescheduleAll([t], [], s2, now);
  const before = S.sessions(tasks[0]);
  assert.equal(before.length, 6);
  assert.match(before[0].label, /page 47-61, task 1\/6$/);
  const first = before[0];
  const mk = (squeeze) => S.markPartial(tasks[0], first.id, { credit: S.minutesForPages(tasks[0], 7), start: first.start + 20 * T.MIN, end: first.end, squeeze });
  // a) add time for the rest
  const ext = S.rescheduleAll([mk(false)], [], s2, now).tasks[0];
  const se = S.sessions(ext);
  assert.match(se[0].label, /page 47-53, task 1\/\d+ \(partly done\)$/);
  assert.equal(se[0].minutes, 40);
  assert.match(se[1].label, /page 54-/);
  assert.equal(Math.round(se.slice(1).reduce((a, c) => a + c.minutes, 0)), 360 - 28);
  assert.equal(S.progress(ext).done, 28);
  // b) squeeze into the existing slots: same number of sessions, same times, more pages each
  const sq = S.rescheduleAll([mk(true)], [], s2, now).tasks[0];
  const ss = S.sessions(sq);
  assert.equal(ss.length, 6);
  assert.deepEqual(ss.slice(1).map((c) => c.start), before.slice(1).map((c) => c.start));
  assert.match(ss[ss.length - 1].label, /page \d+-136, task 6\/6$/);
  assert.match(ss[1].label, /page 54-/);
  console.log('partial:', se.map((c) => c.label.replace('Pride and Prejudice ', '')).join(' | '), '||', ss.map((c) => c.label.replace('Pride and Prejudice ', '')).join(' | '));
}

// 15. Repeating tasks
{
  const s2 = { ...S.DEFAULT_SETTINGS, tz };
  const wk = { id: 'r1', title: 'Exercise', kind: 'generic', rank: 2, repeat: { every: 'week', minutes: 180, count: 3 }, repeatStart: now, created: now, deadline: 0 };
  let { tasks } = S.rescheduleAll([wk], [], s2, now);
  const ss = S.sessions(tasks[0]);
  const byWeek = {};
  for (const c of ss) byWeek[c.pk] = (byWeek[c.pk] || 0) + c.minutes;
  assert.deepEqual(Object.values(byWeek), [180, 180, 180], 'three weeks of 3h: ' + JSON.stringify(byWeek));
  assert.match(ss[0].label, /^Exercise · week of 19 Oct 1\/3$/);
  const daily = { id: 'r2', title: 'Read', kind: 'generic', rank: 2, repeat: { every: 'day', minutes: 30, until: T.atTime('2026-10-25', '12:00', tz), days: [1, 2, 3, 4, 5] }, repeatStart: now, created: now };
  ({ tasks } = S.rescheduleAll([daily], [], s2, now));
  const ds = S.sessions(tasks[0]);
  assert.equal(ds.length, 5, 'weekdays Mon–Fri only');
  assert.ok(ds.every((c) => c.minutes === 30));
  assert.match(ds[0].label, /^Read · Mon 19 Oct$/);
  // mark one done, re-plan: that day's session stays done, others keep their ids
  const ids = ds.map((c) => c.id);
  const d2 = S.rescheduleAll([S.markDone(tasks[0], ids[1])], [], s2, now).tasks[0];
  assert.deepEqual(S.sessions(d2).map((c) => c.id), ids);
  console.log('repeat:', ss.map((c) => c.label).slice(0, 4).join(' | '), '||', ds.map((c) => c.label).join(' | '));
}

// 16. Category time preference, daily cap, safety margin
{
  const s2 = { ...S.DEFAULT_SETTINGS, tz, bounds: { start: '08:00', end: '20:00', days: [1, 2, 3, 4, 5] },
    categories: [{ id: 'st', name: 'Study', color: '#8e24aa', prefer: 'morning' }, { id: 'le', name: 'Leisure', color: '#f6bf26', prefer: 'evening' }] };
  const st = { id: 'a', title: 'Study', kind: 'generic', rank: 1, totalMinutes: 240, categoryId: 'st', deadline: T.atTime('2026-10-23', '20:00', tz), created: 1 };
  const le = { id: 'b', title: 'Guitar', kind: 'generic', rank: 2, totalMinutes: 120, categoryId: 'le', deadline: T.atTime('2026-10-23', '20:00', tz), created: 2 };
  const { tasks } = S.rescheduleAll([st, le], [], s2, now);
  for (const c of S.sessions(tasks[0])) assert.ok(T.minutesOfDay(c.start, tz) < 12 * 60, 'study in the morning ' + f(c.start));
  for (const c of S.sessions(tasks[1])) assert.ok(T.minutesOfDay(c.start, tz) >= 17 * 60, 'guitar in the evening ' + f(c.start));
  // daily cap 2h across both tasks
  const capped = S.rescheduleAll([st, le], [], { ...s2, dailyCapMinutes: 120 }, now).tasks;
  const perDay = {};
  for (const t of capped) for (const c of S.sessions(t)) { const k = T.dayKey(c.start, tz); perDay[k] = (perDay[k] || 0) + c.minutes; }
  assert.ok(Object.values(perDay).every((m) => m <= 120), 'cap: ' + JSON.stringify(perDay));
  // margin: 2 days early; a big task that runs into the margin is flagged late, not a problem
  const big = { id: 'c', title: 'Report', kind: 'generic', rank: 1, totalMinutes: 60 * 40, marginDays: 2, deadline: T.atTime('2026-10-23', '20:00', tz), created: 1 };
  const r = S.rescheduleAll([big], [], s2, now);
  assert.equal(r.problems.length, 0);
  assert.ok(r.tasks[0].lastPlan.late > 0, 'some sessions inside the safety margin');
  const small = S.rescheduleAll([{ ...big, totalMinutes: 300 }], [], s2, now).tasks[0];
  assert.equal(small.lastPlan.late, 0);
  console.log('prefs/cap/margin ok:', JSON.stringify(perDay), 'late', r.tasks[0].lastPlan.late);
}

// 17. Prerequisites and projects with ordered steps; rank inheritance
{
  const s2 = { ...S.DEFAULT_SETTINGS, tz, projects: [{ id: 'p1', name: 'Thesis', sequential: true }] };
  const dl = T.atTime('2026-10-30', '17:00', tz);
  const A = { id: 'A', title: 'Outline', kind: 'generic', rank: 5, totalMinutes: 120, deadline: dl, created: 1, projectId: 'p1', projectStep: 1 };
  const B = { id: 'B', title: 'Draft', kind: 'generic', rank: 1, totalMinutes: 180, deadline: dl, created: 2, projectId: 'p1', projectStep: 2 };
  const X = { id: 'X', title: 'Other', kind: 'generic', rank: 3, totalMinutes: 240, deadline: dl, created: 3 };
  const C2 = { id: 'C', title: 'Polish', kind: 'generic', rank: 2, totalMinutes: 60, deadline: dl, created: 4, after: ['X'] };
  const { tasks } = S.rescheduleAll([A, B, X, C2], [], s2, now);
  const get = (id) => S.sessions(tasks.find((t) => t.id === id));
  const end = (id) => Math.max(...get(id).map((c) => c.end)), start = (id) => Math.min(...get(id).map((c) => c.start));
  assert.ok(start('B') >= end('A'), 'Draft after Outline');
  assert.ok(start('C') >= end('X'), 'Polish after Other');
  assert.ok(start('A') < start('X'), 'Outline inherits Draft’s rank 1 and goes before rank-3 Other');
  console.log('deps ok: A', f(start('A')), 'B', f(start('B')), 'X', f(start('X')), 'C', f(start('C')));
}

// 18. What moved: a new rank-1 task pushes a rank-3 task later
{
  const s2 = { ...S.DEFAULT_SETTINGS, tz };
  const dl = T.atTime('2026-10-30', '17:00', tz);
  const low = { id: 'L', title: 'Low', kind: 'generic', rank: 3, totalMinutes: 120, deadline: dl, created: 1 };
  const r1 = S.rescheduleAll([low], [], s2, now);
  const top = { id: 'H', title: 'High', kind: 'generic', rank: 1, totalMinutes: 180, deadline: dl, created: 2 };
  const r2 = S.rescheduleAll([...r1.tasks, top], [], s2, now);
  assert.equal(r2.moves.length, 1);
  assert.equal(r2.moves[0].taskId, 'L');
  console.log('moves:', r2.moves.map((m) => `${m.title} next ${f(m.nextFrom)} -> ${f(m.nextTo)}`).join(', '));
}

// 19. Changing reading speed keeps pages already read
{
  const s2 = { ...S.DEFAULT_SETTINGS, tz };
  const t = { id: 'bk', title: 'Book', kind: 'reading', rank: 1, reading: { pages: 60, startPage: 1, speed: 15, unit: 'pph', labels: 'actual' }, deadline: T.atTime('2026-10-30', '17:00', tz), created: 1 };
  let x = S.rescheduleAll([t], [], s2, now).tasks[0];
  x = S.markDone(x, S.sessions(x)[0].id);
  assert.match(S.sessions(x)[1].label, /page 16-30/);
  x = S.withReadingSpeed(x, { ...x.reading, speed: 10 });
  x = S.rescheduleAll([x], [], s2, now).tasks[0];
  const ss = S.sessions(x);
  assert.match(ss[0].label, /page 1-15/);
  assert.match(ss[1].label, /page 16-/);
  assert.equal(Math.round(ss.slice(1).reduce((a, c) => a + c.minutes, 0)), 270, '45 pages at 10/h');
  assert.equal(S.learnedSpeed({ speedLog: [{ pages: 5, minutes: 30 }, { pages: 6, minutes: 30 }] }), 11.1);
  console.log('speed change ok:', ss.map((c) => c.label.replace('Book ', '')).join(' | '));
}

// 20. ICS parsing (calendar links / iCloud): time zones, all-day, weekly repeats with an exception
{
  const AC = await import('../src/js/accounts.js');
  const ics = `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a1\r\nSUMMARY:Choir\r\nLOCATION:St. Mary's Hall\r\nDTSTART;TZID=Europe/Berlin:20261020T190000\r\nDTEND;TZID=Europe/Berlin:20261020T203000\r\nRRULE:FREQ=WEEKLY;COUNT=4\r\nEXDATE;TZID=Europe/Berlin:20261027T190000\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:a2\r\nSUMMARY:Holiday\r\nDTSTART;VALUE=DATE:20261023\r\nDTEND;VALUE=DATE:20261024\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:a3\r\nSUMMARY:Call with a very long\r\n  title\r\nDTSTART:20261021T080000Z\r\nDURATION:PT45M\r\nEND:VEVENT\r\nEND:VCALENDAR`;
  const evs = AC.icsToEvents(ics, { id: 'acc', type: 'ics' }, { id: 'ics' }, T.atTime('2026-10-19', '00:00', tz), T.atTime('2026-11-30', '00:00', tz), tz);
  const choir = evs.filter((e) => e.summary === 'Choir').map((e) => T.toDTInput(Date.parse(e.start.dateTime), tz));
  assert.deepEqual(choir, ['2026-10-20T19:00', '2026-11-03T19:00', '2026-11-10T19:00']);
  assert.equal(evs.find((e) => e.summary === 'Holiday').start.date, '2026-10-23');
  const call = evs.find((e) => e.summary.startsWith('Call'));
  assert.equal(call.summary, 'Call with a very long title');
  assert.equal(Date.parse(call.end.dateTime) - Date.parse(call.start.dateTime), 45 * 60000);
  console.log('ics ok:', choir.join(', '));
}

// 21. Analysis: a 5-min gap between back-to-back blocks is not free time
{
  const A = await import('../src/js/analysis.js');
  const at = (hm) => T.atTime('2026-10-19', hm, tz);
  const items = [{ start: at('09:00'), end: at('10:00'), group: 'g', prio: 0, title: 'A' }, { start: at('10:05'), end: at('11:00'), group: 'g', prio: 0, title: 'B' }];
  const d = A.compute(items, [{ start: at('09:00'), end: at('12:00') }], tz);
  assert.equal(d.totals.gaps, 5);
  assert.equal(d.totals.free, 60);
  const d2 = A.compute([items[0], { ...items[1], start: at('10:30') }], [{ start: at('09:00'), end: at('12:00') }], tz);
  assert.equal(d2.totals.gaps, 0, 'a 30-min gap is free time');
  console.log('gaps ok');
}
