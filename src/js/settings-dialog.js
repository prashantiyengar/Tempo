// The Settings dialog (all tabs).
import * as T from './tz.js';
import * as S from './scheduler.js';
import * as G from './gcal.js';
import { LOCAL_CAL } from './engine.js';
import { $, $$, esc, modal, setHTML, linkRange } from './ui.js';
import * as C from './categories.js';
import * as AC from './accounts.js';
import * as N from './notify.js';
import * as A from './analysis.js';
import * as W from './weather.js';
import * as XT from './extras.js';
import * as GM from './game.js';
import * as SC from './scopes.js';
import { driveBoxHTML } from './backup.js';
import { DAYN, catPick, describeDays, sect, tzDatalist, weekdayToggles, wireCatPick, wireSects } from './dialogs.js';

// ======================================================================================
// Settings
// ======================================================================================
const isWebApp = () => !(globalThis.browser ?? globalThis.chrome)?.runtime?.id;
// The plain settings, one line each: [setting, form field, kind, limits]. Saving reads them all the same way.
//   chk: a checkbox · str: text / select (empty: `empty`, else `def`) · int: a whole number from a select ·
//   num: a number — empty gives `empty` (or `def`), 0 gives `def` unless `zero` is allowed; then `min` / `max`, `round`
const FIELDS = [
  ['weekStart', 'weekStart', 'int'], ['weekView', 'weekView', 'str'], ['h12', 'h12', 'flag'], ['keepOn', 'keepOn', 'chk'],
  ['hourHeight', 'hourHeight', 'num', { min: 28, max: 120, def: 48 }], ['snapMinutes', 'snapMinutes', 'int'], ['defaultEventMinutes', 'defaultEventMinutes', 'num', { def: 60 }],
  ['chunkMinutes', 'chunkMinutes', 'num', { min: 5, def: 60 }], ['minChunkMinutes', 'minChunkMinutes', 'num', { min: 5, empty: null }],
  ['breakMinutes', 'breakMinutes', 'num', { min: 0, def: 0 }], ['wiggleMinutes', 'wiggleMinutes', 'num', { min: 0, empty: 15, zero: true }],
  ['sinceLastBuffer', 'sinceLastBuffer', 'num', { min: 0, max: 15, def: 0, round: true }], ['tillNextBuffer', 'tillNextBuffer', 'num', { min: 0, max: 15, def: 0, round: true }],
  ['paperScope', 'paperScope', 'str'], ['goalNotice', 'goalNotice', 'chk'], ['goalNoticeAt', 'goalNoticeAt', 'str', { def: '09:00' }],
  ['sleepEvents', 'sleepEvents', 'chk'], ['sleepCal', 'sleepCal', 'str'], ['sleepAssume', 'sleepAssume', 'chk'], ['sleepCategory', 'sleepCategory', 'str', { empty: null }],
  ['sleepStart', 'sleepStart', 'str', { def: '23:00' }], ['sleepEnd', 'sleepEnd', 'str', { def: '07:00' }], ['sleepDelayMin', 'sleepDelayMin', 'num', { min: 0, def: 0 }],
  ['dailyCapMinutes', 'dailyCapMinutes', 'num', { min: 0, def: 0 }], ['marginDays', 'marginDays', 'num', { min: 0, def: 0 }], ['travelMinutes', 'travelMinutes', 'num', { min: 0, def: 0 }],
  ['repeatHorizonDays', 'repeatHorizonDays', 'num', { min: 7, def: 28 }], ['learnSpeed', 'learnSpeed', 'chk'],
  ['sessionWarn', 'sessionWarn', 'num', { min: 0, def: 0 }], ['sessionMax', 'sessionMax', 'num', { min: 0, def: 0 }], ['maxSpanDays', 'maxSpanDays', 'num', { min: 0, def: 0 }],
  ['assumePastDone', 'assumePastDone', 'chk'], ['allDayBlocks', 'allDayBlocks', 'chk'], ['syncTasksToGoogle', 'syncTasksToGoogle', 'chk'], ['taskCalendarId', 'taskCalendarId', 'str', { empty: null }],
  ['notifyTasks', 'notifyTasks', 'chk'], ['notifyLocal', 'notifyLocal', 'chk'], ['notifyGoogle', 'notifyGoogle', 'chk'],
  ['driveBackup', 'driveBackup', 'chk'], ['eventProfile', 'eventProfile', 'str'], ['taskProfile', 'taskProfile', 'str'], ['hoursChange', 'hoursChange', 'str'], ['askCategory', 'askCategory', 'chk'],
];
export function readField(el, kind, o = {}) {
  if (kind === 'chk') return el.checked;
  const v = el.value;
  if (kind === 'flag') return v === '1';
  if (kind === 'int') return +v;
  if (kind === 'str') return v === '' ? (o.empty !== undefined ? o.empty : (o.def ?? '')) : v;
  let n;
  if (v === '') { if (o.empty !== undefined) return o.empty; n = o.def ?? 0; }
  else { n = +v; if (!Number.isFinite(n) || (!n && !o.zero)) n = o.def ?? 0; }
  if (o.round) n = Math.round(n);
  if (o.min != null) n = Math.max(o.min, n);
  if (o.max != null) n = Math.min(o.max, n);
  return n;
}
export const readFields = (f, fields = FIELDS) => Object.fromEntries(fields.filter(([, name]) => f[name]).map(([key, name, kind, o]) => [key, readField(f[name], kind, o)]));
export function settingsDialog(ctx) {
  const st = ctx.state, s = st.settings;
  const auth = st.auth || {};
  const redirect = G.redirectUri();
  const cals = (st.gmeta.calendars || []).filter((c) => ['owner', 'writer'].includes(c.accessRole));
  const allCals = [{ id: LOCAL_CAL, summary: 'Local (this browser)' }, ...(st.gmeta.calendars || [])];
  const busySet = new Set(s.busyCalendars || allCals.map((c) => c.id));
  const agendaCal = (st.gmeta.calendars || []).find((c) => c.id === (s.taskCalendarId || '')) || (st.gmeta.calendars || []).find((c) => c.primary);
  const agendaOn = !!agendaCal?.notificationSettings?.notifications?.some((n) => n.type === 'agenda' && n.method === 'email');
  let cats = C.ordered(s).map((c) => ({ ...c })); // alphabetical, sub-categories under their main one
  let periods = (s.periods || []).map((p) => ({ ...p, rules: p.rules.map((r) => ({ ...r, days: [...r.days] })) }));
  const fills = (s.autoFills || []).map((r) => ({ ...r, days: [...(r.days || [0, 1, 2, 3, 4, 5, 6])] }));
  let projects = (s.projects || []).map((p) => ({ ...p }));
  let wx = { unit: W.defaultUnit(s.tz), ...(s.weather || {}) };
  let leave = { ...(s.leave || {}) };
  let drains = (s.game?.drains || []).map((d) => ({ ...d, cats: [...(d.cats || [])], words: [...(d.words || [])], types: [...(d.types || ['app', 'busy', 'life'])] }));
  const boosts = (s.game?.boosts || []).map((b) => ({ ...b, cats: [...(b.cats || [])], words: [...(b.words || [])] }));
  let picSrc = (s.picSources?.length ? s.picSources : XT.DEFAULT_SOURCES).map((x) => ({ ...x }));
  let nprofiles = N.profiles(s).map((p) => ({ ...p, rules: p.rules.map((r) => ({ ...r })) }));
  const tp = s.timePrefs || S.DEFAULT_SETTINGS.timePrefs;
  const html = `
  <form class="settings-form">
    <header class="dlg-head"><h2>Settings</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></header>
    <nav class="tabs">${[['General', 0], ['Scheduling', 1], ['Categories', 5], ['Google Calendar', 2], ['Other calendars', 6], ['Notifications', 3], ['Review & goals', 7], ['Data', 4]].map(([n, i]) => `<button type="button" data-tab="${i}" class="${i ? '' : 'on'}">${n}</button>`).join('')}</nav>
    <div class="dlg-body">
      <section data-pane="0">
        <label class="field"><span>Display time zone</span><input name="tz" list="tzlist2" value="${esc(s.tz)}" spellcheck="false"></label>${tzDatalist('tzlist2')}
        ${sect('s-display', 'Calendar display', `<div class="grid3">
          <label class="field"><span>Week view shows</span><select name="weekView"><option value="calendar">Calendar week</option><option value="rolling" ${s.weekView === 'rolling' ? 'selected' : ''}>Today + next 6 days</option></select></label>
          <label class="field"><span>Week starts on</span><select name="weekStart"><option value="1">Monday</option><option value="0" ${s.weekStart === 0 ? 'selected' : ''}>Sunday</option><option value="6" ${s.weekStart === 6 ? 'selected' : ''}>Saturday</option></select></label>
          <label class="field"><span>Time format</span><select name="h12"><option value="0">24-hour</option><option value="1" ${s.h12 ? 'selected' : ''}>12-hour</option></select></label>
          <label class="field"><span>Hour height (px)</span><input type="number" name="hourHeight" min="28" max="120" value="${s.hourHeight}"></label>
          <label class="field"><span>Drag snapping (min)</span><select name="snapMinutes">${[5, 10, 15, 30, 60].map((v) => `<option ${v === s.snapMinutes ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        </div>
        <label class="chk"><input type="checkbox" name="keepOn" ${s.keepOn ? 'checked' : ''}> Google Keep in the sidebar — <span class="muted small">buttons for a new note and your notes (Google doesn't let other sites show Keep inside them, so it opens in a small window beside Tempo)</span></label>`)}
        ${sect('s-events', 'New events', `<div class="grid3">
          <label class="field"><span>Default event length (min)</span><input type="number" name="defaultEventMinutes" min="5" step="5" value="${s.defaultEventMinutes}"></label>
          <label class="field"><span>“Since last event” starts this many minutes after it (0–15)</span><input type="number" name="sinceLastBuffer" min="0" max="15" step="1" value="${s.sinceLastBuffer || 0}"></label>
          <label class="field"><span>“Till next event” ends this many minutes before it (0–15)</span><input type="number" name="tillNextBuffer" min="0" max="15" step="1" value="${s.tillNextBuffer ?? s.sinceLastBuffer ?? 0}"></label>
        </div>`)}
        ${sect('s-sleep', 'Sleep', `
          <label class="chk"><input type="checkbox" name="sleepEvents" ${s.sleepEvents ? 'checked' : ''}> Add a sleep block to my calendar for each night that has passed, in the hours below — around anything already there (an event from 2–3 am gives sleep before and after it)</label>
          <label class="field"><span>Sleep blocks go on</span><select name="sleepCal"><option value="default">My main calendar</option><option value="local" ${s.sleepCal === 'local' ? 'selected' : ''}>Local (this browser only)</option></select></label>
          <label class="chk"><input type="checkbox" name="sleepAssume" ${s.sleepAssume !== false ? 'checked' : ''}> Count this time as sleep on nights with nothing else in it (Analysis covers the full 24 hours)</label>
          <div class="row"><input type="time" name="sleepStart" value="${esc(s.sleepStart || '23:00')}" step="900"> <span class="muted">to</span> <input type="time" name="sleepEnd" value="${esc(s.sleepEnd || '07:00')}" step="900"></div>
          <label class="field"><span>Counts as category</span><select name="sleepCategory">${A.sleepCatOptions(s)}</select></label>
          <label class="field sl-delay"><span>Add each sleep block this many minutes after the night ends (0 = right away)</span><input type="number" name="sleepDelayMin" min="0" max="720" step="5" value="${+s.sleepDelayMin || 0}"></label>`)}
        ${sect('s-fills', 'Fill-in blocks', `<p class="muted small" style="margin:0">Fill unplanned time automatically: once a window is over (e.g. 18:00–20:00), each gap of 15 minutes or more in it becomes an event of the category you choose — with a shopping trip 19:00–19:30 you get “Childcare” 18:00–19:00 and 19:30–20:00.</p>
          <div class="fills-list"></div>
          <button type="button" class="btn small add-fill">+ Add fill-in block</button>`)}
        ${sect('s-game', 'Game mode', (() => {
          const g = s.game || {};
          const guess = (c) => /read|book|study|learn|course|sport|exercise|fitness|gym|run|health|practi|music|language|meditat|yoga/i.test(c.name);
          const life = new Set(g.lifeCats?.length ? g.lifeCats : C.ordered(s).filter(guess).map((c) => c.id));
          const rest = new Set(g.restCats?.length ? g.restCats : C.ordered(s).filter((c) => /leisure|free|fun|social|hobby|family/i.test(c.name)).map((c) => c.id));
          return `<label class="chk"><input type="checkbox" name="gameOn" ${g.on ? 'checked' : ''}> Play Tempo as a game: earn XP for planning and doing things, and level up from 1 to 300</label>
          <label class="field"><span>Count XP from <em class="muted">(a date in the past counts what's already on your calendar, up to 180 days back)</em></span><input type="date" data-quick="off" name="gameStart" value="${esc(g.started || T.dayKey(Date.now(), s.tz))}" max="${T.dayKey(Date.now(), s.tz)}"></label>
          <div class="field"><span>Life-growth categories — they earn <b style="color:#2e9b5b">life XP</b></span>
            <p class="muted small g-life-why" style="margin:0 0 4px">Life XP is for actions that transform you or move your life goals forward — the kind that, over months, upgrade you: learning a language, training for a race, writing, therapy, deep practice. You won't spend many hours a week on them, so choose these categories carefully: even short spells count for a lot, and their value never wears off. Busy time, leisure and everything else count for less and less after your first week (about a third after a month), so a higher level shows that you've grown — not just that you kept busy.</p><div class="game-life">${catPick(s, 'gl-c', life)}</div>
            <div class="gl-weights"></div></div>
          <div class="field"><span>Leisure categories — a little life XP for rest</span><div class="game-rest">${catPick(s, 'gr-c', rest)}</div></div>
          <div class="field"><span>Categories that never score</span><div class="game-no">${catPick(s, 'gn-c', g.noCats || [])}</div><span class="muted small gn-auto"></span></div>
          <div class="field"><span>XP drains — activities that cost XP (e.g. gaming) <em class="muted">(changing them counts all days again)</em></span><div class="drain-list"></div><button type="button" class="btn small add-drain">+ Add a drain</button></div>
          <div class="field"><span>Bonus activities — they earn extra XP, e.g. for the next two weeks <em class="muted">(changing them counts all days again)</em></span><div class="boost-list"></div><button type="button" class="btn small add-boost">+ Add a bonus activity</button></div>
          <details class="game-adv"><summary class="small"><b>Advanced</b> — adjust the points and the pace</summary>
            <div class="game-cfg">${GM.CFG.map(([k, label, d, lo, hi, step]) => `<label class="field"><span>${esc(label)} <em class="muted">(default ${d})</em></span><input type="number" class="gc-v num" data-k="${k}" min="${lo}" max="${hi}" step="${step}" value="${g.cfg?.[k] ?? d}"></label>`).join('')}</div>
            <button type="button" class="btn small ghost gc-reset">Back to the defaults</button>
            <p class="muted small" style="margin:0">Changing these counts all your days again with the new values.</p>
          </details>
          <p class="muted small" style="margin:0">Sleep counts a little (your sleep blocks or sleep category). Progress is kept with your settings, so it follows you to your other devices.</p>`;
        })())}
        ${sect('s-weather', 'Weather', `
          <label class="chk"><input type="checkbox" name="wxOn" ${wx.on ? 'checked' : ''}> Show the forecast at the top of each of the next 14 days</label>
          <div class="row wx-find-row"><input name="wxPlace" placeholder="City, e.g. Berlin" value="${esc(wx.name || '')}" autocomplete="off"><button type="button" class="btn small wx-find">Find</button><button type="button" class="btn small ghost wx-here">📍 My location</button></div>
          <div class="wx-results small">${wx.lat != null ? `Forecast for <b>${esc(wx.name || 'your location')}</b>` : '<span class="muted">Choose a place first.</span>'}</div>
          <label class="field"><span>Temperature in</span><select name="wxUnit"><option value="C" ${wx.unit !== 'F' ? 'selected' : ''}>°C — Celsius</option><option value="F" ${wx.unit === 'F' ? 'selected' : ''}>°F — Fahrenheit</option></select></label>
          <label class="field"><span>Forecast model</span><select name="wxModel">${W.MODELS.map(([v, l]) => `<option value="${v}" ${(wx.model || 'best_match') === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
          <p class="muted small" style="margin:0">Forecasts from Open-Meteo (free, no account). Only the place's coordinates are sent.</p>`, { cls: 'wx-box' })}
      </section>
      <section data-pane="1" hidden>
        ${sect('s-hours', 'Work hours', `<div class="row"><input type="time" name="bStart" value="${s.bounds.start}" step="900"> <span class="muted">to</span> <input type="time" name="bEnd" value="${s.bounds.end}" step="900"></div>
          ${weekdayToggles('bdays', s.bounds.days)}
          <label class="field"><span>When I change these hours or a time period</span><select name="hoursChange">
            <option value="ask" ${(s.hoursChange || 'ask') === 'ask' ? 'selected' : ''}>Ask me</option>
            <option value="move" ${s.hoursChange === 'move' ? 'selected' : ''}>Move planned sessions to fit the new hours</option>
            <option value="keep" ${s.hoursChange === 'keep' ? 'selected' : ''}>Keep planned sessions where they are (only new planning uses the new hours)</option>
          </select></label>`)}
        ${sect('s-leave', 'Leave days', `<p class="muted small" style="margin:0">Days off: task sessions are not planned on them (unless a task or its time period includes leave days). You can also click the weekday name above a day in the calendar.</p>
          <div class="leave-list"></div>
          <div class="row leave-add"><input type="date" name="lvFrom"> <span class="muted">to</span> <input type="date" name="lvTo"> <select name="lvKind">${Object.entries(S.LEAVE_KINDS).map(([k, v]) => `<option value="${k}">${v.icon} ${v.label}</option>`).join('')}</select><button type="button" class="btn small lv-add">Add</button></div>`)}
        ${sect('s-periods', 'Time periods', `<p class="muted small" style="margin:0">Extra windows a task can be scheduled in instead of the work hours above, e.g. “After hours” on Mon, Wed and Thu evenings plus weekends. Each period can have several rules.</p>
          <div class="periods-list"></div>
          <button type="button" class="btn small add-period">+ Add period</button>`)}
        ${sect('s-sessions', 'Task sessions', `<div class="grid3">
          <label class="field"><span>Default session length (min)</span><input type="number" name="chunkMinutes" min="5" step="5" value="${s.chunkMinutes}"></label>
          <label class="field"><span>Shortest session (min) — used only to meet a deadline</span><input type="number" name="minChunkMinutes" min="5" step="5" value="${s.minChunkMinutes ?? ''}" placeholder="= session length"></label>
          <label class="field"><span>Break between sessions (min)</span><input type="number" name="breakMinutes" min="0" step="5" value="${s.breakMinutes}"></label>
          <label class="field"><span>Wiggle room (min) — also use free slots this much shorter than a session</span><input type="number" name="wiggleMinutes" min="0" step="5" value="${s.wiggleMinutes ?? 15}"></label>
        </div>`)}
        ${sect('s-overflow', 'When a task ignores day bounds', `<div class="row"><input type="time" name="oStart" value="${s.overflowBounds.start}" step="900"> <span class="muted">to</span> <input type="time" name="oEnd" value="${s.overflowBounds.end}" step="900"></div>
          ${weekdayToggles('odays', s.overflowBounds.days)}`)}
        ${sect('s-planning', 'Planning', `<div class="grid3">
            <label class="field"><span>Most task time per day, all tasks together (min, 0 = no cap)</span><input type="number" name="dailyCapMinutes" min="0" step="15" value="${s.dailyCapMinutes || 0}"></label>
            <label class="field"><span>Default safety margin — aim to finish … days before a deadline</span><input type="number" name="marginDays" min="0" step="0.5" value="${s.marginDays || 0}"></label>
            <label class="field"><span>Travel buffer around events with a place (min, 0 = off)</span><input type="number" name="travelMinutes" min="0" step="5" value="${s.travelMinutes ?? 15}"></label>
            <label class="field"><span>Plan repeating tasks … days ahead</span><input type="number" name="repeatHorizonDays" min="7" max="120" value="${s.repeatHorizonDays || 28}"></label>
            <label class="field"><span>Focus timer: work / break (min)</span><div class="join"><input type="number" name="pomoWork" min="5" max="120" value="${s.pomodoro?.work || 25}" class="num"><input type="number" name="pomoRest" min="1" max="60" value="${s.pomodoro?.rest || 5}" class="num"></div></label>
          </div>
          <div class="field"><span>Times of day (for category preferences)</span>
            <div class="tod-grid">${['morning', 'afternoon', 'evening'].map((k) => `<span class="tod-l">${k[0].toUpperCase() + k.slice(1)}</span><input type="time" name="tp_${k}_0" value="${tp[k][0]}" step="900"><span class="muted">to</span><input type="time" name="tp_${k}_1" value="${tp[k][1]}" step="900">`).join('')}</div></div>
          <label class="chk"><input type="checkbox" name="learnSpeed" ${s.learnSpeed !== false ? 'checked' : ''}> Learn my reading speed from the pages I report, and adjust reading plans</label>
          <label class="chk"><input type="checkbox" name="assumePastDone" ${s.assumePastDone ? 'checked' : ''}> Assume past sessions were done (mark them undone to reschedule)</label>
        <label class="chk"><input type="checkbox" name="allDayBlocks" ${s.allDayBlocks ? 'checked' : ''}> All-day events block task time</label>`)}
        ${sect('s-limits', 'Limits', `<div class="grid3">
            <label class="field"><span>Ask before creating more than … sessions / repeats</span><input type="number" name="sessionWarn" min="0" value="${s.sessionWarn ?? 20}"></label>
            <label class="field"><span>Never create more than … sessions / repeats</span><input type="number" name="sessionMax" min="0" value="${s.sessionMax ?? 50}"></label>
            <label class="field"><span>Furthest ahead a task or repeating event may run (days, 0 = no limit)</span><input type="number" name="maxSpanDays" min="0" value="${s.maxSpanDays ?? 365}"></label>
          </div>`)}
        ${sect('s-busy', 'Calendars that count as busy', `${allCals.map((c) => `<label class="chk"><input type="checkbox" name="busy" value="${esc(c.id)}" ${busySet.has(c.id) ? 'checked' : ''}> ${esc(c.summary)}</label>`).join('')}`)}
      </section>
      <section data-pane="2" hidden>
        <div class="conn-card">
          ${auth.connected && G.hasClient(auth)
            ? `<div class="row"><span class="pill ok">Connected${auth.email ? ' as ' + esc(auth.email) : ''}</span><span class="muted small">${auth.mode === 'builtin' ? 'via built-in sign-in' : 'via your own Google project'}</span><span class="grow"></span><button type="button" class="btn small ghost sync-panel">Sync status</button><button type="button" class="btn small ghost disconnect">Disconnect</button></div>`
            : `<p class="conn-lead">Connect Google Calendar to see your events here and put task sessions on your calendar (so they show on your phone and people see you as busy).</p>
               <div class="row">
                 ${G.builtinAvailable() ? '<button type="button" class="btn primary connect-builtin"><span class="g-logo">G</span> Sign in with Google</button>' : ''}
                 <button type="button" class="btn ${G.builtinAvailable() ? '' : 'primary'} wizard">${G.builtinAvailable() ? 'Use my own Google project…' : 'Set up Google Calendar (guided, ~5 min)'}</button>
               </div>
               ${G.builtinAvailable() ? '' : '<p class="muted small">One-click sign-in isn’t enabled in this build. The wizard walks you through creating your own free Google sign-in key; it’s a one-time step. (See README → “One-click sign-in” to enable it for everyone using your build.)</p>'}`}
        </div>
        <p class="muted small">Your calendar data goes only between this browser and Google — never to the developer. <a href="privacy.html" target="_blank" rel="noopener">Privacy policy</a></p>
        <details class="adv" ${auth.clientId && auth.mode !== 'builtin' ? 'open' : ''}>
          <summary>Manual setup (your own OAuth client)</summary>
          <label class="field"><span>Authorized redirect URI (paste into Google Cloud console)</span>
            <div class="join"><input readonly value="${esc(redirect || 'Available when installed as an extension')}" class="mono"><button type="button" class="btn small copy-redir">Copy</button></div></label>
          <label class="field"><span>OAuth client ID (Web application)</span><input name="clientId" value="${esc(auth.clientId || '')}" placeholder="1234-abc.apps.googleusercontent.com" class="mono" spellcheck="false"></label>
          <div class="row"><button type="button" class="btn small connect">Connect with this client ID</button></div>
        </details>
        ${sect('s-gtasks', 'Task sessions in Google Calendar', `        <label class="chk"><input type="checkbox" name="syncTasksToGoogle" ${s.syncTasksToGoogle ? 'checked' : ''}> Write task sessions to Google Calendar</label>
        <label class="field"><span>Calendar for task sessions and new events</span>
          <div class="join"><select name="taskCalendarId"><option value="">Primary calendar</option>${cals.filter((c) => !c.primary).map((c) => `<option value="${esc(c.id)}" ${s.taskCalendarId === c.id ? 'selected' : ''}>${esc(c.summary)}</option>`).join('')}</select>
          <button type="button" class="btn small create-cal" ${auth.connected ? '' : 'disabled'}>Create “Tempo Tasks”</button></div></label>
        <button type="button" class="btn small ghost cleanup" ${auth.connected ? '' : 'disabled'}>Remove stray task events from Google</button>`)}
      </section>
      <section data-pane="3" hidden>
        ${sect('s-nprof', 'Notification profiles', `<p class="muted small" style="margin:0">A profile is a set of reminders. Pick one for each event or task; emails are sent by Google${auth.connected ? ` to ${esc(auth.email || 'your Google address')}` : ' (connect Google Calendar)'}. Up to ${N.MAX_RULES} reminders per profile.</p>
          <div class="nprof-list"></div>
          <button type="button" class="btn small add-nprof">+ Add profile</button>
          <div class="grid2">
            <label class="field"><span>New events use</span><select name="eventProfile" class="nprof-sel"></select></label>
            <label class="field"><span>Task sessions use</span><select name="taskProfile" class="nprof-sel"></select></label>
          </div>`)}
        ${sect('s-desktop', 'Desktop notifications', `<label class="chk"><input type="checkbox" name="notifyTasks" ${s.notifyTasks ? 'checked' : ''}> Desktop notifications for task sessions</label>
        <label class="chk"><input type="checkbox" name="notifyLocal" ${s.notifyLocal ? 'checked' : ''}> Desktop notifications for local events</label>
        <label class="chk"><input type="checkbox" name="notifyGoogle" ${s.notifyGoogle ? 'checked' : ''}> Desktop notifications for Google events too (Google also notifies on its own)</label>
        <button type="button" class="btn small ghost test-notif">Send a test notification</button>`)}
        ${sect('s-email', 'Email notifications (sent by Google)', `${auth.connected ? `
          <label class="chk"><input type="checkbox" name="agendaEmail" ${agendaOn ? 'checked' : ''}> Daily agenda email every morning (${esc(agendaCal?.summary || 'primary calendar')})</label>
          <p class="muted small">Google emails ${esc(auth.email || 'your Google address')}. Use a profile with emails (like Important) to get reminder emails for an event or task.</p>`
          : '<p class="muted small">Connect Google Calendar to get email reminders for task sessions and a daily agenda email.</p>'}`)}
      </section>
      <section data-pane="5" hidden>
        <p class="muted small">Give tasks a category to color-code them and to group time in Analysis. A category's icon is added to its sessions' titles (also in Google Calendar). You can also add categories directly in the task dialog.</p>
        <label class="chk"><input type="checkbox" name="askCategory" ${s.askCategory !== false ? 'checked' : ''}> When I create a task without a category, ask me for one</label>
        <div class="cats-list"></div>
        <button type="button" class="btn small add-cat">+ Add category</button>
        ${sect('s-projects', 'Projects', `
          <p class="muted small" style="margin:0">Group tasks into a project in the task dialog. When steps run in order, each task starts only after the previous one is done.</p>
          <div class="proj-list"></div>`)}
      </section>
      <section data-pane="6" hidden>
        <p class="muted small">Show calendars from other accounts next to your Google calendar. Their events count as busy time for task planning (untick “busy” to ignore a calendar). They're read-only here: create and edit events in your main Google account. Sign-ins for these accounts stay on this device.</p>
        <div class="acct-list"></div>
        <div class="acct-add">
          <button type="button" class="btn small" data-add="google">+ Another Google account</button>
          <button type="button" class="btn small" data-add="outlook">+ Outlook / Microsoft 365</button>
          <button type="button" class="btn small" data-add="icloud">+ iCloud</button>
          <button type="button" class="btn small" data-add="ics">+ Calendar link (.ics)</button>
        </div>
        <div class="acct-form"></div>
      </section>
      <section data-pane="7" hidden>
        ${sect('s-paper', 'Weekly review newspaper', `<label class="field"><span>Name of the newspaper</span><input name="paperName" value="${esc(s.paperName && s.paperName !== 'Der Zeitplan' ? s.paperName : 'Remembrance of Things Past')}" maxlength="40"></label>
          <label class="field"><span>Hours counted for time use</span><select name="paperScope">${[...Object.entries(A.SCOPES), ...(s.periods || []).map((p) => ['period:' + p.id, p.name])].map(([v, l]) => `<option value="${esc(v)}" ${(s.paperScope || 'waking') === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`)}
        ${sect('s-papercats', 'Categories in the newspaper', `<div class="field"><span>Categories in the newspaper (untick to leave out)</span><div class="g-catlist paper-cats">${C.ordered(s).map((c) => `<label class="chk ${c.parent ? 'sub' : ''}"><input type="checkbox" class="pc" value="${esc(c.id)}" ${(s.paperCats?.exclude || []).includes(c.id) ? '' : 'checked'}> ${esc(C.catLabel(c))}</label>`).join('')}<label class="chk"><input type="checkbox" class="pc" value="__none" ${(s.paperCats?.exclude || []).includes('__none') ? '' : 'checked'}> Without a category</label></div></div>`)}
        ${sect('s-pics', 'Newspaper pictures', `<div class="field"><span>Picture sources (one is picked at random each time)</span><div class="pic-src-list"></div><button type="button" class="btn small add-pic-src">+ Add a source</button></div>
          <p class="muted small" style="margin:0">Wikimedia Commons: any search words (e.g. <i>Art Nouveau poster</i>) or a category name (e.g. <i>Photographs by Julia Margaret Cameron</i>). Art Institute of Chicago: search words (e.g. <i>Monet</i>). Image links: https addresses of pictures, one per line.</p>`)}
        ${sect('s-goalrem', 'Goal reminder', `<label class="chk"><input type="checkbox" name="goalNotice" ${s.goalNotice !== false ? 'checked' : ''}> On the first day of a new week or month, show my goals</label>
          <label class="field"><span>From (time of day)</span><input type="time" name="goalNoticeAt" value="${esc(s.goalNoticeAt || '09:00')}" step="900"></label>`)}
      </section>
      <section data-pane="4" hidden>
        <p class="muted small">Tasks, settings and local events live in this browser's extension storage. Back them up or move them to another browser:</p>
        <div class="row"><button type="button" class="btn small export-json">Download backup (.json)</button>
        <label class="btn small ghost">Restore backup…<input type="file" accept=".json" class="import-json" hidden></label></div>
        ${driveBoxHTML(s, ctx.state.auth)}
        <p class="muted small">Tempo has no servers: your data only travels between this browser and your own Google account. <a href="privacy.html" target="_blank" rel="noopener">Privacy policy</a></p>
      </section>
    </div>
    <footer class="actions"><span class="grow"></span><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn primary">Save</button></footer>
  </form>`;

  return modal(html, (dlg, close) => {
    const f = $('form', dlg);
    const headH = () => dlg.style.setProperty('--sf-head', ($('.dlg-head', dlg)?.offsetHeight || 48) + 'px');
    headH(); requestAnimationFrame(headH);
    const chk = (n) => !!f[n]?.checked, val = (n) => f[n]?.value ?? '';
    const days = (n) => describeDays($$(`input[name=${n}]:checked`, dlg).map((c) => +c.value));
    const optText = (n) => f[n]?.selectedOptions?.[0]?.textContent || '';
    const updSects = wireSects(dlg, {
      's-leave': () => { const today = T.dayKey(Date.now(), s.tz); const up = Object.keys(leave).filter((k) => k >= today && S.LEAVE_KINDS[leave[k]]).sort(); return up.length ? `${up.length} upcoming day${up.length > 1 ? 's' : ''} · next ${T.format(T.dayStart(up[0], s.tz), s.tz, { day: 'numeric', month: 'short' })}` : 'None upcoming'; },
      's-display': () => `${optText('weekView')} · starts ${optText('weekStart')} · ${optText('h12')}`,
      's-events': () => `${val('defaultEventMinutes')} min · since/till buffers ${val('sinceLastBuffer') || 0}/${val('tillNextBuffer') || 0} min`,
      's-sleep': () => [chk('sleepEvents') ? 'Sleep blocks on' : '', chk('sleepAssume') ? 'assumed in Analysis' : '', `${val('sleepStart')}–${val('sleepEnd')}`].filter(Boolean).join(' · '),
      's-game': () => (chk('gameOn') ? `On · ${$$('.gl-c:checked', dlg).length} life-growth categor${$$('.gl-c:checked', dlg).length === 1 ? 'y' : 'ies'}` : 'Off'),
      's-weather': () => (chk('wxOn') ? `${(val('wxPlace') || 'No place chosen').split(',')[0]} · °${val('wxUnit')}` : 'Off'),
      's-hours': () => `${val('bStart')}–${val('bEnd')}, ${days('bdays')}`,
      's-periods': () => periods.map((x) => x.name).filter(Boolean).join(', ') || 'None',
      's-fills': () => fills.length ? fills.map((r) => `${r.name || C.catById(s, r.catId)?.name || 'Fill-in'} ${r.from}–${r.to}`).join(', ') : 'None',
      's-sessions': () => `${val('chunkMinutes')} min sessions · ${val('breakMinutes')} min breaks · wiggle ${val('wiggleMinutes')} min`,
      's-overflow': () => `${val('oStart')}–${val('oEnd')}, ${days('odays')}`,
      's-planning': () => [+val('dailyCapMinutes') ? `max ${T.fmtDur(+val('dailyCapMinutes'))}/day` : 'No daily cap', +val('marginDays') ? `margin ${val('marginDays')} d` : '', `travel ${val('travelMinutes') || 0} min`].filter(Boolean).join(' · '),
      's-limits': () => `ask above ${val('sessionWarn')} · never above ${val('sessionMax')}`,
      's-busy': () => `${$$('input[name=busy]:checked', dlg).length} of ${allCals.length} calendars`,
      's-gtasks': () => (chk('syncTasksToGoogle') ? `On · ${optText('taskCalendarId')}` : 'Off'),
      's-nprof': () => nprofiles.map((x) => x.name).join(', '),
      's-desktop': () => [chk('notifyTasks') && 'tasks', chk('notifyLocal') && 'local events', chk('notifyGoogle') && 'Google events'].filter(Boolean).join(', ') || 'Off',
      's-email': () => (!auth.connected ? 'Connect Google Calendar first' : chk('agendaEmail') ? 'Daily agenda on' : 'Daily agenda off'),
      's-projects': () => (projects.length ? `${projects.length} project${projects.length > 1 ? 's' : ''}` : 'None yet'),
      's-paper': () => val('paperName'),
      's-papercats': () => { const n = $$('.pc', dlg).filter((c) => !c.checked).length; return n ? `${n} left out` : 'All included'; },
      's-pics': () => `${picSrc.length} source${picSrc.length === 1 ? '' : 's'}`,
      's-goalrem': () => (chk('goalNotice') ? `From ${val('goalNoticeAt')}` : 'Off'),
    });
    $$('.tabs button', dlg).forEach((b) => b.addEventListener('click', () => {
      $$('.tabs button', dlg).forEach((x) => x.classList.toggle('on', x === b));
      $$('[data-pane]', dlg).forEach((p) => (p.hidden = p.dataset.pane !== b.dataset.tab));
      const body = $('.dlg-body', dlg); if (body) body.scrollTop = 0;
    }));
    const saveClientId = async () => { const v = f.clientId.value.trim(); if (v !== (st.auth?.clientId || '')) await ctx.saveAuth({ clientId: v }); };
    $('.copy-redir', dlg).onclick = () => navigator.clipboard?.writeText(redirect);
    $('.connect', dlg)?.addEventListener('click', async () => { G.ensureHostPermission(); await saveClientId(); close({ action: 'connect', mode: 'custom', settings: collect() }); });
    $('.connect-builtin', dlg)?.addEventListener('click', () => { G.ensureHostPermission(); close({ action: 'connect', mode: 'builtin', settings: collect() }); });
    $('.wizard', dlg)?.addEventListener('click', () => close({ action: 'wizard', settings: collect() }));
    $('.sync-panel', dlg)?.addEventListener('click', () => close({ action: 'syncPanel', settings: collect() }));
    $('.disconnect', dlg)?.addEventListener('click', () => close({ action: 'disconnect', settings: collect() }));
    $('.create-cal', dlg)?.addEventListener('click', () => close({ action: 'createCal', settings: collect() }));
    $('.cleanup', dlg)?.addEventListener('click', () => close({ action: 'cleanup', settings: collect() }));
    $('.test-notif', dlg).onclick = () => ctx.testNotification();
    const drawPeriods = () => {
      setHTML($('.periods-list', dlg), periods.map((p, i) => `<div class="period" data-i="${i}">
        <div class="row"><input class="per-name" value="${esc(p.name)}" maxlength="30" aria-label="Period name"><span class="grow"></span><button type="button" class="btn small ghost danger per-del">Delete period</button></div>
        ${p.rules.map((r, j) => `<div class="row per-rule" data-j="${j}">
          <input type="time" class="r-start" value="${r.start}" step="900"> <span class="muted">to</span> <input type="time" class="r-end" value="${r.end}" step="900">
          <div class="wd-toggles">${[1, 2, 3, 4, 5, 6, 0].map((d) => `<label class="wd"><input type="checkbox" class="r-day" value="${d}" ${r.days.includes(d) ? 'checked' : ''}><span>${DAYN[d].slice(0, 2)}</span></label>`).join('')}</div>
          <button type="button" class="icon-btn r-del" title="Remove rule" aria-label="Remove rule">✕</button></div>`).join('')}
        <div class="row"><button type="button" class="link per-add-rule">+ Add rule</button><span class="grow"></span><label class="chk small"><input type="checkbox" class="per-leave" ${p.onLeave ? 'checked' : ''}> Includes leave days</label></div></div>`).join('') || '<p class="muted small">No periods.</p>');
      $$('.period', dlg).forEach((el2) => {
        const p = periods[+el2.dataset.i];
        $('.per-name', el2).oninput = (e) => { p.name = e.target.value; };
        $('.per-del', el2).onclick = () => { periods.splice(+el2.dataset.i, 1); drawPeriods(); };
        $('.per-leave', el2).onchange = (e) => { p.onLeave = e.target.checked; };
        $('.per-add-rule', el2).onclick = () => { p.rules.push({ days: [6, 0], start: '10:00', end: '18:00' }); drawPeriods(); };
        $$('.per-rule', el2).forEach((rw) => {
          const r = p.rules[+rw.dataset.j];
          // a new start: keep the end if it's still a little after it (up to 3 h), otherwise an hour later
          $('.r-start', rw).onchange = (e) => {
            r.start = e.target.value || r.start;
            const m = (x) => { const [h, mm] = String(x).split(':').map(Number); return h * 60 + mm; }, a = m(r.start), b = m(r.end);
            if (!(b > a && b - a <= 180)) { const e2 = Math.min(23 * 60 + 59, a + 60); r.end = `${String(Math.floor(e2 / 60)).padStart(2, '0')}:${String(e2 % 60).padStart(2, '0')}`; $('.r-end', rw).value = r.end; }
          };
          $('.r-end', rw).onchange = (e) => { r.end = e.target.value || r.end; };
          $$('.r-day', rw).forEach((c) => (c.onchange = () => { r.days = $$('.r-day:checked', rw).map((x) => +x.value); }));
          $('.r-del', rw).onclick = () => { p.rules.splice(+rw.dataset.j, 1); drawPeriods(); };
        });
      });
    };
    drawPeriods();
    // fill-in blocks
    const catOpts = (sel) => `<option value="">Choose a category…</option>${C.treeOptionsHTML(s, sel)}`;
    const drawFills = () => {
      setHTML($('.fills-list', dlg), fills.map((r, i) => `<div class="fill-rule period" data-i="${i}">
        <div class="row"><label class="chk small"><input type="checkbox" class="fr-on" ${r.on !== false ? 'checked' : ''} aria-label="On"></label><select class="fr-cat" aria-label="Category">${catOpts(r.catId)}</select><input class="fr-name" value="${esc(r.name || '')}" maxlength="40" placeholder="Title (default: the category)" aria-label="Title"><span class="grow"></span><button type="button" class="icon-btn fr-del" title="Remove" aria-label="Remove fill-in block">✕</button></div>
        <div class="row"><input type="time" class="fr-from" value="${r.from}" step="900" aria-label="From"> <span class="muted">to</span> <input type="time" class="fr-to" value="${r.to}" step="900" aria-label="To">
          <div class="wd-toggles">${[1, 2, 3, 4, 5, 6, 0].map((d) => `<label class="wd"><input type="checkbox" class="fr-day" value="${d}" ${r.days.includes(d) ? 'checked' : ''}><span>${DAYN[d].slice(0, 2)}</span></label>`).join('')}</div></div>
        <label class="chk small"><input type="checkbox" class="fr-skip" ${r.skipIfAny ? 'checked' : ''}> Skip the day if anything at all is planned in this time, even something short</label>
        <div class="row small"><label>Add it <input type="number" class="fr-delay" min="0" max="720" step="5" value="${+r.delayMin || 0}" style="width:5em"> min after the window ends <span class="muted">(0 = right away)</span></label><span class="grow"></span>
          <label>on <select class="fr-cal"><option value="default">my main calendar</option><option value="local" ${r.cal === 'local' ? 'selected' : ''}>this browser only</option></select></label></div></div>`).join('') || '<p class="muted small">No fill-in blocks.</p>');
      $$('.fill-rule', dlg).forEach((el2) => {
        const r = fills[+el2.dataset.i];
        $('.fr-on', el2).onchange = (e) => { r.on = e.target.checked; };
        $('.fr-cat', el2).onchange = (e) => { r.catId = e.target.value; updSects(); };
        $('.fr-name', el2).oninput = (e) => { r.name = e.target.value; };
        $('.fr-from', el2).onchange = (e) => { r.from = e.target.value || r.from; updSects(); };
        $('.fr-to', el2).onchange = (e) => { r.to = e.target.value || r.to; updSects(); };
        $$('.fr-day', el2).forEach((c) => (c.onchange = () => { r.days = $$('.fr-day:checked', el2).map((x) => +x.value); }));
        $('.fr-skip', el2).onchange = (e) => { r.skipIfAny = e.target.checked; };
        $('.fr-delay', el2).oninput = (e) => { r.delayMin = Math.max(0, +e.target.value || 0); };
        $('.fr-cal', el2).onchange = (e) => { r.cal = e.target.value; };
        $('.fr-del', el2).onclick = () => { fills.splice(+el2.dataset.i, 1); drawFills(); updSects(); };
      });
    };
    drawFills();
    $('.add-fill', dlg).onclick = () => { fills.push({ id: 'f-' + Math.random().toString(36).slice(2, 8), name: '', from: '18:00', to: '20:00', catId: '', days: [0, 1, 2, 3, 4, 5, 6], skipIfAny: false, delayMin: 0, cal: 'default', since: T.dayKey(Date.now(), s.tz), on: true }); drawFills(); updSects(); };
    // Leave days: shown as ranges of consecutive days of the same kind
    const drawLeave = () => {
      const keys = Object.keys(leave).filter((k) => S.LEAVE_KINDS[leave[k]]).sort();
      const ranges = [];
      for (const k of keys) { const r = ranges[ranges.length - 1]; if (r && r.kind === leave[k] && T.addDays(r.to, 1) === k) r.to = k; else ranges.push({ from: k, to: k, kind: leave[k] }); }
      const fmt = (k) => T.format(T.dayStart(k, s.tz), s.tz, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
      setHTML($('.leave-list', dlg), ranges.map((r, i) => `<div class="row lv-row" data-i="${i}"><span>${S.LEAVE_KINDS[r.kind].icon} <b>${S.LEAVE_KINDS[r.kind].label}</b> · ${esc(fmt(r.from))}${r.to !== r.from ? ` – ${esc(fmt(r.to))}` : ''}</span><span class="grow"></span><button type="button" class="icon-btn lv-del" aria-label="Remove">✕</button></div>`).join('') || '<p class="muted small" style="margin:0">No leave days.</p>');
      $$('.lv-row', dlg).forEach((row) => { $('.lv-del', row).onclick = () => { const r = ranges[+row.dataset.i]; for (let k = r.from; k <= r.to; k = T.addDays(k, 1)) delete leave[k]; drawLeave(); updSects(); }; });
    };
    drawLeave();
    // When a drain / bonus counts: always, the next week, two weeks, month, 3 months, or a custom period
    const todayK = T.dayKey(Date.now(), s.tz);
    const fmtK = (k) => T.fmtDate(T.dayStart(k, s.tz), s.tz);
    const periodSay = (x) => (!x.from && !x.to ? 'Counts every day.' : x.to && x.to <= todayK ? `Ended ${fmtK(T.addDays(x.to, -1))}.` : `${x.from && x.from > todayK ? `From ${fmtK(x.from)}` : x.from === todayK ? 'From today' : x.from ? `Since ${fmtK(x.from)}` : 'Now'} until ${x.to ? fmtK(T.addDays(x.to, -1)) : 'further notice'}${x.to && x.to > todayK ? ` — ${Math.round((T.dayStart(x.to, s.tz) - T.dayStart(todayK, s.tz)) / T.DAY)} days left` : ''}.`);
    const periodHTML = (x) => { const k = x.period || (x.from || x.to ? 'custom' : 'always'); return `<div class="row pr-row"><label class="field"><span>Counts</span><select class="pr-kind">${GM.PERIODS.map(([v, l]) => `<option value="${v}" ${v === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="field pr-c" ${k === 'custom' ? '' : 'hidden'}><span>From</span><input type="date" data-quick="off" class="pr-from" value="${esc(x.from || todayK)}"></label><label class="field pr-c" ${k === 'custom' ? '' : 'hidden'}><span>Until (incl.)</span><input type="date" data-quick="off" class="pr-to" value="${esc(x.to ? T.addDays(x.to, -1) : T.addDays(todayK, 13))}"></label></div><p class="muted small pr-say" style="margin:0">${esc(periodSay(x))}</p>`; };
    const readPeriod = (row, x, e) => {
      const k = $('.pr-kind', row).value;
      $$('.pr-c', row).forEach((el) => (el.hidden = k !== 'custom'));
      if (k === 'custom') { const a = $('input.pr-from', row).value || todayK, b = $('input.pr-to', row).value || a; x.from = a; x.to = T.addDays(b < a ? a : b, 1); }
      else if (k === 'always') { x.from = null; x.to = null; }
      else if (e?.target?.classList.contains('pr-kind') || x.period !== k) Object.assign(x, GM.periodRange(k, todayK));
      x.period = k;
      $('.pr-say', row).textContent = periodSay(x);
    };
    const updNoAuto = () => { const el = $('.gn-auto', dlg); if (!el) return; const ids = [...new Set(drains.flatMap((d) => d.cats || []))]; el.textContent = ids.length ? `XP-drain categories never score anyway: ${ids.map((id) => C.catLabel(C.catById(s, id)) || id).join(', ')}.` : ''; };
    // XP drains editor
    const gStats = GM.gameStats(s, T.dayKey(Date.now(), s.tz), s.tz);
    const graph = (d) => { const cv = GM.drainCurve(s, d, gStats); return `${GM.drainCurveSVG(cv, d)}<span class="muted small">Now, at level ${gStats.level} (${esc(gStats.rank.name)}), drains cost ×${gStats.scale.toFixed(2)}. Based on ${gStats.est ? 'a typical' : 'your recent'} ${d.per === 'day' ? `day (≈${cv.dayXP} XP)` : `day (≈${cv.dayXP} XP) and week (≈${cv.weekXP} XP)`}. Not doing it wins the clean bonus: <b class="xp-c">+${cv.cleanDay}</b> for the day${d.per === 'week' ? ` and <b class="xp-c">+${cv.cleanWeek}</b> for the week` : ''}.</span>`; };
    const drawDrains = () => {
      const box = $('.drain-list', dlg); if (!box) return;
      const sentence = (d) => { const tol = Math.max(+d.free || 0, +d.tol || 0); return `${+d.free ? `The first ${d.free} h a ${d.per} are free. ` : ''}${tol > (+d.free || 0) ? `Up to ${tol} h a ${d.per}: −${d.basePct}% of the XP of ${d.per === 'week' ? 'each day you do it' : 'that day'}. ` : ''}Beyond: +${d.growPct}% per extra hour${d.per === 'week' ? ' of the whole week\'s XP' : ''}, at most ${d.maxPct}%. Costs ${d.types.length === 3 ? 'all' : d.types.join(' + ')} XP${(d.strength ?? 100) !== 100 ? ` — at ${d.strength}% strength` : ''}.`; };
      setHTML(box, drains.map((d, i) => `<div class="drain" data-i="${i}">
        <div class="row"><input class="dr-name" value="${esc(d.name || '')}" placeholder="Name, e.g. Gameplay" maxlength="30"><select class="dr-per"><option value="week" ${d.per !== 'day' ? 'selected' : ''}>per week</option><option value="day" ${d.per === 'day' ? 'selected' : ''}>per day</option></select><span class="grow"></span><button type="button" class="icon-btn dr-del" title="Remove" aria-label="Remove">✕</button></div>
        <label class="field"><span>Titles with these words</span><input class="dr-words" value="${esc((d.words || []).join(', '))}" placeholder="e.g. game, gaming, PlayStation"></label>
        <div class="field"><span>…and/or these categories</span><div class="dr-cats">${catPick(s, 'dr-cat', d.cats || [])}</div></div>
        <div class="dr-nums">
          <label class="field"><span>Free (h)</span><input type="number" class="dr-free num" min="0" step="0.25" value="${d.free ?? 0}"></label>
          <label class="field"><span>Tolerated up to (h)</span><input type="number" class="dr-tol num" min="0" step="0.25" value="${d.tol ?? 2}"></label>
          <label class="field"><span>Cost while tolerated (%)</span><input type="number" class="dr-base num" min="0" max="100" step="1" value="${d.basePct ?? 10}"></label>
          <label class="field"><span>Extra per hour beyond (%)</span><input type="number" class="dr-grow num" min="0" max="100" step="1" value="${d.growPct ?? 15}"></label>
          <label class="field"><span>At most (%)</span><input type="number" class="dr-max num" min="0" max="100" step="1" value="${d.maxPct ?? 75}"></label>
          <label class="field" title="How much of these costs to apply — e.g. 25% for an activity that should only cost a little"><span>Strength (% of the costs)</span><input type="number" class="dr-str num" min="0" max="200" step="5" value="${d.strength ?? 100}"></label>
        </div>
        <div class="row small">Costs: ${['app', 'busy', 'life'].map((t) => `<label class="chk"><input type="checkbox" class="dr-type" value="${t}" ${d.types.includes(t) ? 'checked' : ''}> ${t} XP</label>`).join(' ')}</div>
        ${periodHTML(d)}
        <details class="dr-adv" ${d.scope ? 'open' : ''}><summary class="small"><b>Advanced</b> — which hours to watch</summary>
          <label class="field"><span>Only count it during</span><select class="dr-scope">${SC.scopeOptions(s).map(([v, l]) => `<option value="${esc(v)}" ${(d.scope || '') === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
          <p class="muted small" style="margin:0">E.g. “Within the day bounds” only counts gaming on your work hours. Time periods are set in Settings → Scheduling.</p></details>
        <p class="muted small dr-say" style="margin:0">${esc(sentence(d))}</p>
        <div class="dr-graph">${graph(d)}</div>
      </div>`).join('') || '<p class="muted small" style="margin:0">No drains. Add one for activities you want to cut down on — they cost XP the more you do them.</p>');
      $$('.drain', box).forEach((row) => {
        const d = drains[+row.dataset.i];
        const read = (e) => {
          readPeriod(row, d, e); updNoAuto();
          d.name = $('.dr-name', row).value; d.per = $('.dr-per', row).value;
          if ($('.dr-scope', row).value) d.scope = $('.dr-scope', row).value; else delete d.scope;
          d.words = $('.dr-words', row).value.split(/[,;\n]/).map((w) => w.trim()).filter(Boolean);
          d.cats = $$('.dr-cat:checked', row).map((x) => x.value);
          d.free = Math.max(0, +$('.dr-free', row).value || 0); d.tol = Math.max(0, +$('.dr-tol', row).value || 0);
          d.strength = Math.min(200, Math.max(0, $('.dr-str', row).value === '' ? 100 : +$('.dr-str', row).value)); if (d.strength === 100) delete d.strength;
          d.basePct = Math.min(100, Math.max(0, +$('.dr-base', row).value || 0)); d.growPct = Math.min(100, Math.max(0, +$('.dr-grow', row).value || 0)); d.maxPct = Math.min(100, Math.max(0, +$('.dr-max', row).value || 0));
          d.types = $$('.dr-type:checked', row).map((x) => x.value); if (!d.types.length) d.types = ['app', 'busy', 'life'];
          $('.dr-say', row).textContent = sentence(d);
          setHTML($('.dr-graph', row), graph(d));
        };
        wireCatPick(row, s, read);
        row.addEventListener('input', read); row.addEventListener('change', read);
        $('.dr-del', row).onclick = () => { drains.splice(+row.dataset.i, 1); drawDrains(); };
      });
    };
    drawDrains(); updNoAuto();
    // bonus activities editor
    const drawBoosts = () => {
      const box = $('.boost-list', dlg); if (!box) return;
      setHTML(box, boosts.map((b, i) => `<div class="drain boost" data-i="${i}">
        <div class="row"><input class="bo-name" value="${esc(b.name || '')}" placeholder="Name, e.g. Thesis sprint" maxlength="30"><label class="field inline" title="How much extra XP it earns while it lasts (100 = double)"><span>Extra XP</span><input type="number" class="bo-pct num" min="0" max="300" step="5" value="${b.pct ?? 50}"> %</label><span class="grow"></span><button type="button" class="icon-btn bo-del" title="Remove" aria-label="Remove">✕</button></div>
        <label class="field"><span>Titles with these words</span><input class="bo-words" value="${esc((b.words || []).join(', '))}" placeholder="e.g. thesis, xyz"></label>
        <div class="field"><span>…and/or these categories</span><div class="bo-cats">${catPick(s, 'bo-cat', b.cats || [])}</div></div>
        ${periodHTML(b)}
      </div>`).join('') || '<p class="muted small" style="margin:0">No bonus activities. Add one to earn extra XP for something for a while — e.g. a category or a word in titles for the next two weeks.</p>');
      $$('.boost', box).forEach((row) => {
        const b = boosts[+row.dataset.i];
        const read = (e) => {
          readPeriod(row, b, e);
          b.name = $('.bo-name', row).value; b.pct = Math.max(0, Math.min(300, +$('.bo-pct', row).value || 0));
          b.words = $('.bo-words', row).value.split(/[,;\n]/).map((w) => w.trim()).filter(Boolean);
          b.cats = $$('.bo-cat:checked', row).map((x) => x.value);
        };
        row.addEventListener('input', read); row.addEventListener('change', read);
        wireCatPick(row, s, read);
        $('.bo-del', row).onclick = () => { boosts.splice(+row.dataset.i, 1); drawBoosts(); };
      });
    };
    drawBoosts();
    $('.add-boost', dlg)?.addEventListener('click', () => { boosts.push({ id: 'bo' + Math.random().toString(36).slice(2, 8), name: '', words: [], cats: [], pct: GM.cfg(s).boostPct, period: '2w', ...GM.periodRange('2w', todayK) }); drawBoosts(); $$('.boost .bo-name', dlg).pop()?.focus(); });
    // how much each life-growth category counts (e.g. Study at 50% of normal life XP)
    const lifeW = { ...(s.game?.lifeWeights || {}) };
    const drawLifeW = () => {
      const box = $('.gl-weights', dlg); if (!box) return;
      const ids = $$('.gl-c:checked', dlg).map((x) => x.value);
      setHTML(box, ids.length ? `<span class="muted small">How much each counts <em>(% of normal life XP)</em></span><div class="glw-list">${ids.map((id) => { const c = C.catById(s, id); return `<label class="glw-row"><span>${esc(c?.icon || '')} ${esc(c?.name || id)}</span><input type="number" class="glw num" data-id="${esc(id)}" min="0" max="300" step="5" value="${lifeW[id] ?? 100}"> %</label>`; }).join('')}</div>` : '');
      $$('.glw', box).forEach((inp) => inp.addEventListener('input', () => { const v = inp.value === '' ? 100 : Math.max(0, Math.min(300, +inp.value)); if (v === 100) delete lifeW[inp.dataset.id]; else lifeW[inp.dataset.id] = v; }));
    };
    drawLifeW();
    wireCatPick(dlg, s, () => { updSects(); drawLifeW(); });
    $('.add-drain', dlg)?.addEventListener('click', () => { drains.push({ ...GM.DRAIN_DEFAULT, id: 'dr' + Math.random().toString(36).slice(2, 8), words: [...GM.DRAIN_DEFAULT.words], cats: [], types: [...GM.DRAIN_DEFAULT.types] }); drawDrains(); });
    $('.gc-reset', dlg)?.addEventListener('click', () => { $$('.gc-v', dlg).forEach((x) => { x.value = GM.CFG.find((c) => c[0] === x.dataset.k)[2]; }); });
    linkRange(f.lvFrom, f.lvTo);
    $('.lv-add', dlg).onclick = () => {
      const a = f.lvFrom.value, b = f.lvTo.value || a;
      if (!a) { f.lvFrom.focus(); return; }
      const [x, y] = a <= b ? [a, b] : [b, a];
      for (let k = x, i = 0; k <= y && i < 400; k = T.addDays(k, 1), i++) leave[k] = f.lvKind.value;
      f.lvFrom.value = ''; f.lvTo.value = ''; drawLeave(); updSects();
    };
    const drawProfiles = () => {
      const unitSel = (m) => { const [u, v] = N.unitOf(+m); return [v, `<select class="np-unit">${['minutes', 'hours', 'days'].map((x) => `<option ${x === u ? 'selected' : ''}>${x}</option>`).join('')}</select>`]; };
      setHTML($('.nprof-list', dlg), nprofiles.map((p, i) => `<div class="nprof" data-i="${i}">
        <div class="row"><input class="np-name" value="${esc(p.name)}" maxlength="24" aria-label="Profile name"><span class="grow"></span>${nprofiles.length > 1 ? '<button type="button" class="btn small ghost danger np-del">Delete profile</button>' : ''}</div>
        ${p.rules.map((r, j) => { const [v, us] = unitSel(r.minutes); return `<div class="row np-rule" data-j="${j}">
          <select class="np-method"><option value="popup">Notification</option><option value="email" ${r.method === 'email' ? 'selected' : ''}>Email</option></select>
          <input type="number" class="np-val num" min="0" value="${v}"> ${us} <span class="muted">before</span>
          <button type="button" class="icon-btn np-rdel" title="Remove" aria-label="Remove reminder">✕</button></div>`; }).join('') || '<p class="muted small">No reminders.</p>'}
        ${p.rules.length < N.MAX_RULES ? '<button type="button" class="link np-add">+ Add reminder</button>' : ''}</div>`).join(''));
      $$('.nprof', dlg).forEach((el2) => {
        const p = nprofiles[+el2.dataset.i];
        $('.np-name', el2).oninput = (e) => { p.name = e.target.value; fillSel(); };
        $('.np-del', el2)?.addEventListener('click', () => { nprofiles.splice(+el2.dataset.i, 1); drawProfiles(); });
        $('.np-add', el2)?.addEventListener('click', () => { p.rules.push({ method: 'email', minutes: 30 }); drawProfiles(); });
        $$('.np-rule', el2).forEach((rw) => {
          const r = p.rules[+rw.dataset.j];
          const upd = () => { r.method = $('.np-method', rw).value; r.minutes = N.toMinutes($('.np-val', rw).value, $('.np-unit', rw).value); };
          $$('select, input', rw).forEach((x) => x.addEventListener('change', upd));
          $('.np-val', rw).addEventListener('input', upd);
          $('.np-rdel', rw).onclick = () => { p.rules.splice(+rw.dataset.j, 1); drawProfiles(); };
        });
      });
      fillSel();
    };
    const fillSel = () => $$('.nprof-sel', dlg).forEach((sel) => {
      const cur = sel.value || (sel.name === 'eventProfile' ? s.eventProfile : s.taskProfile);
      setHTML(sel, nprofiles.map((p) => `<option value="${esc(p.id)}">${esc(p.name || 'Profile')}</option>`).join(''));
      sel.value = nprofiles.some((p) => p.id === cur) ? cur : nprofiles[0]?.id;
    });
    drawProfiles();
    const drawPicSrc = () => {
      setHTML($('.pic-src-list', dlg), picSrc.map((x, i) => `<div class="row pic-src" data-i="${i}">
        <input type="checkbox" class="ps-on" ${x.on !== false ? 'checked' : ''} title="Use this source">
        <input class="ps-name" value="${esc(x.name)}" maxlength="40" aria-label="Source name">
        ${x.kind === 'builtin' ? '<span class="muted small">built in</span>' : `<select class="ps-kind">${Object.entries(XT.SOURCE_KINDS).filter(([k]) => k !== 'builtin').map(([k, l]) => `<option value="${k}" ${x.kind === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
        ${x.kind === 'urls' ? `<textarea class="ps-val" rows="2" placeholder="https://…">${esc(x.value || '')}</textarea>` : `<input class="ps-val" value="${esc(x.value || '')}" placeholder="${x.kind === 'commonscat' ? 'Category name' : 'Search words'}">`}
        <button type="button" class="icon-btn ps-del" aria-label="Remove source">✕</button>`}
      </div>`).join(''));
      $$('.pic-src', dlg).forEach((r) => {
        const x = picSrc[+r.dataset.i];
        $('.ps-on', r).onchange = (e) => { x.on = e.target.checked; };
        $('.ps-name', r).oninput = (e) => { x.name = e.target.value; };
        $('.ps-kind', r)?.addEventListener('change', (e) => { x.kind = e.target.value; drawPicSrc(); });
        $('.ps-val', r)?.addEventListener('input', (e) => { x.value = e.target.value; });
        $('.ps-del', r)?.addEventListener('click', () => { picSrc.splice(+r.dataset.i, 1); drawPicSrc(); });
      });
    };
    drawPicSrc();
    $('.add-pic-src', dlg).onclick = () => { picSrc.push({ id: 'ps-' + Math.random().toString(36).slice(2, 7), name: 'My pictures', kind: 'commons', value: '', on: true }); drawPicSrc(); };
    // Weather place: search by name, or use this device's location
    const wxShow = (h) => setHTML($('.wx-results', dlg), h);
    const pick = (pl) => { wx = { ...wx, name: pl.name, lat: pl.lat, lon: pl.lon }; f.wxOn.checked = true; f.wxPlace.value = pl.name; wxShow(`Forecast for <b>${esc(pl.name)}</b>`); };
    const wxFind = async () => {
      const q = f.wxPlace.value.trim(); if (!q) { f.wxPlace.focus(); return; }
      await W.askPermission();
      wxShow('<span class="muted">Searching…</span>');
      try {
        const res = await W.geocode(q);
        if (!res.length) return wxShow(`<span class="muted">No place called “${esc(q)}” found.</span>`);
        if (res.length === 1) return pick(res[0]);
        wxShow(`<span class="muted">Which one?</span> ${res.map((r, i) => `<button type="button" class="link wx-pl" data-i="${i}">${esc(r.name)}</button>`).join(' · ')}`);
        $$('.wx-pl', dlg).forEach((b) => (b.onclick = () => pick(res[+b.dataset.i])));
      } catch (e) { wxShow(`<span class="muted">${esc(e.message)}</span>`); }
    };
    $('.wx-find', dlg).onclick = wxFind;
    f.wxPlace.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); wxFind(); } });
    $('.wx-here', dlg).onclick = async () => {
      if (!navigator.geolocation) return wxShow('<span class="muted">This browser can\'t share its location — search for a city instead.</span>');
      await W.askPermission();
      wxShow('<span class="muted">Finding your location…</span>');
      navigator.geolocation.getCurrentPosition((p) => pick({ name: `My location (${p.coords.latitude.toFixed(2)}, ${p.coords.longitude.toFixed(2)})`, lat: +p.coords.latitude.toFixed(3), lon: +p.coords.longitude.toFixed(3) }),
        () => wxShow('<span class="muted">Location not available — search for a city instead.</span>'), { timeout: 10000, maximumAge: 3600000 });
    };
    f.wxOn.addEventListener('change', () => { if (f.wxOn.checked) { W.askPermission(); if (wx.lat == null) f.wxPlace.focus(); } });
    $('.add-nprof', dlg).onclick = () => { nprofiles.push({ id: N.newProfileId('profile'), name: 'New profile', rules: [{ method: 'popup', minutes: 10 }] }); drawProfiles(); };
    $('.add-period', dlg).onclick = () => { periods.push({ id: 'p-' + Math.random().toString(36).slice(2, 8), name: 'New period', rules: [{ days: [1, 2, 3, 4, 5], start: s.bounds.end, end: '21:00' }] }); drawPeriods(); };
    const drawCats = () => {
      // alphabetical; categories added just now stay at the end until saved, so you can name them
      const order = [...C.ordered({ categories: cats.filter((c) => !c._new) }).map((c) => cats.indexOf(c)), ...cats.map((c, i) => (c._new ? i : -1)).filter((i) => i >= 0)];
      setHTML($('.cats-list', dlg), order.map((i) => [cats[i], i]).map(([c, i]) => `<div class="cat-row ${c.parent ? 'sub' : ''}" data-i="${i}">
        <span class="sw-dot big" style="background:${esc(c.color)}"></span>
        <details class="ic-pick"><summary class="cat-icbtn" title="Icon" aria-label="Choose icon">${esc(c.icon || '＋')}</summary>
          <div class="icon-grid grouped"><div class="row"><input class="cat-icin" placeholder="Type or paste" maxlength="8" value="${esc(c.icon || '')}"><button type="button" class="ic-btn none" data-ic="">No icon</button></div>${C.iconGridHTML({ categories: cats }, { keep: c.icon || '', exceptId: c.id })}</div></details>
        <select class="cat-pref" title="Preferred time of day" aria-label="Preferred time of day">${[['', 'Any time'], ['morning', 'Mornings'], ['afternoon', 'Afternoons'], ['evening', 'Evenings']].map(([v, l]) => `<option value="${v}" ${(c.prefer || '') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <input class="cat-nm" value="${esc(c.name)}" maxlength="30" aria-label="Category name">
        <select class="cat-par" title="Main category or inside another" aria-label="Inside" ${cats.some((k) => k.parent === c.id) ? 'disabled' : ''}><option value="">Main category</option>${C.mainCats({ categories: cats }, c.id).map((p) => `<option value="${esc(p.id)}" ${c.parent === p.id ? 'selected' : ''}>inside ${esc(C.catLabel(p))}</option>`).join('')}</select>
        ${C.swatchesHTML('cc' + i, c.color)}
        <button type="button" class="icon-btn cat-del" title="Delete category" aria-label="Delete category">✕</button></div>`).join('') || '<p class="muted small">No categories yet.</p>');
      $$('.cat-row', dlg).forEach((row) => {
        const i = +row.dataset.i;
        $('.cat-nm', row).oninput = (e) => { cats[i].name = e.target.value; };
        $('.cat-pref', row).onchange = (e) => { cats[i].prefer = e.target.value || undefined; };
        const pick = $('.ic-pick', row);
        pick.ontoggle = () => {
          if (!pick.open) return;
          $$('.ic-pick[open]', dlg).forEach((o) => { if (o !== pick) o.open = false; });
          const r = $('.cat-icbtn', row).getBoundingClientRect(), grid = $('.icon-grid', pick);
          grid.style.left = Math.max(8, Math.min(innerWidth - 316, r.left)) + 'px';
          grid.style.top = (r.bottom + 268 > innerHeight ? Math.max(8, r.top - 268) : r.bottom + 4) + 'px';
        };
        const setIc = (v) => { cats[i].icon = C.cleanIcon(v); $('.cat-icbtn', row).textContent = cats[i].icon || '＋'; };
        $('.cat-icin', row).oninput = (e) => setIc(e.target.value);
        $$('.ic-btn', row).forEach((b) => (b.onclick = () => { setIc(b.dataset.ic); $('.cat-icin', row).value = cats[i].icon; $('.ic-pick', row).open = false; }));
        C.wireSwatches(row, (col) => { cats[i].color = col; $('.sw-dot', row).style.background = col; });
        $('.cat-par', row).onchange = (e) => { cats[i].parent = e.target.value || undefined; drawCats(); };
        $('.cat-del', row).onclick = () => { const id = cats[i].id; cats.splice(i, 1); for (const k of cats) if (k.parent === id) delete k.parent; drawCats(); };
      });
    };
    drawCats();
    const drawProjects = () => {
      setHTML($('.proj-list', dlg), projects.map((p, i) => {
        const n = st.tasks.filter((t) => t.projectId === p.id && !t.archived).length;
        return `<div class="row proj-row" data-i="${i}"><input class="pj-name" value="${esc(p.name)}" maxlength="40" aria-label="Project name">
          <label class="chk"><input type="checkbox" class="pj-seq" ${p.sequential ? 'checked' : ''}> steps in order</label>
          <span class="muted small">${n} task${n === 1 ? '' : 's'}</span><span class="grow"></span>
          <button type="button" class="icon-btn pj-del" title="Delete project (tasks stay)" aria-label="Delete project">✕</button></div>`;
      }).join('') || '<p class="muted small">No projects yet — create one with + Project (a chain of tasks and events), or from a task’s “Part of project”.</p>');
      $$('.proj-row', dlg).forEach((row) => {
        const p = projects[+row.dataset.i];
        $('.pj-name', row).oninput = (e) => { p.name = e.target.value; };
        $('.pj-seq', row).onchange = (e) => { p.sequential = e.target.checked; };
        $('.pj-del', row).onclick = () => { projects.splice(+row.dataset.i, 1); drawProjects(); };
      });
    };
    drawProjects();
    // ----- Other calendars (accounts) -----
    const typeName = { google: 'Google', outlook: 'Outlook', icloud: 'iCloud', ics: 'Calendar link' };
    const drawAccounts = async () => {
      await AC.loadAccounts();
      const list = AC.accounts();
      setHTML($('.acct-list', dlg), list.map((a) => `<div class="acct" data-id="${esc(a.id)}">
        <div class="row"><b>${esc(typeName[a.type])}</b> <span>${esc(a.label)}</span>
          ${a.error || a.needsReconnect ? `<span class="pill bad">${esc(a.error || 'Reconnect needed')}</span>` : '<span class="pill ok">OK</span>'}
          <span class="grow"></span>
          ${a.type !== 'ics' ? '<button type="button" class="btn small ghost ac-re">Reconnect</button>' : ''}
          <button type="button" class="btn small ghost danger ac-del">Remove</button></div>
        ${(a.calendars || []).map((c) => `<div class="row acal" data-cal="${esc(c.id)}"><i class="sw-dot" style="background:${esc(c.color || '#888')}"></i><span class="grow">${esc(c.name)}</span>
          <label class="chk"><input type="checkbox" class="ac-show" ${c.show !== false ? 'checked' : ''}> show</label>
          <label class="chk"><input type="checkbox" class="ac-busy" ${c.busy !== false ? 'checked' : ''}> busy</label></div>`).join('')}
      </div>`).join('') || '<p class="muted small">No other calendars yet.</p>');
      $$('.acct', dlg).forEach((row) => {
        const id = row.dataset.id;
        $('.ac-del', row).onclick = async () => { await AC.removeAccount(id); ctx.externalChanged?.(); drawAccounts(); };
        $('.ac-re', row)?.addEventListener('click', async () => { try { await AC.reconnect(id); ctx.externalChanged?.(); } catch (e) { alertIn(e); } drawAccounts(); });
        $$('.acal', row).forEach((cr) => {
          $('.ac-show', cr).onchange = async (e) => { await AC.setCalendarFlags(id, cr.dataset.cal, { show: e.target.checked }); ctx.externalChanged?.(); };
          $('.ac-busy', cr).onchange = async (e) => { await AC.setCalendarFlags(id, cr.dataset.cal, { busy: e.target.checked }); ctx.externalChanged?.(); };
        });
      });
    };
    const alertIn = (e) => setHTML($('.acct-form', dlg), `<div class="warn">${esc(e.message || String(e))}</div>`);
    const busyBtn = async (btn, fn) => {
      const lbl = btn.textContent; btn.disabled = true; btn.textContent = 'Connecting…';
      try { await fn(); setHTML($('.acct-form', dlg), ''); ctx.externalChanged?.(); await drawAccounts(); }
      catch (e) { alertIn(e); }
      finally { btn.disabled = false; btn.textContent = lbl; }
    };
    $$('[data-add]', dlg).forEach((b) => (b.onclick = () => {
      const kind = b.dataset.add, form = $('.acct-form', dlg);
      if (kind === 'google') {
        const cid = (st.auth?.mode !== 'builtin' && st.auth?.clientId) || G.webClientId?.() || '';
        setHTML(form, `<div class="box"><p class="small">Pick the other Google account in the window that opens. ${st.auth?.clientId ? '' : '<b>Needs your own Google OAuth client (Settings → Google Calendar → Manual setup).</b>'} While your Google project is in “Testing”, add that account under <i>Audience → Test users</i> first.</p>
          <button type="button" class="btn small primary go">Choose account…</button></div>`);
        $('.go', form).onclick = (e) => busyBtn(e.target, () => AC.addGoogle(cid));
      } else if (kind === 'outlook') {
        setHTML(form, `<div class="box"><p class="small">Outlook needs a free Microsoft app registration, once: <a href="https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noopener">Azure portal → App registrations</a> → <i>New registration</i> → “Accounts in any organizational directory and personal Microsoft accounts” → platform <i>Single-page application</i> with redirect URI <code class="mono">${esc(redirect)}</code> → under <i>Authentication</i> tick <i>Access tokens (implicit flow)</i>. Paste its Application (client) ID:</p>
          <div class="join"><input class="mono ol-id" placeholder="00000000-0000-0000-0000-000000000000" value="${esc(s.outlookClientId || '')}"><button type="button" class="btn small primary go">Sign in to Microsoft…</button></div></div>`);
        $('.go', form).onclick = (e) => { const id = $('.ol-id', form).value.trim(); s.outlookClientId = id; busyBtn(e.target, () => AC.addOutlook(id)); };
      } else if (kind === 'icloud') {
        setHTML(form, `<div class="box"><p class="small">${isWebApp() ? '<b>iCloud only works in the Tempo browser extension</b> (Apple blocks web pages from reading it). ' : ''}Use your Apple ID and an <b>app-specific password</b> (create one at <a href="https://account.apple.com" target="_blank" rel="noopener">account.apple.com</a> → Sign-In and Security → App-Specific Passwords). It's stored only on this device.</p>
          <div class="row"><input class="ic-user" placeholder="Apple ID (email)" autocomplete="off"><input class="ic-pass" type="password" placeholder="xxxx-xxxx-xxxx-xxxx" autocomplete="off"><button type="button" class="btn small primary go">Connect</button></div></div>`);
        $('.go', form).onclick = (e) => busyBtn(e.target, () => AC.addICloud($('.ic-user', form).value.trim(), $('.ic-pass', form).value));
      } else {
        setHTML(form, `<div class="box"><p class="small">Paste a calendar's subscription link (.ics or webcal://) — e.g. Outlook “Publish calendar” ICS link, a shared iCloud calendar's public link, a school or sports schedule.${isWebApp() ? ' Many sites only allow this in the browser extension.' : ''}</p>
          <div class="row"><input class="ics-url mono" placeholder="https://… or webcal://…" style="flex:2"><input class="ics-name" placeholder="Name"><button type="button" class="btn small primary go">Add</button></div></div>`);
        $('.go', form).onclick = (e) => busyBtn(e.target, () => AC.addIcs($('.ics-url', form).value, $('.ics-name', form).value.trim()));
      }
    }));
    drawAccounts();
    $('.add-cat', dlg).onclick = () => { cats.push({ id: 'cat-' + Math.random().toString(36).slice(2, 8), name: 'New category', color: C.CAT_COLORS[cats.length % C.CAT_COLORS.length], icon: '', _new: true }); drawCats(); $$('.cat-nm', dlg).at(-1).select(); };
    $('.export-json', dlg).onclick = () => ctx.exportJson();
    $('.drive-now', dlg)?.addEventListener('click', () => close({ action: 'driveNow', settings: collect() }));
    $('.drive-restore', dlg)?.addEventListener('click', () => close({ action: 'driveRestore', settings: collect() }));
    $('.import-json', dlg).onchange = (e) => { const file = e.target.files[0]; if (file) close({ action: 'import', file }); };

    function collect() {
      const days = (n) => $$(`input[name=${n}]:checked`, dlg).map((c) => +c.value);
      const busy = $$('input[name=busy]:checked', dlg).map((c) => c.value);
      return {
        ...s,
        ...readFields(f),
        tz: T.isValidTz(f.tz.value.trim()) ? f.tz.value.trim() : s.tz,
        bounds: { start: f.bStart.value || '09:00', end: f.bEnd.value || '17:00', days: days('bdays') },
        overflowBounds: { start: f.oStart.value || '07:00', end: f.oEnd.value || '23:00', days: days('odays') },
        paperName: f.paperName.value.trim().slice(0, 40) || 'Remembrance of Things Past',
        paperCats: { exclude: $$('.paper-cats .pc:not(:checked)', dlg).map((x) => x.value) },
        picSources: picSrc.map((x) => ({ ...x, name: (x.name || '').trim() || 'Pictures', value: (x.value || '').trim() })),
        weather: { on: f.wxOn.checked && wx.lat != null, name: wx.name || '', lat: wx.lat ?? null, lon: wx.lon ?? null, unit: f.wxUnit.value, model: f.wxModel.value || 'best_match' },
        game: { ...(s.game || {}), on: f.gameOn.checked, lifeCats: $$('.gl-c:checked', dlg).map((x) => x.value), lifeWeights: Object.fromEntries(Object.entries(lifeW).filter(([id]) => $$('.gl-c:checked', dlg).some((x) => x.value === id))), restCats: $$('.gr-c:checked', dlg).map((x) => x.value), noCats: $$('.gn-c:checked', dlg).map((x) => x.value),
          drains: drains.map((d) => ({ ...d, name: (d.name || '').trim() || 'Drain' })).filter((d) => d.cats.length || d.words.length),
          boosts: boosts.map((b) => ({ ...b, name: (b.name || '').trim() || 'Bonus' })).filter((b) => b.cats.length || b.words.length),
          cfg: Object.fromEntries($$('.gc-v', dlg).map((x) => [x.dataset.k, x.value]).filter(([k, v]) => v !== '' && +v !== GM.CFG.find((c) => c[0] === k)[2]).map(([k, v]) => [k, +v])),
          ...(() => { const st0 = f.gameStart.value && f.gameStart.value <= T.dayKey(Date.now(), s.tz) ? f.gameStart.value : (s.game?.started || T.dayKey(Date.now(), s.tz)); return st0 !== s.game?.started ? { started: st0, ledger: {}, weeks: {} } : { started: st0 }; })(),
          active: f.gameOn.checked && !s.game?.on ? [...new Set([...(s.game?.active || []), T.dayKey(Date.now(), s.tz)])] : s.game?.active },
        sleepEventsFrom: f.sleepEvents.checked ? (s.sleepEvents && s.sleepEventsFrom ? s.sleepEventsFrom : T.addDays(T.dayKey(Date.now(), s.tz), -1)) : s.sleepEventsFrom || null,
        autoFills: fills.filter((r) => r.catId && r.from && r.to && r.days.length).map((r) => ({ ...r, name: (r.name || '').trim(), since: r.since || T.dayKey(Date.now(), s.tz) })),
        pomodoro: { work: Math.max(5, +f.pomoWork.value || 25), rest: Math.max(1, +f.pomoRest.value || 5) },
        outlookClientId: s.outlookClientId || '',
        timePrefs: Object.fromEntries(['morning', 'afternoon', 'evening'].map((k) => [k, [f[`tp_${k}_0`].value || tp[k][0], f[`tp_${k}_1`].value || tp[k][1]]])),
        projects: projects.map((p) => ({ ...p, name: (p.name || '').trim() || 'Project' })),
        busyCalendars: busy.length === allCals.length ? null : busy,
        notifyProfiles: nprofiles.map((p) => ({ id: p.id, name: (p.name || '').trim() || 'Profile', rules: N.overrides(p.rules) })),
        defaultReminder: (() => { const pr = nprofiles.find((p) => p.id === f.eventProfile.value); const m = pr?.rules.find((r) => r.method === 'popup'); return m ? +m.minutes : s.defaultReminder; })(),
        categories: cats.map(({ _new, ...c }) => ({ ...c, name: c.name.trim() || 'Untitled' })),
        leave,
        periods: periods.map((p) => ({ ...p, name: p.name.trim() || 'Untitled period', rules: p.rules.filter((r) => r.days.length && r.start && r.end) })),
        _agendaEmail: f.agendaEmail ? { want: f.agendaEmail.checked, was: agendaOn, calId: agendaCal?.id } : null,
      };
    }
    f.addEventListener('submit', async (e) => { e.preventDefault(); await saveClientId(); close({ action: 'save', settings: collect() }); });
  }, { cls: 'wide' });
}
