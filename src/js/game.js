// Game mode: experience points (XP) and levels 1–300.
//   App XP (blue)    — using Tempo: opening it each day (with a streak bonus), scheduling things, logging habits
//   Busy XP (orange) — getting things done: events attended, task sessions done (later sessions of a task are
//                      worth more), tasks and projects finished, full days, keeping to the plan, weekly fill bonus
//   Life XP (green)  — time in "life growth" categories you choose (reading, exercise…), sleep, leisure, habits, goals
// Scheduling earns a little; completing earns most. Rescheduling costs XP, more each time the same task slips.
// Past days are settled once into a ledger (settings.game.ledger, synced); today is worked out live.
import * as T from './tz.js';

// ---------- settings you can adjust (Settings → Game mode → Advanced) ----------
// [key, label, default, min, max, step]
export const CFG = [
  ['pace', 'Level pace — XP needed per level (×)', 1, 0.25, 4, 0.05],
  ['eventPerHour', 'Busy XP per hour of events', 24, 0, 200, 1],
  ['sessionPerHour', 'Busy XP per hour of task sessions', 30, 0, 200, 1],
  ['lifePerHour', 'Life XP per hour in life-growth categories', 30, 0, 200, 1],
  ['crossShare', 'Busy XP that life-growth and leisure items also earn (% of normal)', 15, 0, 100, 1],
  ['sleepPerHour', 'Life XP per hour of sleep', 2, 0, 50, 0.5],
  ['leisurePerHour', 'Life XP per hour of leisure', 6, 0, 100, 1],
  ['stageBonus', 'Extra XP for each later session of a task (%)', 8, 0, 50, 1],
  ['schedShare', 'App XP for scheduling something (% of what it is worth)', 5, 0, 50, 1],
  ['openXP', 'App XP for opening Tempo on a day', 15, 0, 200, 1],
  ['streakXP', 'Extra app XP per day of a streak (up to 10 days)', 3, 0, 50, 1],
  ['fullDayXP', 'Busy XP for a full day (half of 7:00–23:00 planned)', 40, 0, 300, 5],
  ['keptXP', 'Busy XP for a day kept to the plan', 20, 0, 200, 5],
  ['penalty', 'XP lost per reschedule (more if the same task slips again)', 8, 0, 100, 1],
  ['weekFillXP', 'Weekly bonus for a fully planned week', 300, 0, 2000, 10],
  ['questXP', 'Quest XP (×)', 1, 0, 5, 0.1],
  ['goalXP', 'Goal XP (×)', 1, 0, 5, 0.1],
  ['lifeCap', 'Most of your XP that must be life XP to level up (%)', 25, 0, 50, 1],
];
export const RULES_V = 3; // when the rules change, the ledger is counted again
export function cfg(s) {
  const o = {}, c = s?.game?.cfg || {};
  for (const [k, , d, lo, hi] of CFG) { const v = c[k]; o[k] = v == null || v === '' || !Number.isFinite(+v) ? d : Math.min(hi, Math.max(lo, +v)); }
  return o;
}
export const cfgHash = (s) => JSON.stringify(cfg(s));

// ---------- levels ----------
export const MAX_LEVEL = 300;
// XP to go from level L to L+1: quick at first (level 20 in about a week of regular use, 50 in about a month),
// then slower and slower.
// (a busy week reaches about level 10–15; level 50 takes a couple of busy months; slower and slower after that)
export function need(L) {
  if (L < 20) return 150 + 25 * L;
  if (L < 50) return 650 + 15 * (L - 20);
  const d = L - 50;
  return Math.round(1100 + 30 * d + 0.3 * d * d);
}
const CUM = [0, 0];
for (let L = 1; L <= MAX_LEVEL; L++) CUM[L + 1] = CUM[L] + need(L);
export const xpFor = (L) => CUM[Math.max(1, Math.min(MAX_LEVEL, L))];
// Part of all XP that must be life XP to go past level L — rising slowly, never more than a quarter.
export function lifeShare(L, cap = 0.25) {
  let v;
  if (L <= 5) v = 0;
  else if (L <= 20) v = 0.08 * (L - 5) / 15;
  else if (L <= 50) v = 0.08 + 0.07 * (L - 20) / 30;
  else if (L <= 150) v = 0.15 + 0.10 * (L - 50) / 100;
  else v = 0.25;
  return Math.min(v * (cap / 0.25), cap);
}
export const lifeFor = (L, cap = 0.25) => Math.round(xpFor(L) * lifeShare(L, cap));
// Level from total XP and life XP. `capped`: enough XP for the next level, but not enough life XP yet.
// `pace` scales the XP every level needs; `cap` is the most life XP can be asked for (share of all XP).
export function levelOf(total, life, pace = 1, cap = 0.25) {
  const t = total / pace, lf = life / pace;
  let L = 1;
  while (L < MAX_LEVEL && t >= xpFor(L + 1)) L++;
  let lv = L;
  while (lv > 1 && lf < lifeFor(lv, cap)) lv--;
  const capped = lv < L;
  const next = Math.min(MAX_LEVEL, lv + 1);
  return { level: lv, into: Math.round((t - xpFor(lv)) * pace), span: Math.round((xpFor(next) - xpFor(lv)) * pace), capped, lifeNeed: capped ? Math.round((lifeFor(lv + 1, cap) - lf) * pace) : 0, nextLife: Math.round(lifeFor(next, cap) * pace), max: lv >= MAX_LEVEL };
}

// ---------- ranks: a new one every 5 levels, each with a description and its own emblem ----------
// Ranks belong to eras (the colour and the shape of the emblem); within an era every rank has its own sign.
export const ERAS = [
  { from: 1, name: 'The Garden', color: '#6aa84f', shape: 'leaf' }, { from: 25, name: 'The Workshop', color: '#00897b', shape: 'shield' },
  { from: 50, name: 'The Observatory', color: '#3949ab', shape: 'hex' }, { from: 100, name: 'The Citadel', color: '#8e24aa', shape: 'star' },
  { from: 150, name: 'The High Peaks', color: '#d84315', shape: 'shield' }, { from: 200, name: 'The Golden Age', color: '#b8860b', shape: 'hex' },
  { from: 250, name: 'The Firmament', color: '#283593', shape: 'star' },
];
export const RANKS = [
  [1, 'Seedling', '🌱', 'You have planted the first seed: a calendar that works for you.'],
  [5, 'Sprout', '🌿', 'Green shoots — you are checking in, planning ahead and following through.'],
  [10, 'Sapling', '🪴', 'Roots are forming. A few good habits now hold you up on busy days.'],
  [15, 'Bloom', '🌼', 'Your weeks have colour: work, rest and growth all find their place.'],
  [20, 'Apprentice Planner', '📒', 'You plan your days before they plan you.'],
  [25, 'Journeyman', '🧰', 'Tools in hand, you split big tasks into sessions and finish them.'],
  [30, 'Pathfinder', '🧭', 'You find a way through crowded weeks without losing the thread.'],
  [35, 'Cartographer', '🗺️', 'You map the weeks ahead — deadlines, trips and all.'],
  [40, 'Taskwright', '🛠️', 'You build tasks the way a craftsman builds furniture: piece by piece, square and true.'],
  [45, 'Artisan of Hours', '🎨', 'Your calendar has become a craft: balanced, deliberate, yours.'],
  [50, 'Timekeeper', '⏳', 'You keep time — and time keeps its promises to you.'],
  [55, 'Stargazer', '🔭', 'You look further ahead than most: months, not days.'],
  [60, 'Navigator', '⚓', 'Steady hand on the wheel; storms of meetings no longer push you off course.'],
  [65, 'Lamplighter', '🏮', 'You light the way for the evenings that matter: rest, family, reading.'],
  [70, 'Chronicler', '📜', 'Your weeks tell a story worth reading in the Sunday paper.'],
  [75, 'Scholar', '📚', 'Learning has become part of the rhythm of your week.'],
  [80, 'Alchemist', '⚗️', 'You turn spare hours into skills, and skills into results.'],
  [85, 'Clockmaker', '🕰️', 'Every gear of your week meshes with the next.'],
  [90, 'Oracle', '🔮', 'You see the crunch weeks coming and plan around them.'],
  [95, 'Sage of Seasons', '🍂', 'You plan by the season, not the day.'],
  [100, 'Chronomancer', '🪄', 'A hundred levels: you bend time to your purpose.'],
  [105, 'Warden', '🗝️', 'You guard your best hours like a keeper guards the keys.'],
  [110, 'Rhythm Knight', '🛡️', 'Sworn to the rhythm: work, rest, grow, repeat.'],
  [115, 'Paladin of Plans', '⚜️', 'Your plans hold even when the week tries to break them.'],
  [120, 'Captain', '🎖️', 'You lead your days, and others notice.'],
  [125, 'Strategist', '♟️', 'Every move on your calendar serves a longer game.'],
  [130, 'Commander', '🏰', 'Your weeks run like a well-held fortress.'],
  [135, 'Marshal', '🦅', 'Wide view, sharp focus — the eagle of the schedule.'],
  [140, 'Lord of Lists', '📋', 'No task escapes you; none overwhelms you.'],
  [145, 'Grand Planner', '🗓️', 'Your year has a shape, and you drew it.'],
  [150, 'Habit Sage', '🦉', 'Your habits do the heavy lifting now.'],
  [155, 'Mountaineer', '🧗', 'You climb the long projects one rope length at a time.'],
  [160, 'Summit Seeker', '🏔️', 'The big goals are in sight — and within reach.'],
  [165, 'Hourglass Warden', '⌛', 'Not a grain of sand slips through unplanned.'],
  [170, 'Flamekeeper', '🔥', 'Your streaks burn bright and steady.'],
  [175, 'Thunder Scholar', '⛈️', 'Bursts of deep work, then calm — you master both.'],
  [180, 'Phoenix', '🐦‍🔥', 'Off weeks don\'t stop you; you rise again, stronger.'],
  [185, 'Dragon Tamer', '🐉', 'Even the most fearsome deadlines eat from your hand.'],
  [190, 'Titan', '🗿', 'A pillar of consistency.'],
  [195, 'Colossus', '🏛️', 'What you have built through the years stands tall.'],
  [200, 'Golden Strategist', '👑', 'Two hundred levels: a golden age of well-spent time.'],
  [205, 'Archmage of Hours', '🧙', 'Your magic is simple: the right thing, at the right time.'],
  [210, 'Gilded Sage', '📿', 'Calm, unhurried, and always on time.'],
  [215, 'Lionheart', '🦁', 'Courage to say no — and to say yes to what matters.'],
  [220, 'Sun Bearer', '☀️', 'Your days start bright and end well.'],
  [225, 'Eternal Architect', '📐', 'You design years, not just weeks.'],
  [230, 'Keeper of Legends', '🏆', 'Your achievements could fill a trophy room.'],
  [235, 'High Chronicler', '🖋️', 'The story of your time is one of the great ones.'],
  [240, 'Grandmaster', '🎓', 'Teacher of tempo: others could learn from your calendar.'],
  [245, 'Legend', '🌟', 'Few have walked this far.'],
  [250, 'Celestial Navigator', '🌌', 'You steer by the stars now.'],
  [255, 'Comet Rider', '☄️', 'Fast and sure, you cross whole projects in a sweep.'],
  [260, 'Moon Warden', '🌙', 'Rest is part of your mastery: the nights are planned too.'],
  [265, 'Star Forger', '✨', 'You forge new skills out of the quiet hours.'],
  [270, 'Galaxy Weaver', '🌀', 'All the threads of your life woven into one pattern.'],
  [275, 'Astral Sage', '🪐', 'Planets keep orbits; so do your habits.'],
  [280, 'Keeper of the Cosmos', '🔭', 'Your plans span years and still hold.'],
  [285, 'Timeless One', '♾️', 'Time no longer happens to you; you happen to it.'],
  [290, 'Sovereign of Seasons', '🌈', 'Every season of your life gets its due.'],
  [295, 'Ascendant', '🕊️', 'One last climb.'],
  [300, 'Master of Time', '💎', 'The summit: level 300. Your time is truly your own.'],
];
// kept for compatibility: the ranks as [level, name, icon, colour]
export const eraOf = (L) => { let e = ERAS[0]; for (const x of ERAS) if (L >= x.from) e = x; return e; };
export const TIERS = RANKS.map(([L, n, ic]) => [L, n, ic, eraOf(L).color]);
export const tierOf = (L) => {
  let i = 0; RANKS.forEach((x, j) => { if (L >= x[0]) i = j; });
  const [from, name, icon, desc] = RANKS[i], era = eraOf(from);
  return { from, name, icon, desc, color: era.color, era: era.name, shape: era.shape, index: i, next: RANKS[i + 1] ? { from: RANKS[i + 1][0], name: RANKS[i + 1][1] } : null };
};
// The rank's emblem: its era's shape and colour (lighter for the first ranks of the era), the rank's sign, a star
// for each rank reached within the era, a laurel from level 50, and the level on a ribbon.
const SHAPES = {
  leaf: 'M50 6 C78 14 90 40 82 66 Q74 88 50 96 Q26 88 18 66 C10 40 22 14 50 6 Z',
  shield: 'M50 6 L86 20 L82 62 Q76 84 50 96 Q24 84 18 62 L14 20 Z',
  hex: 'M50 5 L88 27 L88 73 L50 95 L12 73 L12 27 Z',
  star: 'M50 4 L61 30 L90 26 L72 50 L90 74 L61 70 L50 96 L39 70 L10 74 L28 50 L10 26 L39 30 Z',
};
export function emblemSVG(L, size = 64) {
  const t = tierOf(L), id = 'em' + t.from + '-' + size, era = eraOf(t.from);
  const inEra = RANKS.filter((r) => r[0] >= era.from && r[0] <= t.from).length;
  const path = SHAPES[t.shape] || SHAPES.shield;
  const n = Math.min(inEra, 10);
  const stars = Array.from({ length: n }, (_, i) => { const a = Math.PI * (0.12 + (0.76 * i) / Math.max(1, n - 1)); const x = 50 - 44 * Math.cos(a), y = 54 - 44 * Math.sin(a); return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="7" text-anchor="middle" fill="#ffd54f">★</text>`; }).join('');
  const laurel = L >= 50 ? `<path d="M22 88 Q8 66 16 40" fill="none" stroke="#ffd54f" stroke-width="2.5" stroke-dasharray="4 3"/><path d="M78 88 Q92 66 84 40" fill="none" stroke="#ffd54f" stroke-width="2.5" stroke-dasharray="4 3"/>` : '';
  const glow = L >= 200 ? `<circle cx="50" cy="50" r="46" fill="none" stroke="#fff7c2" stroke-opacity=".5" stroke-width="2"/>` : '';
  return `<svg class="g-emblem" width="${size}" height="${size}" viewBox="0 0 100 100" aria-label="${t.name}"><defs><radialGradient id="${id}" cx="40%" cy="30%" r="80%"><stop offset="0" stop-color="#fff" stop-opacity=".6"/><stop offset=".45" stop-color="${t.color}"/><stop offset="1" stop-color="#151525"/></radialGradient></defs>
    ${glow}${laurel}<path d="${path}" fill="url(#${id})" stroke="#ffd54f" stroke-width="${1.5 + Math.min(3, ERAS.indexOf(era) * 0.5)}"/>
    ${stars}<text x="50" y="58" font-size="32" text-anchor="middle">${t.icon}</text>
    <rect x="28" y="72" width="44" height="15" rx="4" fill="#151525" stroke="#ffd54f" stroke-width="1.5"/><text x="50" y="83.5" font-size="10.5" font-weight="700" text-anchor="middle" fill="#ffd54f" font-family="system-ui, sans-serif">${L}</text></svg>`;
}

// ---------- XP for one event or task session ----------
const isLife = (it, g) => (g.lifeCats || []).includes(catOf(it)) || (g.lifeCats || []).includes(parentCat(it, g));
const catOf = (it) => (it.kind === 'chunk' ? it.task?.categoryId : it.catId) || null;
const parentCat = (it, g) => g._parents?.[catOf(it)] || null;
export const isSleepItem = (it, s) => !!(it.ev?.extendedProperties?.private?.tempoSleep || (s.sleepCategory && catOf(it) === s.sleepCategory) || /\bsleep\b|😴/i.test(it.title || ''));
const isRest = (it, s, g) => !isSleepItem(it, s) && ((g.restCats || []).includes(catOf(it)) || /^leisure$/i.test(catOf(it) || ''));
// What an item is worth when completed: { app, busy, life } and the reasons. `done` = it already counts.
// Items count mostly as one kind: life-growth (and leisure) items earn life XP and only a little busy XP; other
// items earn busy XP; sleep earns a little life XP. Categories set to "never score" earn nothing.
export function itemXP(it, s, now = Date.now()) {
  const g = gameOf(s), c = cfg(s);
  const out = { app: 0, busy: 0, life: 0, why: [], done: false, kind: it.kind };
  if (it.allDay || it.declined) return out;
  const cat = catOf(it);
  if (cat && ((g.noCats || []).includes(cat) || (g.noCats || []).includes(g._parents[cat]))) { out.why.push('a category that never scores'); out.done = it.kind === 'chunk' ? it.status === 'done' : it.end <= now; return out; }
  const m = Math.max(0, Math.min(600, (it.end - it.start) / T.MIN)), h = m / 60, cross = c.crossShare / 100;
  if (it.kind === 'chunk') {
    if (it.status === 'waived' || it.sess?.kind === 'waived') return out;
    const stage = Math.min(3, Math.pow(1 + c.stageBonus / 100, Math.max(0, (it.sess?.index || 1) - 1)));
    const busy = (6 + c.sessionPerHour * h) * stage;
    const later = (it.sess?.index || 1) > 1 && c.stageBonus ? ` ${it.sess.index}/${it.sess.count} (×${stage.toFixed(2)} for a later stage)` : '';
    if (isLife(it, g)) { out.life = Math.round(c.lifePerHour * h * stage); out.busy = Math.round(busy * cross); out.why.push(`life growth${later}`); }
    else { out.busy = Math.round(busy); out.why.push(`task session${later}`); }
    out.done = it.status === 'done' || it.sess?.kind === 'done';
    return out;
  }
  if (isSleepItem(it, s)) { out.life = Math.round(Math.min(h, 9) * c.sleepPerHour); out.why.push('sleep'); }
  else {
    const busy = (4 + c.eventPerHour * Math.min(h, 8)) * (it.evDone ? 1.2 : 1);
    if (isLife(it, g)) { out.life = Math.round(c.lifePerHour * Math.min(h, 8) * (it.evDone ? 1.2 : 1)); out.busy = Math.round(busy * cross); out.why.push('life growth'); }
    else if (isRest(it, s, g)) { out.life = Math.round(c.leisurePerHour * Math.min(h, 4)); out.busy = Math.round(busy * cross); out.why.push('leisure'); }
    else { out.busy = Math.round(busy); out.why.push('event'); }
    if (it.evDone) out.why.push('ticked off ×1.2');
  }
  out.done = it.end <= now;
  return out;
}
export const sumXP = (x) => x.app + x.busy + x.life;
export function gameOf(s) {
  const g = s.game || {};
  const parents = {}; for (const c of s.categories || []) if (c.parent) parents[c.id] = c.parent;
  return { ...g, lifeCats: g.lifeCats || [], restCats: g.restCats || [], noCats: g.noCats || [], _parents: parents };
}

// ---------- goals ----------
// The period a goal belongs to: w:YYYY-MM-DD (that week), m:YYYY-MM (that month), y (12 months from when it was set)
export function goalPeriod(key, g, z) {
  if (key.startsWith('w:')) { const a = key.slice(2); return { from: a, to: T.addDays(a, 7), kind: 'week' }; }
  if (key.startsWith('m:')) { const a = key.slice(2) + '-01'; return { from: a, to: T.addMonths(a, 1), kind: 'month' }; }
  const a = g.at ? T.dayKey(g.at, z) : T.dayKey(Date.now(), z); return { from: a, to: T.addDays(a, 365), kind: 'year' };
}
// Hours a goal asks for (its time budget, or an "at least" hours rule), 0 if none
export function goalHours(g, per) {
  if (g.rule && g.rule.kind !== 'timing' && g.rule.op !== 'atMost' && +g.rule.hours > 0) {
    const n = g.rule.per === 'day' ? (per.kind === 'week' ? 7 : per.kind === 'month' ? 30 : 365) : g.rule.per === 'week' ? (per.kind === 'month' ? 4 : per.kind === 'year' ? 52 : 1) : 1;
    return +g.rule.hours * n;
  }
  return (+g.budget || 0) / 60;
}
// What a goal is worth: more for longer periods and more hours; ×1.5 when set before its period begins and not a
// repeating goal (planning ahead), ×0.8 for repeating copies. Defining it earns a fifth; when it asks for hours,
// half of its value comes bit by bit as you put the hours in, the rest when it's reached.
export function goalValue(g, key, s) {
  const per = goalPeriod(key, g, s.tz), hrs = goalHours(g, per);
  const base = { week: 40, month: 90, year: 160 }[per.kind];
  const ahead = !g.repeatId && g.at && g.at < T.dayStart(per.from, s.tz);
  const mult = g.repeatId ? 0.8 : ahead ? 1.5 : 1;
  const reach = Math.round((base + Math.min(300, 5 * hrs)) * mult);
  const define = g.repeatId ? 0 : Math.round(reach * 0.2);
  const progress = hrs > 0 ? Math.round(reach * 0.5) : 0;
  return { reach, define, progress, final: reach - progress, hours: hrs, ahead, per };
}

// ---------- a day's XP ----------
const BAD = new Set(['moved', 'skipped', 'undone', 'resched']);
// ctx: { items (events + sessions of the day and around it), tasks, projects, habits, goals (flat list with doneAt), history, active (days) }
export function dayXP(k, s, ctx, now = Date.now()) {
  const c = cfg(s);
  const z = s.tz, g = gameOf(s), from = T.dayStart(k, z), to = T.dayStart(T.addDays(k, 1), z);
  const r = { k, app: 0, busy: 0, life: 0, pen: 0, lines: [], potential: { app: 0, busy: 0, life: 0 }, quests: [] };
  const add = (type, xp, label) => { if (!xp) return; r[type] += xp; r.lines.push([label, type, xp]); };
  const mine = ctx.items.filter((it) => !it.allDay && it.start >= from && it.start < to);
  let doneN = 0, lifeMin = 0;
  for (const it of mine) {
    const x = itemXP(it, s, now);
    if (x.done) {
      add('busy', x.busy, it.title); add('life', x.life, it.title); add('app', x.app, it.title);
      if (it.kind === 'chunk' || !isSleepItem(it, s)) doneN++;
      if (x.life && !isSleepItem(it, s)) lifeMin += Math.max(0, Math.min(it.end, now) - it.start) / T.MIN;
    } else if (it.start < to) { r.potential.busy += x.busy; r.potential.life += x.life; }
  }
  // scheduling: a fifth of what the item is worth, on the day you created it
  for (const it of ctx.items) {
    const c = it.kind === 'chunk' ? null : Date.parse(it.ev?.created || '') || null;
    if (c && c >= from && c < to && !it.ev?.extendedProperties?.private?.tempoSleep) { const x = itemXP(it, s, now); const v = Math.round(sumXP(x) * c.schedShare / 100); if (v) add('app', v, `scheduled “${it.title}”`); }
  }
  for (const t of ctx.tasks) if (t.created >= from && t.created < to) add('app', Math.round(5 * c.schedShare / 5), `planned task “${t.title}”`);
  for (const p of ctx.projects) if (p.created >= from && p.created < to) add('app', 20, `started project “${p.name}”`);
  // finished tasks and projects
  for (const t of ctx.tasks) { const last = t._finishedAt; if (last >= from && last < to) add('busy', 40 + 8 * (t._sessions || 1), `finished “${t.title}”`); }
  for (const p of ctx.projectsDone || []) if (p.at >= from && p.at < to) add('busy', 200, `completed project “${p.name}”`);
  // habits and goals
  let hDone = 0, hTotal = 0;
  for (const h of ctx.habits) { hTotal++; if (ctx.habitDone(h, k)) { hDone++; add('life', 8, `habit: ${h.name}`); } }
  // goals: defining them (app XP), putting hours into them (life XP, bit by bit) and reaching them (life XP)
  for (const { g: gl, key } of ctx.goalsAll || []) {
    const v0 = goalValue(gl, key, s), gm = c.goalXP, v = { ...v0, define: Math.round(v0.define * gm), final: Math.round(v0.final * gm), progress: Math.round(v0.progress * gm) };
    if (v.define && gl.at >= from && gl.at < to) add('app', v.define, `set goal: ${gl.text}${v.ahead ? ' (ahead of time)' : ''}`);
    const at = gl.override === false ? null : gl.doneAt || gl.autoDoneAt;
    if (at >= from && at < to && (gl.done || gl.autoDoneAt)) add('life', v.final, `goal reached: ${gl.text}`);
    if (v.progress && ctx.goalMinutes && k >= v.per.from && k < v.per.to && from < now) {
      const target = v.hours * 60, before = ctx.goalMinutes(gl, key, T.dayStart(v.per.from, z), from), today = ctx.goalMinutes(gl, key, from, to);
      const x = Math.round(v.progress * (Math.min(before + today, target) - Math.min(before, target)) / target);
      if (x > 0) add('life', x, `progress on goal: ${gl.text}`);
    }
  }
  // using the app: a day you opened it, with a streak bonus
  if ((g.active || []).includes(k)) {
    let streak = 1; for (let d = T.addDays(k, -1); (g.active || []).includes(d) && streak < 30; d = T.addDays(d, -1)) streak++;
    add('app', Math.round(c.openXP + Math.min(10, streak - 1) * c.streakXP), streak > 1 ? `day ${streak} in a row` : 'opened Tempo');
  }
  // a full day: at least half of the waking day (07–23) filled with things other than sleep
  const wake0 = T.atTime(k, '07:00', z), wake1 = T.atTime(k, '23:00', z);
  const occ = merge(mine.filter((it) => !isSleepItem(it, s) && it.end <= now + T.DAY).map((it) => [Math.max(it.start, wake0), Math.min(it.end, wake1)]).filter(([a, b]) => b > a));
  const fill = occ.reduce((a, [x, y]) => a + (y - x), 0) / (wake1 - wake0);
  if (to <= now && fill >= 0.5) add('busy', Math.round(c.fullDayXP * (1 + 2 * (Math.min(fill, 1) - 0.5))), `a full day (${Math.round(fill * 100)}% planned)`);
  // rescheduling costs XP — more each time the same task slips again within a week
  const hist = (ctx.history || []).filter((h) => BAD.has(h.kind) && h.at >= from && h.at < to);
  for (const h of hist) {
    const again = (ctx.history || []).filter((x) => BAD.has(x.kind) && x.taskId && x.taskId === h.taskId && x.at < h.at && x.at > h.at - 7 * T.DAY).length;
    const p = Math.round(Math.min(5 * c.penalty, c.penalty * (again + 1)));
    r.pen += p; r.lines.push([`${again ? `rescheduled again (${again + 1}×)` : 'rescheduled'}${h.title ? `: ${h.title}` : ''}`, 'pen', -p]);
  }
  if (to <= now && !hist.length && doneN >= 1 && c.keptXP) add('busy', c.keptXP, 'kept to the plan');
  // daily quests
  const q = [
    { id: 'q-done', label: 'Complete 3 events or task sessions', have: doneN, goal: 3, xp: 30, type: 'busy' },
    { id: 'q-life', label: 'Spend 1 hour on life growth', have: Math.round(lifeMin), goal: 60, xp: 40, type: 'life', unit: 'min' },
    hTotal ? { id: 'q-habits', label: 'Tick off all your habits', have: hDone, goal: hTotal, xp: 25, type: 'life' }
      : { id: 'q-plan', label: 'Plan something for tomorrow', have: ctx.items.some((it) => it.start >= to && it.start < to + T.DAY && (Date.parse(it.ev?.created || '') >= from || it.kind === 'chunk')) ? 1 : 0, goal: 1, xp: 20, type: 'app' },
  ];
  for (const x of q) { x.xp = Math.round(x.xp * c.questXP); x.ok = x.have >= x.goal; if (x.ok && x.xp) add(x.type, x.xp, `quest: ${x.label}`); }
  r.quests = q;
  r.net = r.app + r.busy + r.life - r.pen;
  r.fill = fill; r.penN = hist.length; r.doneN = doneN;
  r.potential.total = r.potential.busy + r.potential.life + r.potential.app;
  return r;
}
function merge(iv) { iv.sort((a, b) => a[0] - b[0]); const out = []; for (const x of iv) { const l = out[out.length - 1]; if (l && x[0] <= l[1]) l[1] = Math.max(l[1], x[1]); else out.push([...x]); } return out; }

// Week bonus (once the week is over): how much of the week's waking hours were planned, and keeping to the plan.
export function weekXP(wk, s, days) {
  const fills = days.map((d) => d.fill || 0);
  const fill = fills.length ? fills.reduce((a, x) => a + x, 0) / fills.length : 0;
  const pens = days.reduce((a, d) => a + (d.penN || 0), 0);
  const c = cfg(s);
  const b = Math.round(c.weekFillXP * Math.min(1, fill)) + (pens <= 2 ? Math.round(c.weekFillXP / 3) : 0);
  return { busy: b, fill, pens };
}

// ---------- achievements ----------
export const ACHIEVEMENTS = [
  ['first-task', '🎯', 'First steps', 'Plan your first task'], ['first-project', '🏗️', 'Architect', 'Start a project'],
  ['streak-7', '🔥', 'On fire', 'Open Tempo 7 days in a row'], ['streak-30', '🌋', 'Unstoppable', 'Open Tempo 30 days in a row'],
  ['sessions-25', '⚙️', 'Machinist', 'Complete 25 task sessions'], ['sessions-100', '🏭', 'Factory', 'Complete 100 task sessions'],
  ['life-1000', '🌳', 'Growing', 'Earn 1,000 life XP'], ['life-10000', '🌲', 'Old growth', 'Earn 10,000 life XP'],
  ['full-week', '🧱', 'Solid week', 'Plan more than 60% of a week'], ['clean-week', '🕊️', 'Smooth sailing', 'A week with no rescheduling'],
  ['level-20', '📒', 'Apprentice', 'Reach level 20'], ['level-50', '⏳', 'Timekeeper', 'Reach level 50'], ['level-100', '🔮', 'Chronomancer', 'Reach level 100'],
];
export const ACH_XP = 60;
