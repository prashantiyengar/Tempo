// The weekly review as a broadsheet: "Der Zeitplan", a playful weekly newspaper about your own week —
// headlines from your time use, what got done, the books you read, a horoscope and the weather outlook.
// Everything is written on the fly from the review data; nothing leaves the browser.
import * as T from './tz.js';
import * as W from './weather.js';
import { esc } from './ui.js';
import * as PH from './phrases.js';

const fmtH = (m) => { const v = m / 60; return v >= 10 ? `${Math.round(v)} hours` : v >= 1 ? `${(Math.round(v * 10) / 10)} hours` : `${Math.round(m)} minutes`; };
const dur = (m) => T.fmtDur(Math.round(m));
const plural = (n, a, b = a + 's') => `${n} ${n === 1 ? a : b}`;

// deterministic "randomness" per week, so the paper doesn't change on every redraw
function rng(seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) { h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  return () => { h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return ((h ^= h >>> 16) >>> 0) / 4294967296; };
}
const pick = (r, list) => list[Math.floor(r() * list.length)];

function isoWeek(key) {
  const d = new Date(key + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((d - jan4) / 864e5 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
}

export const SIGNS = [
  ['aries', 'Aries', '♈', '03-21', 'fire'], ['taurus', 'Taurus', '♉', '04-20', 'earth'], ['gemini', 'Gemini', '♊', '05-21', 'air'],
  ['cancer', 'Cancer', '♋', '06-21', 'water'], ['leo', 'Leo', '♌', '07-23', 'fire'], ['virgo', 'Virgo', '♍', '08-23', 'earth'],
  ['libra', 'Libra', '♎', '09-23', 'air'], ['scorpio', 'Scorpio', '♏', '10-23', 'water'], ['sagittarius', 'Sagittarius', '♐', '11-22', 'fire'],
  ['capricorn', 'Capricorn', '♑', '12-22', 'earth'], ['aquarius', 'Aquarius', '♒', '01-20', 'air'], ['pisces', 'Pisces', '♓', '02-19', 'water'],
];
export function signOfDate(key) {
  const md = key.slice(5);
  let cur = SIGNS[9]; // Capricorn spans the new year
  for (const sg of [...SIGNS].sort((a, b) => a[3].localeCompare(b[3]))) if (md >= sg[3]) cur = sg;
  return cur;
}

const OPEN = {
  fire: ['Your fire burns bright this week.', 'Mars nudges you to charge ahead.', 'Boldness pays off — within reason.', 'The sun favours the first move.'],
  earth: ['Steady steps win the race.', 'Saturn rewards the patient planner.', 'You have solid ground under your feet.', 'Small, regular efforts add up.'],
  air: ['Ideas swirl around you.', 'Mercury favours good conversations.', 'A light breeze clears your desk.', 'Curiosity opens a door.'],
  water: ['Trust your instincts.', 'The moon asks you to pace yourself.', 'Deep focus comes easily now.', 'Let things flow, and they will.'],
};

function horoscope(r, s, use, signId) {
  const z = s.tz;
  const sg = SIGNS.find((x) => x[0] === signId) || signOfDate(T.dayKey(Date.now(), z));
  const rand = rng(r.reviewWeek + sg[0]);
  const days = Array.from({ length: 7 }, (_, i) => T.addDays(T.dayKey(r.nextFrom, z), i));
  const wd = (k) => T.format(T.dayStart(k, z), z, { weekday: 'long' });
  const total = days.reduce((a, k) => a + (r.load[k] || 0), 0);
  const busiest = days.reduce((a, k) => ((r.load[k] || 0) > (r.load[a] || 0) ? k : a), days[0]);
  const work = days.filter((k) => (s.bounds?.days || [1, 2, 3, 4, 5]).includes(T.weekday(k)));
  const lightest = (work.length ? work : days).reduce((a, k) => ((r.load[k] || 0) < (r.load[a] || 0) ? k : a), (work.length ? work : days)[0]);
  const parts = [pick(rand, OPEN[sg[4]])];
  if (!total) parts.push('The stars see an open week — no task sessions planned. Perfect for starting something new.');
  else parts.push(`The stars count ${dur(total)} of task time ahead; ${wd(busiest)} looks crowded (${dur(r.load[busiest] || 0)}), so guard your breaks.`);
  const hard = r.risks.filter((x) => !x.soft);
  parts.push(hard.length ? `Beware: “${hard[0].t.title}” needs attention before it bites.` : r.risks.length ? `“${r.risks[0].t.title}” is due soon — no drama if you start early.` : 'No deadline clouds on the horizon.');
  const lucky = 1 + Math.floor(rand() * 9);
  const top = use.groups[0];
  parts.push(`Lucky day: ${wd(lightest)}. Lucky number: ${lucky}.${top ? ` Lucky colour: whatever ${top.label.replace(/^\S+\s/, '')} wears.` : ''}`);
  return { sign: sg, text: parts.join(' ') };
}

function weatherBox(s, now) {
  const days = W.forecast(s);
  if (!days) return `<p class="np-small">Our weather desk is closed. Switch it on in Settings → General → Weather to get the outlook here.</p>`;
  const z = s.tz, today = T.dayKey(now, z);
  const keys = Array.from({ length: 7 }, (_, i) => T.addDays(today, i)).filter((k) => days[k]);
  if (!keys.length) return '<p class="np-small">No forecast yet — it arrives the next time you open the calendar.</p>';
  const u = s.weather.unit || 'C';
  const best = keys.reduce((a, k) => ((days[k].rain ?? 100) - (days[k].max ?? 0) < (days[a].rain ?? 100) - (days[a].max ?? 0) ? k : a), keys[0]);
  const rainy = keys.filter((k) => (days[k].rain ?? 0) >= 60).length;
  return `<table class="np-wx">${keys.map((k) => { const d = days[k], c = W.describeCode(d.code); return `<tr><td>${esc(T.format(T.dayStart(k, z), z, { weekday: 'short' }))}</td><td class="np-wx-i" title="${esc(c.text)}">${c.icon}</td><td>${W.temp(d.max, u)}</td><td class="np-mute">${W.temp(d.min, u)}</td><td class="np-mute">${d.rain != null ? d.rain + '%' : ''}</td></tr>`; }).join('')}</table>
    <p class="np-small">${rainy ? `${plural(rainy, 'day')} with a good chance of rain. ` : 'Mostly dry. '}Best day to be outside: <b>${esc(T.format(T.dayStart(best, z), z, { weekday: 'long' }))}</b>${s.weather.name ? ` (${esc(s.weather.name.split(',')[0])})` : ''}.</p>`;
}

// use: { groups: [{label, color, m}], occupied, free, available, busiest: {k, m} | null, scope }
export const PERIODS = {
  week: { label: 'Week', noun: 'week', this: 'this week', de: 'der Woche', ed: 'Wochenausgabe', cur: 'Ausgabe zur Wochenmitte' },
  fortnight: { label: 'Two weeks', noun: 'fortnight', this: 'these two weeks', de: 'der zwei Wochen', ed: 'Doppelausgabe', cur: 'Laufende Doppelausgabe' },
  month: { label: 'Month', noun: 'month', this: 'this month', de: 'des Monats', ed: 'Monatsausgabe', cur: 'Ausgabe zur Monatsmitte' },
  quarter: { label: 'Quarter', noun: 'quarter', this: 'this quarter', de: 'des Quartals', ed: 'Quartalsausgabe', cur: 'Laufende Quartalsausgabe' },
  year: { label: 'Year', noun: 'year', this: 'this year', de: 'des Jahres', ed: 'Jahresausgabe', cur: 'Laufende Jahresausgabe' },
};

// extras: { orn: {left, right, top, motto}, joke: {text, source, link}, quote: {text, by} } — picture and online
// horoscope are filled in afterwards (they load from the network) into .np-pic and .np-horo-live.
export function renderPaper({ r, s, use, now = Date.now(), signId = null, period = 'week', extras = {}, pics = [], goals = { blocks: [], next: [] }, projects = [], habits = [] }) {
  const z = s.tz;
  const P = PERIODS[period] || PERIODS.week;
  const rand = rng(r.reviewWeek + period);
  const de = (ms, o) => new Intl.DateTimeFormat('de-DE', { timeZone: z, ...o }).format(ms);
  const wkEndK = T.dayKey(r.weekEnd - 1, z);
  const nr = period === 'week' || period === 'fortnight' ? isoWeek(r.reviewWeek) : period === 'month' ? +r.reviewWeek.slice(5, 7) : period === 'quarter' ? `Q${Math.floor((+r.reviewWeek.slice(5, 7) - 1) / 3) + 1}` : r.reviewWeek.slice(0, 4);
  // headlines are about what you did — assumed sleep stays in the chart but doesn't make the news
  const newsy = use.groups.filter((g) => !/Sleep \(assumed\)/.test(g.label));
  const top = newsy[0], second = newsy[1];
  const awake = use.occupied - use.groups.filter((g) => /Sleep \(assumed\)/.test(g.label)).reduce((a, g) => a + g.m, 0);
  const share = top && awake > 0 ? Math.round((top.m / awake) * 100) : 0;
  const finished = [...r.completed.map((t) => ({ title: t.title, kind: 'task' })), ...r.doneEvents.map((e) => ({ title: e.title, kind: 'event', when: e.start }))];
  const sessions = r.sum.done + r.sum.partial;
  const pagesTotal = r.reading.reduce((a, x) => a + x.pages, 0);

  // ---- lead story: where the time went
  const topName = top ? top.label : '';
  const many = /[^s]s$/i.test(topName.trim()); // "Uncategorized tasks take…", "Work takes…"
  const v = (one, more) => (many ? more : one);
  const say = (tpl, vars = {}) => PH.say(rand, tpl, { noun: P.noun, ...vars });
  const K = (k) => say(PH.KICKERS[k], { de: P.de });
  const verbs = { rules: v('rules', 'rule'), dominates: v('dominates', 'dominate'), takes: v('takes', 'take'), edges: v('edges', 'edge'), leads: v('leads', 'lead') };
  const scopeW = awake < use.occupied ? 'the waking' : 'all';
  const lead = !top
    ? { kicker: K('lead'), h: say(PH.LEAD_QUIET), sub: say(PH.LEAD_QUIET_SUB) }
    : share >= 45
      ? { kicker: K('lead'), h: say(PH.LEAD_DOMINANT, { top: topName, ...verbs }), sub: say(PH.LEAD_DOMINANT_SUB, { share, scope: scopeW, top: topName, hours: fmtH(top.m) }) }
      : { kicker: K('lead'), h: second ? say(PH.LEAD_BALANCED, { top: topName, second: second.label, ...verbs }) : say(PH.LEAD_SINGLE, { top: topName, ...verbs }),
        sub: say(PH.LEAD_BALANCED_SUB, { top: topName, hours: fmtH(top.m), and2: second ? `, ${fmtH(second.m)} for ${second.label}` : '' }) };
  const busyTxt = use.busiest ? ' ' + say(PH.BUSIEST, { day: T.format(T.dayStart(use.busiest.k, z), z, { weekday: 'long' }), hours: fmtH(use.busiest.m) }) : '';
  const leadBody = top
    ? `Of ${fmtH(use.available)} ${esc(use.scope)}, ${fmtH(use.occupied)} were occupied and ${fmtH(use.free)} stayed free.${esc(busyTxt)} ${use.groups.length > 2 ? esc(say(PH.RUNNERS, { list: use.groups.slice(2, 5).map((g) => `${g.label} (${dur(g.m)})`).join(', ') })) : ''}`
    : `Of ${fmtH(use.available)} ${esc(use.scope)}, almost everything stayed free.`;
  // ---- commentary: stock analysis phrases chosen by what the numbers say
  const freePct = use.available > 0 ? Math.round((use.free / use.available) * 100) : null;
  const readMin = r.reading.reduce((a, x) => a + (x.minutes || 0), 0);
  const commentParts = [];
  if (freePct != null && use.occupied) commentParts.push(say(freePct >= 50 ? PH.FREE_HIGH : freePct >= 25 ? PH.FREE_MID : PH.FREE_LOW, { free: freePct }));
  if (r.sum.completion != null) commentParts.push(say(r.sum.completion >= 85 ? PH.COMPLETION.high : r.sum.completion >= 50 ? PH.COMPLETION.mid : PH.COMPLETION.low, { pct: r.sum.completion }));
  if (pagesTotal && readMin >= 20) commentParts.push(say(PH.READING_PACE, { pph: Math.round((pagesTotal / readMin) * 60) }));
  if (commentParts.length) commentParts.push(say(PH.COMMENT_CLOSE));
  const commentHTML = commentParts.length ? `<p class="np-comment"><b>${esc(K('comment'))}.</b> ${esc(commentParts.join(' '))}</p>` : '';
  const maxG = Math.max(1, ...use.groups.map((g) => g.m));

  // ---- business section: getting things done
  const comp = r.sum.completion;
  const bizH = say(!sessions && !finished.length ? PH.BIZ.none : comp != null && comp >= 85 ? PH.BIZ.high : comp != null && comp < 50 ? PH.BIZ.low : PH.BIZ.mid);
  const bizBody = `${plural(sessions, 'task session')} done${r.sum.partial ? ` (${r.sum.partial} of them partly)` : ''}${comp != null ? `, ${comp}% of what was planned` : ''}. ${finished.length ? `${plural(finished.length, 'item')} finished for good.` : 'Nothing was finished for good — yet.'} ${r.sum.slipped ? `${plural(r.sum.slipped, 'session')} slipped: ${r.sum.skipped} deleted, ${r.sum.undone} marked undone, ${r.sum.moved} pushed later.` : 'Nothing slipped.'}`;

  // ---- culture: books & events
  const books = r.reading.length
    ? `<h3 class="np-h3">${esc(say(PH.BOOKS, { pages: pagesTotal }))}</h3>
       <ul class="np-list">${r.reading.map((x) => `<li><i>${esc(x.t.title)}</i> — <b>${x.pages} pages</b>${x.minutes ? ` in ${dur(x.minutes)}` : ''}${x.total ? ` <span class="np-mute">(of ${x.total})</span>` : ''}</li>`).join('')}</ul>`
    : `<h3 class="np-h3">${esc(say(PH.NO_BOOKS))}</h3><p class="np-small">No reading sessions ${P.this}. Add a reading plan with 📖 and this column fills itself.</p>`;
  // events grouped by day
  const MAXEV = period === 'week' ? 30 : 60;
  const byDay = new Map();
  for (const e of r.allEvents.slice(0, MAXEV)) { const k = e.allDay ? e.startKey : T.dayKey(e.start, z); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(e); }
  const evRows = [...byDay.entries()].map(([k, list]) => `<div class="np-day"><div class="np-dayh">${esc(T.format(T.dayStart(k, z), z, period === 'week' ? { weekday: 'long', day: 'numeric' } : { weekday: 'short', day: 'numeric', month: 'short' }))}</div>
    <ul class="np-list np-plain">${list.map((e) => `<li><span class="np-mute">${e.allDay ? 'all day' : esc(T.fmtTime(e.start, z, s.h12))}</span> ${e.evDone ? '✓ ' : ''}${esc(e.title)}</li>`).join('')}</ul></div>`).join('');

  // the period's events get their own section across the page
  const wideTermine = !!s.reviewAllEvents;
  const termineBody = `${evRows ? `<div class="np-days">${evRows}</div>` : '<p class="np-small">No events.</p>'}${r.allEvents.length > MAXEV ? `<p class="np-small np-mute">…and ${r.allEvents.length - MAXEV} more.</p>` : ''}${r.skippedFrequent ? `<p class="np-small np-mute">Left out: ${plural(r.skippedFrequent, 'event')} repeating daily or 3+ times a week.</p>` : ''}`;
  const hz = horoscope(r, s, use, signId);
  // ---- goal progress: blocks (e.g. this week, this month), each with Work / Fitness / Personal
  const blocks = goals.blocks || [];
  const allG = (blocks[0]?.prog || []).flatMap((p) => p.goals), reached = allG.filter((g) => g.done).length;
  const gHead = !blocks.some((b) => b.prog.some((p) => p.goals.length)) ? say(PH.GOALS.none)
    : !allG.length ? say(PH.GOALS.progress)
      : reached === allG.length ? say(PH.GOALS.all, { n: allG.length })
        : say(reached * 2 >= allG.length ? PH.GOALS.most : PH.GOALS.few, { k: reached, n: allG.length });
  const bar = (p) => p.budget ? `<span class="np-gbar"><i style="width:${Math.min(100, (p.spent / p.budget) * 100)}%"></i></span>` : '';
  const headRow = (p) => (!p.goals.length && !p.spent) ? '' : `<div class="np-ghead"><div class="np-ghh"><b>${p.icon} ${esc(p.label)}</b> <span class="np-mute">${p.goals.length ? `${p.reached}/${p.goals.length} goals` : 'no goals'}${p.cats.length ? ` · ${dur(p.spent)}${p.budget ? ` of ${dur(p.budget)}` : ''}` : ''}</span>${bar(p)}</div>
    ${p.goals.length ? `<ol class="np-goal-list">${p.goals.slice(0, 5).map((g) => { const pg = (p.perGoal || []).find((q) => q.id === g.id); return `<li class="${g.done ? 'np-gdone' : ''}">${g.done ? '✓' : '○'} ${esc(g.text)}${pg && (pg.done || pg.planned) ? ` <span class="np-mute">(${dur(pg.done)}${pg.planned ? ` + ${dur(pg.planned)} scheduled` : ''}${g.budget ? ` of ${dur(g.budget)}` : ''})</span>` : ''}</li>`; }).join('')}${p.goals.length > 5 ? `<li class="np-mute">…${p.goals.length - 5} more</li>` : ''}</ol>` : ''}</div>`;
  const goalsHTML = `<h3 class="np-h3">${esc(gHead)}</h3>
    ${blocks.length && blocks.some((b) => b.prog.some((p) => p.goals.length || p.spent)) ? blocks.map((b) => { const rows = b.prog.map(headRow).join(''); return rows ? `<h4 class="np-h4">${esc(b.label)}</h4>${rows}` : ''; }).join('')
      : `<p class="np-small">Set goals under Work, Fitness and Personal in the <b>Goals</b> tab, and the paper will report on them.</p>`}
    ${goals.next?.length ? `<h4 class="np-h4">Coming up</h4>${goals.next.slice(0, 2).map((x) => `<p class="np-small"><i>${esc(x.label)}:</i> ${x.list.slice(0, 3).map((g, i) => `${i + 1}. ${esc(g.text)}`).join(' · ')}${x.list.length > 3 ? ' …' : ''}</p>`).join('')}` : ''}`;
  // ---- projects: time put in this period, steps finished, overall progress, what's next
  const pjActive = projects.filter((x) => x.done || x.finished.length);
  const pjDone = projects.find((x) => x.completedNow);
  const pjHours = projects.reduce((a, x) => a + x.done, 0);
  const projH = !projects.length ? say(PH.PROJ_H.none) : pjDone ? say(PH.PROJ_H.finished, { name: pjDone.name }) : pjActive.length ? say(PH.PROJ_H.active, { projects: plural(pjActive.length, 'project'), hours: fmtH(pjHours) }) : say(PH.PROJ_H.quiet);
  const projHTML = !projects.length ? '' : `<section class="np-proj">
        <span class="np-kicker">${esc(K('proj'))}</span>
        <h3 class="np-h3">${esc(projH)}</h3>
        ${projects.map((x) => `<div class="np-pj"><div class="np-ghh"><b>📁 ${esc(x.name)}</b> <span class="np-mute">${x.complete ? 'complete' : `${x.pct}% · ${x.steps}`}${x.done ? ` · ${dur(x.done)} ${P.this}` : ''}</span><span class="np-gbar"><i style="width:${x.pct}%"></i></span></div>
          ${x.finished.length ? `<p class="np-small">✓ ${x.finished.map((t) => esc(t)).join(' · ')}</p>` : ''}
          ${x.next && !x.complete ? `<p class="np-small np-mute">Next: ${esc(x.next.title)}${x.next.at ? ` (${esc(T.format(x.next.at, z, { weekday: 'short', day: 'numeric', month: 'short' }))})` : ''}${x.late ? ' — <b>behind schedule</b>' : ''}</p>` : ''}</div>`).join('')}
      </section>`;
  // ---- habits: kept / expected this period, score, streak, a square per day
  const hbPct = habits.length ? Math.round(habits.reduce((a, x) => a + x.pct, 0) / habits.length) : 0;
  const hbBest = habits.length ? [...habits].sort((a, b) => b.streak - a.streak || b.score - a.score)[0] : null;
  const habitHTML = !habits.length ? '' : `<section class="np-habits">
        <span class="np-kicker">${esc(K('habits'))}</span>
        <h3 class="np-h3">${esc(say(hbPct >= 75 ? PH.HABIT_H.strong : hbPct >= 40 ? PH.HABIT_H.mid : PH.HABIT_H.weak, { pct: hbPct, best: hbBest?.name || '', streak: hbBest?.streak ? `${hbBest.streak}-${hbBest.streakUnit}` : '' }))}</h3>
        ${habits.map((x) => `<div class="np-hb"><div class="np-ghh"><b>${esc(x.name)}</b> <span class="np-mute">${x.number ? `${x.done} / ${x.expected} ${esc(x.unit)}` : `${x.done} of ${x.expected} ${+x.expected === 1 ? 'time' : 'times'}`} · score ${Math.round(x.score * 100)}%${x.change ? ` (${x.change > 0 ? '+' : ''}${Math.round(x.change * 100)})` : ''}${x.streak ? ` · streak ${x.streak} ${x.streakUnit}${x.streak === 1 ? '' : 's'}` : ''}</span></div>
          ${x.days.length ? `<div class="np-hbdays">${x.days.map((d) => `<i class="${d.v === 1 ? 'd' : d.v === -1 ? 's' : d.v > 0 ? 'p' : ''}" title="${esc(d.k)}"></i>`).join('')}</div>` : ''}</div>`).join('')}
      </section>`;
  const days = Array.from({ length: 7 }, (_, i) => T.addDays(T.dayKey(r.nextFrom, z), i));
  const maxL = Math.max(60, ...Object.values(r.load));
  const kindTxt = { skipped: 'was deleted', undone: 'was marked undone', moved: 'was pushed later' };

  return `<article class="np">
    <header class="np-mast">
      <div class="np-ears"><span>Nr. ${nr} · ${r.isCurrent ? P.cur : P.ed}</span><span>Preis: ${Math.round((r.weekEnd - r.from) / T.HOUR)} Stunden</span></div>
      ${extras.orn ? `<div class="np-crown">${extras.orn.top}</div>` : ''}
      <div class="np-titlerow">${extras.orn ? extras.orn.left : ''}<h1 class="np-title">${esc(s.paperName || 'Der Zeitplan')}</h1>${extras.orn ? extras.orn.right : ''}</div>
      ${extras.orn ? `<div class="np-motto"><span>${esc(extras.orn.motto)}</span></div>` : ''}
      <div class="np-tag">Wochenzeitung für Ihre Zeit · ${esc(de(r.from, { day: 'numeric', month: 'long' }))} – ${esc(de(T.dayStart(wkEndK, z), { day: 'numeric', month: 'long', year: 'numeric' }))}</div>
    </header>
    <div class="np-grid">
      <section class="np-lead">
        <span class="np-kicker">${esc(lead.kicker)}</span>
        <h2 class="np-h1">${esc(lead.h)}</h2>
        <p class="np-sub">${esc(lead.sub)}</p>
        <div class="np-cols"><p class="np-drop">${leadBody}</p>
          ${commentHTML}
          ${use.groups.length ? `<figure class="np-fig"><figcaption>Where the hours went</figcaption>${use.groups.slice(0, 6).map((g) => `<div class="np-bar"><span>${esc(g.label)}</span><i style="width:${(g.m / maxG) * 100}%;--c:${esc(g.color)}"></i><b>${dur(g.m)}</b></div>`).join('')}</figure>` : ''}
        </div>
      </section>
      <aside class="np-side">
        <span class="np-kicker">${esc(K('weather'))}</span>
        <h3 class="np-h3">${esc(say(PH.WEATHER_H))}</h3>
        ${weatherBox(s, now)}
        <hr>
        <span class="np-kicker">${esc(K('horoscope'))}</span>
        <h3 class="np-h3">${hz.sign[2]} ${esc(hz.sign[1])}</h3>
        <p class="np-small">${esc(hz.text)}</p>
        <div class="np-horo-live"></div>
        <label class="np-sign">Your sign: <select data-np="sign"><option value="">${esc(signOfDate(T.dayKey(now, z))[1])} (season)</option>${SIGNS.map((x) => `<option value="${x[0]}" ${signId === x[0] ? 'selected' : ''}>${x[2]} ${x[1]}</option>`).join('')}</select></label>
      </aside>
      <section class="np-biz">
        <span class="np-kicker">${esc(K('biz'))}</span>
        <h3 class="np-h2">${esc(bizH)}</h3>
        <p>${esc(bizBody)}</p>
        ${finished.length ? `<h4 class="np-h4">Finished ${P.this}</h4><ul class="np-list np-check">${finished.slice(0, 12).map((x) => `<li>✓ ${esc(x.title)}${x.kind === 'event' ? ' <span class="np-mute">(event)</span>' : ''}</li>`).join('')}${finished.length > 12 ? `<li class="np-mute">…and ${finished.length - 12} more</li>` : ''}</ul>` : ''}
      </section>
      <section class="np-pic-s">
        <span class="np-kicker">${esc(K('pic'))}</span>
        <div class="np-pic"><p class="np-small np-mute">Fetching a picture…</p></div>
        <div class="np-pic-tools"><button type="button" class="link np-pic-new">Another picture</button><span ${pics.length ? '' : 'hidden'}> · <button type="button" class="link np-pic-hist">Picture archive (${pics.length})</button></span></div>
      </section>
      <section class="np-feuil">
        <span class="np-kicker">${esc(K('feuil'))}</span>
        ${books}
        ${s.reviewAllEvents && !wideTermine ? `<h4 class="np-h4">Termine ${P.de}</h4>${termineBody}` : ''}
      </section>
      ${wideTermine ? `<section class="np-termine"><span class="np-kicker">${esc(K('termine'))}</span>${termineBody}</section>` : ''}
      <section class="np-goals">
        <span class="np-kicker">${esc(K('goals'))}</span>
        ${goalsHTML}
      </section>
      ${projHTML}
      ${habitHTML}
      <section class="np-words">
        <span class="np-kicker">${esc(K('words'))}</span>
        ${extras.quote ? `<blockquote class="np-quote">“${esc(extras.quote.text)}”<cite>— ${esc(extras.quote.by)}</cite></blockquote>` : ''}
        <button type="button" class="link np-quote-new">Another thought</button>
        <hr>
        <span class="np-kicker">${esc(K('joke'))}</span>
        ${extras.joke ? `<p class="np-joke">${esc(extras.joke.text)}</p>${extras.joke.link ? `<p class="np-small np-mute">From <a href="${esc(extras.joke.link)}" target="_blank" rel="noopener">${esc(extras.joke.source)}</a></p>` : ''}` : ''}
        <button type="button" class="link np-joke-new">Another joke</button>
      </section>
      <section class="np-out">
        <span class="np-kicker">${esc(K('out'))}</span>
        <h3 class="np-h3">${esc(say(r.risks.filter((x) => !x.soft).length ? PH.OUT_RISK : PH.OUT_CLEAR))}</h3>
        ${r.risks.length ? `<ul class="np-list">${r.risks.slice(0, 6).map((x) => `<li class="${x.soft ? '' : 'np-bad'}"><b>${esc(x.t.title)}</b> — ${esc(x.why)} <button class="link rv-open" data-task="${esc(x.t.id)}">open</button></li>`).join('')}</ul>` : '<p class="np-small">Nothing looks at risk.</p>'}
        <div class="np-load">${days.map((k) => { const m = r.load[k] || 0; return `<div><i style="height:${(m / maxL) * 100}%" title="${dur(m)}"></i><span>${esc(T.format(T.dayStart(k, z), z, { weekday: 'narrow' }))}</span></div>`; }).join('')}</div>
        <p class="np-small np-mute">Task time planned per day next week.</p>
      </section>
      <section class="np-corr">
        <span class="np-kicker">${esc(K('corr'))}</span>
        ${r.slips.length ? `<p class="np-small">${esc(say(PH.CORR_INTRO, { period: P.this === 'this week' ? 'the week' : P.this.replace('this ', 'the ').replace('these', 'the'), items: r.slips.length === 1 ? 'item' : 'items' }))} ${r.slips.slice(-6).map((x) => `“${esc(x.title || 'a session')}” ${kindTxt[x.kind]}${x.by ? ` by ${dur(x.by)}` : ''}`).join('; ')}. ${esc(say(PH.CORR_OUTRO))}</p>` : `<p class="np-small">${esc(say(PH.CORR_NONE))}</p>`}
        ${r.sum.overrun ? `<p class="np-small">Also: ${plural(r.sum.overrun, 'session')} ran over time.</p>` : ''}
      </section>
    </div>
    ${pics.length ? `<details class="np-archive"><summary>Bildarchiv — pictures shown before (${pics.length})</summary><ol>${pics.map((x) => `<li><a href="${esc(x.page)}" target="_blank" rel="noopener">${esc(x.title)}</a>${x.year ? ` <span class="np-mute">(${x.year})</span>` : ''} <span class="np-mute">· ${esc(T.format(x.at, z, { day: 'numeric', month: 'short' }))}</span></li>`).join('')}</ol></details>` : ''}
    <footer class="np-foot">${esc(s.paperName || 'Der Zeitplan')} is written by Tempo from your calendar · not affiliated with any real newspaper</footer>
  </article>`;
}

export function pictureHTML(pic) {
  if (!pic) return '<p class="np-small np-mute">The archive is closed today — no picture could be fetched. Try “Another picture”.</p>';
  const cap = [pic.artist, pic.year].filter(Boolean).join(', ');
  const ar = pic.w && pic.h ? ` width="${pic.w}" height="${pic.h}" style="aspect-ratio:${pic.w} / ${pic.h}"` : '';
  return `<figure class="np-figure"><a href="${esc(pic.page)}" target="_blank" rel="noopener"><img src="${esc(pic.thumb)}" alt="${esc(pic.title)}"${ar} decoding="async"></a>
    <figcaption><b>${esc(pic.title)}</b>${cap ? ` — ${esc(cap)}` : ''}${pic.desc && pic.desc !== pic.title ? `<br><span class="np-mute">${esc(pic.desc)}</span>` : ''}<br><span class="np-mute">${/wikimedia/.test(pic.page || '') ? 'Wikimedia Commons · ' : ''}${esc(pic.license)}</span></figcaption></figure>`;
}
