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
  ['drainRankScale', 'XP drains cost more as you rise: extra % for each rank (every 5 levels)', 3, 0, 20, 0.5],
  ['cleanDayPct', 'Clean-day bonus: % of the day\'s XP for a day without drains', 4, 0, 50, 0.5],
  ['cleanDayStep', 'Clean-day bonus grows by this % for each day in a row', 0.2, 0, 5, 0.05],
  ['cleanWeekPct', 'Clean-week bonus: % of the week\'s XP for a week without drains', 5, 0, 50, 0.5],
  ['cleanWeekStep', 'Clean-week bonus grows by this % for each week in a row', 0.5, 0, 10, 0.1],
  ['cleanCapBase', 'Clean bonus cap at the first rank (%)', 6, 0, 50, 0.5],
  ['cleanCapRank', 'Clean bonus cap: extra % for each rank (every 5 levels)', 0.25, 0, 5, 0.05],
  ['cleanMaxPct', 'Clean bonus: never more than (%)', 15, 0, 100, 1],
  ['habitXP', 'Habit ticked off (life XP)', 8, 0, 100, 1],
  ['habitStreakXP', 'Habit streak: extra XP for each day (or period) in a row', 1, 0, 20, 0.5],
  ['habitRankPct', 'Habit streak rewards grow by this % for each rank', 4, 0, 50, 1],
  ['habitMilestoneXP', 'Habit streak milestone (7, 30, 100, 365 days; 4, 12, 52 weeks)', 20, 0, 500, 5],
  ['laterXP', 'Scheduling something from Later (life XP)', 4, 0, 100, 1],
  ['laterPerWeek', '…plus this for each week it waited in Later', 2, 0, 50, 0.5],
  ['laterMaxWeeks', '…counting at most this many weeks', 26, 1, 104, 1],
  ['laterDoneMult', 'Doing something from Later: × the scheduling bonus', 3, 0, 20, 0.5],
  ['boostPct', 'Bonus activities: extra XP (%) — the default for new ones', 50, 0, 300, 5],
];
// How a clean streak's bonus grows: first period base %, then + step % for each period in a row, up to the maximum.
export const cleanPct = (base, step, n, max) => (n > 0 ? +Math.min(max, base + step * (n - 1)).toFixed(2) : 0);
// The cap on a clean bonus: higher ranks can earn a bit more
export const cleanCap = (s, level = 1) => { const c = cfg(s); return +Math.min(c.cleanMaxPct, c.cleanCapBase + c.cleanCapRank * tierOf(Math.max(1, level)).index).toFixed(2); };
// Time-limited drains and bonus activities: active on day k? (from / to are day keys; to is the first day it no longer counts)
export const activeOn = (x, k) => (!x.from || k >= x.from) && (!x.to || k < x.to);
export const PERIODS = [['always', 'Always'], ['1w', 'Next week'], ['2w', 'Next two weeks'], ['1m', 'Next month'], ['3m', 'Next 3 months'], ['custom', 'Custom period']];
export function periodRange(kind, today) {
  if (kind === '1w') return { from: today, to: T.addDays(today, 7) };
  if (kind === '2w') return { from: today, to: T.addDays(today, 14) };
  if (kind === '1m') return { from: today, to: T.addMonths(today, 1) };
  if (kind === '3m') return { from: today, to: T.addMonths(today, 3) };
  return { from: null, to: null };
}
export const RULES_V = 3; // when the rules change, the ledger is counted again
export function cfg(s) {
  const o = {}, c = s?.game?.cfg || {};
  for (const [k, , d, lo, hi] of CFG) { const v = c[k]; o[k] = v == null || v === '' || !Number.isFinite(+v) ? d : Math.min(hi, Math.max(lo, +v)); }
  return o;
}
// Everything that changes how XP is counted: changing any of it counts all days again from the start.
export const cfgHash = (s) => JSON.stringify([cfg(s), s?.game?.drains || [], s?.game?.boosts || [], (s?.habits || []).filter((h) => h.game === false).map((h) => h.id), s?.game?.lifeCats || [], s?.game?.restCats || [], s?.game?.noCats || []]);

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
  const cat = catOf(it), day = T.dayKey(it.start, s.tz);
  const isDone = () => (it.kind === 'chunk' ? it.status === 'done' || it.sess?.kind === 'done' : it.end <= now);
  const dr = g._drains.find((d) => activeOn(d, day) && d._m(it));
  if (dr) { out.why.push(`an XP drain (${dr.name || 'drain'}) — never scores`); out.done = isDone(); out.drain = true; return out; }
  const boost = g._boosts.find((b) => activeOn(b, day) && b._m(it));
  if (!boost && cat && ((g.noCats || []).includes(cat) || (g.noCats || []).includes(g._parents[cat]))) { out.why.push('a category that never scores'); out.done = isDone(); return out; }
  if (boost) { const r = itemBase(it, s, now, g, c); const f = 1 + (+boost.pct || 0) / 100; r.app = Math.round(r.app * f); r.busy = Math.round(r.busy * f); r.life = Math.round(r.life * f); r.why.push(`bonus: ${boost.name || 'bonus activity'} +${boost.pct}%`); r.boost = boost.name; return r; }
  return itemBase(it, s, now, g, c);
}
function itemBase(it, s, now, g, c) {
  const out = { app: 0, busy: 0, life: 0, why: [], done: false, kind: it.kind };
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
  const live = (l) => (l || []).filter((d) => (d.cats || []).length || (d.words || []).length).map((d) => ({ ...d, _m: drainMatcher(d, s) }));
  const key = s.game?.drains, key2 = s.game?.boosts;
  if (!gameOfCache || gameOfCache.d !== key || gameOfCache.b !== key2 || gameOfCache.c !== s.categories) gameOfCache = { d: key, b: key2, c: s.categories, drains: live(key), boosts: live(key2) };
  return { ...g, lifeCats: g.lifeCats || [], restCats: g.restCats || [], noCats: g.noCats || [], _parents: parents, _drains: gameOfCache.drains, _boosts: gameOfCache.boosts };
}
let gameOfCache = null;

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

// ---------- Later: scheduling something that waited in the Later list ----------
// { days waited, sched: life XP for scheduling it, done: life XP for doing it }
export function laterBonus(s, created, at = Date.now()) {
  const c = cfg(s), days = Math.max(0, Math.floor((at - (created || at)) / T.DAY));
  const sched = Math.round(c.laterXP + c.laterPerWeek * Math.min(days / 7, c.laterMaxWeeks));
  return { days, sched, done: Math.round(sched * c.laterDoneMult) };
}
const waited = (d) => (d >= 14 ? `${Math.floor(d / 7)} weeks` : d === 1 ? '1 day' : `${d} days`);
// an event that came from Later: { created, at } from its private properties
export function laterOfEvent(it) {
  const p = it.ev?.extendedProperties?.private; if (!p?.tempoLaterAt) return null;
  return { created: +p.tempoLaterCreated || +p.tempoLaterAt, at: +p.tempoLaterAt };
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
  // from Later: a little life XP for scheduling it (more the longer it waited), more for doing it
  for (const t of ctx.tasks) {
    const fl = t.fromLater; if (!fl?.at) continue;
    const lb = laterBonus(s, fl.created, fl.at);
    if (fl.at >= from && fl.at < to) add('life', lb.sched, `scheduled from Later: “${t.title}” (waited ${waited(lb.days)})`);
    if (t._finishedAt >= from && t._finishedAt < to) add('life', lb.done, `did something from Later: “${t.title}”`);
  }
  for (const it of ctx.items) {
    const fl = laterOfEvent(it); if (!fl) continue;
    const lb = laterBonus(s, fl.created, fl.at);
    if (fl.at >= from && fl.at < to) add('life', lb.sched, `scheduled from Later: “${it.title}” (waited ${waited(lb.days)})`);
    if (it.start >= from && it.start < to && it.end <= now && !it.declined) add('life', lb.done, `did something from Later: “${it.title}”`);
  }
  for (const p of ctx.projectsDone || []) if (p.at >= from && p.at < to) add('busy', 200, `completed project “${p.name}”`);
  // habits and goals
  let hDone = 0, hTotal = 0;
  const rankI = ctx.habits.length ? tierOf(ctx.level ?? levelAt(s, k, z)).index : 0;
  for (const h of ctx.habits) {
    if (h.game === false) continue;
    hTotal++;
    if (!ctx.habitDone(h, k)) continue;
    hDone++; add('life', c.habitXP, `habit: ${h.name}`);
    const n = ctx.habitStreak ? ctx.habitStreak(h, k) : 0;
    if (n >= 2) { const hr = habitReward(s, n, rankI, h.freq?.per || 'day'); add('life', hr.xp, `habit streak: ${h.name} (${n} ${h.freq?.per && h.freq.per !== 'day' ? h.freq.per : 'day'}s in a row)`); if (hr.milestone) add('life', hr.milestone, `habit milestone: ${h.name} — ${n} ${h.freq?.per && h.freq.per !== 'day' ? h.freq.per : 'day'}s!`); }
  }
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

// ---------- XP drains: categories (or words) that cost XP ----------
// { id, name, cats, words, per: 'day' | 'week', free: hours with no cost, tol: hours tolerated, basePct: cost while
//   tolerated (% of that day's XP), growPct: extra % for each hour beyond, maxPct: the most it can cost (% of the
//   week's — or day's — XP), types: ['app','busy','life'] }
// Example "Gameplay": weekly, tolerate 2 h at 10% of the XP of the days you played; beyond that +15% an hour of the
// whole week's XP, up to 75%.
export const DRAIN_DEFAULT = { name: 'Gameplay', cats: [], words: ['game', 'gaming'], per: 'week', free: 0, tol: 2, basePct: 10, growPct: 15, maxPct: 75, types: ['app', 'busy', 'life'] };
const foldD = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
export function drainMatcher(d, s) {
  const set = new Set(d.cats || []);
  for (const c of s.categories || []) if (c.parent && set.has(c.parent)) set.add(c.id);
  const ws = (d.words || []).map((w) => foldD(String(w).trim())).filter(Boolean);
  const re = ws.length ? new RegExp(`(^|[^\\p{L}\\p{N}])(${ws.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'u') : null;
  return (it) => {
    if (it.allDay || it.declined || (it.kind === 'chunk' && it.sess?.kind === 'waived')) return false;
    if (set.size && set.has((it.kind === 'chunk' ? it.task?.categoryId : it.catId) || '__none')) return true;
    return !!re && re.test(foldD(it.kind === 'chunk' ? `${it.task?.title || ''} ${it.title || ''}` : `${it.title || ''} ${it.ev?.summary || ''}`));
  };
}
// Hours of a drain per day in [fromKey, toKey) (elapsed only, overlaps counted once)
export function drainHours(d, s, items, fromKey, toKey, now = Date.now()) {
  const z = s.tz, m = drainMatcher(d, s), out = {};
  for (let k = fromKey; k < toKey; k = T.addDays(k, 1)) {
    if (!activeOn(d, k)) continue;
    const a = T.dayStart(k, z), b = Math.min(T.dayStart(T.addDays(k, 1), z), now);
    const iv = items.filter(m).map((it) => [Math.max(it.start, a), Math.min(it.end, b)]).filter(([x, y]) => y > x).sort((x, y) => x[0] - y[0]);
    let ms = 0, cs = -1, ce = -1;
    for (const [x, y] of iv) { if (x > ce) { if (ce > cs) ms += ce - cs; cs = x; ce = y; } else ce = Math.max(ce, y); }
    if (ce > cs) ms += ce - cs;
    out[k] = ms / T.HOUR;
  }
  return out;
}
// The % a drain costs for h hours. `scale` grows with your level (drains cost more the higher you climb).
export function drainPct(d, h, scale = 1) {
  const free = +d.free || 0, tol = Math.max(free, +d.tol || 0);
  if (h <= free + 1e-9) return 0;
  if (h <= tol + 1e-9) return Math.min(100, (+d.basePct || 0) * scale);
  return Math.min(+d.maxPct || 75, ((+d.basePct || 0) + (+d.growPct || 0) * (h - tol)) * scale);
}
export const drainScale = (s, level = 1) => 1 + (cfg(s).drainRankScale / 100) * tierOf(Math.max(1, level)).index;
// What the drains cost in a week. dayXP: { k: { app, busy, life } } for the days of the week (XP before drains).
// Returns { total, lines: [[label, cost, dayKey | null]] }
export function weekDrains(s, wk, dayXPs, items, now = Date.now(), scale = 1) {
  const drains = (s.game?.drains || []).filter((d) => (d.cats || []).length || (d.words || []).length);
  const days = Array.from({ length: 7 }, (_, i) => T.addDays(wk, i));
  const xpOf = (k, types) => { const x = dayXPs[k]; return x ? types.reduce((a, t) => a + Math.max(0, x[t] || 0), 0) : 0; };
  const lines = [];
  for (const d of drains) {
    const types = d.types?.length ? d.types : ['app', 'busy', 'life'];
    const hrs = drainHours(d, s, items, wk, T.addDays(wk, 7), now);
    const fh = (h) => (h >= 1 ? `${+h.toFixed(1)} h` : `${Math.round(h * 60)} min`);
    if (d.per === 'day') {
      for (const k of days) { if (!activeOn(d, k)) continue; const h = hrs[k] || 0, p = drainPct(d, h, scale); if (p) lines.push([`${d.name}: ${fh(h)} that day → −${Math.round(p)}%`, Math.round(xpOf(k, types) * p / 100), k]); }
      continue;
    }
    const H = days.reduce((a, k) => a + (hrs[k] || 0), 0), tol = Math.max(+d.free || 0, +d.tol || 0);
    if (H <= tol + 1e-9) {
      const p = drainPct(d, H, scale);
      if (p) for (const k of days) if ((hrs[k] || 0) > 0) lines.push([`${d.name}: ${fh(hrs[k])} (${fh(H)} this week, tolerated) → −${Math.round(p)}% of the day`, Math.round(xpOf(k, types) * p / 100), k]);
    } else {
      const p = drainPct(d, H, scale), wkXP = days.reduce((a, k) => a + xpOf(k, types), 0);
      lines.push([`${d.name}: ${fh(H)} this week, ${fh(H - tol)} over the ${fh(tol)} tolerated → −${Math.round(p)}% of the week`, Math.round(wkXP * p / 100), null]);
    }
  }
  return { total: lines.reduce((a, l) => a + l[1], 0), lines: lines.filter((l) => l[1] > 0) };
}

// All drain hours on a day (any drain) — for clean days
export function anyDrainHours(s, items, fromKey, toKey, now = Date.now()) {
  const out = {};
  for (const d of (s.game?.drains || []).filter((x) => (x.cats || []).length || (x.words || []).length)) {
    const h = drainHours(d, s, items, fromKey, toKey, now);
    for (const [k, v] of Object.entries(h)) out[k] = (out[k] || 0) + v;
  }
  return out;
}

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


// ---- Clean days and weeks (no XP drain at all), totals from the ledger, and when levels were reached
export const hasDrains = (s, k) => (s.game?.drains || []).some((d) => ((d.cats || []).length || (d.words || []).length) && (!k || activeOn(d, k)));
// Habit streak reward: a little XP per day (period) in a row — more, and for longer streaks, the higher your rank
export function habitReward(s, n, rankI, per = 'day') {
  const c = cfg(s), mult = 1 + (c.habitRankPct / 100) * rankI, cap = 6 + rankI;
  const xp = Math.round(c.habitStreakXP * Math.min(n - 1, cap) * mult);
  const ms = per === 'day' ? [7, 30, 100, 365] : per === 'week' ? [4, 12, 52] : [3, 6, 12];
  const i = ms.indexOf(n);
  return { xp, milestone: i >= 0 ? Math.round(c.habitMilestoneXP * 2 ** i * mult) : 0, cap, mult };
}
const posXP = (d) => Math.max(0, d.a || 0) + Math.max(0, d.b || 0) + Math.max(0, d.l || 0);
// Clean-day bonus for a settled day: streak n (this day included) and its XP
export function cleanDay(s, dayEntry, n, level = 1) {
  const c = cfg(s), pct = cleanPct(c.cleanDayPct, c.cleanDayStep, n, cleanCap(s, level));
  return { pct, xp: Math.round(posXP(dayEntry) * pct / 100) };
}
export function cleanWeek(s, dayEntries, weekBusy, n, level = 1) {
  const c = cfg(s), pct = cleanPct(c.cleanWeekPct, c.cleanWeekStep, n, cleanCap(s, level));
  return { pct, xp: Math.round((dayEntries.reduce((a, d) => a + posXP(d), 0) + Math.max(0, weekBusy || 0)) * pct / 100) };
}
// XP earned before day `upto` (settled days and weeks, achievements unlocked before then), for the level at that time
export function ledgerTotals(s, upto, z) {
  const g = s.game || {}, t = { app: 0, busy: 0, life: 0, pen: 0, clean: 0, drain: 0 };
  for (const [k, d] of Object.entries(g.ledger || {})) if (!upto || k < upto) { t.app += d.a || 0; t.busy += d.b || 0; t.life += d.l || 0; t.pen += d.p || 0; t.clean += d.cb || 0; }
  for (const [wk, w] of Object.entries(g.weeks || {})) if (!upto || T.addDays(wk, 7) <= upto) { t.busy += w.b || 0; t.drain += w.drain || 0; t.clean += w.cb || 0; }
  for (const at of Object.values(g.ach || {})) if (!upto || !z || T.dayKey(at, z) < upto) t.app += ACH_XP;
  t.total = Math.max(0, t.app + t.busy + t.life + t.clean - t.pen - t.drain);
  return t;
}
export const levelAt = (s, upto, z) => { const c = cfg(s), t = ledgerTotals(s, upto, z); return levelOf(t.total, t.life, c.pace, c.lifeCap / 100).level; };
// Days on which a new level was reached: { dayKey: level }
export function levelUps(s, z, ws = 1) {
  const g = s.game || {}, c = cfg(s), out = {};
  const keys = Object.keys(g.ledger || {}).sort();
  if (!keys.length) return out;
  const achBy = {}; for (const at of Object.values(g.ach || {})) { const k = T.dayKey(at, z); achBy[k] = (achBy[k] || 0) + ACH_XP; }
  let tot = 0, life = 0, prev = 1;
  for (const k of keys) {
    const d = g.ledger[k];
    tot += (d.a || 0) + (d.b || 0) + (d.l || 0) + (d.cb || 0) - (d.p || 0) + (achBy[k] || 0); life += d.l || 0;
    const wk = T.addDays(k, -6), w = g.weeks?.[wk];
    if (w && T.startOfWeek(wk, ws) === wk) tot += (w.b || 0) + (w.cb || 0) - (w.drain || 0);
    const L = levelOf(Math.max(0, tot), life, c.pace, c.lifeCap / 100).level;
    if (L > prev) out[k] = L;
    prev = Math.max(prev, L);
  }
  return out;
}
// Recent averages from the ledger (for the drain graphs): XP per day and per week by type, the level, the clean streaks
export function gameStats(s, todayKey, z) {
  const g = s.game || {}, led = g.ledger || {};
  const keys = Object.keys(led).sort().filter((k) => k < todayKey).slice(-28);
  const day = { app: 0, busy: 0, life: 0 };
  for (const k of keys) { day.app += Math.max(0, led[k].a || 0); day.busy += Math.max(0, led[k].b || 0); day.life += Math.max(0, led[k].l || 0); }
  const est = !keys.length;
  for (const t of Object.keys(day)) day[t] = est ? { app: 25, busy: 120, life: 30 }[t] : day[t] / keys.length;
  const wks = Object.values(g.weeks || {}).slice(-4), wb = wks.length ? wks.reduce((a, w) => a + Math.max(0, w.b || 0), 0) / wks.length : 0;
  const week = { app: day.app * 7, busy: day.busy * 7 + wb, life: day.life * 7 };
  const level = levelAt(s, todayKey, z);
  const last = keys.length ? led[keys[keys.length - 1]] : null;
  const lastWk = Object.keys(g.weeks || {}).sort().pop();
  return { day, week, est, level, scale: drainScale(s, level), rank: tierOf(level), cleanDays: last?.cs || 0, cleanWeeks: lastWk ? g.weeks[lastWk].cs || 0 : 0 };
}
// For a drain: what each hour would cost now, and what keeping clean would win
export function drainCurve(s, d, st) {
  const c = cfg(s), types = d.types?.length ? d.types : ['app', 'busy', 'life'];
  const dayXP = types.reduce((a, t) => a + st.day[t], 0), weekXP = types.reduce((a, t) => a + st.week[t], 0);
  const tol = Math.max(+d.free || 0, +d.tol || 0);
  let H = Math.max(4, Math.ceil(tol) + 3);
  for (let h = Math.ceil(tol) + 1; h <= 12; h++) { H = Math.max(H, h); if (drainPct(d, h, st.scale) >= (+d.maxPct || 75)) break; }
  H = Math.min(12, H);
  const bars = [];
  for (let h = 1; h <= H; h++) {
    const pct = drainPct(d, h, st.scale);
    const base = d.per === 'day' || h <= tol + 1e-9 ? dayXP : weekXP;
    bars.push({ h, pct, xp: Math.round(base * pct / 100), whole: d.per !== 'day' && h > tol + 1e-9 });
  }
  const allDay = st.day.app + st.day.busy + st.day.life, allWeek = st.week.app + st.week.busy + st.week.life;
  const cap = cleanCap(s, st.level);
  const cd = Math.round(allDay * cleanPct(c.cleanDayPct, c.cleanDayStep, st.cleanDays + 1, cap) / 100);
  const cw = Math.round(allWeek * cleanPct(c.cleanWeekPct, c.cleanWeekStep, st.cleanWeeks + 1, cap) / 100);
  return { bars, cleanDay: cd, cleanWeek: cw, dayXP: Math.round(dayXP), weekXP: Math.round(weekXP) };
}
export function drainCurveSVG(cv, d) {
  const W = 300, Hh = 92, top = 14, base = 70, n = cv.bars.length + 1, bw = W / n;
  const mx = Math.max(1, cv.cleanDay + cv.cleanWeek, ...cv.bars.map((b) => b.xp));
  const y = (v) => base - (v / mx) * (base - top);
  const win = cv.cleanDay + (d.per === 'week' ? cv.cleanWeek : 0);
  const bar = (i, v, col, lab, sub, tip) => `<g><title>${tip}</title><rect x="${(i * bw + 3).toFixed(1)}" y="${y(v).toFixed(1)}" width="${(bw - 6).toFixed(1)}" height="${(base - y(v)).toFixed(1)}" rx="2" fill="${col}"/><text x="${(i * bw + bw / 2).toFixed(1)}" y="${(y(v) - 3).toFixed(1)}" text-anchor="middle" font-size="9" fill="currentColor">${lab}</text><text x="${(i * bw + bw / 2).toFixed(1)}" y="${base + 11}" text-anchor="middle" font-size="9" fill="currentColor" opacity=".7">${sub}</text></g>`;
  return `<svg class="dr-chart" viewBox="0 0 ${W} ${Hh}" width="100%" role="img" aria-label="XP each hour of ${d.name} would cost">
    <line x1="0" x2="${W}" y1="${base}" y2="${base}" stroke="currentColor" opacity=".25"/>
    ${bar(0, win, '#2e9b5b', '+' + win, 'none', `Not detected: +${cv.cleanDay} for a clean day${d.per === 'week' ? ` and +${cv.cleanWeek} for a clean week` : ''}`)}
    ${cv.bars.map((b, i) => bar(i + 1, b.xp, b.whole ? '#c0392b' : '#e67e22', b.xp ? '−' + b.xp : '0', b.h + ' h', `${b.h} h a ${d.per}: −${Math.round(b.pct)}% of ${b.whole ? 'the week' : d.per === 'week' ? 'each day you do it' : 'that day'} ≈ −${b.xp} XP${win ? `, and no clean bonus (+${win})` : ''}`)).join('')}
    <text x="0" y="${Hh - 2}" font-size="8.5" fill="currentColor" opacity=".7">hours a ${d.per} → XP it costs (orange: % of the day, red: % of the week)</text>
  </svg>`;
}
