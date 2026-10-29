// Event, task, settings and problem dialogs.
import * as T from './tz.js';
import * as S from './scheduler.js';
import * as G from './gcal.js';
import { parseRRule, expand } from './rrule.js';
import { $, $$, TASK_COLORS, choose, esc, linkRange, modal, nudgeHTML, setHTML } from './ui.js';
import * as C from './categories.js';
import * as P from './projects.js';
import * as HB from './habits.js';
import * as SC from './scopes.js';

const WDN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const WDL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const ORD = ['', 'first', 'second', 'third', 'fourth', 'fifth'];

export function tzDatalist(id) {
  return `<datalist id="${id}">${T.allTimezones().map((z) => `<option value="${esc(z)}">`).join('')}</datalist>`;
}

// Collapsible sections ("▾"): closed by default, with a one-line summary of what's inside while closed.
// (localStorage 'tempo:expandAll' = '1' opens them all.)
const expandAll = () => { try { return localStorage.getItem('tempo:expandAll') === '1'; } catch { return false; } };
// A category picker like the goals' one: the chosen categories as chips and a button; the chips to pick from fold away when done.
export function catPick(s, cls, sel, { none = 'None chosen' } = {}) {
  sel = new Set(sel || []);
  return `<div class="cp" data-cp="${esc(cls)}"><div class="cp-sum"><span class="cp-chips">${cpChips(s, [...sel], none)}</span><button type="button" class="btn small cp-open" aria-expanded="false">Choose categories…</button></div>
    <div class="cp-grid g-pick" hidden>${C.treeChipsHTML(s, (c) => `<label class="cat-chip ${c.parent ? 'sub' : ''} ${sel.has(c.id) ? 'on' : ''}" style="--c:${esc(c.color)}" title="${esc(C.fullLabel(s, c))}"><input type="checkbox" class="${esc(cls)}" value="${esc(c.id)}" ${sel.has(c.id) ? 'checked' : ''} hidden><i></i>${c.parent ? '<span class="cat-sub">↳</span>' : ''}${c.icon ? `<span class="cat-ic">${esc(c.icon)}</span>` : ''}${esc(c.name)}</label>`)}
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

export function weekdayToggles(name, days) {
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

// compact −/+ time buttons (same as the quick-create box)
const NUDGE_MIN = [[-60, '−1h'], [-30, '−30'], [-10, '−10'], [-5, '−5'], [5, '+5'], [15, '+15'], [30, '+30'], [60, '+1h']];
export const NUDGE_DAY = [[-1440, '−1d'], [-60, '−1h'], [-15, '−15'], [15, '+15'], [60, '+1h'], [1440, '+1d']];
export const nudgesHTML = (cls, steps = NUDGE_MIN) => nudgeHTML(cls, steps === NUDGE_DAY ? 'day' : 'min');
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
export const limitHint = 'You can change this limit in Settings → Scheduling → Limits.';
export async function checkCount(kind, n, s) {
  if (s.sessionMax && n > s.sessionMax) {
    await choose(`Too many ${kind}`, `This would create ${n} ${kind}, more than the limit of ${s.sessionMax}. ${kind === 'sessions' ? 'Use longer sessions, a later start or a shorter task.' : 'End the series sooner.'} ${limitHint}`, [], { cancel: 'OK' });
    return false;
  }
  if (s.sessionWarn && n > s.sessionWarn) {
    return !!(await choose(`Create ${n} ${kind}?`, `That's more than ${s.sessionWarn}. ${limitHint}`, [{ value: true, label: `Yes, create ${n} ${kind}` }], { cancel: 'Go back' }));
  }
  return true;
}
export async function checkSpan(what, endMs, s, now = Date.now()) {
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

export const DAYN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
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
// First-time onboarding wizard (shown once when no Google calendar is connected)
// ======================================================================================
export function onboardingWizard(ctx) {
  const builtin = G.builtinAvailable();
  const slides = [
    { icon: '🚀', title: 'Welcome to Tempo',
      body: `<p>Tempo turns Google Calendar into a productivity powerhouse.</p>
        <ul class="ob-list">
          <li><b>Auto-scheduler</b> — add a task, set a deadline, and Tempo splits it into sessions across your free time</li>
          <li><b>Habit tracking</b> — set daily or weekly goals and watch your streaks grow</li>
          <li><b>Time analysis</b> — see exactly where your time goes, by category</li>
          <li><b>Game layer</b> — earn XP, level up and unlock achievements for staying on track</li>
        </ul>
        <p class="small muted">Coded entirely by Claude. Designed to be free and full-featured, always.</p>` },
    { icon: '🔗', title: 'Connect Google Calendar',
      body: builtin
        ? `<p>One click to sync your events, tasks and settings across devices.</p>
          <div class="ob-connect-box">
            <button type="button" class="btn primary ob-go">Connect Google Calendar</button>
            <div class="ob-result"></div>
          </div>
          <p class="small muted">Tempo only talks to Google's servers — no third-party analytics or tracking. Your data stays in your Google account.</p>`
        : `<p>To sync your events you'll need to set up a free Google Cloud project (takes about 5 minutes, once).</p>
          <div class="ob-connect-box">
            <button type="button" class="btn primary ob-setup">Set up Google connection</button>
            <div class="ob-result"></div>
          </div>
          <p class="small muted">Tempo only talks to Google's servers — no third-party analytics or tracking.</p>` },
    { icon: '⚙️', title: 'Quick tips',
      body: `<ul class="ob-list">
          <li><b>Categories</b> — organise events into a tree (Work › Meetings, Life › Fitness) to see where time goes</li>
          <li><b>Settings</b> — tap the ⚙️ gear icon to set your work hours, week start day, task calendar and more</li>
          <li><b>Command bar</b> — press <kbd>Ctrl+K</kbd> (or <kbd>⌘K</kbd>) to search anything in the app instantly</li>
          <li><b>Game</b> — enable the XP game in Settings → Game to gamify your productivity</li>
        </ul>
        <p>You can always access Settings from the gear icon in the toolbar.</p>` },
  ];
  return modal(`
    <form class="ob-form">
      <header class="dlg-head"><h2>${slides[0].title}</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></header>
      <div class="dlg-body">
        ${slides.map((s, i) => `<section class="ob-slide" data-ob="${i}" ${i ? 'hidden' : ''}>
          <div class="ob-icon">${s.icon}</div>
          ${s.body}
        </section>`).join('')}
      </div>
      <footer class="actions">
        <button type="button" class="btn ghost ob-back" style="visibility:hidden">Back</button>
        <span class="grow"></span>
        <span class="muted small ob-pos">1 / ${slides.length}</span>
        <button type="button" class="btn primary ob-next">Next</button>
      </footer>
    </form>`, (dlg, close) => {
    let cur = 0, connected = false;
    const show = (i) => {
      cur = Math.max(0, Math.min(slides.length - 1, i));
      $$('[data-ob]', dlg).forEach((x) => (x.hidden = +x.dataset.ob !== cur));
      const h2 = $('h2', dlg); if (h2) h2.textContent = slides[cur].title;
      $('.ob-back', dlg).style.visibility = cur ? '' : 'hidden';
      $('.ob-next', dlg).textContent = cur === slides.length - 1 ? 'Get started' : 'Next';
      $('.ob-pos', dlg).textContent = `${cur + 1} / ${slides.length}`;
    };
    $('.ob-back', dlg).onclick = () => show(cur - 1);
    $('.ob-next', dlg).onclick = () => { if (cur === slides.length - 1) close({ connected }); else show(cur + 1); };
    // Extension one-click connect
    const goBtn = $('.ob-go', dlg);
    if (goBtn) {
      goBtn.onclick = async () => {
        const res = $('.ob-result', dlg);
        goBtn.disabled = true;
        goBtn.textContent = 'Connecting…';
        G.ensureHostPermission();
        const r = await ctx.connect('builtin');
        connected = r.ok;
        goBtn.disabled = false;
        goBtn.textContent = 'Connect Google Calendar';
        setHTML(res, r.ok
          ? `<div class="okbox">✓ Connected${r.email ? ' as <b>' + esc(r.email) + '</b>' : ''}!</div>`
          : `<div class="warn">✕ ${esc(r.error)}</div>`);
        if (r.ok) { goBtn.hidden = true; setTimeout(() => show(cur + 1), 1200); }
      };
    }
    // Web: open the full setup wizard
    const setupBtn = $('.ob-setup', dlg);
    if (setupBtn) {
      setupBtn.onclick = async () => {
        close(); // close onboarding, open setup wizard
        const r = await ctx._openWizard();
        connected = r?.connected;
      };
    }
    show(0);
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
      const fmtD = (k) => T.fmtDate(T.dayStart(k, tz), tz);
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
  const when = `${T.fmtDate(sess.start, tz)}, ${T.fmtTime(sess.start, tz, s.h12)}–${T.fmtTime(sess.end, tz, s.h12)}`;
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
            <select name="evCat"><option value="">No category</option>${C.treeOptionsHTML(s)}</select>
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
  const when = `${T.fmtDate(sess.start, tz)}, ${T.fmtTime(sess.start, tz, s.h12)}–${T.fmtTime(sess.end, tz, s.h12)}`;
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
          <label class="field"><span>${task.reading?.format === 'audio' ? `Minutes of audio heard (of ${planned})` : `Pages read (of ${planned}: page ${pa}–${pb})`}</span>
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
      if (reading) { const n = +f.pages.value || 0; $('.pg-to', dlg).textContent = f.pages.value === '' ? '' : task.reading?.format === 'audio' ? (n ? T.fmtDur(n) + ' heard' : 'nothing heard') : n ? `read page ${pa}–${pa + n - 1}` : 'nothing read'; }
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
    if (r.st.kind === 'task') return `<span class="ps-pct">${r.pct}%${r.next ? ` · next ${esc(T.fmtDate(r.next, tz))}` : ''}${r.late ? ' · ⚠' : ''}</span>`;
    return `<span class="ps-pct">${r.next ? esc(T.fmtDate(r.next, tz)) : ''}</span>`;
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
        <label class="field"><span>Category for its tasks and events</span><select name="catId"><option value="">— none —</option>${C.treeOptionsHTML(s, p0.catId)}</select></label>
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

export const TASK_COLORS_PUBLIC = TASK_COLORS;

// The big dialogs live in their own modules; they're re-exported here so callers keep using D.eventDialog etc.
export { eventDialog } from './event-dialog.js';
export { taskDialog } from './task-dialog.js';
export { settingsDialog } from './settings-dialog.js';
