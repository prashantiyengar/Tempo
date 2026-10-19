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
