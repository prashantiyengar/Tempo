// The event dialog: create or edit an event (times, repeat, calendar, category, notifications, guests…).
import * as T from './tz.js';
import * as G from './gcal.js';
import { parseRRule, buildRRule, describe, sameRule } from './rrule.js';
import { LOCAL_CAL, interval } from './engine.js';
import { $, $$, esc, modal, setHTML, choose } from './ui.js';
import * as C from './categories.js';
import * as N from './notify.js';
import { ORD, WDL, askTitle, checkCount, limitHint, nudgesHTML, recurrenceExtent, sect, tzDatalist, weekdayToggles, wireSects } from './dialogs.js';

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
      <input name="summary" class="title-input" placeholder="Add title" value="${esc(ev?.summary || init.title || '')}" autofocus autocomplete="off">
      <button type="button" class="icon-btn" data-close aria-label="Close">✕</button>
    </header>
    <div class="dlg-body">
      <div class="row when">
        <label class="chk"><input type="checkbox" name="allDay" ${allDay ? 'checked' : ''}> All day</label>
      </div>
      <div class="tline">
        <span class="t-l">From</span>
        <input type="date" name="sDate" value="${sKey}" required>
        <input type="time" name="sTime" value="${sTime}" step="60" class="timed">
        <button type="button" class="now-btn st-now timed" title="Start now (keeps the length)">Now</button>
      </div>
      <div class="row timed t-adj">
        ${nudgesHTML('st-add')}
        ${ctx.lastEventEnd ? '<button type="button" class="chip-btn since-last" title="Start when the previous event ended (looks back up to 12 hours, also into the day before)">⤒ Since last event</button>' : ''}
      </div>
      <div class="tline">
        <span class="t-l">To</span>
        <input type="date" name="eDate" value="${eKey}" required data-quick="off">
        <input type="time" name="eTime" value="${eTime}" step="60" class="timed">
        <button type="button" class="now-btn en-now timed" title="End now">Now</button>
        <span class="muted small timed t-len">Length <b class="dur-now"></b></span>
      </div>
      <div class="row timed t-adj dur-row">
        ${nudgesHTML('dur-add')}
        ${ctx.nextEventStart ? '<button type="button" class="chip-btn till-next" title="End when the next event starts (looks ahead up to 12 hours)">⤓ Till next event</button>' : ''}
      </div>
      <div class="row catcol">
        <div class="field grow"><span>Category</span><div class="ev-cat-host"></div></div>
        <div class="field"><span>Color</span>
          <div class="swatches small">
            <label class="sw"><input type="radio" name="colorId" value="" ${!colorId ? 'checked' : ''}><i class="sw-cal" title="Calendar color"></i></label>
            ${Object.entries(G.EVENT_COLORS).map(([id, c]) => `<label class="sw"><input type="radio" name="colorId" value="${id}" ${colorId === id ? 'checked' : ''}><i style="background:${c}"></i></label>`).join('')}
          </div>
        </div>
      </div>

      ${sect('ev-notify', 'Notifications &amp; repeat', `
        <div class="sub-h">Notifications</div>
        <label class="field"><span>Profile</span><select name="nprofile">${N.profiles(s).map((p) => `<option value="${esc(p.id)}">${esc(p.name)} — ${esc(N.describeProfile(p))}</option>`).join('')}<option value="">Custom</option></select></label>
        <label class="chk google-only"><input type="checkbox" name="useDefault" ${rem.useDefault && !isNew ? 'checked' : ''}> Use calendar's default notifications</label>
        <div class="rem-rows"></div>
        <button type="button" class="btn small ghost add-rem">+ Add notification</button>
        <div class="sub-h">Repeat</div>
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
        <div class="muted small rec-desc"></div>`)}

      ${sect('ev-more', 'Calendar, location &amp; more', `
        <div class="row timed">
          <label class="field grow"><span>Time zone</span>
            <input name="tz" list="tzlist" value="${esc(evTz)}" spellcheck="false">
          </label>
          ${tzDatalist('tzlist')}
        </div>
        <div class="grid3">
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
        </div>
        <label class="field"><span>Location</span><input name="location" value="${esc(ev?.location || '')}" placeholder="Add location"></label>
        <label class="field google-only"><span>Guests</span><input name="attendees" value="${esc((ev?.attendees || []).filter((a) => !a.self).map((a) => a.email).join(', '))}" placeholder="email@example.com, …"></label>
        <label class="chk google-only"><input type="checkbox" name="meet" ${ev?.conferenceData ? 'checked disabled' : ''}> Add Google Meet video conferencing</label>`)}

      <label class="field"><span>Description</span><textarea name="description" rows="2" placeholder="Add description">${esc(ev?.description || '')}</textarea></label>
    </div>
    <footer class="actions">
      ${isNew ? '' : '<button type="button" class="btn danger ghost del">Delete</button>'}
      <span class="grow"></span>
      <button type="button" class="btn ghost" data-close>Cancel</button>
      <button type="submit" class="btn primary">Save</button>
    </footer>
  </form>`;

  return modal(html, (dlg, close) => {
    ctx.titleSuggest?.($('form', dlg)?.summary);
    const f = $('form', dlg);
    f.freq.value = r0.freq;
    f.monthMode.value = r0.monthMode;
    f.ends.value = r0.ends;
    let evCat = C.catById(s, ev ? C.eventCategoryId(ev, st.eventCats || {}) : init.categoryId);
    C.categoryPicker($('.ev-cat-host', dlg), { compact: true,
      settings: s, selected: evCat?.id,
      onChange: (c) => {
        evCat = c;
        const id = c ? G.nearestColorId(c.color) : '';
        const r = dlg.querySelector(`input[name=colorId][value="${id}"]`); if (r) r.checked = true;
      },
      onCreate: async (name, color, icon, parent) => { const c = C.newCategory(s, name, color, icon, parent); await ctx.saveSettings(); return c; },
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
    // Notification profile: new events start with your usual profile; picking one fills in its reminders.
    const readOverrides = (g) => $$('.rem-row', dlg).map((r) => ({ method: g ? $('.rm-method', r).value : 'popup', minutes: N.toMinutes($('.rm-val', r).value, $('.rm-unit', r).value) }));
    const applyProfile = (id) => {
      const p = N.profileById(s, id); if (!p) return;
      const g = (f.calId.value || calId) !== LOCAL_CAL;
      $$('.rem-row', dlg).forEach((r) => r.remove());
      N.overrides(p.rules, { google: g }).forEach(addRem);
      f.useDefault.checked = false;
    };
    const matchNow = () => {
      const g = (f.calId.value || calId) !== LOCAL_CAL;
      if (g && f.useDefault.checked) return '';
      const mine = JSON.stringify(N.overrides(readOverrides(g), { google: g }));
      return N.profiles(s).find((p) => JSON.stringify(N.overrides(p.rules, { google: g })) === mine)?.id || '';
    };
    if (isNew) { f.nprofile.value = init.notifyProfile && N.profileById(s, init.notifyProfile) ? init.notifyProfile : N.eventDefault(s)?.id || ''; applyProfile(f.nprofile.value); }
    else f.nprofile.value = N.matchProfile(s, ev) || '';
    f.calId?.addEventListener('change', () => { if (f.nprofile.value) applyProfile(f.nprofile.value); });
    f.nprofile.addEventListener('change', () => { if (f.nprofile.value) applyProfile(f.nprofile.value); sync(); });
    remBox.addEventListener('change', () => { f.nprofile.value = matchNow(); });
    remBox.addEventListener('click', (e) => { if (e.target.closest('.rm-del')) setTimeout(() => { f.nprofile.value = matchNow(); }); });
    f.useDefault.addEventListener('change', () => { f.nprofile.value = matchNow(); });
    $('.add-rem', dlg).onclick = () => { f.useDefault.checked = false; sync(); addRem(); f.nprofile.value = matchNow(); };

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

    // Length shortcuts: each click adds to the end time (click again to add more)
    const zoneOf = () => (T.isValidTz(f.tz.value.trim()) ? f.tz.value.trim() : s.tz);
    const endMs = () => T.atTime(f.eDate.value, f.eTime.value || '00:00', zoneOf());
    const startMs = () => T.atTime(f.sDate.value, f.sTime.value || '00:00', zoneOf());
    const showDur = () => { const m = Math.round((endMs() - startMs()) / T.MIN); const d = $('.dur-now', dlg); if (d) d.textContent = m > 0 ? T.fmtDur(m) : '—'; };
    $('.st-now', dlg)?.addEventListener('click', () => {
      const d = endMs() - startMs(), n = Math.floor(Date.now() / T.MIN) * T.MIN;
      const a = T.toDTInput(n, zoneOf()); f.sDate.value = a.slice(0, 10); f.sTime.value = a.slice(11, 16);
      setEnd(n + Math.max(5 * T.MIN, d)); f.sTime.dispatchEvent(new Event('change', { bubbles: true })); showDur();
    });
    $('.en-now', dlg)?.addEventListener('click', () => { setEnd(Math.max(startMs() + 5 * T.MIN, Math.floor(Date.now() / T.MIN) * T.MIN)); f.eTime.dispatchEvent(new Event('change', { bubbles: true })); showDur(); });
    const setEnd = (ms) => { const dt = T.toDTInput(ms, zoneOf()); f.eDate.value = dt.slice(0, 10); f.eTime.value = dt.slice(11, 16); };
    $('.since-last', dlg)?.addEventListener('click', async () => {
      // look back from the start shown in the dialog (or from now, if you're creating something happening now)
      const ref = startMs(), nowish = Math.abs(ref - Date.now()) < 20 * T.MIN;
      const r = await ctx.lastEventEnd({ ref: nowish ? null : ref, exclude: ev ? `${ev._calId}|${ev.id}` : null });
      if (!r.found && !nowish) { setHTML($('.since-note', dlg) || $('.dur-row', dlg).appendChild(Object.assign(document.createElement('span'), { className: 'muted small since-note' })), 'No earlier event in the 12 hours before.'); return; }
      const keepEnd = endMs();
      const dt = T.toDTInput(r.start, zoneOf());
      f.sDate.value = dt.slice(0, 10); f.sTime.value = dt.slice(11, 16);
      setEnd(nowish ? Math.max(r.end, r.start + 5 * T.MIN) : Math.max(keepEnd, r.start + 5 * T.MIN));
      f.sTime.dispatchEvent(new Event('change', { bubbles: true }));
      showDur();
      setHTML($('.since-note', dlg) || $('.dur-row', dlg).appendChild(Object.assign(document.createElement('span'), { className: 'muted small since-note' })), esc(r.note));
    });
    $('.till-next', dlg)?.addEventListener('click', async () => {
      const note = (h) => setHTML($('.since-note', dlg) || $('.dur-row', dlg).appendChild(Object.assign(document.createElement('span'), { className: 'muted small since-note' })), h);
      const r = await ctx.nextEventStart({ ref: startMs(), exclude: ev ? `${ev._calId}|${ev.id}` : null });
      if (!r.found) { note(esc(r.note)); return; }
      setEnd(r.end); f.eTime.dispatchEvent(new Event('change', { bubbles: true })); showDur(); note(esc(r.note));
    });
    // From −/+ moves only the start; the end stays (pushed on only if the start would pass it)
    $$('.st-add', dlg).forEach((b) => (b.onclick = () => {
      const ns = startMs() + +b.dataset.add * T.MIN;
      const a = T.toDTInput(ns, zoneOf()); f.sDate.value = a.slice(0, 10); f.sTime.value = a.slice(11, 16);
      if (endMs() < ns + 5 * T.MIN) setEnd(ns + 5 * T.MIN);
      f.sTime.dispatchEvent(new Event('change', { bubbles: true })); showDur(); sync();
    }));
    $$('.dur-add', dlg).forEach((b) => (b.onclick = () => {
      const add = +b.dataset.add;
      // + adds to the end; − shortens, but never below 5 minutes
      const base = add > 0 ? Math.max(endMs(), startMs()) : endMs();
      const dt = T.toDTInput(Math.max(startMs() + 5 * T.MIN, base + add * T.MIN), zoneOf());
      f.eDate.value = dt.slice(0, 10); f.eTime.value = dt.slice(11, 16);
      f.eTime.dispatchEvent(new Event('change', { bubbles: true }));
      showDur();
    }));
    f.addEventListener('input', showDur); f.addEventListener('change', showDur); showDur();
    let recTouched = false;
    const REC_FIELDS = new Set(['freq', 'interval', 'byday', 'monthMode', 'ends', 'until', 'count']);
    f.addEventListener('input', (e) => { if (REC_FIELDS.has(e.target.name)) recTouched = true; });
    f.addEventListener('change', (e) => { if (REC_FIELDS.has(e.target.name)) recTouched = true; });
    f.addEventListener('input', sync);
    // Changing "from" (date or time) moves "to" with it, keeping the length.
    let snap = { s: startMs(), e: endMs() };
    f.addEventListener('change', (e) => {
      const user = e.isTrusted || e.detail === 'user';
      if (user && (e.target.name === 'sDate' || e.target.name === 'sTime') && Number.isFinite(snap.s) && Number.isFinite(snap.e)) {
        const ns = startMs();
        if (Number.isFinite(ns)) { setEnd(ns + Math.max(f.allDay.checked ? 0 : 5 * T.MIN, snap.e - snap.s)); showDur(); }
      } else {
        if (e.target.name === 'sDate' && f.eDate.value < f.sDate.value) f.eDate.value = f.sDate.value;
        if (e.target.name === 'sTime' && f.sDate.value === f.eDate.value && f.eTime.value <= f.sTime.value) {
          f.eTime.value = T.hhmm(Math.min(23 * 60 + 55, T.parseHHMM(f.sTime.value) + s.defaultEventMinutes));
        }
      }
      snap = { s: startMs(), e: endMs() };
      sync();
    });
    sync();
    wireSects(dlg, {
      'ev-notify': () => {
        const g = (f.calId.value || calId) !== LOCAL_CAL;
        const n = g && f.useDefault.checked ? 'Calendar default' : N.profileById(s, f.nprofile.value)?.name || ($$('.rem-row', dlg).length ? `${$$('.rem-row', dlg).length} custom` : 'None');
        const rr = f.freq.value ? buildRec() : null;
        return `🔔 ${n} · ${rr ? describe(rr) : 'Does not repeat'}`;
      },
      'ev-more': () => {
        const cal = cals.find((c) => c.id === (f.calId.value || calId));
        const g = (f.calId.value || calId) !== LOCAL_CAL;
        const guests = g ? f.attendees.value.split(',').filter((x) => x.trim()).length : 0;
        return [cal?.summary, f.transparency.value === 'transparent' ? 'Free' : 'Busy', f.visibility.value !== 'default' ? f.visibility.value[0].toUpperCase() + f.visibility.value.slice(1) : '',
          f.location.value.trim() ? '📍 ' + f.location.value.trim() : '', guests ? `${guests} guest${guests > 1 ? 's' : ''}` : '', !f.allDay.checked && f.tz.value.trim() !== s.tz ? f.tz.value.trim() : ''].filter(Boolean).join(' · ');
      },
    });

    $('.del', dlg)?.addEventListener('click', () => close({ action: 'delete' }));

    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const ad = f.allDay.checked;
      const zone = T.isValidTz(f.tz.value.trim()) ? f.tz.value.trim() : s.tz;
      let title = f.summary.value.trim();
      if (!title && (isNew || ev?.summary)) {
        if (evCat) title = evCat.name;
        else {
          const a = await askTitle(s, { what: 'event', onCreate: async (name, color, icon, parent) => { const c = C.newCategory(s, name, color, icon, parent); await ctx.saveSettings(); return c; } });
          if (!a) { f.summary.focus(); return; }
          title = a.title; if (a.cat) evCat = a.cat;
        }
        f.summary.value = title;
      }
      const body = {
        summary: title || '(No title)',
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
      // Only a real change to the repeat settings counts (the same rule written differently, e.g. by Google, doesn't),
      // and only if you touched them — so editing one occurrence never splits the series.
      const recChanged = isNew ? recNow.length > 0 : recTouched && !sameRule(recNow, rec || []);
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
      body.reminders = g && f.useDefault.checked ? { useDefault: true } : { useDefault: false, overrides: N.overrides(overrides, { google: g }) };
      { const base = body.extendedProperties || ev?.extendedProperties || {}; const np = f.nprofile.value;
        if (np || base.private?.tempoNotify) body.extendedProperties = { ...base, private: { ...(base.private || {}), tempoNotify: np || '' } }; }
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

