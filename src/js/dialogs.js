// Event, task, settings and problem dialogs.
import * as T from './tz.js';
import * as S from './scheduler.js';
import * as G from './gcal.js';
import { parseRRule, buildRRule, describe, WD, expand } from './rrule.js';
import { LOCAL_CAL, interval } from './engine.js';
import { $, $$, esc, modal, TASK_COLORS, setHTML, choose } from './ui.js';
import * as C from './categories.js';

const WDN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WDL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ORD = ['', 'first', 'second', 'third', 'fourth', 'fifth'];

function tzDatalist(id) {
  return `<datalist id="${id}">${T.allTimezones().map((z) => `<option value="${esc(z)}">`).join('')}</datalist>`;
}

function weekdayToggles(name, days) {
  return `<div class="wd-toggles">${[1, 2, 3, 4, 5, 6, 0].map((d) =>
    `<label class="wd"><input type="checkbox" name="${name}" value="${d}" ${days.includes(d) ? 'checked' : ''}><span>${WDN[d][0]}${WDN[d][1]}</span></label>`).join('')}</div>`;
}

// ======================================================================================
// Event dialog
// ======================================================================================
export function eventDialog(ctx, { ev = null, master = null, init = {} }) {
  const st = ctx.state, s = st.settings;
  const isNew = !ev;
  const calId = ev?._calId || init.calId || ctx.defaultCalendar();
  const evTz = ev?.start?.timeZone || s.tz;
  const iv = ev ? interval(ev, evTz) : null;
  const allDay = ev ? iv.allDay : !!init.allDay;
  const start = ev ? iv.start : init.start;
  const end = ev ? iv.end : init.end;
  const sKey = allDay ? (ev ? iv.startKey : T.dayKey(start, s.tz)) : T.dayKey(start, evTz);
  const eKey = allDay ? T.addDays(ev ? iv.endKey : T.dayKey(end - 1, s.tz) , ev ? -1 : 0) : T.dayKey(end, evTz);
  const sTime = allDay ? T.hhmm(9 * 60) : T.hhmm(T.minutesOfDay(start, evTz));
  const eTime = allDay ? T.hhmm(10 * 60) : T.hhmm(T.minutesOfDay(end, evTz));
  const rec = (master || ev)?.recurrence;
  const rule = parseRRule(rec) || null;
  const cals = ctx.writableCalendars();
  const isGoogle = calId !== LOCAL_CAL;
  const rem = ev?.reminders || { useDefault: true, overrides: [] };
  const remRows = (rem.useDefault ? [] : rem.overrides || []);
  const startWd = T.weekday(sKey);
  const dom = T.parseKey(sKey).d;
  const nth = Math.ceil(dom / 7);
  const isLast = dom + 7 > T.daysInMonth(T.parseKey(sKey).y, T.parseKey(sKey).m);

  const r0 = {
    freq: rule?.freq || '',
    interval: rule?.interval || 1,
    byday: rule?.byday?.length ? rule.byday.map((b) => b.wd) : [startWd],
    monthMode: rule?.byday?.length ? (rule.byday[0].n === -1 ? 'last' : 'nth') : 'day',
    ends: rule?.count ? 'after' : rule?.until ? 'on' : 'never',
    count: rule?.count || 10,
    until: rule?.until ? `${rule.until.slice(0, 4)}-${rule.until.slice(4, 6)}-${rule.until.slice(6, 8)}` : T.addDays(sKey, 90),
  };
  const colorId = ev?.colorId || '';

  const html = `
  <form class="event-form" autocomplete="off">
    <header class="dlg-head">
      <input name="summary" class="title-input" placeholder="Add title" value="${esc(ev?.summary || init.title || '')}" autofocus>
      <button type="button" class="icon-btn" data-close aria-label="Close">✕</button>
    </header>
    <div class="dlg-body">
      <div class="row when">
        <label class="chk"><input type="checkbox" name="allDay" ${allDay ? 'checked' : ''}> All day</label>
      </div>
      <div class="row dt">
        <input type="date" name="sDate" value="${sKey}" required>
        <input type="time" name="sTime" value="${sTime}" step="300" class="timed">
        <span class="muted">to</span>
        <input type="time" name="eTime" value="${eTime}" step="300" class="timed">
        <input type="date" name="eDate" value="${eKey}" required>
      </div>
      <div class="row timed">
        <label class="field grow"><span>Time zone</span>
          <input name="tz" list="tzlist" value="${esc(evTz)}" spellcheck="false">
        </label>
        ${tzDatalist('tzlist')}
      </div>

      <fieldset class="box">
        <legend>Repeat</legend>
        <div class="row">
          <select name="freq">
            <option value="">Does not repeat</option>
            <option value="DAILY">Daily</option><option value="WEEKLY">Weekly</option>
            <option value="MONTHLY">Monthly</option><option value="YEARLY">Yearly</option>
          </select>
          <span class="rec-only">every</span>
          <input type="number" name="interval" min="1" max="99" value="${r0.interval}" class="rec-only num">
          <span class="rec-only unit-label"></span>
        </div>
        <div class="row rec-weekly">${weekdayToggles('byday', r0.byday)}</div>
        <div class="row rec-monthly">
          <select name="monthMode">
            <option value="day">On day ${dom}</option>
            <option value="nth">On the ${ORD[nth]} ${WDL[startWd]}</option>
            ${isLast ? `<option value="last">On the last ${WDL[startWd]}</option>` : ''}
          </select>
        </div>
        <div class="row rec-only">
          <span>Ends</span>
          <select name="ends"><option value="never">Never</option><option value="on">On</option><option value="after">After</option></select>
          <input type="date" name="until" value="${r0.until}" class="ends-on">
          <input type="number" name="count" min="1" max="999" value="${r0.count}" class="ends-after num"><span class="ends-after">occurrences</span>
        </div>
        <div class="muted small rec-desc"></div>
      </fieldset>

      <div class="grid2">
        <label class="field"><span>Calendar</span>
          <select name="calId" ${isNew ? '' : 'disabled'}>
            ${cals.map((c) => `<option value="${esc(c.id)}" ${c.id === calId ? 'selected' : ''}>${esc(c.summary)}</option>`).join('')}
          </select>
        </label>
        <label class="field"><span>Show as</span>
          <select name="transparency"><option value="opaque">Busy</option><option value="transparent" ${ev?.transparency === 'transparent' ? 'selected' : ''}>Free</option></select>
        </label>
        <label class="field"><span>Visibility</span>
          <select name="visibility">
            ${['default', 'public', 'private'].map((v) => `<option value="${v}" ${(ev?.visibility || 'default') === v ? 'selected' : ''}>${v[0].toUpperCase() + v.slice(1)}</option>`).join('')}
          </select>
        </label>
        <div class="field full"><span>Category</span><div class="ev-cat-host"></div></div>
        <div class="field"><span>Color</span>
          <div class="swatches">
            <label class="sw"><input type="radio" name="colorId" value="" ${!colorId ? 'checked' : ''}><i class="sw-cal" title="Calendar color"></i></label>
            ${Object.entries(G.EVENT_COLORS).map(([id, c]) => `<label class="sw"><input type="radio" name="colorId" value="${id}" ${colorId === id ? 'checked' : ''}><i style="background:${c}"></i></label>`).join('')}
          </div>
        </div>
      </div>

      <fieldset class="box">
        <legend>Notifications</legend>
        <label class="chk google-only"><input type="checkbox" name="useDefault" ${rem.useDefault ? 'checked' : ''}> Use calendar's default notifications</label>
        <div class="rem-rows"></div>
        <button type="button" class="btn small ghost add-rem">+ Add notification</button>
      </fieldset>

      <label class="field"><span>Location</span><input name="location" value="${esc(ev?.location || '')}" placeholder="Add location"></label>
      <label class="field google-only"><span>Guests</span><input name="attendees" value="${esc((ev?.attendees || []).filter((a) => !a.self).map((a) => a.email).join(', '))}" placeholder="email@example.com, …"></label>
      <label class="chk google-only"><input type="checkbox" name="meet" ${ev?.conferenceData ? 'checked disabled' : ''}> Add Google Meet video conferencing</label>
      <label class="field"><span>Description</span><textarea name="description" rows="3" placeholder="Add description">${esc(ev?.description || '')}</textarea></label>
    </div>
    <footer class="actions">
      ${isNew ? '' : '<button type="button" class="btn danger ghost del">Delete</button>'}
      <span class="grow"></span>
      <button type="button" class="btn ghost" data-close>Cancel</button>
      <button type="submit" class="btn primary">Save</button>
    </footer>
  </form>`;

  return modal(html, (dlg, close) => {
    const f = $('form', dlg);
    f.freq.value = r0.freq;
    f.monthMode.value = r0.monthMode;
    f.ends.value = r0.ends;
    let evCat = C.catById(s, ev ? C.eventCategoryId(ev, st.eventCats || {}) : init.categoryId);
    C.categoryPicker($('.ev-cat-host', dlg), {
      settings: s, selected: evCat?.id,
      onChange: (c) => {
        evCat = c;
        const id = c ? G.nearestColorId(c.color) : '';
        const r = dlg.querySelector(`input[name=colorId][value="${id}"]`); if (r) r.checked = true;
      },
      onCreate: async (name, color, icon) => { const c = C.newCategory(s, name, color, icon); await ctx.saveSettings(); return c; },
    });
    const remBox = $('.rem-rows', dlg);
    const addRem = (o = { method: 'popup', minutes: s.defaultReminder }) => {
      let val = o.minutes, unit = 'minutes';
      if (val && val % 1440 === 0) { val /= 1440; unit = 'days'; } else if (val && val % 60 === 0) { val /= 60; unit = 'hours'; }
      const row = document.createElement('div');
      row.className = 'row rem-row';
      setHTML(row, `
        <select class="rm-method"><option value="popup">Notification</option><option value="email" ${o.method === 'email' ? 'selected' : ''} class="google-only">Email</option></select>
        <input type="number" class="rm-val num" min="0" value="${val}">
        <select class="rm-unit">${['minutes', 'hours', 'days'].map((u) => `<option ${u === unit ? 'selected' : ''}>${u}</option>`).join('')}</select>
        <span class="muted">before</span><button type="button" class="icon-btn rm-del" aria-label="Remove">✕</button>`);
      $('.rm-del', row).onclick = () => row.remove();
      remBox.appendChild(row);
    };
    remRows.forEach(addRem);
    if (isNew && !isGoogle && !remRows.length) addRem();
    $('.add-rem', dlg).onclick = () => { f.useDefault.checked = false; sync(); addRem(); };

    const sync = () => {
      const ad = f.allDay.checked;
      $$('.timed', dlg).forEach((e) => (e.style.display = ad ? 'none' : ''));
      const freq = f.freq.value;
      $$('.rec-only', dlg).forEach((e) => (e.style.display = freq ? '' : 'none'));
      $('.rec-weekly', dlg).style.display = freq === 'WEEKLY' ? '' : 'none';
      $('.rec-monthly', dlg).style.display = freq === 'MONTHLY' ? '' : 'none';
      $('.unit-label', dlg).textContent = { DAILY: 'day(s)', WEEKLY: 'week(s)', MONTHLY: 'month(s)', YEARLY: 'year(s)' }[freq] || '';
      $$('.ends-on', dlg).forEach((e) => (e.style.display = freq && f.ends.value === 'on' ? '' : 'none'));
      $$('.ends-after', dlg).forEach((e) => (e.style.display = freq && f.ends.value === 'after' ? '' : 'none'));
      const g = (f.calId.value || calId) !== LOCAL_CAL;
      $$('.google-only', dlg).forEach((e) => (e.style.display = g ? '' : 'none'));
      remBox.style.display = g && f.useDefault.checked ? 'none' : '';
      $('.add-rem', dlg).style.display = g && f.useDefault.checked ? 'none' : '';
      const rr = buildRec();
      $('.rec-desc', dlg).textContent = rr ? describe(rr) : '';
      const cal = cals.find((c) => c.id === (f.calId.value || calId));
      $('.sw-cal', dlg).style.background = cal?.color || '#888';
    };

    const buildRec = () => {
      const freq = f.freq.value;
      if (!freq) return [];
      const k = f.sDate.value || sKey;
      const wd = T.weekday(k);
      const o = { freq, interval: +f.interval.value || 1 };
      if (freq === 'WEEKLY') o.byday = $$('input[name=byday]:checked', dlg).map((c) => ({ n: null, wd: +c.value }));
      if (freq === 'MONTHLY') {
        const d = T.parseKey(k).d;
        if (f.monthMode.value === 'nth') o.byday = [{ n: Math.ceil(d / 7), wd }];
        else if (f.monthMode.value === 'last') o.byday = [{ n: -1, wd }];
        else o.bymonthday = [d];
      }
      if (f.ends.value === 'after') o.count = Math.max(1, +f.count.value || 1);
      if (f.ends.value === 'on' && f.until.value) o.until = f.until.value.replace(/-/g, '') + (f.allDay.checked ? '' : 'T235959Z');
      return [buildRRule(o)];
    };

    f.addEventListener('input', sync);
    f.addEventListener('change', (e) => {
      if (e.target.name === 'sDate' && f.eDate.value < f.sDate.value) f.eDate.value = f.sDate.value;
      if (e.target.name === 'sTime' && f.sDate.value === f.eDate.value && f.eTime.value <= f.sTime.value) {
        f.eTime.value = T.hhmm(Math.min(23 * 60 + 55, T.parseHHMM(f.sTime.value) + s.defaultEventMinutes));
      }
      sync();
    });
    sync();

    $('.del', dlg)?.addEventListener('click', () => close({ action: 'delete' }));

    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const ad = f.allDay.checked;
      const zone = T.isValidTz(f.tz.value.trim()) ? f.tz.value.trim() : s.tz;
      const body = {
        summary: f.summary.value.trim() || '(No title)',
        location: f.location.value.trim(),
        description: f.description.value,
        transparency: f.transparency.value,
        visibility: f.visibility.value,
        colorId: f.colorId.value || null,
        ...(() => { const ch = C.eventCategoryChanges(ev || {}, evCat); return (evCat || C.eventCategoryId(ev || {})) ? { extendedProperties: ch.extendedProperties } : {}; })(),
      };
      if (ad) {
        if (f.eDate.value < f.sDate.value) f.eDate.value = f.sDate.value;
        body.start = { date: f.sDate.value };
        body.end = { date: T.addDays(f.eDate.value, 1) };
      } else {
        const a = T.atTime(f.sDate.value, f.sTime.value, zone);
        let b = T.atTime(f.eDate.value, f.eTime.value, zone);
        if (b <= a) b = a + 30 * T.MIN;
        body.start = { dateTime: new Date(a).toISOString(), timeZone: zone };
        body.end = { dateTime: new Date(b).toISOString(), timeZone: zone };
      }
      let recNow = buildRec();
      const recChanged = JSON.stringify(recNow) !== JSON.stringify((rec || []).filter((l) => l.startsWith('RRULE:')));
      if (isNew || recChanged) body.recurrence = recNow;
      if (recChanged && recNow.length) {
        const allDay0 = !!body.start.date;
        const st0 = allDay0 ? T.dayStart(body.start.date, zone) : Date.parse(body.start.dateTime);
        const spanEnd = s.maxSpanDays ? st0 + s.maxSpanDays * T.DAY : Infinity;
        const ext = recurrenceExtent(recNow, st0, allDay0, body.start.date, zone);
        const tooFar = ext.end > spanEnd, tooMany = !!s.sessionMax && ext.n > s.sessionMax;
        if (tooFar || tooMany) {
          // Over a limit: offer to end the series at the last occurrence that's within the limits.
          const within = recurrenceExtent(recNow, st0, allDay0, body.start.date, zone, spanEnd).list.slice(0, s.sessionMax || Infinity);
          const last = within[within.length - 1];
          const why = [tooFar ? `extend more than ${s.maxSpanDays} days ahead` : '', tooMany ? `happen ${ext.n === Infinity ? 'endlessly' : ext.n + ' times'} (the limit is ${s.sessionMax})` : ''].filter(Boolean).join(' and ');
          const ok = await choose(tooFar ? 'Repeating event too far ahead' : 'Too many occurrences', `This repeating event would ${why}. ${limitHint}`,
            last == null ? [] : [{ value: true, label: `End it on ${T.format(typeof last === 'string' ? T.dayStart(last, zone) : last, zone, { day: 'numeric', month: 'short', year: 'numeric' })} (${within.length} time${within.length === 1 ? '' : 's'})`, desc: 'Keeps the series within your limits.' }],
            { cancel: 'Go back' });
          if (!ok) return;
          const u = typeof last === 'string' ? last.replace(/-/g, '') : new Date(last).toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
          recNow = recNow.map((l) => (l.startsWith('RRULE:') ? l.replace(/;(COUNT|UNTIL)=[^;]*/g, '') + ';UNTIL=' + u : l));
          body.recurrence = recNow;
        } else if (!(await checkCount('occurrences', ext.n, s))) return;
      }
      const targetCal = f.calId.value || calId;
      const g = targetCal !== LOCAL_CAL;
      const overrides = $$('.rem-row', dlg).map((r) => {
        const v = +$('.rm-val', r).value || 0;
        const u = $('.rm-unit', r).value;
        return { method: g ? $('.rm-method', r).value : 'popup', minutes: v * (u === 'days' ? 1440 : u === 'hours' ? 60 : 1) };
      }).slice(0, 5);
      body.reminders = g && f.useDefault.checked ? { useDefault: true } : { useDefault: false, overrides };
      if (g) {
        const emails = f.attendees.value.split(/[,;\s]+/).map((x) => x.trim()).filter((x) => /.+@.+\..+/.test(x));
        const keep = (ev?.attendees || []).filter((a) => a.self || emails.includes(a.email));
        const known = new Set(keep.map((a) => a.email));
        const attendees = [...keep, ...emails.filter((x) => !known.has(x)).map((email) => ({ email }))];
        if (attendees.length || ev?.attendees?.length) body.attendees = attendees;
      }
      close({ action: 'save', body, calId: targetCal, conference: g && f.meet.checked && !ev?.conferenceData, recurrenceChanged: recChanged });
    });
  }, { cls: 'wide' });
}

// ---------- Creation limits (Settings → Scheduling → Limits) ----------
const limitHint = 'You can change this limit in Settings → Scheduling → Limits.';
async function checkCount(kind, n, s) {
  if (s.sessionMax && n > s.sessionMax) {
    await choose(`Too many ${kind}`, `This would create ${n} ${kind}, more than the limit of ${s.sessionMax}. ${kind === 'sessions' ? 'Use longer sessions, a later start or a shorter task.' : 'End the series sooner.'} ${limitHint}`, [], { cancel: 'OK' });
    return false;
  }
  if (s.sessionWarn && n > s.sessionWarn) {
    return !!(await choose(`Create ${n} ${kind}?`, `That's more than ${s.sessionWarn}. ${limitHint}`, [{ value: true, label: `Yes, create ${n} ${kind}` }], { cancel: 'Go back' }));
  }
  return true;
}
async function checkSpan(what, endMs, s, now = Date.now()) {
  if (!s.maxSpanDays || endMs <= now + s.maxSpanDays * T.DAY) return true;
  await choose(`${what} too far ahead`, `${what === 'Deadline' ? 'The deadline' : 'This repeating event'} would extend more than ${s.maxSpanDays} days ahead. ${what === 'Deadline' ? 'Choose an earlier deadline.' : 'Set an end date or a number of times.'} ${limitHint}`, [], { cancel: 'OK' });
  return false;
}
// How many times a repeating event occurs and when it ends (Infinity if it never ends). With `upTo`, also lists
// the occurrences that start before that time.
export function recurrenceExtent(recLines, startMs, allDay, startKey, tz, upTo) {
  const r = parseRRule(recLines);
  if (!r) return { n: 1, end: startMs, list: [allDay ? startKey : startMs] };
  const list = upTo != null ? expand({ rule: r, startMs, startKey, allDay, tz }, -Infinity, upTo + 1, tz) : [];
  if (!r.count && !r.until) return { n: Infinity, end: Infinity, list };
  const occ = expand({ rule: r, startMs, startKey, allDay, tz }, -Infinity, Infinity, tz);
  const last = occ.length ? occ[occ.length - 1] : startMs;
  return { n: occ.length, end: typeof last === 'string' ? T.dayStart(last, tz) : last, list };
}

const DAYN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function describeDays(days) {
  const d = [...(days || [])].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  if (d.length === 7) return 'every day';
  if (d.join() === '1,2,3,4,5') return 'Mon–Fri';
  if (d.join() === '6,0') return 'weekends';
  return d.map((x) => DAYN[x]).join(', ');
}
export const describeRules = (rules) => (rules || []).map((r) => `${describeDays(r.days)} ${r.start}–${r.end}`).join('; ');

// "End of work day / end of work week / within two weeks", using day bounds (working days + end time).
export function deadlinePreset(kind, bounds, tz, now = Date.now()) {
  const days = bounds.days?.length ? bounds.days : [1, 2, 3, 4, 5];
  const endOf = (k) => T.atTime(k, bounds.end || '17:00', tz);
  let k = T.dayKey(now, tz);
  if (kind === '2w') { let d = T.addDays(k, 14); for (let i = 0; i < 7 && !days.includes(T.weekday(d)); i++) d = T.addDays(d, -1); return endOf(d); }
  // next working day whose end is still ahead
  for (let i = 0; i < 14 && (!days.includes(T.weekday(k)) || endOf(k) <= now); i++) k = T.addDays(k, 1);
  if (kind === 'day') return endOf(k);
  // last working day of that week
  const ws = T.startOfWeek(k, 1);
  let last = k;
  for (let i = 0; i < 7; i++) { const d = T.addDays(ws, i); if (days.includes(T.weekday(d)) && d >= k) last = d; }
  return endOf(last);
}

// ======================================================================================
// Task dialog
// ======================================================================================
export function taskDialog(ctx, task = null, preset = {}) {
  const st = ctx.state, s = st.settings, tz = s.tz;
  const now = Date.now();
  const t = task || {
    id: S.newId('t'), kind: preset.kind || 'generic', title: '', rank: 3,
    totalMinutes: 600, reading: { pages: 100, startPage: 1, speed: 15, unit: 'pph', labels: 'actual' },
    deadline: preset.deadline || T.atTime(T.addDays(T.dayKey(now, tz), 7), s.bounds.end, tz),
    earliestStart: preset.earliestStart || null,
    chunkMinutes: null, minChunkMinutes: null, maxPerDayMinutes: null, breakMinutes: null,
    bounds: null, ignoreBounds: false,
    color: TASK_COLORS[st.tasks.length % TASK_COLORS.length],
    reminderMinutes: null, notes: '', frozen: [], planned: [], skipped: [], created: now,
  };
  const r = { pages: 100, startPage: 1, speed: 15, unit: 'pph', labels: 'actual', ...(t.reading || {}) };
  const b = t.bounds || s.bounds;
  const prog = task ? S.progress(task) : null;

  const html = `
  <form class="task-form" autocomplete="off">
    <header class="dlg-head">
      <div class="seg kind-seg">
        <label><input type="radio" name="kind" value="generic" ${t.kind !== 'reading' ? 'checked' : ''}><span>Task</span></label>
        <label><input type="radio" name="kind" value="reading" ${t.kind === 'reading' ? 'checked' : ''}><span>Reading</span></label>
      </div>
      <button type="button" class="icon-btn" data-close aria-label="Close">✕</button>
    </header>
    <div class="dlg-body">
      <input name="title" class="title-input" placeholder="${t.kind === 'reading' ? 'Book title' : 'Task name'}" value="${esc(t.title)}" autofocus required>
      <div class="field"><span>Category</span><div class="cat-host"></div></div>
      ${prog ? `<div class="progress-line"><div class="bar"><i style="width:${prog.pct}%;background:${t.color}"></i></div><span class="muted small">${T.fmtDur(prog.done)} of ${T.fmtDur(prog.total)} done</span></div>` : ''}

      <div class="grid3 only-generic">
        <label class="field"><span>Total time (hours)</span><input type="number" name="hours" min="0" step="0.25" value="${+(t.totalMinutes / 60).toFixed(2)}"></label>
      </div>
      <div class="grid3 only-reading">
        <label class="field"><span>Pages to read</span><input type="number" name="pages" min="1" value="${r.pages}"></label>
        <label class="field"><span>Start page</span><input type="number" name="startPage" min="1" value="${r.startPage}"></label>
        <label class="field"><span>Reading speed</span>
          <div class="join"><input type="number" name="speed" min="0.1" step="0.1" value="${r.speed}" class="num">
          <select name="unit"><option value="pph">pages / hour</option><option value="ppm">pages / minute</option><option value="mpp">minutes / page</option></select></div>
        </label>
        <label class="field"><span>Session labels</span>
          <select name="labels"><option value="actual">Actual page numbers</option><option value="relative">Relative (page 1-20…)</option></select>
        </label>
      </div>
      <div class="calc muted small"></div>

      <div class="grid3">
        <div class="field"><span>Deadline</span><input type="datetime-local" name="deadline" value="${t.deadline ? T.toDTInput(t.deadline, tz) : ''}" required>
          <div class="dl-presets"><button type="button" class="chip-btn" data-dl="day">End of work day</button><button type="button" class="chip-btn" data-dl="week">End of work week</button><button type="button" class="chip-btn" data-dl="2w">Within two weeks</button></div></div>
        <label class="field"><span>Don't start before</span><input type="datetime-local" name="earliest" value="${t.earliestStart ? T.toDTInput(t.earliestStart, tz) : ''}"></label>
        <label class="field"><span>Rank <em class="muted">(1 = most important)</em></span><input type="number" name="rank" min="1" max="99" value="${t.rank}"></label>
      </div>

      <fieldset class="box">
        <legend>Sessions</legend>
        <div class="grid3">
          <label class="field"><span>Session length (min)</span><input type="number" name="chunk" min="5" step="5" placeholder="${s.chunkMinutes} (default)" value="${t.chunkMinutes ?? ''}"></label>
          <label class="field"><span>Shortest session (min)</span><input type="number" name="minChunk" min="5" step="5" placeholder="${s.minChunkMinutes ? s.minChunkMinutes + ' (default)' : '= session length'}" value="${t.minChunkMinutes ?? ''}"></label>
          <label class="field"><span>Max per day (min)</span><input type="number" name="maxDay" min="5" step="5" placeholder="no limit" value="${t.maxPerDayMinutes ?? ''}"></label>
          <label class="field"><span>Break between (min)</span><input type="number" name="break" min="0" step="5" placeholder="${s.breakMinutes} (default)" value="${t.breakMinutes ?? ''}"></label>
          <label class="field"><span>Wiggle room (min)</span><input type="number" name="wiggle" min="0" step="5" placeholder="${s.wiggleMinutes ?? 15} (default)" value="${t.wiggleMinutes ?? ''}" title="Also use free slots up to this much shorter than the session length"></label>
          ${ctx.taskCalendars().length > 1 ? `<label class="field"><span>Google calendar</span><select name="calendarId">${ctx.taskCalendars().map((c) => `<option value="${esc(c.id)}" ${c.id === (t.calendarId || ctx.defaultTaskCal()) ? 'selected' : ''}>${esc(c.summary)}</option>`).join('')}</select></label>` : ''}
          <label class="field"><span>Reminder (min before)</span><input type="number" name="reminder" min="-1" placeholder="${s.taskReminderMinutes} (default)" value="${t.reminderMinutes ?? ''}"></label>
          <label class="field google-only-t"><span>Email reminder (min before)</span><input type="number" name="emailReminder" min="-1" placeholder="${s.taskEmailReminderMinutes != null ? s.taskEmailReminderMinutes + ' (default)' : 'off (default)'}" value="${t.emailReminderMinutes ?? ''}"></label>
          <div class="field color-field"><span>Color</span><div class="swatches">${TASK_COLORS.map((c) => `<label class="sw"><input type="radio" name="color" value="${c}" ${t.color === c ? 'checked' : ''}><i style="background:${c}"></i></label>`).join('')}</div></div>
        </div>
      </fieldset>

      <fieldset class="box">
        <legend>When to schedule</legend>
        <div class="when-opts">
          <label class="chk"><input type="radio" name="bmode" value="default" ${!t.bounds && !t.periodId ? 'checked' : ''}> Work hours <span class="muted small">(${s.bounds.start}–${s.bounds.end}, ${describeDays(s.bounds.days)})</span></label>
          ${(s.periods || []).map((p) => `<label class="chk"><input type="radio" name="bmode" value="period:${esc(p.id)}" ${!t.bounds && t.periodId === p.id ? 'checked' : ''}> ${esc(p.name)} <span class="muted small">(${esc(describeRules(p.rules))})</span></label>`).join('')}
          <label class="chk"><input type="radio" name="bmode" value="custom" ${t.bounds ? 'checked' : ''}> Custom for this task</label>
        </div>
        <div class="row custom-bounds">
          <input type="time" name="bStart" value="${b.start}" step="900"> <span class="muted">to</span> <input type="time" name="bEnd" value="${b.end}" step="900">
          ${weekdayToggles('bdays', b.days)}
        </div>
        <p class="muted small" style="margin:0">Add or change periods such as “After hours” in Settings → Scheduling.</p>
        <label class="chk"><input type="checkbox" name="ignoreBounds" ${t.ignoreBounds ? 'checked' : ''}> Ignore day bounds — also use time after my official day (${s.overflowBounds.start}–${s.overflowBounds.end}, any day)</label>
      </fieldset>

      <label class="field"><span>Notes</span><textarea name="notes" rows="2">${esc(t.notes || '')}</textarea></label>
      <div class="preview"></div>
    </div>
    <footer class="actions">
      ${task ? '<button type="button" class="btn danger ghost del">Delete series</button>' : ''}
      <span class="grow"></span>
      <button type="button" class="btn ghost" data-close>Cancel</button>
      <button type="submit" class="btn primary">${task ? 'Save & reschedule' : 'Schedule'}</button>
    </footer>
  </form>`;

  return modal(html, (dlg, close) => {
    const f = $('form', dlg);
    f.unit.value = r.unit;
    f.labels.value = r.labels || 'actual';
    let cat = C.catById(s, t.categoryId);
    const showColor = () => { $('.color-field', dlg).style.display = cat ? 'none' : ''; };
    C.categoryPicker($('.cat-host', dlg), {
      settings: s, selected: cat?.id,
      onChange: (c) => { cat = c; showColor(); update(); },
      onCreate: async (name, color, icon) => { const c = C.newCategory(s, name, color, icon); await ctx.saveSettings(); return c; },
    });
    showColor();
    // Deadline shortcuts, based on the task's own day bounds if set, otherwise the default ones
    $$('[data-dl]', dlg).forEach((b) => (b.onclick = () => {
      const bd = f.bmode.value === 'custom' ? { start: f.bStart.value || '09:00', end: f.bEnd.value || '17:00', days: $$('input[name=bdays]:checked', dlg).map((c) => +c.value) } : s.bounds;
      f.deadline.value = T.toDTInput(deadlinePreset(b.dataset.dl, bd, tz), tz);
      $$('[data-dl]', dlg).forEach((x) => x.classList.toggle('on', x === b));
      update();
    }));
    if (!ctx.taskCalendars().length) $$('.google-only-t', dlg).forEach((e) => (e.style.display = 'none'));

    const read = () => {
      const kind = f.kind.value;
      const custom = f.bmode.value === 'custom';
      const num = (v) => (v === '' || v == null ? null : +v);
      return {
        ...t,
        kind,
        title: f.title.value.trim() || (kind === 'reading' ? 'Reading' : 'Task'),
        totalMinutes: Math.max(5, Math.round((+f.hours.value || 0) * 60)),
        reading: { pages: Math.max(1, +f.pages.value || 1), startPage: Math.max(1, +f.startPage.value || 1), speed: Math.max(0.1, +f.speed.value || 1), unit: f.unit.value, labels: f.labels.value },
        deadline: T.fromDTInput(f.deadline.value, tz),
        earliestStart: T.fromDTInput(f.earliest.value, tz),
        rank: Math.max(1, Math.round(+f.rank.value || 3)),
        chunkMinutes: num(f.chunk.value), minChunkMinutes: num(f.minChunk.value), maxPerDayMinutes: num(f.maxDay.value),
        breakMinutes: num(f.break.value), wiggleMinutes: num(f.wiggle.value), reminderMinutes: num(f.reminder.value), emailReminderMinutes: num(f.emailReminder.value),
        color: f.color.value || t.color,
        bounds: custom ? { start: f.bStart.value || '09:00', end: f.bEnd.value || '17:00', days: $$('input[name=bdays]:checked', dlg).map((c) => +c.value) } : null,
        ...(() => {
          const pid = f.bmode.value.startsWith('period:') ? f.bmode.value.slice(7) : null;
          const per = pid && (s.periods || []).find((x) => x.id === pid);
          return per ? { periodId: per.id, periodName: per.name, periodRules: per.rules } : { periodId: null, periodName: null, periodRules: null };
        })(),
        ignoreBounds: f.ignoreBounds.checked,
        notes: f.notes.value,
        calendarId: f.calendarId ? f.calendarId.value : t.calendarId,
      };
    };
    const readWithCat = () => C.applyCategory(read(), cat);

    const update = () => {
      const kind = f.kind.value;
      $$('.only-generic', dlg).forEach((e) => (e.style.display = kind === 'generic' ? '' : 'none'));
      $$('.only-reading', dlg).forEach((e) => (e.style.display = kind === 'reading' ? '' : 'none'));
      f.title.placeholder = kind === 'reading' ? 'Book title, e.g. Pride and Prejudice' : 'Task name';
      $('.custom-bounds', dlg).style.display = f.bmode.value === 'custom' ? '' : 'none';
      const draft = read();
      const total = S.totalMinutes(draft);
      const p = S.params(draft, s);
      $('.calc', dlg).textContent = kind === 'reading'
        ? `≈ ${T.fmtDur(total)} of reading · ${+(S.pagesPerHour(draft.reading)).toFixed(1)} pages/hour · ≈ ${Math.ceil(total / p.chunk)} sessions of ${p.chunk} min`
        : `≈ ${Math.ceil(total / p.chunk)} sessions of ${p.chunk} min`;
      // Live preview using the last known busy time and the other tasks
      const others = st.tasks.filter((x) => x.id !== draft.id);
      const { tasks, problems } = S.rescheduleAll([...others, draft], ctx.lastBusy || [], s, Date.now());
      const mine = tasks.find((x) => x.id === draft.id);
      const ss = S.sessions(mine).filter((c) => c.kind !== 'done');
      const prob = problems.find((x) => x.taskId === draft.id);
      const fmt = (ms) => T.format(ms, tz, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: s.h12 });
      let out = '';
      if (ss.length) {
        out += `<div class="pv-head">${ss.length} session${ss.length > 1 ? 's' : ''} · first ${fmt(ss[0].start)} · last ends ${fmt(ss[ss.length - 1].end)}</div>`;
        out += `<ol class="pv-list">${ss.slice(0, 6).map((c) => `<li><b>${fmt(c.start)}</b> ${esc(c.label)}</li>`).join('')}${ss.length > 6 ? `<li class="muted">… ${ss.length - 6} more</li>` : ''}</ol>`;
      }
      if (prob) {
        out += `<div class="warn">⚠ Not enough free time before the deadline — ${T.fmtDur(prob.shortfall)} short.
          ${prob.suggestedDeadline ? `Earliest feasible deadline: <b>${fmt(prob.suggestedDeadline)}</b>. <button type="button" class="link use-sugg" data-v="${prob.suggestedDeadline}">Use it</button>` : ''}
          ${prob.fitsIgnoringBounds ? ' It would fit if you ignore day bounds.' : ''}</div>`;
      }
      setHTML($('.preview', dlg), out);
      $('.use-sugg', dlg)?.addEventListener('click', (e) => { f.deadline.value = T.toDTInput(+e.target.dataset.v, tz); update(); });
    };
    let timer;
    f.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(update, 120); });
    f.addEventListener('change', update);
    update();

    $('.del', dlg)?.addEventListener('click', () => close({ delete: true }));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const nt = readWithCat();
      if (!nt.deadline) return;
      if (!(await checkSpan('Deadline', nt.deadline, s))) return;
      const others = st.tasks.filter((x) => x.id !== nt.id);
      const mine = S.rescheduleAll([...others, nt], ctx.lastBusy || [], s, Date.now()).tasks.find((x) => x.id === nt.id);
      const n = S.sessions(mine).filter((c) => c.kind !== 'done').length;
      if (!(await checkCount('sessions', n, s))) return;
      close({ task: nt });
    });
  }, { cls: 'wide' });
}

// ======================================================================================
// Not enough time prompt
// ======================================================================================
export function problemDialog(ctx, task, prob) {
  const tz = ctx.state.settings.tz;
  const fmt = (ms) => T.format(ms, tz, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: ctx.state.settings.h12 });
  const sugg = prob.suggestedDeadline || task.deadline + 7 * T.DAY;
  return modal(`
    <form class="problem">
      <h2>Not enough time for “${esc(task.title)}”</h2>
      <p>With your current calendar there's <b>${T.fmtDur(prob.shortfall)}</b> of work that doesn't fit before the deadline (${fmt(task.deadline)}).</p>
      <label class="field"><span>New deadline</span><input type="datetime-local" name="dl" value="${T.toDTInput(sugg, tz)}"></label>
      ${prob.suggestedDeadline ? `<p class="muted small">Suggested: the earliest deadline that fits everything — ${fmt(prob.suggestedDeadline)}.</p>` : ''}
      <div class="choice-list">
        <button type="button" class="choice-btn" data-a="deadline"><strong>Set this new deadline</strong><span>Reschedule all sessions before it.</span></button>
        ${!task.ignoreBounds ? `<button type="button" class="choice-btn" data-a="ignore"><strong>Ignore day bounds for this task</strong><span>${prob.fitsIgnoringBounds ? 'This will fit using evening/weekend time.' : 'Uses evenings and weekends too (may still not fit).'}</span></button>` : ''}
        <button type="button" class="choice-btn" data-a="keep"><strong>Keep the deadline</strong><span>Leftover sessions stay scheduled after the deadline, marked overdue.</span></button>
      </div>
    </form>`, (dlg, close) => {
    $$('.choice-btn', dlg).forEach((b) => b.addEventListener('click', () => close({ action: b.dataset.a, deadline: T.fromDTInput($('[name=dl]', dlg).value, tz) })));
  }, { cls: 'narrow' });
}

// ======================================================================================
// Settings
// ======================================================================================
export function settingsDialog(ctx) {
  const st = ctx.state, s = st.settings;
  const auth = st.auth || {};
  const redirect = G.redirectUri();
  const cals = (st.gmeta.calendars || []).filter((c) => ['owner', 'writer'].includes(c.accessRole));
  const allCals = [{ id: LOCAL_CAL, summary: 'Local (this browser)' }, ...(st.gmeta.calendars || [])];
  const busySet = new Set(s.busyCalendars || allCals.map((c) => c.id));
  const agendaCal = (st.gmeta.calendars || []).find((c) => c.id === (s.taskCalendarId || '')) || (st.gmeta.calendars || []).find((c) => c.primary);
  const agendaOn = !!agendaCal?.notificationSettings?.notifications?.some((n) => n.type === 'agenda' && n.method === 'email');
  let cats = (s.categories || []).map((c) => ({ ...c }));
  let periods = (s.periods || []).map((p) => ({ ...p, rules: p.rules.map((r) => ({ ...r, days: [...r.days] })) }));
  const html = `
  <form class="settings-form">
    <header class="dlg-head"><h2>Settings</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></header>
    <nav class="tabs">${[['General', 0], ['Scheduling', 1], ['Categories', 5], ['Google Calendar', 2], ['Notifications', 3], ['Data', 4]].map(([n, i]) => `<button type="button" data-tab="${i}" class="${i ? '' : 'on'}">${n}</button>`).join('')}</nav>
    <div class="dlg-body">
      <section data-pane="0">
        <label class="field"><span>Display time zone</span><input name="tz" list="tzlist2" value="${esc(s.tz)}" spellcheck="false"></label>${tzDatalist('tzlist2')}
        <div class="grid3">
          <label class="field"><span>Week view shows</span><select name="weekView"><option value="calendar">Calendar week</option><option value="rolling" ${s.weekView === 'rolling' ? 'selected' : ''}>Today + next 6 days</option></select></label>
          <label class="field"><span>Week starts on</span><select name="weekStart"><option value="1">Monday</option><option value="0" ${s.weekStart === 0 ? 'selected' : ''}>Sunday</option><option value="6" ${s.weekStart === 6 ? 'selected' : ''}>Saturday</option></select></label>
          <label class="field"><span>Time format</span><select name="h12"><option value="0">24-hour</option><option value="1" ${s.h12 ? 'selected' : ''}>12-hour</option></select></label>
          <label class="field"><span>Hour height (px)</span><input type="number" name="hourHeight" min="28" max="120" value="${s.hourHeight}"></label>
          <label class="field"><span>Drag snapping (min)</span><select name="snapMinutes">${[5, 10, 15, 30, 60].map((v) => `<option ${v === s.snapMinutes ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
          <label class="field"><span>Default event length (min)</span><input type="number" name="defaultEventMinutes" min="5" step="5" value="${s.defaultEventMinutes}"></label>
        </div>
      </section>
      <section data-pane="1" hidden>
        <fieldset class="box"><legend>Default day bounds</legend>
          <div class="row"><input type="time" name="bStart" value="${s.bounds.start}" step="900"> <span class="muted">to</span> <input type="time" name="bEnd" value="${s.bounds.end}" step="900"></div>
          ${weekdayToggles('bdays', s.bounds.days)}
        </fieldset>
        <fieldset class="box"><legend>Time periods</legend>
          <p class="muted small" style="margin:0">Extra windows a task can be scheduled in instead of the work hours above, e.g. “After hours” on Mon, Wed and Thu evenings plus weekends. Each period can have several rules.</p>
          <div class="periods-list"></div>
          <button type="button" class="btn small add-period">+ Add period</button>
        </fieldset>
        <fieldset class="box"><legend>When a task ignores day bounds, use</legend>
          <div class="row"><input type="time" name="oStart" value="${s.overflowBounds.start}" step="900"> <span class="muted">to</span> <input type="time" name="oEnd" value="${s.overflowBounds.end}" step="900"></div>
          ${weekdayToggles('odays', s.overflowBounds.days)}
        </fieldset>
        <div class="grid3">
          <label class="field"><span>Default session length (min)</span><input type="number" name="chunkMinutes" min="5" step="5" value="${s.chunkMinutes}"></label>
          <label class="field"><span>Shortest session (min) — used only to meet a deadline</span><input type="number" name="minChunkMinutes" min="5" step="5" value="${s.minChunkMinutes ?? ''}" placeholder="= session length"></label>
          <label class="field"><span>Break between sessions (min)</span><input type="number" name="breakMinutes" min="0" step="5" value="${s.breakMinutes}"></label>
          <label class="field"><span>Wiggle room (min) — also use free slots this much shorter than a session</span><input type="number" name="wiggleMinutes" min="0" step="5" value="${s.wiggleMinutes ?? 15}"></label>
        </div>
        <fieldset class="box"><legend>Limits</legend>
          <div class="grid3">
            <label class="field"><span>Ask before creating more than … sessions / repeats</span><input type="number" name="sessionWarn" min="0" value="${s.sessionWarn ?? 20}"></label>
            <label class="field"><span>Never create more than … sessions / repeats</span><input type="number" name="sessionMax" min="0" value="${s.sessionMax ?? 50}"></label>
            <label class="field"><span>Furthest ahead a task or repeating event may run (days, 0 = no limit)</span><input type="number" name="maxSpanDays" min="0" value="${s.maxSpanDays ?? 365}"></label>
          </div>
        </fieldset>
        <label class="chk"><input type="checkbox" name="assumePastDone" ${s.assumePastDone ? 'checked' : ''}> Assume past sessions were done (mark them undone to reschedule)</label>
        <label class="chk"><input type="checkbox" name="allDayBlocks" ${s.allDayBlocks ? 'checked' : ''}> All-day events block task time</label>
        <fieldset class="box"><legend>Calendars that count as busy</legend>
          ${allCals.map((c) => `<label class="chk"><input type="checkbox" name="busy" value="${esc(c.id)}" ${busySet.has(c.id) ? 'checked' : ''}> ${esc(c.summary)}</label>`).join('')}
        </fieldset>
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
        <label class="chk"><input type="checkbox" name="syncTasksToGoogle" ${s.syncTasksToGoogle ? 'checked' : ''}> Write task sessions to Google Calendar</label>
        <label class="field"><span>Calendar for task sessions</span>
          <div class="join"><select name="taskCalendarId"><option value="">Primary calendar</option>${cals.filter((c) => !c.primary).map((c) => `<option value="${esc(c.id)}" ${s.taskCalendarId === c.id ? 'selected' : ''}>${esc(c.summary)}</option>`).join('')}</select>
          <button type="button" class="btn small create-cal" ${auth.connected ? '' : 'disabled'}>Create “Tempo Tasks”</button></div></label>
        <button type="button" class="btn small ghost cleanup" ${auth.connected ? '' : 'disabled'}>Remove stray task events from Google</button>
      </section>
      <section data-pane="3" hidden>
        <label class="chk"><input type="checkbox" name="notifyTasks" ${s.notifyTasks ? 'checked' : ''}> Desktop notifications for task sessions</label>
        <label class="field"><span>Default task reminder (minutes before, -1 for none)</span><input type="number" name="taskReminderMinutes" min="-1" value="${s.taskReminderMinutes}"></label>
        <label class="chk"><input type="checkbox" name="notifyLocal" ${s.notifyLocal ? 'checked' : ''}> Desktop notifications for local events</label>
        <label class="chk"><input type="checkbox" name="notifyGoogle" ${s.notifyGoogle ? 'checked' : ''}> Desktop notifications for Google events too (Google also notifies on its own)</label>
        <label class="field"><span>Default reminder for new events (minutes)</span><input type="number" name="defaultReminder" min="0" value="${s.defaultReminder}"></label>
        <button type="button" class="btn small ghost test-notif">Send a test notification</button>
        <fieldset class="box">
          <legend>Email notifications (sent by Google)</legend>
          ${auth.connected ? `
          <label class="field"><span>Email reminder before each task session (minutes, empty = off)</span><input type="number" name="taskEmailReminderMinutes" min="0" placeholder="off" value="${s.taskEmailReminderMinutes ?? ''}"></label>
          <label class="chk"><input type="checkbox" name="agendaEmail" ${agendaOn ? 'checked' : ''}> Daily agenda email every morning (${esc(agendaCal?.summary || 'primary calendar')})</label>
          <p class="muted small">Google emails ${esc(auth.email || 'your Google address')}. Events you create in Tempo can also get email reminders: add one under Notifications in the event dialog. A task can override the session reminder in its own settings.</p>`
          : '<p class="muted small">Connect Google Calendar to get email reminders for task sessions and a daily agenda email.</p>'}
        </fieldset>
      </section>
      <section data-pane="5" hidden>
        <p class="muted small">Give tasks a category to color-code them and to group time in Analysis. A category's icon is added to its sessions' titles (also in Google Calendar). You can also add categories directly in the task dialog.</p>
        <label class="chk"><input type="checkbox" name="askCategory" ${s.askCategory !== false ? 'checked' : ''}> When I create a task without a category, ask me for one</label>
        <div class="cats-list"></div>
        <button type="button" class="btn small add-cat">+ Add category</button>
      </section>
      <section data-pane="4" hidden>
        <p class="muted small">Tasks, settings and local events live in this browser's extension storage. Back them up or move them to another browser:</p>
        <div class="row"><button type="button" class="btn small export-json">Download backup (.json)</button>
        <label class="btn small ghost">Restore backup…<input type="file" accept=".json" class="import-json" hidden></label></div>
        <p class="muted small">Tempo has no servers: your data only travels between this browser and your own Google account. <a href="privacy.html" target="_blank" rel="noopener">Privacy policy</a></p>
      </section>
    </div>
    <footer class="actions"><span class="grow"></span><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn primary">Save</button></footer>
  </form>`;

  return modal(html, (dlg, close) => {
    const f = $('form', dlg);
    $$('.tabs button', dlg).forEach((b) => b.addEventListener('click', () => {
      $$('.tabs button', dlg).forEach((x) => x.classList.toggle('on', x === b));
      $$('[data-pane]', dlg).forEach((p) => (p.hidden = p.dataset.pane !== b.dataset.tab));
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
        <button type="button" class="link per-add-rule">+ Add rule</button></div>`).join('') || '<p class="muted small">No periods.</p>');
      $$('.period', dlg).forEach((el2) => {
        const p = periods[+el2.dataset.i];
        $('.per-name', el2).oninput = (e) => { p.name = e.target.value; };
        $('.per-del', el2).onclick = () => { periods.splice(+el2.dataset.i, 1); drawPeriods(); };
        $('.per-add-rule', el2).onclick = () => { p.rules.push({ days: [6, 0], start: '10:00', end: '18:00' }); drawPeriods(); };
        $$('.per-rule', el2).forEach((rw) => {
          const r = p.rules[+rw.dataset.j];
          $('.r-start', rw).onchange = (e) => { r.start = e.target.value || r.start; };
          $('.r-end', rw).onchange = (e) => { r.end = e.target.value || r.end; };
          $$('.r-day', rw).forEach((c) => (c.onchange = () => { r.days = $$('.r-day:checked', rw).map((x) => +x.value); }));
          $('.r-del', rw).onclick = () => { p.rules.splice(+rw.dataset.j, 1); drawPeriods(); };
        });
      });
    };
    drawPeriods();
    $('.add-period', dlg).onclick = () => { periods.push({ id: 'p-' + Math.random().toString(36).slice(2, 8), name: 'New period', rules: [{ days: [1, 2, 3, 4, 5], start: s.bounds.end, end: '21:00' }] }); drawPeriods(); };
    const drawCats = () => {
      setHTML($('.cats-list', dlg), cats.map((c, i) => `<div class="cat-row" data-i="${i}">
        <span class="sw-dot big" style="background:${esc(c.color)}"></span>
        <details class="ic-pick"><summary class="cat-icbtn" title="Icon" aria-label="Choose icon">${esc(c.icon || '＋')}</summary>
          <div class="icon-grid"><input class="cat-icin" placeholder="Type or paste" maxlength="8" value="${esc(c.icon || '')}">${C.CAT_ICONS.map((ic) => `<button type="button" class="ic-btn" data-ic="${ic}">${ic}</button>`).join('')}<button type="button" class="ic-btn none" data-ic="">No icon</button></div></details>
        <input class="cat-nm" value="${esc(c.name)}" maxlength="30" aria-label="Category name">
        <div class="swatches">${C.CAT_COLORS.map((col) => `<label class="sw"><input type="radio" name="cc${i}" value="${col}" ${col === c.color ? 'checked' : ''}><i style="background:${col}"></i></label>`).join('')}</div>
        <button type="button" class="icon-btn cat-del" title="Delete category" aria-label="Delete category">✕</button></div>`).join('') || '<p class="muted small">No categories yet.</p>');
      $$('.cat-row', dlg).forEach((row) => {
        const i = +row.dataset.i;
        $('.cat-nm', row).oninput = (e) => { cats[i].name = e.target.value; };
        const pick = $('.ic-pick', row);
        pick.ontoggle = () => {
          if (!pick.open) return;
          $$('.ic-pick[open]', dlg).forEach((o) => { if (o !== pick) o.open = false; });
          const r = $('.cat-icbtn', row).getBoundingClientRect(), grid = $('.icon-grid', pick);
          grid.style.left = Math.max(8, Math.min(innerWidth - 276, r.left)) + 'px';
          grid.style.top = (r.bottom + 268 > innerHeight ? Math.max(8, r.top - 268) : r.bottom + 4) + 'px';
        };
        const setIc = (v) => { cats[i].icon = C.cleanIcon(v); $('.cat-icbtn', row).textContent = cats[i].icon || '＋'; };
        $('.cat-icin', row).oninput = (e) => setIc(e.target.value);
        $$('.ic-btn', row).forEach((b) => (b.onclick = () => { setIc(b.dataset.ic); $('.cat-icin', row).value = cats[i].icon; $('.ic-pick', row).open = false; }));
        $$('input[type=radio]', row).forEach((r) => (r.onchange = () => { cats[i].color = r.value; $('.sw-dot', row).style.background = r.value; }));
        $('.cat-del', row).onclick = () => { cats.splice(i, 1); drawCats(); };
      });
    };
    drawCats();
    $('.add-cat', dlg).onclick = () => { cats.push({ id: 'cat-' + Math.random().toString(36).slice(2, 8), name: 'New category', color: C.CAT_COLORS[cats.length % C.CAT_COLORS.length], icon: '' }); drawCats(); $$('.cat-nm', dlg).at(-1).select(); };
    $('.export-json', dlg).onclick = () => ctx.exportJson();
    $('.import-json', dlg).onchange = (e) => { const file = e.target.files[0]; if (file) close({ action: 'import', file }); };

    function collect() {
      const days = (n) => $$(`input[name=${n}]:checked`, dlg).map((c) => +c.value);
      const busy = $$('input[name=busy]:checked', dlg).map((c) => c.value);
      return {
        ...s,
        tz: T.isValidTz(f.tz.value.trim()) ? f.tz.value.trim() : s.tz,
        weekStart: +f.weekStart.value, weekView: f.weekView.value, h12: f.h12.value === '1',
        hourHeight: Math.min(120, Math.max(28, +f.hourHeight.value || 48)),
        snapMinutes: +f.snapMinutes.value, defaultEventMinutes: +f.defaultEventMinutes.value || 60,
        bounds: { start: f.bStart.value || '09:00', end: f.bEnd.value || '17:00', days: days('bdays') },
        overflowBounds: { start: f.oStart.value || '07:00', end: f.oEnd.value || '23:00', days: days('odays') },
        chunkMinutes: Math.max(5, +f.chunkMinutes.value || 60), minChunkMinutes: f.minChunkMinutes.value ? Math.max(5, +f.minChunkMinutes.value) : null,
        breakMinutes: Math.max(0, +f.breakMinutes.value || 0),
        wiggleMinutes: Math.max(0, f.wiggleMinutes.value === '' ? 15 : +f.wiggleMinutes.value),
        sessionWarn: Math.max(0, +f.sessionWarn.value || 0), sessionMax: Math.max(0, +f.sessionMax.value || 0), maxSpanDays: Math.max(0, +f.maxSpanDays.value || 0),
        assumePastDone: f.assumePastDone.checked, allDayBlocks: f.allDayBlocks.checked,
        busyCalendars: busy.length === allCals.length ? null : busy,
        syncTasksToGoogle: f.syncTasksToGoogle.checked, taskCalendarId: f.taskCalendarId.value || null,
        notifyTasks: f.notifyTasks.checked, notifyLocal: f.notifyLocal.checked, notifyGoogle: f.notifyGoogle.checked,
        taskReminderMinutes: +f.taskReminderMinutes.value, defaultReminder: Math.max(0, +f.defaultReminder.value || 0),
        taskEmailReminderMinutes: f.taskEmailReminderMinutes ? (f.taskEmailReminderMinutes.value === '' ? null : Math.max(0, +f.taskEmailReminderMinutes.value)) : s.taskEmailReminderMinutes,
        categories: cats.map((c) => ({ ...c, name: c.name.trim() || 'Untitled' })),
        askCategory: f.askCategory.checked,
        periods: periods.map((p) => ({ ...p, name: p.name.trim() || 'Untitled period', rules: p.rules.filter((r) => r.days.length && r.start && r.end) })),
        _agendaEmail: f.agendaEmail ? { want: f.agendaEmail.checked, was: agendaOn, calId: agendaCal?.id } : null,
      };
    }
    f.addEventListener('submit', async (e) => { e.preventDefault(); await saveClientId(); close({ action: 'save', settings: collect() }); });
  }, { cls: 'wide' });
}


// ======================================================================================
// Sync status panel
// ======================================================================================
export function syncDialog(ctx) {
  const st = ctx.state, a = st.auth || {}, info = st.syncInfo;
  const tz = st.settings.tz;
  const conn = a.connected && G.hasClient(a);
  const cal = (st.gmeta.calendars || []).find((c) => c.id === (st.settings.taskCalendarId || (st.gmeta.calendars || []).find((x) => x.primary)?.id));
  const total = st.tasks.filter((t) => !t.archived).reduce((n, t) => n + S.sessions(t).length, 0);
  const onG = st.tasks.filter((t) => !t.archived).reduce((n, t) => n + S.sessions(t).filter((c) => c.gid).length, 0);
  const when = (ms) => T.format(ms, tz, { weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: st.settings.h12 });
  const row = (ok, label, detail = '') => `<li class="${ok === true ? 'ok' : ok === false ? 'bad' : 'warn'}"><b>${ok === true ? '✓' : ok === false ? '✕' : '!'}</b><div><div>${label}</div>${detail ? `<div class="muted small">${detail}</div>` : ''}</div></li>`;
  const checks = [
    row(conn, conn ? `Connected to Google${a.email ? ' as ' + esc(a.email) : ''}` : 'Not connected to Google', conn ? '' : 'Task sessions only exist in this browser until you connect.'),
    conn ? row(!a.needsReconnect, a.needsReconnect ? 'Sign-in expired' : 'Sign-in is valid', a.needsReconnect ? 'Google needs you to sign in again (this can happen about once an hour if silent renewal is blocked by your browser).' : '') : '',
    row(st.settings.syncTasksToGoogle, st.settings.syncTasksToGoogle ? 'Writing task sessions to Google is on' : 'Writing task sessions to Google is OFF', st.settings.syncTasksToGoogle ? '' : 'Turn it on in Settings → Google Calendar.'),
    conn ? row(true, `Sessions go to: <b>${esc(cal?.summary || 'Primary calendar')}</b>`, 'In Google Calendar, make sure this calendar is ticked under “My calendars”, then refresh the page.') : '',
    total ? row(onG === total && conn, `${onG} of ${total} task sessions are on Google Calendar`) : row(null, 'No task sessions yet'),
    info ? row(info.ok, info.ok ? `Last sync ${when(info.at)} — OK` : `Last sync ${when(info.at)} — problem`, info.ok ? '' : esc(info.error || '')) : '',
  ].join('');
  return modal(`
    <form class="syncdlg">
      <header class="dlg-head"><h2>Google sync status</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></header>
      <div class="dlg-body"><ul class="checks">${checks}</ul></div>
      <footer class="actions">
        ${!conn ? '<button type="button" class="btn primary" data-a="connect">Connect Google Calendar</button>' : ''}
        ${conn && (a.needsReconnect || info?.kind === 'permission' || info?.kind === 'auth') ? '<button type="button" class="btn primary" data-a="reconnect">Reconnect</button>' : ''}
        <span class="grow"></span>
        <button type="button" class="btn ghost" data-a="settings">Settings</button>
        ${conn ? '<button type="button" class="btn" data-a="sync">Sync now</button>' : ''}
      </footer>
    </form>`, (dlg, close) => {
    $$('[data-a]', dlg).forEach((b) => b.addEventListener('click', () => { if (b.dataset.a === 'reconnect' || b.dataset.a === 'connect') G.ensureHostPermission(); close(b.dataset.a); }));
  }, { cls: 'narrow' });
}

// ======================================================================================
// Setup wizard (own Google Cloud project)
// ======================================================================================
export function setupWizard(ctx) {
  const st = ctx.state, a = st.auth || {};
  const redirect = G.redirectUri() || 'https://<extension-id>.chromiumapp.org/';
  const link = (href, label) => `<a class="btn small" href="${href}" target="_blank" rel="noopener">${label} ↗</a>`;
  const steps = [
    { t: 'Create a free Google Cloud project', b: `<p>Google requires every app that edits calendars to have its own sign-in key. You'll make a private one just for yourself — it's free and takes about 5 minutes, once.</p>
        <p>Open the console, sign in with the Google account whose calendar you use, and create a project (any name, e.g. <i>Tempo</i>).</p>
        <div class="row">${link('https://console.cloud.google.com/projectcreate', 'Create project')}</div>` },
    { t: 'Turn on the Google Calendar API', b: `<p>Make sure your new project is selected at the top of the page, then click <b>Enable</b>.</p><div class="row">${link('https://console.cloud.google.com/apis/library/calendar-json.googleapis.com', 'Open Calendar API')}</div>` },
    { t: 'Set up the consent screen', b: `<p>Click <b>Get started</b> (or <i>Configure consent screen</i>):</p>
        <ol><li>App name: <b>Tempo</b>; support email: your email.</li><li>Audience: <b>External</b>.</li><li>Contact email: your email → <b>Create</b>.</li>
        <li>Then open <b>Audience</b> → <b>Test users</b> → <b>Add users</b> and add <b>your own Gmail address</b>.</li></ol>
        <div class="row">${link('https://console.cloud.google.com/auth/overview', 'Open consent screen')}${link('https://console.cloud.google.com/auth/audience', 'Open test users')}</div>` },
    { t: 'Create the sign-in key (OAuth client)', b: `<ol><li>Click <b>Create client</b>. Application type: <b>Web application</b>.</li>
        <li>Under <b>Authorized redirect URIs</b> click <b>Add URI</b> and paste exactly:</li></ol>
        <div class="join"><input readonly class="mono" value="${esc(redirect)}"><button type="button" class="btn small copy">Copy</button></div>
        <ol start="3"><li>Click <b>Create</b>, then copy the <b>Client ID</b> (ends in <i>.apps.googleusercontent.com</i>).</li></ol>
        <div class="row">${link('https://console.cloud.google.com/auth/clients/create', 'Create OAuth client')}</div>` },
    { t: 'Paste your Client ID and connect', b: `<label class="field"><span>Client ID</span><input name="cid" class="mono" spellcheck="false" placeholder="1234567890-abc123.apps.googleusercontent.com" value="${esc(a.clientId || '')}"></label>
        <div class="cid-hint small muted"></div>
        <p class="small muted">On Google's screen you may see “Google hasn't verified this app” — that's expected for your private key: click <b>Continue</b>. Then <b>tick every checkbox</b> (especially <i>See, edit, share and permanently delete all the calendars</i>) — if you leave it unticked, Tempo can't write task sessions.</p>
        <div class="row"><button type="button" class="btn primary go">Connect Google Calendar</button></div>
        <div class="result"></div>` },
  ];
  return modal(`
    <form class="wizard-form">
      <header class="dlg-head"><h2>Connect Google Calendar</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></header>
      <div class="wz-steps">${steps.map((x, i) => `<button type="button" data-s="${i}"><i>${i + 1}</i><span>${x.t}</span></button>`).join('')}</div>
      <div class="dlg-body">${steps.map((x, i) => `<section data-step="${i}" ${i ? 'hidden' : ''}><h3>${i + 1}. ${x.t}</h3>${x.b}</section>`).join('')}</div>
      <footer class="actions"><button type="button" class="btn ghost back">Back</button><span class="grow"></span><span class="muted small pos"></span><button type="button" class="btn primary next">Next</button></footer>
    </form>`, (dlg, close) => {
    let cur = a.clientId ? 4 : 0, connected = false;
    const show = (i) => {
      cur = Math.max(0, Math.min(steps.length - 1, i));
      $$('[data-step]', dlg).forEach((x) => (x.hidden = +x.dataset.step !== cur));
      $$('.wz-steps button', dlg).forEach((x) => { x.classList.toggle('on', +x.dataset.s === cur); x.classList.toggle('done', +x.dataset.s < cur); });
      $('.back', dlg).style.visibility = cur ? '' : 'hidden';
      $('.next', dlg).textContent = cur === steps.length - 1 ? (connected ? 'Done' : 'Close') : 'Next';
      $('.pos', dlg).textContent = `Step ${cur + 1} of ${steps.length}`;
    };
    $$('.wz-steps button', dlg).forEach((x) => (x.onclick = () => show(+x.dataset.s)));
    $('.back', dlg).onclick = () => show(cur - 1);
    $('.next', dlg).onclick = () => (cur === steps.length - 1 ? close({ connected }) : show(cur + 1));
    $('.copy', dlg).onclick = (e) => { navigator.clipboard?.writeText(redirect); e.target.textContent = 'Copied ✓'; };
    const cid = $('[name=cid]', dlg), hint = $('.cid-hint', dlg);
    const validate = () => {
      const v = cid.value.trim();
      const ok = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(v);
      hint.textContent = !v ? '' : ok ? '✓ Looks like a valid client ID' : v.includes('GOCSPX') ? 'That looks like the client SECRET — copy the Client ID instead.' : 'A client ID looks like 1234567890-abc….apps.googleusercontent.com';
      hint.className = 'cid-hint small ' + (ok ? 'g-ok' : v ? 'g-bad' : 'muted');
      return ok;
    };
    cid.addEventListener('input', validate); validate();
    $('.go', dlg).onclick = async () => {
      G.ensureHostPermission();
      if (!validate()) { cid.focus(); return; }
      const res = $('.result', dlg);
      setHTML(res, '<p class="muted">Waiting for Google…</p>');
      await ctx.saveAuth({ clientId: cid.value.trim(), mode: 'custom' });
      const r = await ctx.connect('custom');
      connected = r.ok;
      setHTML(res, r.ok
        ? `<div class="okbox">✓ Connected${r.email ? ' as <b>' + esc(r.email) + '</b>' : ''}. Your task sessions are being added to Google Calendar now.</div>`
        : `<div class="warn">✕ ${esc(r.error)}<br><span class="small">Most common fixes: the redirect URI in step 4 must match exactly; your Gmail must be listed as a Test user (step 3); tick all the checkboxes on Google's permission screen.</span></div>`);
      show(cur);
    };
    show(cur);
  }, { cls: 'wide' });
}


// ======================================================================================
// Multi-page export
// ======================================================================================
export function exportDialog(ctx, { cursor, weekStart }) {
  const tz = ctx.state.settings.tz;
  return modal(`
    <form class="export-form">
      <header class="dlg-head"><h2>Export several weeks or months</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></header>
      <div class="dlg-body">
        <div class="grid2">
          <div class="field"><span>Each page shows</span>
            <div class="seg"><label><input type="radio" name="unit" value="week" checked><span>One week</span></label><label><input type="radio" name="unit" value="month"><span>One month</span></label></div></div>
          <label class="field"><span>Number of pages</span><input type="number" name="count" min="1" max="52" value="4"></label>
          <label class="field"><span>Starting from (the week/month containing)</span><input type="date" name="start" value="${cursor}"></label>
          <div class="field"><span>Format</span>
            <div class="seg"><label><input type="radio" name="fmt" value="pdf" checked><span>PDF</span></label><label><input type="radio" name="fmt" value="tiff"><span>TIFF</span></label></div></div>
          <label class="field"><span>Quality</span><select name="scale"><option value="2">High (sharp when printed)</option><option value="1">Standard (smaller file)</option></select></label>
        </div>
        <p class="summary muted"></p>
      </div>
      <footer class="actions"><span class="grow"></span><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn primary">Export</button></footer>
    </form>`, (dlg, close) => {
    const f = $('form', dlg);
    const upd = () => {
      const unit = f.unit.value, n = Math.max(1, Math.min(52, +f.count.value || 1));
      const k0 = unit === 'month' ? T.addMonths(f.start.value || cursor, 0) : T.startOfWeek(f.start.value || cursor, weekStart);
      const kN = unit === 'month' ? T.addDays(T.addMonths(k0, n), -1) : T.addDays(k0, 7 * n - 1);
      const fmtD = (k) => T.format(T.dayStart(k, tz), tz, { day: 'numeric', month: 'short', year: 'numeric' });
      $('.summary', dlg).textContent = `${n} page${n > 1 ? 's' : ''} covering ${fmtD(k0)} – ${fmtD(kN)} as one ${f.fmt.value === 'pdf' ? 'PDF' : 'multi-page TIFF'} file.`;
    };
    f.addEventListener('input', upd); f.addEventListener('change', upd); upd();
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      close({ unit: f.unit.value, count: Math.max(1, Math.min(52, +f.count.value || 1)), start: f.start.value || cursor, fmt: f.fmt.value, scale: +f.scale.value });
    });
  }, { cls: 'narrow' });
}

// ======================================================================================
// Deleting a session that was already done: reschedule (default) or not, and optionally record what you did instead
// ======================================================================================
export function deleteDoneDialog(ctx, task, sess) {
  const st = ctx.state, s = st.settings, tz = s.tz;
  const when = `${T.format(sess.start, tz, { weekday: 'short', day: 'numeric', month: 'short' })}, ${T.fmtTime(sess.start, tz, s.h12)}–${T.fmtTime(sess.end, tz, s.h12)}`;
  const others = S.sortTasks(st.tasks.filter((t) => !t.archived && t.id !== task.id));
  const cals = ctx.writableCalendars();
  return modal(`
    <form class="deldone">
      <header class="dlg-head"><h2>Delete done session</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></header>
      <div class="dlg-body">
        <p class="muted small" style="margin:0">“${esc(sess.label)}” · ${esc(when)}</p>
        <label class="chk big-chk"><input type="checkbox" name="resched" checked>
          <span><b>Reschedule this session's work</b><br><span class="muted small">It wasn't really done — find a future free slot for it. Untick if the work is no longer needed.</span></span></label>
        <fieldset class="box">
          <legend>What did you do in that time instead? (optional)</legend>
          <label class="chk"><input type="radio" name="rep" value="none" checked> Nothing to record</label>
          <label class="chk"><input type="radio" name="rep" value="event"> Something else — add it to the calendar</label>
          <div class="row rep-event">
            <input name="evTitle" placeholder="e.g. Team meeting, Errands" style="flex:1;min-width:160px">
            <select name="evCal">${cals.map((c) => `<option value="${esc(c.id)}">${esc(c.summary)}</option>`).join('')}</select>
          </div>
          ${others.length ? `<label class="chk"><input type="radio" name="rep" value="task"> Worked on another task — count this time toward it</label>
          <div class="row rep-task"><select name="repTask" style="flex:1">${others.map((t) => `<option value="${esc(t.id)}">${esc(t.title)}</option>`).join('')}</select></div>` : ''}
        </fieldset>
      </div>
      <footer class="actions">
        <button type="button" class="btn danger ghost all">Delete entire series…</button>
        <span class="grow"></span>
        <button type="button" class="btn ghost" data-close>Cancel</button>
        <button type="submit" class="btn primary">Delete session</button>
      </footer>
    </form>`, (dlg, close) => {
    const f = $('form', dlg);
    const sync = () => {
      const v = f.rep.value;
      $('.rep-event', dlg).style.display = v === 'event' ? '' : 'none';
      const rt = $('.rep-task', dlg); if (rt) rt.style.display = v === 'task' ? '' : 'none';
      if (v === 'event') f.evTitle.focus();
    };
    f.addEventListener('change', sync); sync();
    $('.all', dlg).onclick = () => close({ action: 'all' });
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const kind = f.rep.value;
      if (kind === 'event' && !f.evTitle.value.trim()) { f.evTitle.focus(); return; }
      close({ action: 'one', reschedule: f.resched.checked, replace: { kind, title: f.evTitle.value.trim(), calId: f.evCal.value, taskId: f.repTask?.value } });
    });
  }, { cls: 'narrow' });
}
