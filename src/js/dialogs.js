// Event, task, settings and problem dialogs.
import * as T from './tz.js';
import * as S from './scheduler.js';
import * as G from './gcal.js';
import { parseRRule, buildRRule, describe, WD, expand, sameRule } from './rrule.js';
import { LOCAL_CAL, interval } from './engine.js';
import { $, $$, esc, modal, TASK_COLORS, setHTML, choose, linkRange } from './ui.js';
import * as C from './categories.js';
import * as AC from './accounts.js';
import * as N from './notify.js';
import * as A from './analysis.js';
import * as W from './weather.js';
import * as XT from './extras.js';
import * as P from './projects.js';
import * as HB from './habits.js';
import * as GM from './game.js';
import * as SC from './scopes.js';

const WDN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WDL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ORD = ['', 'first', 'second', 'third', 'fourth', 'fifth'];

function tzDatalist(id) {
  return `<datalist id="${id}">${T.allTimezones().map((z) => `<option value="${esc(z)}">`).join('')}</datalist>`;
}

// Collapsible sections ("▾"): closed by default, with a one-line summary of what's inside while closed.
// (localStorage 'tempo:expandAll' = '1' opens them all.)
const expandAll = () => { try { return localStorage.getItem('tempo:expandAll') === '1'; } catch { return false; } };
// A category picker like the goals' one: the chosen categories as chips and a button; the chips to pick from fold away when done.
export function catPick(s, cls, sel, { none = 'None chosen' } = {}) {
  sel = new Set(sel || []);
  return `<div class="cp" data-cp="${esc(cls)}"><div class="cp-sum"><span class="cp-chips">${cpChips(s, [...sel], none)}</span><button type="button" class="btn small cp-open" aria-expanded="false">Choose categories…</button></div>
    <div class="cp-grid g-pick" hidden>${C.ordered(s).map((c) => `<label class="cat-chip ${c.parent ? 'sub' : ''} ${sel.has(c.id) ? 'on' : ''}" style="--c:${esc(c.color)}" title="${esc(C.fullLabel(s, c))}"><input type="checkbox" class="${esc(cls)}" value="${esc(c.id)}" ${sel.has(c.id) ? 'checked' : ''} hidden><i></i>${c.parent ? '<span class="cat-sub">↳</span>' : ''}${c.icon ? `<span class="cat-ic">${esc(c.icon)}</span>` : ''}${esc(c.name)}</label>`).join('')}
      <div class="cp-done-row"><button type="button" class="btn small primary cp-done">Done</button></div></div></div>`;
}
function cpChips(s, ids, none) {
  const l = ids.map((id) => C.catById(s, id)).filter(Boolean);
  return l.length ? l.map((c) => `<span class="cp-chip" style="--c:${esc(c.color)}">${c.icon ? esc(c.icon) + ' ' : ''}${esc(c.name)}</span>`).join('') : `<span class="muted cp-none">${esc(none)}</span>`;
}
export function wireCatPick(root, s, onChange) {
  $$('.cp', root).forEach((cp) => {
    if (cp.dataset.wired) return; cp.dataset.wired = '1';
    const grid = $('.cp-grid', cp), btn = $('.cp-open', cp), none = $('.cp-none', cp)?.textContent || 'None chosen';
    const show = (on) => { grid.hidden = !on; btn.setAttribute('aria-expanded', String(on)); btn.textContent = on ? 'Hide' : 'Choose categories…'; };
    btn.onclick = () => show(grid.hidden);
    $('.cp-done', cp).onclick = () => show(false);
    grid.addEventListener('change', (e) => {
      const x = e.target; if (!x.matches('input[type=checkbox]')) return;
      x.closest('label').classList.toggle('on', x.checked);
      setHTML($('.cp-chips', cp), cpChips(s, $$('input:checked', grid).map((i) => i.value), none));
      onChange?.();
    });
  });
}
export function sect(id, title, body, { cls = '', open = false } = {}) {
  return `<details class="sect ${cls}" data-sect="${id}" ${open || expandAll() ? 'open' : ''}><summary><span class="sect-t">${title}</span><span class="sect-s"></span><span class="sect-caret" aria-hidden="true">▾</span></summary><div class="sect-b">${body}</div></details>`;
}
// summaries: { sectionId: () => 'text shown while closed' }. Returns a function that refreshes them.
export function wireSects(root, summaries = {}) {
  const upd = () => $$('details.sect', root).forEach((d) => {
    const el = d.querySelector(':scope > summary .sect-s'), fn = summaries[d.dataset.sect];
    if (el) el.textContent = fn ? String(fn() || '') : '';
  });
  $$('details.sect', root).forEach((d) => d.addEventListener('toggle', upd));
  // a field that fails validation inside a closed section: open it so the browser can show the problem
  root.addEventListener('invalid', (e) => { const d = e.target.closest?.('details.sect'); if (d && !d.open) d.open = true; }, true);
  root.addEventListener('input', upd); root.addEventListener('change', upd); upd();
  return upd;
}

function weekdayToggles(name, days) {
  return `<div class="wd-toggles">${[1, 2, 3, 4, 5, 6, 0].map((d) =>
    `<label class="wd"><input type="checkbox" name="${name}" value="${d}" ${days.includes(d) ? 'checked' : ''}><span>${WDN[d][0]}${WDN[d][1]}</span></label>`).join('')}</div>`;
}

// ======================================================================================
// Event dialog
// ======================================================================================
// Something is being saved without a title: ask for one, or let the user pick a category and use its name.
// Resolves { title, cat } or null when they go back.
export function askTitle(settings, { what = 'event', onCreate } = {}) {
  return modal(`<form class="choice ask-title" novalidate><h2>What should this ${esc(what)} be called?</h2>
      <label class="field"><input name="t" placeholder="Title" autocomplete="off" autofocus></label>
      <p class="muted small" style="margin:8px 0 4px">…or pick a category to use its name:</p>
      <div class="cat-host"></div>
      <div class="actions"><button type="button" class="btn ghost" data-close>Back</button><button type="submit" class="btn primary">Save</button></div>
    </form>`, (dlg, close) => {
    const f = $('form', dlg);
    C.categoryPicker($('.cat-host', dlg), { settings, selected: null, allowNone: false, onChange: (c) => { if (c) close({ title: c.name, cat: c }); }, onCreate });
    f.addEventListener('submit', (e) => { e.preventDefault(); const v = f.t.value.trim(); if (!v) { f.t.focus(); f.t.classList.add('shake'); setTimeout(() => f.t.classList.remove('shake'), 400); return; } close({ title: v, cat: null }); });
  }, { cls: 'narrow' }).then((r) => r || null);
}

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
    // From: move the start; the end moves with it (the length stays)
    $$('.st-add', dlg).forEach((b) => (b.onclick = () => {
      const len = endMs() - startMs(), ns = startMs() + +b.dataset.add * T.MIN;
      const a = T.toDTInput(ns, zoneOf()); f.sDate.value = a.slice(0, 10); f.sTime.value = a.slice(11, 16);
      setEnd(ns + Math.max(5 * T.MIN, len)); f.sTime.dispatchEvent(new Event('change', { bubbles: true })); showDur(); sync();
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

export const TASK_COLORS_PUBLIC = TASK_COLORS;
// compact −/+ time buttons (same as the quick-create box)
const NUDGE_MIN = [[-60, '−1h'], [-30, '−30'], [-10, '−10'], [-5, '−5'], [5, '+5'], [15, '+15'], [30, '+30'], [60, '+1h']];
const NUDGE_DAY = [[-1440, '−1d'], [-60, '−1h'], [-15, '−15'], [15, '+15'], [60, '+1h'], [1440, '+1d']];
function nudgesHTML(cls, steps = NUDGE_MIN) {
  const b = ([m, l]) => `<button type="button" class="${cls} ${m < 0 ? 'minus' : ''}" data-add="${m}">${l}</button>`;
  return `<span class="nudges"><span class="nudge">${steps.filter((x) => x[0] < 0).map(b).join('')}</span><span class="nudge">${steps.filter((x) => x[0] > 0).map(b).join('')}</span></span>`;
}
// Limits check for a task created outside the dialog (quick add).
export async function checkTaskLimits(ctx, nt) {
  const s = ctx.state.settings;
  if (!(await checkSpan(nt.repeat ? 'Repeating task' : 'Deadline', nt.deadline, s))) return false;
  const others = ctx.state.tasks.filter((x) => x.id !== nt.id);
  const mine = S.rescheduleAll([...others, nt], ctx.lastBusy || [], s, Date.now()).tasks.find((x) => x.id === nt.id);
  const ss = S.sessions(mine).filter((c) => c.kind !== 'done');
  const n = nt.repeat ? Math.max(0, ...Object.values(ss.reduce((m, c) => ({ ...m, [c.pk]: (m[c.pk] || 0) + 1 }), {}))) : ss.length;
  return checkCount('sessions', n, s);
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
  const msg = what === 'Deadline' ? ['The deadline', 'Choose an earlier deadline.'] : what === 'Repeating task' ? ['This repeating task', 'End it sooner (fewer weeks or an earlier date).'] : ['This repeating event', 'Set an end date or a number of times.'];
  await choose(`${what} too far ahead`, `${msg[0]} would extend more than ${s.maxSpanDays} days ahead. ${msg[1]} ${limitHint}`, [], { cancel: 'OK' });
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
    id: S.newId('t'), kind: preset.kind || 'generic', title: preset.title || '', rank: 3,
    totalMinutes: preset.totalMinutes || 600, reading: { pages: 100, startPage: 1, speed: 15, unit: 'pph', labels: 'actual' },
    deadline: preset.deadline || T.atTime(T.addDays(T.dayKey(now, tz), 7), s.bounds.end, tz),
    earliestStart: preset.earliestStart || null,
    chunkMinutes: null, minChunkMinutes: null, maxPerDayMinutes: null, breakMinutes: null,
    bounds: null, ignoreBounds: false,
    color: TASK_COLORS[st.tasks.length % TASK_COLORS.length],
    reminderMinutes: null, notes: '', frozen: [], planned: [], skipped: [], created: now,
    ...(preset.draft || {}),
  };
  const r = { pages: 100, startPage: 1, speed: 15, unit: 'pph', labels: 'actual', ...(t.reading || {}) };
  const b = t.bounds || s.bounds;
  const prog = task ? S.progress(task) : null;
  const rep = t.repeat || null;
  // tasks it can wait for: not finished ones (unless already chosen)
  const others = S.sortTasks(st.tasks.filter((x) => !x.archived && x.id !== t.id && (t.after?.includes(x.id) || x.repeat || S.progress(x, now).pct < 100)));
  const projects = s.projects || [];

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
      <input name="title" class="title-input" placeholder="${t.kind === 'reading' ? 'Book title' : 'Task name'}" value="${esc(t.title)}" autofocus>
      <div class="row catcol">
        <div class="field grow"><span>Category</span><div class="cat-host"></div></div>
        <div class="field color-field"><span>Color</span><div class="swatches small">${TASK_COLORS.map((c) => `<label class="sw"><input type="radio" name="color" value="${c}" ${t.color === c ? 'checked' : ''}><i style="background:${c}"></i></label>`).join('')}</div></div>
      </div>
      ${prog ? `<div class="progress-line"><div class="bar"><i style="width:${prog.pct}%;background:${t.color}"></i></div><span class="muted small">${T.fmtDur(prog.done)} of ${T.fmtDur(prog.total)} done</span></div>` : ''}

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

      <div class="grid3">
        <label class="field only-once only-generic"><span>Total time (hours)</span><input type="number" name="hours" min="0" step="0.25" value="${+(t.totalMinutes / 60).toFixed(2)}"></label>
        <label class="field"><span>Rank <em class="muted">(1 = most important)</em></span><input type="number" name="rank" min="1" max="99" value="${t.rank}"></label>
        <label class="field only-once"><span>Aim to finish early (days)</span><input type="number" name="margin" min="0" step="0.5" placeholder="${s.marginDays ? s.marginDays + ' (default)' : '0 — use the full time'}" value="${t.marginDays ?? ''}" title="Safety margin: plan to be done this many days before the deadline; the deadline itself stays the hard limit"></label>
      </div>
      <div class="tline">
        <span class="t-l">From</span>
        <input type="datetime-local" name="earliest" value="${t.earliestStart ? T.toDTInput(t.earliestStart, tz) : ''}" title="Don't start before">
        <span class="muted small">don't start before (optional)</span>
      </div>
      <div class="row t-adj">${nudgesHTML('es-add', NUDGE_DAY)}<button type="button" class="chip-btn es-clear">Any time</button></div>
      <div class="tline only-once">
        <span class="t-l">To</span>
        <input type="datetime-local" name="deadline" value="${t.deadline ? T.toDTInput(t.deadline, tz) : ''}" required title="Deadline">
        <span class="muted small">deadline</span>
      </div>
      <div class="row t-adj only-once">${nudgesHTML('dl-add', NUDGE_DAY)}</div>
      <div class="dl-presets only-once"><button type="button" class="chip-btn" data-dl="day">End of work day</button><button type="button" class="chip-btn" data-dl="week">End of work week</button><button type="button" class="chip-btn" data-dl="2w">Within two weeks</button></div>
      <div class="calc muted small"></div>

      ${sect('t-notify', 'Notifications &amp; repeat', `
        <div class="grid3">
        ${(() => { const legacy = !t.notifyProfile && ((t.reminderMinutes ?? '') !== '' || (t.emailReminderMinutes ?? '') !== ''); const cur = legacy ? 'custom' : (t.notifyProfile || '');
          return `<label class="field notify-field"><span>Notifications</span><select name="notify">
            <option value="">Usual — ${esc(N.taskDefault(s)?.name || 'Default')} (${esc(N.describeProfile(N.taskDefault(s)))})</option>
            ${N.profiles(s).map((p) => `<option value="${esc(p.id)}" ${cur === p.id ? 'selected' : ''}>${esc(p.name)} — ${esc(N.describeProfile(p))}</option>`).join('')}
            <option value="none" ${cur === 'none' ? 'selected' : ''}>No reminders</option>
            <option value="custom" ${cur === 'custom' ? 'selected' : ''}>Custom minutes…</option></select></label>`; })()}
          <label class="field only-custom-notify"><span>Reminder (min before)</span><input type="number" name="reminder" min="-1" placeholder="${s.taskReminderMinutes} (default)" value="${t.reminderMinutes ?? ''}"></label>
          <label class="field google-only-t only-custom-notify"><span>Email reminder (min before)</span><input type="number" name="emailReminder" min="-1" placeholder="${s.taskEmailReminderMinutes != null ? s.taskEmailReminderMinutes + ' (default)' : 'off (default)'}" value="${t.emailReminderMinutes ?? ''}"></label>
        </div>
        <div class="grid3 only-generic">
          <label class="field"><span>Repeats</span><select name="repEvery"><option value="">Doesn't repeat</option><option value="day" ${rep?.every === 'day' ? 'selected' : ''}>Every day</option><option value="week" ${rep?.every === 'week' ? 'selected' : ''}>Every week</option></select></label>
          <label class="field only-rep"><span>Hours each <span class="rep-unit">${rep?.every === 'day' ? 'day' : 'week'}</span></span><input type="number" name="repHours" min="0.25" step="0.25" value="${rep ? +(rep.minutes / 60).toFixed(2) : 3}"></label>
          <div class="field only-rep"><span>Ends</span><div class="row nowrap">
            <select name="repEnd"><option value="count" ${!rep?.until ? 'selected' : ''}>After</option><option value="until" ${rep?.until ? 'selected' : ''}>On</option></select>
            <input type="number" name="repCount" min="1" max="520" class="num rep-c" value="${rep?.count || 12}"><span class="rep-c rep-count-unit">${rep?.every === 'day' ? 'days' : 'weeks'}</span>
            <input type="date" name="repUntil" class="rep-u" value="${rep?.until ? T.dayKey(rep.until, tz) : T.addDays(T.dayKey(now, tz), 84)}"></div></div>
          <div class="field only-rep rep-days-f"><span>On these days</span>${weekdayToggles('repDays', rep?.days?.length ? rep.days : [0, 1, 2, 3, 4, 5, 6])}</div>
        </div>`, { open: !!rep })}

      ${sect('t-project', 'Project &amp; order', `
        <div class="grid3">
          <label class="field"><span>Part of project</span><select name="projectId"><option value="">— none —</option>${projects.map((p) => `<option value="${esc(p.id)}" ${t.projectId === p.id ? 'selected' : ''}>${esc(p.name)}${p.sequential ? ' (steps in order)' : ''}</option>`).join('')}<option value="__new">+ New project…</option></select></label>
          <label class="field new-proj"><span>Project name</span><input name="projName" placeholder="e.g. Thesis"></label>
          <label class="chk new-proj"><input type="checkbox" name="projSeq" checked> Steps run in order (each starts when the previous is done)</label>
        </div>
        ${others.length ? `<details class="after-box" ${t.after?.length ? 'open' : ''}><summary>Starts only after… ${t.after?.length ? `<b>(${t.after.length})</b>` : ''}</summary>
          <div class="after-list">${others.map((o) => `<label class="chk"><input type="checkbox" name="after" value="${esc(o.id)}" ${t.after?.includes(o.id) ? 'checked' : ''}> ${esc(o.title)}</label>`).join('')}</div></details>` : ''}`)}

      ${sect('t-sessions', 'Sessions', `
        <div class="grid3">
          <label class="field"><span>Session length (min)</span><input type="number" name="chunk" min="5" step="5" placeholder="${s.chunkMinutes} (default)" value="${t.chunkMinutes ?? ''}"></label>
          <label class="field"><span>Shortest session (min)</span><input type="number" name="minChunk" min="5" step="5" placeholder="${s.minChunkMinutes ? s.minChunkMinutes + ' (default)' : '= session length'}" value="${t.minChunkMinutes ?? ''}"></label>
          <label class="field"><span>Max per day (min)</span><input type="number" name="maxDay" min="5" step="5" placeholder="no limit" value="${t.maxPerDayMinutes ?? ''}"></label>
          <label class="field"><span>Break between (min)</span><input type="number" name="break" min="0" step="5" placeholder="${s.breakMinutes} (default)" value="${t.breakMinutes ?? ''}"></label>
          <label class="field"><span>Wiggle room (min)</span><input type="number" name="wiggle" min="0" step="5" placeholder="${s.wiggleMinutes ?? 15} (default)" value="${t.wiggleMinutes ?? ''}" title="Also use free slots up to this much shorter than the session length"></label>
          ${ctx.taskCalendars().length > 1 ? `<label class="field"><span>Google calendar</span><select name="calendarId">${ctx.taskCalendars().map((c) => `<option value="${esc(c.id)}" ${c.id === (t.calendarId || ctx.defaultTaskCal()) ? 'selected' : ''}>${esc(c.summary)}</option>`).join('')}</select></label>` : ''}
        </div>`)}

      ${sect('t-when', 'When to schedule', `
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
        <label class="chk"><input type="checkbox" name="onLeave" ${t.onLeave ? 'checked' : ''}> Also schedule on my leave days (vacation / sick leave)</label>
        <label class="chk"><input type="checkbox" name="ignoreBounds" ${t.ignoreBounds ? 'checked' : ''}> Ignore day bounds — also use time after my official day (${s.overflowBounds.start}–${s.overflowBounds.end}, any day)</label>`)}

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
    C.categoryPicker($('.cat-host', dlg), { compact: true,
      settings: s, selected: cat?.id,
      onChange: (c) => { cat = c; showColor(); update(); },
      onCreate: async (name, color, icon, parent) => { const c = C.newCategory(s, name, color, icon, parent); await ctx.saveSettings(); return c; },
    });
    showColor();
    // Deadline shortcuts, based on the task's own day bounds if set, otherwise the default ones
    $$('[data-dl]', dlg).forEach((b) => (b.onclick = () => {
      const bd = f.bmode.value === 'custom' ? { start: f.bStart.value || '09:00', end: f.bEnd.value || '17:00', days: $$('input[name=bdays]:checked', dlg).map((c) => +c.value) } : s.bounds;
      // counted from "From" (don't start before) when it's set and later than now
      f.deadline.value = T.toDTInput(deadlinePreset(b.dataset.dl, bd, tz, Math.max(Date.now(), T.fromDTInput(f.earliest.value, tz) ?? 0)), tz);
      $$('[data-dl]', dlg).forEach((x) => x.classList.toggle('on', x === b));
      update();
    }));
    if (!ctx.taskCalendars().length) $$('.google-only-t', dlg).forEach((e) => (e.style.display = 'none'));
    // ± buttons under From (don't start before) and To (deadline)
    const nudgeDT = (inp, add, from) => { const v = T.fromDTInput(inp.value, tz) ?? from(); inp.value = T.toDTInput(Math.max(Date.now() - T.DAY * 365, v + add * T.MIN), tz); inp.dispatchEvent(new CustomEvent('change', { bubbles: true, detail: 'user' })); };
    // "From" (don't start before) moves the deadline with it; it never ends up less than a day after it
    linkRange(f.earliest, f.deadline, { minGap: 24 * 60 });
    const roundNow = () => Math.ceil(Date.now() / (15 * T.MIN)) * 15 * T.MIN;
    $$('.es-add', dlg).forEach((b) => (b.onclick = () => nudgeDT(f.earliest, +b.dataset.add, roundNow)));
    $$('.dl-add', dlg).forEach((b) => (b.onclick = () => { $$('[data-dl]', dlg).forEach((x) => x.classList.remove('on')); nudgeDT(f.deadline, +b.dataset.add, () => T.fromDTInput(f.earliest.value, tz) ?? roundNow()); }));
    $('.es-clear', dlg).onclick = () => { f.earliest.value = ''; f.earliest.dispatchEvent(new Event('change', { bubbles: true })); };

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
        breakMinutes: num(f.break.value), wiggleMinutes: num(f.wiggle.value), reminderMinutes: f.notify.value === 'custom' ? num(f.reminder.value) : null, emailReminderMinutes: f.notify.value === 'custom' ? num(f.emailReminder.value) : null,
        notifyProfile: f.notify.value || null,
        color: f.color.value || t.color,
        bounds: custom ? { start: f.bStart.value || '09:00', end: f.bEnd.value || '17:00', days: $$('input[name=bdays]:checked', dlg).map((c) => +c.value) } : null,
        ...(() => {
          const pid = f.bmode.value.startsWith('period:') ? f.bmode.value.slice(7) : null;
          const per = pid && (s.periods || []).find((x) => x.id === pid);
          return per ? { periodId: per.id, periodName: per.name, periodRules: per.rules, periodLeave: !!per.onLeave } : { periodId: null, periodName: null, periodRules: null, periodLeave: null };
        })(),
        ignoreBounds: f.ignoreBounds.checked,
        onLeave: f.onLeave.checked || undefined,
        notes: f.notes.value,
        calendarId: f.calendarId ? f.calendarId.value : t.calendarId,
        marginDays: num(f.margin.value),
        after: $$('input[name=after]:checked', dlg).map((c) => c.value),
        ...readRepeat(kind),
        ...readProject(),
      };
    };
    const readRepeat = (kind) => {
      const every = kind === 'generic' ? f.repEvery.value : '';
      if (!every) return { repeat: null };
      const repeat = { every, minutes: Math.max(5, Math.round((+f.repHours.value || 0) * 60)) };
      if (every === 'day') { const d = $$('input[name=repDays]:checked', dlg).map((c) => +c.value); if (d.length && d.length < 7) repeat.days = d; }
      if (f.repEnd.value === 'until') repeat.until = T.atTime(f.repUntil.value || T.dayKey(now, tz), '23:59', tz);
      else repeat.count = Math.max(1, Math.round(+f.repCount.value || 1));
      const repeatStart = t.repeatStart || now;
      const draft = { repeat, repeatStart, created: t.created };
      return { repeat, repeatStart, deadline: S.repeatEnd(draft, s) };
    };
    const readProject = () => {
      const v = f.projectId.value;
      if (!v) return { projectId: null, projectName: null };
      if (v === '__new') return { projectId: '__new', projectName: f.projName.value.trim() || 'Project' };
      const p = projects.find((x) => x.id === v);
      const step = t.projectId === v && t.projectStep != null ? t.projectStep : Math.max(0, ...st.tasks.filter((x) => x.projectId === v).map((x) => x.projectStep || 0)) + 1;
      return { projectId: v, projectName: p?.name, projectStep: step };
    };
    const readWithCat = () => C.applyCategory(read(), cat);

    const update = () => {
      const kind = f.kind.value;
      const cn = f.notify.value === 'custom';
      $$('.only-custom-notify', dlg).forEach((e) => { e.style.display = cn && !(e.classList.contains('google-only-t') && !ctx.taskCalendars().length) ? '' : 'none'; if (cn) { const d = e.closest('details'); if (d && !d.open) d.open = true; } });
      $$('.only-generic', dlg).forEach((e) => (e.style.display = kind === 'generic' ? '' : 'none'));
      $$('.only-reading', dlg).forEach((e) => (e.style.display = kind === 'reading' ? '' : 'none'));
      f.title.placeholder = kind === 'reading' ? 'Book title, e.g. Pride and Prejudice' : 'Task name';
      $('.custom-bounds', dlg).style.display = f.bmode.value === 'custom' ? '' : 'none';
      const repOn = kind === 'generic' && !!f.repEvery.value;
      $$('.only-rep', dlg).forEach((e) => (e.style.display = repOn ? '' : 'none'));
      $$('.only-once', dlg).forEach((e) => (e.style.display = repOn || (kind !== 'generic' && e.classList.contains('only-generic')) ? 'none' : ''));
      $('.rep-days-f', dlg).style.display = repOn && f.repEvery.value === 'day' ? '' : 'none';
      $$('.rep-c', dlg).forEach((e) => (e.style.display = f.repEnd.value === 'count' ? '' : 'none'));
      $$('.rep-u', dlg).forEach((e) => (e.style.display = f.repEnd.value === 'until' ? '' : 'none'));
      $('.rep-unit', dlg).textContent = f.repEvery.value === 'day' ? 'day' : 'week';
      $('.rep-count-unit', dlg).textContent = f.repEvery.value === 'day' ? 'days' : 'weeks';
      f.deadline.required = !repOn;
      $$('.new-proj', dlg).forEach((e) => (e.style.display = f.projectId.value === '__new' ? '' : 'none'));
      const draft0 = read();
      const draft = draft0.projectId === '__new' ? { ...draft0, projectId: null } : draft0;
      const total = S.totalMinutes(draft);
      const p = S.params(draft, s);
      $('.calc', dlg).textContent = kind === 'reading'
        ? `≈ ${T.fmtDur(total)} of reading · ${+(S.pagesPerHour(draft.reading)).toFixed(1)} pages/hour · ≈ ${Math.ceil(total / p.chunk)} sessions of ${p.chunk} min`
        : draft.repeat ? `≈ ${Math.ceil(draft.repeat.minutes / p.chunk)} session${Math.ceil(draft.repeat.minutes / p.chunk) > 1 ? 's' : ''} of up to ${p.chunk} min each ${draft.repeat.every}, until ${T.format(draft.deadline - 1, tz, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}`
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
        out += draft.repeat ? `<div class="pv-head">Next ${ss.length} session${ss.length > 1 ? 's' : ''} (planned ${s.repeatHorizonDays || 28} days ahead) · first ${fmt(ss[0].start)}</div>`
          : `<div class="pv-head">${ss.length} session${ss.length > 1 ? 's' : ''} · first ${fmt(ss[0].start)} · last ends ${fmt(ss[ss.length - 1].end)}</div>`;
        out += `<ol class="pv-list">${ss.slice(0, 6).map((c) => `<li><b>${fmt(c.start)}</b> ${esc(c.label)}</li>`).join('')}${ss.length > 6 ? `<li class="muted">… ${ss.length - 6} more</li>` : ''}</ol>`;
      }
      if (prob) {
        out += `<div class="warn">⚠ Not enough free time before the deadline — ${T.fmtDur(prob.shortfall)} short.
          ${prob.suggestedDeadline ? `Earliest feasible deadline: <b>${fmt(prob.suggestedDeadline)}</b>. <button type="button" class="link use-sugg" data-v="${prob.suggestedDeadline}">Use it</button>` : ''}
          ${prob.fitsIgnoringBounds ? ' It would fit if you ignore day bounds.' : ''}</div>`;
      }
      if (mine?.lastPlan?.late > 0 && !prob) out += `<div class="warn soft">◔ ${mine.lastPlan.late} session${mine.lastPlan.late > 1 ? 's' : ''} fall inside your safety margin — finishing ${fmt(mine.lastPlan.finish)}, later than ${S.marginDays(draft, s)} day${S.marginDays(draft, s) === 1 ? '' : 's'} before the deadline.</div>`;
      if (mine?.lastPlan?.waitingFor?.length) out += `<div class="muted small">⏳ Starts after ${mine.lastPlan.waitingFor.map((id) => esc(st.tasks.find((x) => x.id === id)?.title || 'another task')).join(', ')}.</div>`;
      if (draft.repeat && mine?.lastPlan?.periods?.length) out += `<div class="warn soft">◔ Not enough free time in ${mine.lastPlan.periods.length} upcoming ${draft.repeat.every === 'day' ? 'day' : 'week'}${mine.lastPlan.periods.length > 1 ? 's' : ''} (e.g. ${esc(S.periodLabel(mine.lastPlan.periods[0].key, draft.repeat.every))}).</div>`;
      setHTML($('.preview', dlg), out);
      $('.use-sugg', dlg)?.addEventListener('click', (e) => { f.deadline.value = T.toDTInput(+e.target.dataset.v, tz); update(); });
    };
    let timer;
    f.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(update, 120); });
    f.addEventListener('change', update);
    update();
    wireSects(dlg, {
      't-notify': () => {
        const o = f.notify.selectedOptions[0];
        const n = f.notify.value === 'custom' ? 'Custom' : f.notify.value === 'none' ? 'No reminders' : f.notify.value ? (o?.textContent || '').split(' — ')[0] : `Usual (${N.taskDefault(s)?.name || 'Default'})`;
        const rp = f.kind.value === 'generic' && f.repEvery.value ? `${f.repEvery.value === 'day' ? 'Every day' : 'Every week'} · ${+f.repHours.value || 0} h` : "Doesn't repeat";
        return `🔔 ${n} · ${rp}`;
      },
      't-project': () => {
        const v = f.projectId.value, after = $$('input[name=after]:checked', dlg).length;
        return [v === '__new' ? `New: ${f.projName.value.trim() || 'Project'}` : v ? projects.find((x) => x.id === v)?.name : 'No project', after ? `after ${after} task${after > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ');
      },
      't-sessions': () => {
        const p = S.params(read(), s);
        return [`${p.chunk} min sessions`, `${f.break.value === '' ? s.breakMinutes : +f.break.value} min breaks`, f.maxDay.value ? `max ${f.maxDay.value} min/day` : ''].filter(Boolean).join(' · ');
      },
      't-when': () => {
        const v = f.bmode.value;
        const w = v === 'custom' ? `${f.bStart.value}–${f.bEnd.value}` : v.startsWith('period:') ? ((s.periods || []).find((x) => 'period:' + x.id === v)?.name || 'Period') : `Work hours (${s.bounds.start}–${s.bounds.end})`;
        return w + (f.ignoreBounds.checked ? ' · may run past day bounds' : '') + (f.onLeave.checked ? ' · also on leave days' : '');
      },
    });

    $('.del', dlg)?.addEventListener('click', () => close({ delete: true }));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      // No name: use the category's, or ask
      if (!f.title.value.trim()) {
        if (cat) f.title.value = cat.name;
        else {
          const a = await askTitle(s, { what: f.kind.value === 'reading' ? 'reading plan' : 'task', onCreate: async (name, color, icon, parent) => { const c = C.newCategory(s, name, color, icon, parent); await ctx.saveSettings(); return c; } });
          if (!a) { f.title.focus(); return; }
          f.title.value = a.title; if (a.cat) cat = a.cat;
        }
      }
      let nt = readWithCat();
      if (!nt.deadline) return;
      if (!(await checkSpan(nt.repeat ? 'Repeating task' : 'Deadline', nt.deadline, s))) return;
      const others = st.tasks.filter((x) => x.id !== nt.id);
      if (nt.projectId === '__new') {
        const proj = { id: S.newId('p'), name: nt.projectName, sequential: f.projSeq.checked, color: nt.color, catId: nt.categoryId || null };
        s.projects = [...(s.projects || []), proj];
        await ctx.saveSettings();
        nt = { ...nt, projectId: proj.id, projectStep: 1 };
      }
      const mine = S.rescheduleAll([...others, nt], ctx.lastBusy || [], s, Date.now()).tasks.find((x) => x.id === nt.id);
      const ss = S.sessions(mine).filter((c) => c.kind !== 'done');
      // repeating tasks: the limit applies per day/week
      const n = nt.repeat ? Math.max(0, ...Object.values(ss.reduce((m, c) => ({ ...m, [c.pk]: (m[c.pk] || 0) + 1 }), {}))) : ss.length;
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
const isWebApp = () => !(globalThis.browser ?? globalThis.chrome)?.runtime?.id;
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
          <label class="field"><span>Counts as category</span><select name="sleepCategory">${A.sleepCatOptions(s)}</select></label>`)}
        ${sect('s-game', 'Game mode', (() => {
          const g = s.game || {};
          const guess = (c) => /read|book|study|learn|course|sport|exercise|fitness|gym|run|health|practi|music|language|meditat|yoga/i.test(c.name);
          const life = new Set(g.lifeCats?.length ? g.lifeCats : C.ordered(s).filter(guess).map((c) => c.id));
          const rest = new Set(g.restCats?.length ? g.restCats : C.ordered(s).filter((c) => /leisure|free|fun|social|hobby|family/i.test(c.name)).map((c) => c.id));
          return `<label class="chk"><input type="checkbox" name="gameOn" ${g.on ? 'checked' : ''}> Play Tempo as a game: earn XP for planning and doing things, and level up from 1 to 300</label>
          <label class="field"><span>Count XP from <em class="muted">(a date in the past counts what's already on your calendar, up to 180 days back)</em></span><input type="date" data-quick="off" name="gameStart" value="${esc(g.started || T.dayKey(Date.now(), s.tz))}" max="${T.dayKey(Date.now(), s.tz)}"></label>
          <div class="field"><span>Life-growth categories — they earn <b style="color:#2e9b5b">life XP</b> (things that build long-term skills, e.g. reading, working out)</span><div class="game-life">${catPick(s, 'gl-c', life)}</div></div>
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
        ${sect('s-paper', 'Weekly review newspaper', `<label class="field"><span>Name of the newspaper</span><input name="paperName" value="${esc(s.paperName || 'Der Zeitplan')}" maxlength="40"></label>
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
    const fmtK = (k) => T.format(T.dayStart(k, s.tz), s.tz, { weekday: 'short', day: 'numeric', month: 'short' });
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
      const sentence = (d) => { const tol = Math.max(+d.free || 0, +d.tol || 0); return `${+d.free ? `The first ${d.free} h a ${d.per} are free. ` : ''}${tol > (+d.free || 0) ? `Up to ${tol} h a ${d.per}: −${d.basePct}% of the XP of ${d.per === 'week' ? 'each day you do it' : 'that day'}. ` : ''}Beyond: +${d.growPct}% per extra hour${d.per === 'week' ? ' of the whole week\'s XP' : ''}, at most ${d.maxPct}%. Costs ${d.types.length === 3 ? 'all' : d.types.join(' + ')} XP.`; };
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
        <div class="row"><input class="bo-name" value="${esc(b.name || '')}" placeholder="Name, e.g. Thesis sprint" maxlength="30"><label class="field inline"><span>Extra XP</span><input type="number" class="bo-pct num" min="0" max="300" step="5" value="${b.pct ?? 50}"> %</label><span class="grow"></span><button type="button" class="icon-btn bo-del" title="Remove" aria-label="Remove">✕</button></div>
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
    wireCatPick(dlg, s, () => updSects());
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
      const order = C.ordered({ categories: cats }).map((c) => cats.indexOf(c));
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
    $('.add-cat', dlg).onclick = () => { cats.push({ id: 'cat-' + Math.random().toString(36).slice(2, 8), name: 'New category', color: C.CAT_COLORS[cats.length % C.CAT_COLORS.length], icon: '' }); drawCats(); $$('.cat-nm', dlg).at(-1).select(); };
    $('.export-json', dlg).onclick = () => ctx.exportJson();
    $('.import-json', dlg).onchange = (e) => { const file = e.target.files[0]; if (file) close({ action: 'import', file }); };

    function collect() {
      const days = (n) => $$(`input[name=${n}]:checked`, dlg).map((c) => +c.value);
      const busy = $$('input[name=busy]:checked', dlg).map((c) => c.value);
      return {
        ...s,
        tz: T.isValidTz(f.tz.value.trim()) ? f.tz.value.trim() : s.tz,
        weekStart: +f.weekStart.value, weekView: f.weekView.value, h12: f.h12.value === '1', keepOn: f.keepOn.checked,
        hourHeight: Math.min(120, Math.max(28, +f.hourHeight.value || 48)),
        snapMinutes: +f.snapMinutes.value, defaultEventMinutes: +f.defaultEventMinutes.value || 60,
        bounds: { start: f.bStart.value || '09:00', end: f.bEnd.value || '17:00', days: days('bdays') },
        overflowBounds: { start: f.oStart.value || '07:00', end: f.oEnd.value || '23:00', days: days('odays') },
        chunkMinutes: Math.max(5, +f.chunkMinutes.value || 60), minChunkMinutes: f.minChunkMinutes.value ? Math.max(5, +f.minChunkMinutes.value) : null,
        breakMinutes: Math.max(0, +f.breakMinutes.value || 0),
        wiggleMinutes: Math.max(0, f.wiggleMinutes.value === '' ? 15 : +f.wiggleMinutes.value),
        sinceLastBuffer: Math.max(0, Math.min(15, Math.round(+f.sinceLastBuffer.value || 0))),
        tillNextBuffer: Math.max(0, Math.min(15, Math.round(+f.tillNextBuffer.value || 0))),
        paperName: f.paperName.value.trim().slice(0, 40) || 'Der Zeitplan', paperScope: f.paperScope.value,
        paperCats: { exclude: $$('.paper-cats .pc:not(:checked)', dlg).map((x) => x.value) },
        picSources: picSrc.map((x) => ({ ...x, name: (x.name || '').trim() || 'Pictures', value: (x.value || '').trim() })),
        goalNotice: f.goalNotice.checked, goalNoticeAt: f.goalNoticeAt.value || '09:00',
        weather: { on: f.wxOn.checked && wx.lat != null, name: wx.name || '', lat: wx.lat ?? null, lon: wx.lon ?? null, unit: f.wxUnit.value, model: f.wxModel.value || 'best_match' },
        game: { ...(s.game || {}), on: f.gameOn.checked, lifeCats: $$('.gl-c:checked', dlg).map((x) => x.value), restCats: $$('.gr-c:checked', dlg).map((x) => x.value), noCats: $$('.gn-c:checked', dlg).map((x) => x.value),
          drains: drains.map((d) => ({ ...d, name: (d.name || '').trim() || 'Drain' })).filter((d) => d.cats.length || d.words.length),
          boosts: boosts.map((b) => ({ ...b, name: (b.name || '').trim() || 'Bonus' })).filter((b) => b.cats.length || b.words.length),
          cfg: Object.fromEntries($$('.gc-v', dlg).map((x) => [x.dataset.k, x.value]).filter(([k, v]) => v !== '' && +v !== GM.CFG.find((c) => c[0] === k)[2]).map(([k, v]) => [k, +v])),
          ...(() => { const st0 = f.gameStart.value && f.gameStart.value <= T.dayKey(Date.now(), s.tz) ? f.gameStart.value : (s.game?.started || T.dayKey(Date.now(), s.tz)); return st0 !== s.game?.started ? { started: st0, ledger: {}, weeks: {} } : { started: st0 }; })(),
          active: f.gameOn.checked && !s.game?.on ? [...new Set([...(s.game?.active || []), T.dayKey(Date.now(), s.tz)])] : s.game?.active },
        sleepEvents: f.sleepEvents.checked, sleepCal: f.sleepCal.value,
        sleepEventsFrom: f.sleepEvents.checked ? (s.sleepEvents && s.sleepEventsFrom ? s.sleepEventsFrom : T.addDays(T.dayKey(Date.now(), s.tz), -1)) : s.sleepEventsFrom || null,
        sleepAssume: f.sleepAssume.checked, sleepCategory: f.sleepCategory.value || null, sleepStart: f.sleepStart.value || '23:00', sleepEnd: f.sleepEnd.value || '07:00',
        dailyCapMinutes: Math.max(0, +f.dailyCapMinutes.value || 0), marginDays: Math.max(0, +f.marginDays.value || 0),
        travelMinutes: Math.max(0, +f.travelMinutes.value || 0), repeatHorizonDays: Math.max(7, +f.repeatHorizonDays.value || 28),
        pomodoro: { work: Math.max(5, +f.pomoWork.value || 25), rest: Math.max(1, +f.pomoRest.value || 5) }, learnSpeed: f.learnSpeed.checked,
        outlookClientId: s.outlookClientId || '',
        timePrefs: Object.fromEntries(['morning', 'afternoon', 'evening'].map((k) => [k, [f[`tp_${k}_0`].value || tp[k][0], f[`tp_${k}_1`].value || tp[k][1]]])),
        projects: projects.map((p) => ({ ...p, name: (p.name || '').trim() || 'Project' })),
        sessionWarn: Math.max(0, +f.sessionWarn.value || 0), sessionMax: Math.max(0, +f.sessionMax.value || 0), maxSpanDays: Math.max(0, +f.maxSpanDays.value || 0),
        assumePastDone: f.assumePastDone.checked, allDayBlocks: f.allDayBlocks.checked,
        busyCalendars: busy.length === allCals.length ? null : busy,
        syncTasksToGoogle: f.syncTasksToGoogle.checked, taskCalendarId: f.taskCalendarId.value || null,
        notifyTasks: f.notifyTasks.checked, notifyLocal: f.notifyLocal.checked, notifyGoogle: f.notifyGoogle.checked,
        notifyProfiles: nprofiles.map((p) => ({ id: p.id, name: (p.name || '').trim() || 'Profile', rules: N.overrides(p.rules) })),
        eventProfile: f.eventProfile.value, taskProfile: f.taskProfile.value,
        defaultReminder: (() => { const pr = nprofiles.find((p) => p.id === f.eventProfile.value); const m = pr?.rules.find((r) => r.method === 'popup'); return m ? +m.minutes : s.defaultReminder; })(),
        hoursChange: f.hoursChange.value,
        categories: cats.map((c) => ({ ...c, name: c.name.trim() || 'Untitled' })),
        askCategory: f.askCategory.checked,
        leave,
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
    info && info.verified != null ? row(info.verified === info.total ? true : null, `${info.verified} of ${info.total} sessions verified on Google (read back after syncing)`,
      info.repaired ? `${info.repaired} session${info.repaired === 1 ? ' was' : 's were'} missing or different on Google and ${info.repaired === 1 ? 'was' : 'were'} rewritten.` : '') : '',
    conn && st.settings.sharedSyncedAt ? row(true, `Categories and time periods synced ${when(st.settings.sharedSyncedAt)}`, 'Shared with your other devices through Google Calendar.') : '',
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

// Export a custom date range limited to certain hours (work hours, a period like "After hours", or any times).
export function customExportDialog(ctx, { cursor }) {
  const s = ctx.state.settings, tz = s.tz;
  const today = T.dayKey(Date.now(), tz);
  const periods = s.periods || [];
  return modal(`
    <form class="export-form custom-export">
      <header class="dlg-head"><h2>Export dates and hours</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></header>
      <div class="dlg-body">
        <div class="grid2">
          <label class="field"><span>From</span><input type="date" name="from" value="${cursor || today}"></label>
          <label class="field"><span>To</span><input type="date" name="to" value="${T.addDays(cursor || today, 4)}"></label>
        </div>
        <div class="dl-presets"><button type="button" class="chip-btn" data-r="next5">Next 5 days</button><button type="button" class="chip-btn" data-r="week">This work week</button><button type="button" class="chip-btn" data-r="next7">Next 7 days</button><button type="button" class="chip-btn" data-r="nextweek">Next week</button></div>
        <label class="field"><span>Hours</span><select name="hours">
          <option value="bounds">Work hours (${s.bounds.start}–${s.bounds.end})</option>
          ${periods.map((p) => `<option value="period:${esc(p.id)}">${esc(p.name)} (${esc(describeRules(p.rules))})</option>`).join('')}
          <option value="full">Whole day (00:00–24:00)</option>
          <option value="auto">Work day plus anything scheduled around it</option>
          <option value="custom">Custom hours…</option></select></label>
        <div class="row custom-hours"><input type="time" name="hStart" value="09:00" step="900"> <span class="muted">to</span> <input type="time" name="hEnd" value="17:00" step="900"></div>
        <div class="grid2">
          <label class="field"><span>Days per page</span><select name="perPage">${[7, 6, 5, 4, 3, 2, 1].map((n) => `<option value="${n}">${n}</option>`).join('')}</select></label>
          <div class="field"><span>Format</span>
            <div class="seg"><label><input type="radio" name="fmt" value="pdf" checked><span>PDF</span></label><label><input type="radio" name="fmt" value="png"><span>PNG</span></label><label><input type="radio" name="fmt" value="tiff"><span>TIFF</span></label></div></div>
          <label class="field"><span>Quality</span><select name="scale"><option value="2">High (sharp when printed)</option><option value="1">Standard (smaller file)</option></select></label>
          <label class="chk" style="align-self:end"><input type="checkbox" name="summary" checked> Time breakdown on each page</label>
        </div>
        <p class="summary muted"></p>
      </div>
      <footer class="actions"><span class="grow"></span><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn primary">Export</button></footer>
    </form>`, (dlg, close) => {
    const f = $('form', dlg);
    linkRange(f.from, f.to);
    const ws = s.weekStart ?? 1, wdays = s.bounds.days?.length ? s.bounds.days : [1, 2, 3, 4, 5];
    $$('[data-r]', dlg).forEach((b) => (b.onclick = () => {
      const r = b.dataset.r;
      let a = today, z = T.addDays(today, 4);
      if (r === 'next7') z = T.addDays(today, 6);
      if (r === 'week' || r === 'nextweek') {
        const w0 = T.addDays(T.startOfWeek(today, ws), r === 'nextweek' ? 7 : 0);
        const offs = wdays.map((d) => (d - ws + 7) % 7).sort((x, y) => x - y);
        a = T.addDays(w0, offs[0]); z = T.addDays(w0, offs[offs.length - 1]);
      }
      f.from.value = a; f.to.value = z; upd();
    }));
    const read = () => {
      let from = f.from.value || today, to = f.to.value || from;
      if (to < from) [from, to] = [to, from];
      const n = T.daysBetween(from, to) + 1;
      const v = f.hours.value;
      let hours = null, label = '';
      if (v === 'bounds') { hours = { rules: [s.bounds], label: 'Work hours' }; }
      else if (v.startsWith('period:')) { const p = periods.find((x) => 'period:' + x.id === v); hours = { rules: p.rules, label: p.name }; }
      else if (v === 'full') hours = { rules: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '24:00' }], label: 'Whole day' };
      else if (v === 'custom') hours = { rules: [{ days: [0, 1, 2, 3, 4, 5, 6], start: f.hStart.value || '09:00', end: f.hEnd.value || '17:00' }], label: `${f.hStart.value}–${f.hEnd.value}` };
      label = hours?.label || '';
      const per = Math.max(1, Math.min(7, +f.perPage.value || 7));
      return { from, to, n, hours, label, perPage: per, pages: Math.ceil(n / per), fmt: f.fmt.value, scale: +f.scale.value, summary: f.summary.checked };
    };
    const upd = () => {
      $('.custom-hours', dlg).style.display = f.hours.value === 'custom' ? '' : 'none';
      const r = read();
      if (r.fmt === 'png' && r.pages > 1) { f.fmt.value = 'pdf'; }
      const fmtD = (k) => T.format(T.dayStart(k, tz), tz, { weekday: 'short', day: 'numeric', month: 'short' });
      $('.summary', dlg).textContent = `${r.n} day${r.n > 1 ? 's' : ''} (${fmtD(r.from)} – ${fmtD(r.to)})${r.label ? ', ' + r.label.toLowerCase() : ''} → ${r.pages} page${r.pages > 1 ? 's' : ''}${r.pages > 1 && f.fmt.value === 'png' ? '' : ''}.${r.n > 62 ? ' (At most 62 days.)' : ''}`;
    };
    f.addEventListener('input', upd); f.addEventListener('change', upd);
    f.perPage.value = '7'; upd();
    f.addEventListener('submit', (e) => { e.preventDefault(); const r = read(); if (r.n > 62) return; close(r); });
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

// ---------- Partly done session ----------
// Reading: how many pages were read. Other tasks: how much of the session's work got done. The rest is either added
// as new time or squeezed into the remaining sessions. Optionally, part of the slot went to something else: the
// block is then split into that (an event, or time on another task) and the shorter session.
// Started a task session late: when did you start, what (if anything) filled the time before, and should the
// missed minutes be planned again later?
export function startedLateDialog(ctx, { task, sess }) {
  const st = ctx.state, s = st.settings, tz = s.tz;
  const fmt = (ms) => T.fmtTime(ms, tz, s.h12);
  const hhmm = (ms) => T.toDTInput(ms, tz).slice(11, 16);
  const nowM = Math.floor(Date.now() / T.MIN) * T.MIN;
  const def = Math.min(Math.max(nowM, sess.start + T.MIN), sess.end - 5 * T.MIN);
  const others = st.tasks.filter((t) => !t.archived && t.id !== task.id);
  const cals = ctx.writableCalendars();
  const def0 = ctx.defaultCalendar?.() || cals[0]?.id;
  return modal(`<form class="late-form" novalidate>
      <header class="dlg-head"><h2>Started late</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></header>
      <div class="dlg-body">
        <p class="muted small" style="margin:0">“${esc(sess.label || task.title)}” was planned ${esc(fmt(sess.start))}–${esc(fmt(sess.end))}.</p>
        <label class="field"><span>I started at</span><input type="time" name="at" step="60" value="${hhmm(def)}"></label>
        <p class="late-sum small"></p>
        <fieldset class="box"><legend class="late-before">Before that</legend>
          <label class="chk"><input type="radio" name="fill" value="none" checked> Leave it as free time</label>
          <label class="chk"><input type="radio" name="fill" value="event"> I was doing something else: <input name="evTitle" placeholder="e.g. Phone call" style="flex:1;min-width:0"></label>
          <div class="row late-ev" hidden>
            <select name="evCat"><option value="">No category</option>${(s.categories || []).map((c) => `<option value="${esc(c.id)}">${esc((c.icon ? c.icon + ' ' : '') + c.name)}</option>`).join('')}</select>
            ${cals.length > 1 ? `<select name="evCal">${cals.map((c) => `<option value="${esc(c.id)}" ${c.id === def0 ? 'selected' : ''}>${esc(c.summary)}</option>`).join('')}</select>` : ''}
          </div>
          ${others.length ? `<label class="chk"><input type="radio" name="fill" value="task"> I worked on another task: <select name="otherTask">${others.map((t) => `<option value="${esc(t.id)}">${esc(t.title)}</option>`).join('')}</select></label>` : ''}
        </fieldset>
        <label class="chk late-re"><input type="checkbox" name="realloc" checked> <span>Plan the missed time again later</span></label>
        <p class="muted small" style="margin:0">Untick to drop it: this session then still counts as fully done.</p>
      </div>
      <div class="actions"><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn primary">Save</button></div>
    </form>`, (dlg, close) => {
    const f = $('form', dlg);
    const at = () => {
      const k = T.dayKey(sess.start, tz);
      const v = T.atTime(k, f.at.value || hhmm(def), tz);
      return Math.min(Math.max(v, sess.start + T.MIN), sess.end - T.MIN);
    };
    const upd = () => {
      const a = at(), late = Math.round((a - sess.start) / T.MIN);
      setHTML($('.late-sum', dlg), `The session becomes <b>${esc(fmt(a))}–${esc(fmt(sess.end))}</b> (${T.fmtDur(Math.round((sess.end - a) / T.MIN))}); you missed <b>${T.fmtDur(late)}</b>.`);
      $('.late-before', dlg).textContent = `${fmt(sess.start)}–${fmt(a)}`;
      $('.late-re span', dlg).textContent = `Plan the missed ${T.fmtDur(late)} again later`;
      $('.late-ev', dlg).hidden = f.fill.value !== 'event';
    };
    f.addEventListener('input', upd); f.addEventListener('change', upd);
    f.evTitle.addEventListener('focus', () => { f.querySelector('input[name=fill][value=event]').checked = true; upd(); });
    f.otherTask?.addEventListener('focus', () => { f.querySelector('input[name=fill][value=task]').checked = true; upd(); });
    upd();
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const a = at(), kind = f.fill.value;
      if (kind === 'event' && !f.evTitle.value.trim()) { f.evTitle.focus(); return; }
      close({ start: a, reallocate: f.realloc.checked,
        fill: kind === 'event' ? { kind, title: f.evTitle.value.trim(), catId: f.evCat.value || null, calId: f.evCal?.value || def0 }
          : kind === 'task' ? { kind, taskId: f.otherTask.value } : null });
    });
  }, { cls: 'narrow' });
}

export function partialDialog(ctx, task, sess, opts = {}) {
  const st = ctx.state, s = st.settings, tz = s.tz;
  const when = `${T.format(sess.start, tz, { weekday: 'short', day: 'numeric', month: 'short' })}, ${T.fmtTime(sess.start, tz, s.h12)}–${T.fmtTime(sess.end, tz, s.h12)}`;
  const reading = task.kind === 'reading';
  const [pa, pb] = sess.pages || [0, 0];
  const planned = reading ? Math.max(1, pb - pa + 1) : 0;
  const length = Math.round((sess.end - sess.start) / T.MIN);
  const others = S.sortTasks(st.tasks.filter((t) => !t.archived && t.id !== task.id));
  const cals = ctx.writableCalendars();
  const laterSessions = S.sessions(task).filter((c) => c.kind === 'planned' && c.start > sess.start && c.id !== sess.id).length;
  // Prefill: what was recorded before, or an estimate from the timer.
  const est = opts.actualMin != null ? opts.actualMin / Math.max(1, length) : null;
  const prevPct = est != null ? Math.max(0, Math.min(100, Math.round((est * 100) / 5) * 5)) : sess.partial && sess.slotMin ? Math.round((sess.credit / sess.slotMin) * 100) : 50;
  const prevPages = reading ? (opts.actualMin != null ? Math.round((opts.actualMin / 60) * S.pagesPerHour(task.reading)) : sess.partial ? (sess.pagesDone ?? Math.round((sess.credit / 60) * S.pagesPerHour(task.reading))) : '') : '';
  return modal(`
    <form class="partial">
      <header class="dlg-head"><h2>Partly done</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></header>
      <div class="dlg-body">
        <p class="muted small" style="margin:0">“${esc(sess.label)}” · ${esc(when)}</p>
        ${opts.actualMin != null ? `<p class="small timer-note">⏱ You worked <b>${T.fmtDur(Math.round(opts.actualMin))}</b> of ${T.fmtDur(length)}. ${reading ? 'The pages below are an estimate at your current speed — correct them.' : 'Adjust how much got done if needed.'}</p>` : ''}
        ${reading ? `
          <label class="field"><span>Pages read (of ${planned}: page ${pa}–${pb})</span>
            <div class="row"><input type="number" name="pages" min="0" max="${planned * 3}" step="1" value="${prevPages}" required autofocus style="width:7em"><span class="muted small pg-to"></span></div></label>`
        : `
          <label class="field"><span>How much of this session's work got done?</span>
            <div class="row"><input type="range" name="pct" min="0" max="100" step="5" value="${prevPct}" style="flex:1"><b class="pct-val" style="width:3.5em;text-align:right">${prevPct}%</b></div></label>`}
        <fieldset class="box">
          <legend>The rest of the work</legend>
          <label class="chk"><input type="radio" name="fit" value="extend" checked> <span><b>Add time for it</b> <span class="muted small">— longer or extra sessions, as needed</span></span></label>
          <label class="chk ${laterSessions ? '' : 'disabled'}"><input type="radio" name="fit" value="squeeze" ${laterSessions ? '' : 'disabled'}> <span><b>Fit it into the remaining ${laterSessions || ''} session${laterSessions === 1 ? '' : 's'}</b> <span class="muted small">— same sessions, ${reading ? 'more pages' : 'more work'} in each${laterSessions ? '' : ' (none left, so time will be added)'}</span></span></label>
        </fieldset>
        <fieldset class="box">
          <legend>Did something else take part of this time? (optional)</legend>
          <label class="chk"><input type="checkbox" name="split"> Yes — record it and shorten this session</label>
          <div class="split-box">
            <div class="row">
              <input type="number" name="otherMin" min="5" max="${Math.max(5, length - 5)}" step="5" value="${Math.min(20, Math.max(5, Math.round(length / 3 / 5) * 5))}" style="width:6em"> <span>min</span>
              <select name="where"><option value="start">at the start</option><option value="end">at the end</option></select>
            </div>
            <label class="chk"><input type="radio" name="rep" value="event" checked> Something else — add it to the calendar</label>
            <div class="row rep-event">
              <input name="evTitle" placeholder="e.g. Phone call" style="flex:1;min-width:160px">
              <select name="evCal">${cals.map((c) => `<option value="${esc(c.id)}">${esc(c.summary)}</option>`).join('')}</select>
            </div>
            ${others.length ? `<label class="chk"><input type="radio" name="rep" value="task"> Worked on another task — count that time toward it</label>
            <div class="row rep-task"><select name="repTask" style="flex:1">${others.map((t) => `<option value="${esc(t.id)}">${esc(t.title)}</option>`).join('')}</select></div>` : ''}
            <p class="muted small split-preview"></p>
          </div>
        </fieldset>
      </div>
      <footer class="actions">
        ${opts.actualMin != null ? '<button type="button" class="btn ghost all-done">It’s all done</button>' : ''}
        <span class="grow"></span>
        <button type="button" class="btn ghost" data-close>Cancel</button>
        <button type="submit" class="btn primary">Save</button>
      </footer>
    </form>`, (dlg, close) => {
    const f = $('form', dlg);
    $('.all-done', dlg)?.addEventListener('click', () => close({ allDone: true }));
    const fmt = (ms) => T.fmtTime(ms, tz, s.h12);
    const sync = () => {
      if (reading) { const n = +f.pages.value || 0; $('.pg-to', dlg).textContent = f.pages.value === '' ? '' : n ? `read page ${pa}–${pa + n - 1}` : 'nothing read'; }
      else $('.pct-val', dlg).textContent = f.pct.value + '%';
      const on = f.split.checked;
      $('.split-box', dlg).style.display = on ? '' : 'none';
      $('.rep-event', dlg).style.display = f.rep.value === 'event' ? '' : 'none';
      const rt = $('.rep-task', dlg); if (rt) rt.style.display = f.rep.value === 'task' ? '' : 'none';
      if (on) {
        const m = Math.max(5, Math.min(length - 5, +f.otherMin.value || 0));
        const cut = f.where.value === 'start' ? sess.start + m * T.MIN : sess.end - m * T.MIN;
        const other = f.where.value === 'start' ? [sess.start, cut] : [cut, sess.end];
        const mine = f.where.value === 'start' ? [cut, sess.end] : [sess.start, cut];
        const what = f.rep.value === 'task' ? `“${others.find((t) => t.id === f.repTask?.value)?.title || 'other task'}”` : `“${f.evTitle.value.trim() || 'Something else'}”`;
        $('.split-preview', dlg).textContent = `${fmt(other[0])}–${fmt(other[1])} ${what} (${m} min) · ${fmt(mine[0])}–${fmt(mine[1])} ${task.title} (${length - m} min)`;
      }
    };
    f.addEventListener('input', sync); f.addEventListener('change', sync); sync();
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      if (reading && f.pages.value === '') { f.pages.focus(); return; }
      const credit = reading ? S.minutesForPages(task, Math.max(0, +f.pages.value || 0)) : (Math.max(0, +f.pct.value) / 100) * (sess.partial ? sess.slotMin : (sess.work || length));
      let split = null;
      if (f.split.checked) {
        if (f.rep.value === 'event' && !f.evTitle.value.trim()) { f.evTitle.focus(); return; }
        const m = Math.max(5, Math.min(length - 5, +f.otherMin.value || 0));
        split = { minutes: m, where: f.where.value, kind: f.rep.value, title: f.evTitle.value.trim(), calId: f.evCal.value, taskId: f.repTask?.value };
      }
      close({ credit, squeeze: f.fit.value === 'squeeze', split, pages: reading ? +f.pages.value : null, pct: reading ? null : +f.pct.value });
    });
  }, { cls: 'narrow' });
}

// ======================================================================================
// Project dialog: a chain of tasks and events, each with an ideal start, end and (tasks) hours
// ======================================================================================
// Resolves { project, removed: [steps] } (save), { delete: true, removed } or null (cancel).
export function projectDialog(ctx, project = null) {
  const st = ctx.state, s = st.settings, tz = s.tz;
  const isNew = !project;
  const p0 = project ? { ...project } : { id: P.newProjectId(), name: '', sequential: true, titleMode: 'prefix', created: Date.now(), steps: [] };
  let steps = (project ? P.steps(project, st.tasks) : []).map((x) => ({ ...x }));
  const removed = [];
  const today = T.dayKey(Date.now(), tz);
  const keyOf = (ms) => (ms ? T.dayKey(ms, tz) : '');
  const timeOf = (ms, d) => (ms ? T.hhmm(T.minutesOfDay(ms, tz)) : d);
  const prog = project ? P.progress(project, st.tasks, Date.now(), ctx.eventDone || (() => false)) : null;
  const statusOf = (stp) => {
    const r = prog?.rows.find((x) => x.st.id === stp.id); if (!r || !stp.ref) return '<span class="ps-new">new</span>';
    if (r.finished) return '<span class="ps-ok">✓ done</span>';
    if (r.st.kind === 'task') return `<span class="ps-pct">${r.pct}%${r.next ? ` · next ${esc(T.format(r.next, tz, { weekday: 'short', day: 'numeric', month: 'short' }))}` : ''}${r.late ? ' · ⚠' : ''}</span>`;
    return `<span class="ps-pct">${r.next ? esc(T.format(r.next, tz, { weekday: 'short', day: 'numeric', month: 'short' })) : ''}</span>`;
  };
  const html = `<form class="project-form" autocomplete="off" novalidate>
    <header class="dlg-head"><input name="name" class="title-input" placeholder="Project name, e.g. Thesis" value="${esc(p0.name)}" maxlength="40" autofocus><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></header>
    <div class="dlg-body">
      ${prog ? `<div class="pj-prog"><div class="bar"><i style="width:${prog.pct}%"></i></div><span class="muted small">${prog.finished}/${prog.count} steps done · ${T.fmtDur(prog.done)} of ${T.fmtDur(prog.total)}</span></div>` : ''}
      <div class="row">
        <label class="field"><span>Project name in titles</span><select name="titleMode">
          <option value="prefix" ${p0.titleMode !== 'suffix' && p0.titleMode !== 'none' ? 'selected' : ''}>At the start — “Name: step”</option>
          <option value="suffix" ${p0.titleMode === 'suffix' ? 'selected' : ''}>At the end — “step — Name”</option>
          <option value="none" ${p0.titleMode === 'none' ? 'selected' : ''}>Not added</option></select></label>
        <label class="field"><span>Category for its tasks and events</span><select name="catId"><option value="">— none —</option>${C.ordered(s).map((c) => `<option value="${esc(c.id)}" ${p0.catId === c.id ? 'selected' : ''}>${c.parent ? '↳ ' : ''}${esc(C.catLabel(c))}</option>`).join('')}</select></label>
        <label class="chk"><input type="checkbox" name="sequential" ${p0.sequential !== false ? 'checked' : ''}> Steps run in order (each starts after the previous is done)</label>
      </div>
      <div class="sub-h">Steps</div>
      <div class="pj-steps"></div>
      <div class="row"><button type="button" class="btn small pj-add" data-kind="task">+ Task</button><button type="button" class="btn small pj-add" data-kind="event">+ Event</button>
        <span class="muted small">Tasks are split into sessions between their start and end; events go on your calendar.</span></div>
      <p class="muted small pj-err" hidden></p>
    </div>
    <footer class="actions">
      ${isNew ? '' : '<button type="button" class="btn danger ghost pj-delete">Delete project…</button>'}
      <span class="grow"></span>
      <button type="button" class="btn ghost" data-close>Cancel</button>
      <button type="submit" class="btn primary">${isNew ? 'Create project' : 'Save'}</button>
    </footer></form>`;
  return modal(html, (dlg, close) => {
    const f = $('form', dlg), box = $('.pj-steps', dlg);
    const read = () => {
      $$('.pj-step', box).forEach((row) => {
        const x = steps[+row.dataset.i];
        x.kind = $('.ps-kind', row).value;
        x.title = $('.ps-title', row).value;
        const sd = $('input.ps-sd', row).value, ed = $('input.ps-ed', row).value || sd;
        if (x.kind === 'task') {
          x.start = sd ? T.atTime(sd, s.bounds.start, tz) : null;
          x.end = ed ? T.atTime(ed, s.bounds.end, tz) : null;
          x.hours = Math.max(0.25, +$('input.ps-h', row).value || 1);
          delete x.allDay;
        } else {
          x.start = sd ? T.atTime(sd, $('input.ps-st', row).value || '10:00', tz) : null;
          x.end = ed ? T.atTime(ed, $('input.ps-et', row).value || '11:00', tz) : null;
          if (x.start && x.end && x.end <= x.start) x.end = x.start + T.HOUR;
        }
      });
    };
    const draw = () => {
      setHTML(box, steps.map((x, i) => `<div class="pj-step ${x.kind}" data-i="${i}">
        <span class="ps-n">${i + 1}</span>
        <select class="ps-kind" aria-label="Kind"><option value="task">Task</option><option value="event" ${x.kind === 'event' ? 'selected' : ''}>Event</option></select>
        <input class="ps-title" placeholder="${x.kind === 'task' ? 'What to do, e.g. Write chapter 2' : 'Event, e.g. Meeting with supervisor'}" value="${esc(x.title || '')}">
        <div class="ps-when">${x.kind === 'task'
          ? `<label>Start <input type="date" data-quick="off" class="ps-sd" value="${keyOf(x.start)}"></label><label>End <input type="date" data-quick="off" class="ps-ed" value="${keyOf(x.end)}"></label><label>Hours <input type="number" class="ps-h num" min="0.25" step="0.25" value="${x.hours ?? 2}"></label>`
          : `<label><input type="date" data-quick="off" class="ps-sd" value="${keyOf(x.start)}"> <input type="time" class="ps-st" value="${timeOf(x.start, '10:00')}" step="300"></label><label>to <input type="date" data-quick="off" class="ps-ed" value="${keyOf(x.end)}"> <input type="time" class="ps-et" value="${timeOf(x.end, '11:00')}" step="300"></label>`}</div>
        <span class="ps-status">${statusOf(x)}</span>
        <span class="ps-acts"><button type="button" class="icon-btn sm ps-up" title="Earlier in the chain" ${i ? '' : 'disabled'}>▲</button><button type="button" class="icon-btn sm ps-down" title="Later in the chain" ${i < steps.length - 1 ? '' : 'disabled'}>▼</button><button type="button" class="icon-btn sm ps-del" title="Remove this step">✕</button></span>
      </div>`).join('') || '<p class="muted small">No steps yet — add the tasks and events of this project in the order they happen.</p>');
      $$('.pj-step', box).forEach((row) => {
        const i = +row.dataset.i;
        $('.ps-kind', row).onchange = () => { read(); const x = steps[i]; if (x.ref) { removed.push({ ...x, kind: x.kind === 'task' ? 'event' : 'task' }); x.ref = null; } if (x.kind === 'event' && x.start) { x.start = T.atTime(T.dayKey(x.start, tz), '10:00', tz); x.end = x.start + T.HOUR; } draw(); };
        // changing a step's start moves its end with it (the length stays)
        // (the end fields are updated in place, so typing in the start field isn't interrupted)
        const moveEnd = (e) => {
          if (!e.isTrusted) return;
          const old = { ...steps[i] }; read(); const x = steps[i];
          if (!(old.start && old.end && x.start && x.kind === old.kind)) return;
          x.end = x.start + (old.end - old.start);
          $('input.ps-ed', row).value = keyOf(x.end);
          if (x.kind === 'event') $('input.ps-et', row).value = timeOf(x.end, '11:00');
        };
        $('input.ps-sd', row).addEventListener('change', moveEnd);
        $('input.ps-st', row)?.addEventListener('change', moveEnd);
        $('.ps-up', row).onclick = () => { read(); [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]]; draw(); };
        $('.ps-down', row).onclick = () => { read(); [steps[i + 1], steps[i]] = [steps[i], steps[i + 1]]; draw(); };
        $('.ps-del', row).onclick = () => { read(); const [x] = steps.splice(i, 1); if (x.ref) removed.push(x); draw(); };
      });
    };
    draw();
    $$('.pj-add', dlg).forEach((b) => (b.onclick = () => {
      read();
      const last = steps[steps.length - 1];
      const startK = last?.end ? keyOf(last.end) : today;
      const kind = b.dataset.kind;
      steps.push(kind === 'task'
        ? { id: P.newStepId(), kind, title: '', start: T.atTime(startK, s.bounds.start, tz), end: T.atTime(T.addDays(startK, 7), s.bounds.end, tz), hours: 2, ref: null }
        : { id: P.newStepId(), kind, title: '', start: T.atTime(startK, '10:00', tz), end: T.atTime(startK, '11:00', tz), ref: null });
      draw();
      $$('.pj-step .ps-title', box).pop()?.focus();
    }));
    $('.pj-delete', dlg)?.addEventListener('click', async () => {
      const v = await choose(`Delete “${p0.name}”?`, null, [
        { value: 'all', label: 'Delete the project and its tasks and events', danger: true },
        { value: 'keep', label: 'Delete only the project', desc: 'Its tasks and events stay (without the project).' }]);
      if (v) close({ delete: true, removeItems: v === 'all', removed: [...removed, ...steps.filter((x) => x.ref)] });
    });
    f.addEventListener('submit', (e) => {
      e.preventDefault(); read();
      const err = $('.pj-err', dlg);
      const name = f.name.value.trim();
      const bad = !name ? 'Give the project a name.' : steps.find((x) => !x.title.trim()) ? 'Every step needs a title.'
        : steps.find((x) => !x.start || !x.end) ? 'Every step needs a start and an end.' : steps.find((x) => x.kind === 'task' && x.end <= x.start) ? 'A task ends before it starts.' : '';
      if (bad) { err.textContent = bad; err.hidden = false; if (!name) f.name.focus(); return; }
      close({ project: { ...p0, name, titleMode: f.titleMode.value, catId: f.catId.value || null, sequential: f.sequential.checked, steps: steps.map((x) => ({ ...x, title: x.title.trim() })) }, removed });
    });
  }, { cls: 'wide' });
}

// ======================================================================================
// Habit dialog (new / edit). Resolves the habit, { delete: true }, or null.
// ======================================================================================
export function habitDialog(ctx, habit = null) {
  const h0 = habit || { id: HB.newId(), name: '', question: '', color: HB.COLORS[(ctx.state.settings.habits || []).length * 5 % HB.COLORS.length], type: 'yesno', freq: { times: 1, per: 'day' }, target: 1, unit: '', created: Date.now(), log: {} };
  const f0 = h0.freq || { times: 1, per: 'day' };
  const html = `<form class="habit-form" autocomplete="off" novalidate>
    <header class="dlg-head"><h2>${habit ? 'Edit habit' : 'New habit'}</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></header>
    <div class="dlg-body">
      <div class="seg hb-type"><label><input type="radio" name="type" value="yesno" ${h0.type !== 'number' ? 'checked' : ''}><span>Yes or no</span></label><label><input type="radio" name="type" value="number" ${h0.type === 'number' ? 'checked' : ''}><span>Measurable</span></label></div>
      <label class="field"><span>Name</span><input name="name" value="${esc(h0.name)}" placeholder="e.g. Exercise, Meditate, Drink water" maxlength="60" autofocus></label>
      <label class="field"><span>Question</span><input name="question" value="${esc(h0.question || '')}" placeholder="e.g. Did you exercise today?" maxlength="100"></label>
      <div class="field"><span>Color</span><div class="swatches hb-colors">${HB.COLORS.map((c) => `<label class="sw"><input type="radio" name="color" value="${c}" ${h0.color === c ? 'checked' : ''}><i style="background:${c}"></i></label>`).join('')}</div></div>
      <div class="row hb-yesno">
        <label class="field"><span>How often</span><select name="per"><option value="day" ${f0.per === 'day' ? 'selected' : ''}>Every day</option><option value="week" ${f0.per === 'week' ? 'selected' : ''}>Times per week</option><option value="month" ${f0.per === 'month' ? 'selected' : ''}>Times per month</option></select></label>
        <label class="field hb-times"><span>Times</span><input type="number" name="times" min="1" max="31" value="${f0.times || 1}" class="num"></label>
      </div>
      <div class="row hb-number">
        <label class="field"><span>Target</span><input type="number" name="target" min="0.1" step="any" value="${h0.target || 1}" class="num"></label>
        <label class="field"><span>Unit</span><input name="unit" value="${esc(h0.unit || '')}" placeholder="e.g. glasses, km, pages" maxlength="20"></label>
        <label class="field"><span>Per</span><select name="nper"><option value="day" ${f0.per === 'day' ? 'selected' : ''}>day</option><option value="week" ${f0.per === 'week' ? 'selected' : ''}>week</option><option value="month" ${f0.per === 'month' ? 'selected' : ''}>month</option></select></label>
      </div>
      <label class="chk hb-game"><input type="checkbox" name="hgame" ${h0.game !== false ? 'checked' : ''}> 🎮 Counts in game mode — earns XP when ticked off, plus small rewards for streaks (bigger at higher ranks)</label>
      ${sect('hb-adv', 'Advanced: automatic tracking', `<div class="hb-auto">
        <label class="field"><span>Tick it off by itself</span><select name="amode">
          <option value="">No — I tick it off myself</option>
          <option value="tick" ${h0.auto?.mode === 'tick' ? 'selected' : ''}>Tick a day when an event or task contains…</option>
          <option value="untick" ${h0.auto?.mode === 'untick' ? 'selected' : ''}>Tick every day, except when an event or task contains…</option>
          <option value="hours" ${h0.auto?.mode === 'hours' ? 'selected' : ''}>Tick by hours spent in categories…</option>
          <option value="timing" ${h0.auto?.mode === 'timing' ? 'selected' : ''}>Tick when something starts by / ends before a time…</option></select></label>
        <div class="hb-auto-timing">
          <div class="row"><label class="field"><span>Tick the day when it</span><select name="twhich"><option value="endBy" ${h0.auto?.which !== 'startBy' ? 'selected' : ''}>ends before</option><option value="startBy" ${h0.auto?.which === 'startBy' ? 'selected' : ''}>starts by</option></select></label>
            <label class="field"><span>Time</span><input type="time" name="ttime" value="${esc(h0.auto?.time || '07:00')}" step="300"></label></div>
          <label class="field"><span>What counts: titles with these words…</span><input name="twords" value="${esc(h0.auto?.mode === 'timing' ? (h0.auto.words || []).join(', ') : '')}" placeholder="e.g. sleep — or: essay, report" autocomplete="off"></label>
          <div class="field"><span>…and/or these categories</span><div class="g-catlist">${C.ordered(ctx.state.settings).map((c) => `<label class="chk ${c.parent ? 'sub' : ''}"><input type="checkbox" name="tcat" value="${esc(c.id)}" ${h0.auto?.mode === 'timing' && (h0.auto.cats || []).includes(c.id) ? 'checked' : ''}> ${esc(C.catLabel(c))}</label>`).join('')}</div></div>
          <p class="muted small" style="margin:0">E.g. “ends before 07:00” with the word <i>sleep</i>: ticked when your sleep (block) ended by 7, not when you were still asleep at 7. “Starts by 09:00” with <i>Work</i>: ticked when work started by 9. Sleep blocks count for the morning they end.</p>
        </div>
        <div class="hb-auto-words">
          <label class="field"><span>Words to look for in titles</span><input name="awords" value="${esc((h0.auto?.words || []).join(', '))}" placeholder="e.g. run, gym, swim (separate with commas)" autocomplete="off"></label>
          <p class="muted small" style="margin:0">Words match the start of a word, ignoring case — “run” finds “Morning run” and “Running”, not “Brunch”.</p>
        </div>
        <div class="hb-auto-hours">
          <div class="row"><label class="field"><span>When I spend</span><select name="aop"><option value="atLeast" ${h0.auto?.op !== 'atMost' ? 'selected' : ''}>at least</option><option value="atMost" ${h0.auto?.op === 'atMost' ? 'selected' : ''}>at most</option></select></label>
            <label class="field"><span>Hours</span><input type="number" name="ahours" min="0" step="0.25" value="${h0.auto?.hours ?? 1}" class="num"></label>
            <label class="field"><span>Per</span><select name="aper"><option value="day" ${h0.auto?.per !== 'week' ? 'selected' : ''}>day</option><option value="week" ${h0.auto?.per === 'week' ? 'selected' : ''}>week</option></select></label></div>
          <div class="field"><span>…in these categories</span><div class="g-catlist hb-acats">${C.ordered(ctx.state.settings).map((c) => `<label class="chk ${c.parent ? 'sub' : ''}"><input type="checkbox" name="acat" value="${esc(c.id)}" ${(h0.auto?.cats || []).includes(c.id) ? 'checked' : ''}> ${esc(C.catLabel(c))}</label>`).join('')}</div></div>
          <p class="muted small" style="margin:0">“At most” suits habits like “Not more than 2 h of screen time a day”. Per week: “at least” ticks the day your week's total gets there; “at most” ticks each day while the week stays under.</p>
        </div>
        <div class="hb-auto-from">
          <label class="field"><span>From</span><input type="date" data-quick="off" name="afrom" value="${esc(h0.auto?.from || T.addDays(T.dayKey(Date.now(), ctx.state.settings.tz), -30))}"></label>
          <label class="field"><span>Only count what happens during <em class="muted">(e.g. reading “after hours”)</em></span><select name="ascope">${SC.scopeOptions(ctx.state.settings).map(([v, l]) => `<option value="${esc(v)}" ${(h0.auto?.scope || '') === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
          <p class="muted small" style="margin:0">Only time that has already passed counts, never future events or tasks. A day you tick or untick yourself keeps your choice.</p>
        </div></div>`, { open: !!h0.auto })}
      <p class="muted small" style="margin:0">Tick a habit off in the list (click a day). Right-click or long-press a day to mark it skipped — a skipped day doesn't break your streak.</p>
    </div>
    <footer class="actions">${habit ? `<button type="button" class="btn ghost danger hb-del">Delete…</button><button type="button" class="btn ghost hb-arch">${habit.archived ? 'Unarchive' : 'Archive'}</button>` : ''}<span class="grow"></span><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn primary">${habit ? 'Save' : 'Add habit'}</button></footer>
  </form>`;
  return modal(html, (dlg, close) => {
    const f = $('form', dlg);
    const sync = () => {
      const num = f.type.value === 'number';
      $('.hb-yesno', dlg).style.display = num ? 'none' : '';
      $('.hb-number', dlg).style.display = num ? '' : 'none';
      $('.hb-times', dlg).style.display = f.per.value === 'day' ? 'none' : '';
      $('details[data-sect=hb-adv]', dlg).style.display = num ? 'none' : '';
      $('.hb-auto-words', dlg).style.display = f.amode.value === 'tick' || f.amode.value === 'untick' ? '' : 'none';
      $('.hb-auto-hours', dlg).style.display = f.amode.value === 'hours' ? '' : 'none';
      $('.hb-auto-timing', dlg).style.display = f.amode.value === 'timing' ? '' : 'none';
      $('.hb-auto-from', dlg).style.display = f.amode.value ? '' : 'none';
    };
    f.addEventListener('change', sync); sync();
    wireSects(dlg, { 'hb-adv': () => ({ tick: '⚡ by words', untick: '⚡ unless words', hours: '⚡ by hours', timing: `⚡ ${f.twhich.value === 'endBy' ? 'ends before' : 'starts by'} ${f.ttime.value}` }[f.amode.value] || 'Off') });
    $('.hb-del', dlg)?.addEventListener('click', async () => { if (await choose(`Delete “${h0.name}”?`, 'Its whole history goes too. (Archiving keeps it.)', [{ value: true, label: 'Delete the habit', danger: true }])) close({ delete: true }); });
    $('.hb-arch', dlg)?.addEventListener('click', () => close({ ...h0, archived: !h0.archived }));
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = f.name.value.trim(); if (!name) { f.name.focus(); return; }
      const num = f.type.value === 'number';
      const per = num ? f.nper.value : f.per.value;
      close({ ...h0, name, question: f.question.value.trim(), color: f.color.value || h0.color, type: num ? 'number' : 'yesno', game: f.hgame.checked,
        freq: { per, times: num || per === 'day' ? 1 : Math.max(1, Math.min(per === 'week' ? 7 : 31, Math.round(+f.times.value || 1))) },
        target: num ? Math.max(0.1, +f.target.value || 1) : 1, unit: num ? f.unit.value.trim() : '',
        auto: (() => {
          const a = autoOf(); return a && f.ascope.value ? { ...a, scope: f.ascope.value } : a;
        })() });
      function autoOf() {
          const fromK = f.afrom.value || T.dayKey(Date.now(), ctx.state.settings.tz);
          if (num || !f.amode.value) return null;
          if (f.amode.value === 'timing') { const cats = $$('input[name=tcat]:checked', dlg).map((x) => x.value), words = f.twords.value.split(/[,;\n]/).map((w) => w.trim()).filter(Boolean); return cats.length || words.length ? { mode: 'timing', which: f.twhich.value, time: f.ttime.value || '07:00', cats, words, from: fromK } : null; }
          if (f.amode.value === 'hours') { const cats = $$('input[name=acat]:checked', dlg).map((x) => x.value); return cats.length ? { mode: 'hours', cats, op: f.aop.value, hours: Math.max(0, +f.ahours.value || 0), per: f.aper.value, from: fromK } : null; }
          return f.awords.value.trim() ? { mode: f.amode.value, words: [...new Set(f.awords.value.split(/[,;\n]/).map((w) => w.trim()).filter(Boolean))].slice(0, 12), from: fromK } : null;
      }
    });
  });
}
