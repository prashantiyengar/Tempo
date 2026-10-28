// Fast checks of the pure logic (no browser): node test/unit.test.js
import * as I from '../src/js/items.js';
import * as T from '../src/js/tz.js';
import * as E from '../src/js/engine.js';
import * as GM from '../src/js/game.js';
import * as GL from '../src/js/goals.js';

let fails = 0;
const eq = (label, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`); };

// items: matching and time
const s = { categories: [{ id: 'work' }, { id: 'meet', parent: 'work' }, { id: 'fit' }] };
const it = (title, catId, x = {}) => ({ kind: 'event', title, catId, start: 0, end: 60000, ...x });
const m = I.itemMatcher({ cats: ['work'], words: ['run'] }, s);
eq('matcher: word at the start of a word', [m(it('Morning run')), m(it('Running club')), m(it('Brunch'))], [true, true, false]);
eq('matcher: a main category counts its sub-categories', [m(it('x', 'meet')), m(it('x', 'fit'))], [true, false]);
eq('matcher: declined and waived never match', [m(it('run', null, { declined: true })), m({ kind: 'chunk', title: 'run', task: { title: 'run' }, status: 'waived', start: 0, end: 1 })], [false, false]);
eq('matcher: "both" needs the category and a word', I.itemMatcher({ cats: ['fit'], words: ['run'], mode: 'both' }, s)(it('Evening run', 'work')), false);
eq('matcher: accents and case are ignored', I.wordMatcher(['cafe'])('Café Central'), true);
eq('takesTime: free / all-day / normal', [I.takesTime(it('a', null, { ev: { transparency: 'transparent' } })), I.takesTime(it('a', null, { allDay: true })), I.takesTime(it('a', null, { allDay: true }), { allDay: true }), I.takesTime(it('a'))], [false, false, true, true]);
eq('unionLength counts overlaps once', I.unionLength([[0, 10], [5, 15], [20, 25]]), 20);
eq('mergePairs', I.mergePairs([[5, 8], [0, 6], [10, 12]]), [[0, 8], [10, 12]]);

// time zones: cached offsets agree with Intl, including DST changes and odd offsets
const F = (z) => new Intl.DateTimeFormat('en-US', { timeZone: z, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
let bad = 0;
for (const z of ['Europe/Berlin', 'America/New_York', 'Asia/Kathmandu', 'Australia/Lord_Howe', 'America/St_Johns']) {
  const f = F(z);
  for (let ms = Date.UTC(2026, 0, 1); ms < Date.UTC(2027, 0, 1); ms += 37 * 60000) {
    const o = {}; for (const p of f.formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = +p.value; if (o.hour === 24) o.hour = 0;
    const p = T.partsOf(ms, z);
    if (p.y !== o.year || p.m !== o.month || p.d !== o.day || p.h !== o.hour || p.mi !== o.minute) bad++;
  }
}
eq('tz: cached offsets match Intl all year in 5 zones', bad, 0);
eq('tz: wall-clock round trip on a DST day', T.minutesOfDay(T.atTime('2026-03-29', '03:30', 'Europe/Berlin'), 'Europe/Berlin'), 210);

// shared settings in parts
const big = { notes: Array.from({ length: 300 }, (_, i) => ({ id: 'n' + i, text: 'x'.repeat(200) })) };
const parts = E.encodeParts(big, 7);
const asEvents = (ps) => ps.map((p) => ({ extendedProperties: { private: p } }));
eq('settings parts: each within 32 KB', parts.every((p) => Object.entries(p).reduce((t, [k, v]) => t + k.length + v.length, 0) <= 32000), true);
eq('settings parts: round trip', E.decodeParts(asEvents(parts))?.obj.notes.length, 300);
eq('settings parts: an incomplete newer version is skipped', E.decodeParts([...asEvents(parts), ...asEvents(E.encodeParts(big, 9)).slice(0, 1)])?.rev, 7);

// game: one reschedule penalty a day per task; life steps
const at = (h) => Date.parse(`2026-10-26T${h}:00+01:00`);
const hist = [{ kind: 'resched', taskId: 'a', at: at('09') }, { kind: 'moved', taskId: 'a', at: at('10') }, { kind: 'resched', evId: 'e', title: 'Dentist', at: at('11') }];
eq('penalties: once per task / event per day', GL && GM.penaltiesOn(hist, at('00'), at('23'), 'Europe/Berlin').map((h) => [h.taskId || h.evId, h.times]), [['a', 2], ['e', 1]]);

console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exitCode = fails ? 1 : 0;
