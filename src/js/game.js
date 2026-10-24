// Game mode: experience points (XP) and levels 1–300.
//   App XP (blue)    — using Tempo: opening it each day (with a streak bonus), scheduling things, logging habits
//   Busy XP (orange) — getting things done: events attended, task sessions done (later sessions of a task are
//                      worth more), tasks and projects finished, full days, keeping to the plan, weekly fill bonus
//   Life XP (green)  — time in "life growth" categories you choose (reading, exercise…), sleep, leisure, habits, goals
// Scheduling earns a little; completing earns most. Rescheduling costs XP, more each time the same task slips.
// Past days are settled once into a ledger (settings.game.ledger, synced); today is worked out live.
import * as T from './tz.js';

// ---------- levels ----------
export const MAX_LEVEL = 300;
// XP to go from level L to L+1: quick at first (level 20 in about a week of regular use, 50 in about a month),
// then slower and slower.
export function need(L) {
  if (L < 20) return 120 + 10 * L;
  if (L < 50) return 300 + 11 * (L - 20);
  const d = L - 50;
  return Math.round(650 + 25 * d + 0.25 * d * d);
}
const CUM = [0, 0];
for (let L = 1; L <= MAX_LEVEL; L++) CUM[L + 1] = CUM[L] + need(L);
export const xpFor = (L) => CUM[Math.max(1, Math.min(MAX_LEVEL, L))];
// Part of all XP that must be life XP to go past level L — rising slowly, never more than a quarter.
export function lifeShare(L) {
  if (L <= 5) return 0;
  if (L <= 20) return 0.08 * (L - 5) / 15;
  if (L <= 50) return 0.08 + 0.07 * (L - 20) / 30;
  if (L <= 150) return 0.15 + 0.10 * (L - 50) / 100;
  return 0.25;
}
export const lifeFor = (L) => Math.round(xpFor(L) * lifeShare(L));
// Level from total XP and life XP. `capped`: enough XP for the next level, but not enough life XP yet.
export function levelOf(total, life) {
  let L = 1;
  while (L < MAX_LEVEL && total >= xpFor(L + 1)) L++;
  let lv = L;
  while (lv > 1 && life < lifeFor(lv)) lv--;
  const capped = lv < L;
  const next = Math.min(MAX_LEVEL, lv + 1);
  return { level: lv, into: total - xpFor(lv), span: xpFor(next) - xpFor(lv), capped, lifeNeed: capped ? lifeFor(lv + 1) - life : 0, nextLife: lifeFor(next), max: lv >= MAX_LEVEL };
}

// ---------- ranks (a name and an emblem for each major level) ----------
export const TIERS = [
  [1, 'Seedling', '🌱', '#7cb342'], [10, 'Sprout', '🌿', '#43a047'], [20, 'Apprentice Planner', '📒', '#00897b'],
  [30, 'Pathfinder', '🧭', '#039be5'], [40, 'Taskwright', '🛠️', '#3949ab'], [50, 'Timekeeper', '⏳', '#5e35b1'],
  [75, 'Chronicler', '📜', '#8e24aa'], [100, 'Chronomancer', '🔮', '#d81b60'], [125, 'Rhythm Knight', '🛡️', '#e53935'],
  [150, 'Habit Sage', '🦉', '#f4511e'], [175, 'Hourglass Warden', '⌛', '#fb8c00'], [200, 'Grand Strategist', '♟️', '#b8860b'],
  [225, 'Archmage of Hours', '🧙', '#6d4c41'], [250, 'Eternal Architect', '🏛️', '#546e7a'], [275, 'Celestial Navigator', '🌌', '#283593'],
  [300, 'Master of Time', '👑', '#c49a00'],
];
export const tierOf = (L) => { let t = TIERS[0], i = 0; TIERS.forEach((x, j) => { if (L >= x[0]) { t = x; i = j; } }); return { from: t[0], name: t[1], icon: t[2], color: t[3], index: i, next: TIERS[i + 1] || null }; };
// The rank's emblem: a crest in the rank's colour with its sign, a star per rank reached and the level on a ribbon.
export function emblemSVG(L, size = 64) {
  const t = tierOf(L), id = 'em' + L + '-' + size, n = t.index;
  const stars = Array.from({ length: Math.min(n, 15) }, (_, i) => { const a = Math.PI * (0.15 + (0.7 * i) / Math.max(1, Math.min(n, 15) - 1 || 1)); const x = 50 - 43 * Math.cos(a), y = 50 - 43 * Math.sin(a) + 4; return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="7" text-anchor="middle" fill="#ffd54f">★</text>`; }).join('');
  return `<svg class="g-emblem" width="${size}" height="${size}" viewBox="0 0 100 100" aria-label="${t.name}"><defs><radialGradient id="${id}" cx="40%" cy="32%" r="75%"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset=".45" stop-color="${t.color}"/><stop offset="1" stop-color="#1b1b2a"/></radialGradient></defs>
    <path d="M50 6 L86 20 L82 62 Q76 84 50 96 Q24 84 18 62 L14 20 Z" fill="url(#${id})" stroke="#ffd54f" stroke-width="${n >= 10 ? 4 : n >= 5 ? 3 : 2}"/>
    ${n >= 7 ? '<path d="M50 6 L86 20 L82 62 Q76 84 50 96 Q24 84 18 62 L14 20 Z" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="1" transform="translate(50 52) scale(.86) translate(-50 -52)"/>' : ''}
    ${stars}<text x="50" y="58" font-size="34" text-anchor="middle">${t.icon}</text>
    <rect x="26" y="70" width="48" height="16" rx="4" fill="#1b1b2a" stroke="#ffd54f" stroke-width="1.5"/><text x="50" y="82.5" font-size="11" font-weight="700" text-anchor="middle" fill="#ffd54f" font-family="system-ui, sans-serif">${L}</text></svg>`;
}

// ---------- XP for one event or task session ----------
const isLife = (it, g) => (g.lifeCats || []).includes(catOf(it)) || (g.lifeCats || []).includes(parentCat(it, g));
const catOf = (it) => (it.kind === 'chunk' ? it.task?.categoryId : it.catId) || null;
const parentCat = (it, g) => g._parents?.[catOf(it)] || null;
export const isSleepItem = (it, s) => !!(it.ev?.extendedProperties?.private?.tempoSleep || (s.sleepCategory && catOf(it) === s.sleepCategory) || /\bsleep\b|😴/i.test(it.title || ''));
const isRest = (it, s, g) => !isSleepItem(it, s) && ((g.restCats || []).includes(catOf(it)) || /^leisure$/i.test(catOf(it) || ''));
// What an item is worth when completed: { app, busy, life } and the reasons. `done` = it already counts.
export function itemXP(it, s, now = Date.now()) {
  const g = gameOf(s);
  const out = { app: 0, busy: 0, life: 0, why: [], done: false, kind: it.kind };
  if (it.allDay || it.declined) return out;
  const m = Math.max(0, Math.min(600, (it.end - it.start) / T.MIN));
  if (it.kind === 'chunk') {
    if (it.status === 'waived' || it.sess?.kind === 'waived') return out;
    const stage = Math.min(3, Math.pow(1.08, Math.max(0, (it.sess?.index || 1) - 1)));
    out.busy = Math.round((12 + 0.45 * m) * stage);
    out.why.push(`task session${(it.sess?.index || 1) > 1 ? ` ${it.sess.index}/${it.sess.count} (×${stage.toFixed(2)} for a later stage)` : ''}`);
    if (isLife(it, g)) { out.life = Math.round(0.55 * m * stage); out.why.push('life growth'); }
    out.done = it.status === 'done' || it.sess?.kind === 'done';
    return out;
  }
  if (isSleepItem(it, s)) {
    out.life = Math.round(Math.min(m, 540) * 0.1); out.why.push('sleep');
  } else {
    out.busy = Math.round(8 + 0.35 * Math.min(m, 480)); out.why.push('event');
    if (it.evDone) { out.busy = Math.round(out.busy * 1.2); out.why.push('ticked off'); }
    if (isLife(it, g)) { out.life = Math.round(0.5 * Math.min(m, 480)); out.why.push('life growth'); }
    else if (isRest(it, s, g)) { out.life = Math.round(0.15 * Math.min(m, 240)); out.why.push('leisure'); }
  }
  out.done = it.end <= now;
  return out;
}
export const sumXP = (x) => x.app + x.busy + x.life;
export function gameOf(s) {
  const g = s.game || {};
  const parents = {}; for (const c of s.categories || []) if (c.parent) parents[c.id] = c.parent;
  return { ...g, lifeCats: g.lifeCats || [], restCats: g.restCats || [], _parents: parents };
}

// ---------- a day's XP ----------
const BAD = new Set(['moved', 'skipped', 'undone', 'resched']);
// ctx: { items (events + sessions of the day and around it), tasks, projects, habits, goals (flat list with doneAt), history, active (days) }
export function dayXP(k, s, ctx, now = Date.now()) {
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
    if (c && c >= from && c < to && !it.ev?.extendedProperties?.private?.tempoSleep) { const x = itemXP(it, s, now); add('app', Math.max(4, Math.round(sumXP(x) * 0.2)), `scheduled “${it.title}”`); }
  }
  for (const t of ctx.tasks) if (t.created >= from && t.created < to) add('app', 12, `planned task “${t.title}”`);
  for (const p of ctx.projects) if (p.created >= from && p.created < to) add('app', 40, `started project “${p.name}”`);
  // finished tasks and projects
  for (const t of ctx.tasks) { const last = t._finishedAt; if (last >= from && last < to) add('busy', 40 + 8 * (t._sessions || 1), `finished “${t.title}”`); }
  for (const p of ctx.projectsDone || []) if (p.at >= from && p.at < to) add('busy', 200, `completed project “${p.name}”`);
  // habits and goals
  let hDone = 0, hTotal = 0;
  for (const h of ctx.habits) { hTotal++; if (ctx.habitDone(h, k)) { hDone++; add('life', 8, `habit: ${h.name}`); add('app', 2, `logged ${h.name}`); } }
  for (const gl of ctx.goals) if (gl.doneAt >= from && gl.doneAt < to) add('life', 30, `goal reached: ${gl.text}`);
  // using the app: a day you opened it, with a streak bonus
  if ((g.active || []).includes(k)) {
    let streak = 1; for (let d = T.addDays(k, -1); (g.active || []).includes(d) && streak < 30; d = T.addDays(d, -1)) streak++;
    add('app', 20 + Math.min(40, 4 * (streak - 1)), streak > 1 ? `day ${streak} in a row` : 'opened Tempo');
  }
  // a full day: at least half of the waking day (07–23) filled with things other than sleep
  const wake0 = T.atTime(k, '07:00', z), wake1 = T.atTime(k, '23:00', z);
  const occ = merge(mine.filter((it) => !isSleepItem(it, s) && it.end <= now + T.DAY).map((it) => [Math.max(it.start, wake0), Math.min(it.end, wake1)]).filter(([a, b]) => b > a));
  const fill = occ.reduce((a, [x, y]) => a + (y - x), 0) / (wake1 - wake0);
  if (to <= now && fill >= 0.5) add('busy', Math.round(40 + 80 * (Math.min(fill, 1) - 0.5)), `a full day (${Math.round(fill * 100)}% planned)`);
  // rescheduling costs XP — more each time the same task slips again within a week
  const hist = (ctx.history || []).filter((h) => BAD.has(h.kind) && h.at >= from && h.at < to);
  for (const h of hist) {
    const again = (ctx.history || []).filter((x) => BAD.has(x.kind) && x.taskId && x.taskId === h.taskId && x.at < h.at && x.at > h.at - 7 * T.DAY).length;
    const p = Math.min(40, 8 * (again + 1));
    r.pen += p; r.lines.push([`${again ? `rescheduled again (${again + 1}×)` : 'rescheduled'}${h.title ? `: ${h.title}` : ''}`, 'pen', -p]);
  }
  if (to <= now && !hist.length && doneN >= 1) add('busy', 25, 'kept to the plan');
  // daily quests
  const q = [
    { id: 'q-done', label: 'Complete 3 events or task sessions', have: doneN, goal: 3, xp: 30, type: 'busy' },
    { id: 'q-life', label: 'Spend 1 hour on life growth', have: Math.round(lifeMin), goal: 60, xp: 40, type: 'life', unit: 'min' },
    hTotal ? { id: 'q-habits', label: 'Tick off all your habits', have: hDone, goal: hTotal, xp: 25, type: 'life' }
      : { id: 'q-plan', label: 'Plan something for tomorrow', have: ctx.items.some((it) => it.start >= to && it.start < to + T.DAY && (Date.parse(it.ev?.created || '') >= from || it.kind === 'chunk')) ? 1 : 0, goal: 1, xp: 20, type: 'app' },
  ];
  for (const x of q) { x.ok = x.have >= x.goal; if (x.ok) add(x.type, x.xp, `quest: ${x.label}`); }
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
  const b = Math.round(300 * Math.min(1, fill)) + (pens <= 2 ? 100 : 0);
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
