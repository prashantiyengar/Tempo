// Quick create, title suggestions, and the popups of events and task sessions (with the shared item actions).
import * as T from './tz.js';
import * as S from './scheduler.js';
import * as E from './engine.js';
import * as EV from './events.js';
import * as G from './gcal.js';
import * as D from './dialogs.js';
import { describe } from './rrule.js';
import * as C from './categories.js';
import { $, $$, esc, choose, popover, modal, setHTML } from './ui.js';
import * as UI from './ui.js';
import * as N from './notify.js';
import { app, set, st, tz } from './core.js';
import { currentToNow, doneAtAnotherTime, eventDoneAtAnotherTime, extendToNow, finishedEarly, lastEventEnd, nextEventStart, nowMin, startedLate } from './actions.js';
import { collectItems, ctx, cycle, editEvent, newEvent, refreshFromServer, render, replaceTask, saveTasks, setEventDone, toast } from './app.js';
import { gameXPLine } from './game-ui.js';
import { handleError, logHistory, openSyncPanel, setStatus } from './status.js';
import { askScope } from './interactions.js';
import { deleteDoneSession, dropTimer, startTimer, timer, tmWork } from './timer.js';
import { deleteTask, editTask, newTask, pushUndo, undoableEventChange, undoableEventDelete } from './undo.js';

// ======================================================================================
// Quick create & item popovers
// ======================================================================================
// Title suggestions while typing an event's title: the titles of your events of the last 7 days (today included),
// most recent first — not task sessions.
// (shown as tappable chips under the title — native suggestion lists don't show up on many phones)
export async function refreshTitleList() {
  try {
    const z = tz(), today = T.dayKey(Date.now(), z);
    const evs = (await collectItems([T.addDays(today, -6), today])).filter((it) => it.kind === 'event' && it.start >= T.dayStart(T.addDays(today, -6), z) && it.start < T.dayStart(T.addDays(today, 1), z) && (it.ev?.summary || '').trim()).sort((a, b) => b.start - a.start);
    const seen = new Set(), titles = [];
    for (const it of evs) { const t = it.ev.summary.trim(), k = t.toLowerCase(); if (!seen.has(k)) { seen.add(k); titles.push(t); } }
    app.titleList = titles.slice(0, 80);
    document.querySelectorAll('.ts-live').forEach((h) => h._ts?.());
  } catch (err) { console.warn('Tempo: title suggestions', err); }
}
export function attachTitleSuggest(inp) {
  if (!inp || inp.dataset.ts) return; inp.dataset.ts = '1';
  // a small dropdown under the title (it never pushes the title aside): shows once you start typing
  const wrap = document.createElement('span'); wrap.className = 'ts-wrap';
  inp.replaceWith(wrap); wrap.appendChild(inp);
  const box = document.createElement('div'); box.className = 'ts-host'; box.setAttribute('role', 'listbox'); box.hidden = true;
  wrap.appendChild(box);
  let shown = false;
  const draw = () => {
    const q = inp.value.trim().toLowerCase(), list = app.titleList || [];
    const hits = q ? list.filter((t) => t.toLowerCase() !== q && t.toLowerCase().includes(q)).sort((a, b) => (b.toLowerCase().startsWith(q) - a.toLowerCase().startsWith(q))).slice(0, 4) : [];
    box.hidden = !shown || !hits.length;
    setHTML(box, hits.map((t) => `<button type="button" class="ts-item" role="option" data-t="${esc(t)}">${esc(t)}</button>`).join(''));
    $$('.ts-item', box).forEach((b) => { b.addEventListener('pointerdown', (e) => e.preventDefault()); b.onclick = () => { inp.value = b.dataset.t; inp.dispatchEvent(new Event('input', { bubbles: true })); shown = false; draw(); inp.focus(); }; });
  };
  box._ts = draw; box.classList.add('ts-live');
  inp.addEventListener('input', () => { shown = true; draw(); });
  inp.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !box.hidden) { e.stopPropagation(); shown = false; draw(); } });
  inp.addEventListener('blur', () => setTimeout(() => { shown = false; draw(); }, 150));
}
export function quickCreate(rect, sel, onClose) {
  refreshTitleList();
  const z = tz(), s = set();
  const when = sel.allDay
    ? (T.daysBetween(T.dayKey(sel.start, z), T.dayKey(sel.end, z)) > 1
      ? `${T.fmtDate(sel.start, z)} – ${T.fmtDate(sel.end - 1, z)}`
      : T.format(sel.start, z, { weekday: 'long', day: 'numeric', month: 'long' }))
    : `${T.format(sel.start, z, { weekday: 'long', day: 'numeric', month: 'long' })} · ${T.fmtTime(sel.start, z, s.h12)} – ${T.fmtTime(sel.end, z, s.h12)}`;
  const cals = ctx.writableCalendars();
  const def = ctx.defaultCalendar();
  const durMin = Math.round((sel.end - sel.start) / T.MIN);
  popover(rect, `
    <form class="qc" novalidate>
      <input name="title" placeholder="Add title" autofocus autocomplete="off">
      <div class="qc-when">${esc(when)}${sel.allDay ? ' · all day' : ''}</div>
      ${sel.note ? `<div class="qc-note muted small">⇕ ${esc(sel.note)}</div>` : ''}
      ${sel.allDay ? '' : (() => {
        return `<div class="qc-times">
          <div class="qc-t"><span class="qc-l">From</span><input type="time" name="qs" step="60"><button type="button" class="now-btn st-now" title="Start now">Now</button>${nudges('st-add')}</div>
          <div class="qc-t"><span class="qc-l">To</span><input type="time" name="qe" step="60"><button type="button" class="now-btn en-now" title="End now">Now</button>${nudges('dur-add')}</div>
          <div class="qc-fill"><button type="button" class="chip-btn since-last" title="Start when the previous event ended (up to 12 h earlier)">⤒ Since last event</button><button type="button" class="chip-btn till-next" title="End when the next event starts (up to 12 h later)">⤓ Till next event</button></div>
        </div>`;
      })()}
      <div class="qc-sels"><select name="cal" aria-label="Calendar">${cals.map((c) => `<option value="${esc(c.id)}" ${c.id === def ? 'selected' : ''}>${esc(c.summary)}</option>`).join('')}</select>
      <select name="np" class="qc-np" aria-label="Notifications" title="Notification profile">${N.profiles(s).map((pr) => `<option value="${esc(pr.id)}" ${pr.id === N.eventDefault(s)?.id ? 'selected' : ''} title="${esc(N.describeProfile(pr))}">🔔 ${esc(pr.name)}</option>`).join('')}</select></div>
      <div class="qc-cat"></div>
      <div class="qc-actions">
        <button type="button" class="btn small ghost more">More options</button>
        <span class="grow"></span>
        <button type="button" class="btn small ghost qc-cancel">Cancel</button>
        <button type="submit" class="btn small primary">Save</button>
      </div>
      <div class="qc-alt">
        <span class="muted small">Or turn this into</span>
        <button type="button" class="link as-task">a split task${sel.allDay ? '' : ` (${T.fmtDur(durMin)})`}</button>
        <button type="button" class="link as-reading">a reading plan</button>
      </div>
    </form>`, (p, close) => {
    const f = $('form', p);
    attachTitleSuggest(f.title);
    setTimeout(() => f.title.focus(), 0);
    // length shortcuts: each click extends the event
    const hhmm = (ms) => T.toDTInput(ms, z).slice(11, 16);
    const redraw = () => {
      if (f.qs) { f.qs.value = hhmm(sel.start); f.qe.value = hhmm(sel.end); }
      $('.qc-when', p).textContent = `${T.format(sel.start, z, { weekday: 'long', day: 'numeric', month: 'long' })} · ${T.fmtTime(sel.start, z, s.h12)} – ${T.fmtTime(sel.end, z, s.h12)} (${T.fmtDur(Math.round((sel.end - sel.start) / T.MIN))})`;
      const g = $('.ghost-sel'); if (g) g.style.height = (((sel.end - sel.start) / T.HOUR) * s.hourHeight) + 'px';
      f.title.focus();
    };
    $$('.dur-add', p).forEach((b) => (b.onclick = () => { sel.end = Math.max(sel.start + 5 * T.MIN, sel.end + +b.dataset.add * T.MIN); redraw(); }));
    $('.st-now', p)?.addEventListener('click', () => { const d = sel.end - sel.start; sel.start = nowMin(); sel.end = sel.start + d; $('.ghost-sel')?.remove(); redraw(); });
    $('.en-now', p)?.addEventListener('click', () => { sel.end = Math.max(sel.start + 5 * T.MIN, nowMin()); redraw(); });
    // From: move the whole slot (the length stays)
    // From −/+ moves only the start (the end stays, and is pushed on only if the start would pass it)
    $$('.st-add', p).forEach((b) => (b.onclick = () => { sel.start += +b.dataset.add * T.MIN; if (sel.end < sel.start + 5 * T.MIN) sel.end = sel.start + 5 * T.MIN; redraw(); }));
    // typed times: same day as the start; an end before the start means the next day
    const fromInputs = () => {
      const day = T.dayKey(sel.start, z);
      const st0 = T.atTime(day, f.qs.value || hhmm(sel.start), z);
      let en = T.atTime(day, f.qe.value || hhmm(sel.end), z);
      if (en <= st0) en = T.atTime(T.addDays(day, 1), f.qe.value || hhmm(sel.end), z);
      sel.start = st0; sel.end = en; redraw();
    };
    // changing From moves To with it (the length stays)
    const fromStart = () => { const len = sel.end - sel.start; const day = T.dayKey(sel.start, z); sel.start = T.atTime(day, f.qs.value || hhmm(sel.start), z); sel.end = sel.start + Math.max(5 * T.MIN, len); redraw(); };
    if (f.qs) { f.qs.addEventListener('change', fromStart); f.qe.addEventListener('change', fromInputs); f.qs.value = hhmm(sel.start); f.qe.value = hhmm(sel.end); }
    $('.since-last', p)?.addEventListener('click', async () => {
      const ref = sel.start, nowish = Math.abs(ref - Date.now()) < 20 * T.MIN;
      const r = await lastEventEnd({ ref: nowish ? null : ref });
      if (!r.found && !nowish) { toast('No earlier event in the 12 hours before this slot.', { noUndo: true }); return; }
      sel.start = r.start;
      if (nowish) sel.end = Math.max(r.end, sel.start + 5 * T.MIN);
      else if (sel.end <= sel.start) sel.end = sel.start + 5 * T.MIN;
      $('.ghost-sel')?.remove(); redraw(); toast(r.note, { noUndo: true });
    });
    $('.qc-cancel', p)?.addEventListener('click', () => { close(); onClose?.(); });
    let qcCat = null;
    C.categoryPicker($('.qc-cat', p), { compact: true,
      settings: set(), selected: null,
      onChange: (c) => { qcCat = c; },
      onCreate: async (name, color, icon, parent) => { const c = C.newCategory(set(), name, color, icon, parent); await E.persist(st(), ['settings']); return c; },
    });
    $('.till-next', p)?.addEventListener('click', async () => {
      const r = await nextEventStart({ ref: sel.start });
      if (!r.found) { toast(r.note, { noUndo: true }); return; }
      sel.end = r.end; $('.ghost-sel')?.remove(); redraw(); toast(r.note, { noUndo: true });
    });
    let saving = false;
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (saving) return;
      // No title: use the category's name, or ask (picking a category in the prompt uses its name)
      let title = f.title.value.trim(), cat = qcCat;
      if (!title) {
        if (cat) title = cat.name;
        else {
          saving = true;
          const a = await D.askTitle(set(), { what: 'event', onCreate: async (name, color, icon, parent) => { const c = C.newCategory(set(), name, color, icon, parent); await E.persist(st(), ['settings']); return c; } });
          saving = false;
          if (!a) { f.title.focus(); return; }
          title = a.title; cat = a.cat || cat;
        }
      }
      const g = f.cal.value !== E.LOCAL_CAL, prof = N.profileById(set(), f.np.value);
      const body = { ...selBody(sel, title, f.cal.value), ...(cat ? C.eventCategoryChanges({}, cat) : {}) };
      if (prof) {
        body.reminders = { useDefault: false, overrides: N.overrides(prof.rules, { google: g }) };
        body.extendedProperties = { ...(body.extendedProperties || {}), private: { ...(body.extendedProperties?.private || {}), tempoNotify: prof.id } };
      }
      close(); onClose?.();
      await saveNewEvent(f.cal.value, body);
    });
    $('.more', p).onclick = () => { const v = { title: f.title.value, calId: f.cal.value, categoryId: qcCat?.id, notifyProfile: f.np.value }; close(); onClose?.(); newEvent({ ...sel, ...v }); };
    $('.as-task', p).onclick = () => { const title = f.title.value; close(); onClose?.(); newTask({ kind: 'generic', title, earliestStart: sel.allDay ? null : sel.start, totalMinutes: sel.allDay ? null : Math.round((sel.end - sel.start) / T.MIN) }); };
    $('.as-reading', p).onclick = () => { const title = f.title.value; close(); onClose?.(); newTask({ kind: 'reading', title, earliestStart: sel.allDay ? null : sel.start }); };
  });
}

// Compact −/+ time buttons: two joined groups, e.g. [−1h|−30|−10|−5] [+5|+15|+30|+1h]
const nudges = (cls) => UI.nudgeHTML(cls);


export function selBody(sel, title, calId) {
  const z = tz();
  const body = { summary: title };
  if (sel.allDay) { body.start = { date: T.dayKey(sel.start, z) }; body.end = { date: T.dayKey(sel.end, z) }; }
  else { body.start = { dateTime: new Date(sel.start).toISOString(), timeZone: z }; body.end = { dateTime: new Date(sel.end).toISOString(), timeZone: z }; }
  if (calId === E.LOCAL_CAL) body.reminders = { useDefault: false, overrides: [{ method: 'popup', minutes: set().defaultReminder }] };
  return body;
}

export let createdEvents = 0;
export async function saveNewEvent(calId, body, opts) {
  try {
    setStatus('Saving…');
    if (app.laterTag) body = { ...body, extendedProperties: { ...(body.extendedProperties || {}), private: { ...(body.extendedProperties?.private || {}), tempoLaterCreated: String(app.laterTag.created || Date.now()), tempoLaterAt: String(Date.now()) } } };
    const created = await EV.createEvent(st(), calId, body, opts);
    createdEvents++;
    pushUndo(`create “${body.summary || 'event'}”`, async () => { await EV.deleteEvent(st(), created, 'this'); await afterEventChange(); });
    await afterEventChange();
    toast('Event created');
  } catch (err) { handleError(err); render(); }
}

export async function afterEventChange() {
  await E.persist(st(), ['localEvents']);
  E.invalidate();
  setStatus('');
  await render();
  cycle(); // busy time changed -> tasks may need to move
  // Google's lists can trail a change by a few seconds (a series edit especially): look again shortly so task
  // sessions still sitting on the new time move off it.
  for (const t of app.recheckT || []) clearTimeout(t);
  app.recheckT = [6000, 30000].map((ms) => setTimeout(() => { E.invalidate(); cycle({ sync: true }); }, ms));
}

function fmtWhen(it) {
  const z = tz(), s = set();
  if (it.allDay) {
    const last = T.addDays(it.endKey, -1);
    const a = T.format(T.dayStart(it.startKey, z), z, { weekday: 'long', day: 'numeric', month: 'long' });
    return last === it.startKey ? a : `${a} – ${T.format(T.dayStart(last, z), z, { weekday: 'long', day: 'numeric', month: 'long' })}`;
  }
  const sameDay = T.dayKey(it.start, z) === T.dayKey(it.end - 1, z);
  return sameDay
    ? `${T.format(it.start, z, { weekday: 'long', day: 'numeric', month: 'long' })} · ${T.fmtTime(it.start, z, s.h12)} – ${T.fmtTime(it.end, z, s.h12)}`
    : `${T.format(it.start, z, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: s.h12 })} – ${T.format(it.end, z, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: s.h12 })}`;
}

export function openItem(it, rect) {
  if (it.kind === 'chunk') return openChunk(it, rect);
  const ev = it.ev;
  const cal = it.ev._calId === E.LOCAL_CAL ? { summary: 'Local (this browser)' } : ev._calName ? { summary: ev._calName } : (st().gmeta.calendars || []).find((c) => c.id === ev._calId);
  const rems = ev.reminders?.useDefault === false ? (ev.reminders.overrides || []) : null;
  const meet = ev.hangoutLink || ev.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri;
  const evTz = ev.start?.timeZone && ev.start.timeZone !== tz() ? ev.start.timeZone : null;
  const desc = (ev.description || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();
  popover(rect, `
    <div class="pop">
      <div class="pop-tools">
        ${it.editable ? '<button class="icon-btn edit" title="Edit">✎</button><button class="icon-btn del" title="Delete">🗑</button>' : ''}
        ${ev.htmlLink ? `<a class="icon-btn" href="${esc(ev.htmlLink)}" target="_blank" rel="noopener" title="Open in ${ev._ext === 'outlook' ? 'Outlook' : 'Google Calendar'}">↗</a>` : ''}
        <button class="icon-btn x" title="Close">✕</button>
      </div>
      <div class="pop-title"><i style="--c:${it.color}"></i><h3>${esc(it.title)}</h3>${it.evDone ? '<span class="pill ok">Done</span>' : ''}</div>
      <div class="pop-row small"><button class="cat-chip on pop-evcat" ${it.catId ? `style="--c:${esc(C.catById(set(), it.catId)?.color || it.color)}"` : ''}>${it.catId ? `<i></i>${esc(C.catLabel(C.catById(set(), it.catId)) || 'Category')}` : '+ Category'} ▾</button></div>
      ${ev.extendedProperties?.private?.tempoTask ? '<div class="pop-row warnbox small">This is a Tempo task session that isn’t loaded in this browser yet. <button class="link load-tasks">Load tasks from Google</button></div>' : ''}
      <div class="pop-row">${esc(fmtWhen(it))}${evTz ? `<div class="muted small">Event time zone: ${esc(evTz)}</div>` : ''}${ev.recurrence?.length ? `<div class="muted small">${esc(describe(ev.recurrence))}</div>` : ev.recurringEventId ? '<div class="muted small">↻ Repeating event</div>' : ''}</div>
      ${ev.location ? `<div class="pop-row">📍 ${esc(ev.location)}${E.hasPlace(ev) && set().travelMinutes ? `<div class="muted small">🚗 ${set().travelMinutes} min travel buffer before and after</div>` : ''}</div>` : ''}
      ${meet ? `<div class="pop-row"><a class="btn small primary" href="${esc(meet)}" target="_blank" rel="noopener">Join video call</a></div>` : ''}
      ${ev.attendees?.length ? `<div class="pop-row small">👥 ${ev.attendees.length} guest${ev.attendees.length > 1 ? 's' : ''}: ${esc(ev.attendees.slice(0, 4).map((a) => a.displayName || a.email).join(', '))}${ev.attendees.length > 4 ? '…' : ''}</div>` : ''}
      ${rems ? `<div class="pop-row small">🔔 ${rems.length ? esc(rems.map((r) => `${T.fmtDur(r.minutes)} before${r.method === 'email' ? ' (email)' : ''}`).join(', ')) : 'No notifications'}</div>` : ''}
      ${desc ? `<div class="pop-row desc">${esc(desc.slice(0, 400))}${desc.length > 400 ? '…' : ''}</div>` : ''}
      <div class="pop-row pop-actions">${it.evDone ? '<button class="btn small ev-undone">↺ Mark undone</button>' : '<button class="btn small ev-done">✓ Mark done</button>'}${it.editable && !it.allDay ? '<button class="btn small ghost to-later">📋 Move to Later</button>' : ''}${itemActionsHTML(it)}</div>
      ${gameXPLine(it)}
      <div class="pop-row muted small">📅 ${esc(cal?.summary || ev._calId)}${ev.transparency === 'transparent' ? ' · free' : ''}${!it.editable ? ' · read-only' : ''}</div>
    </div>`, (p, close) => {
    $('.x', p).onclick = close;
    $('.load-tasks', p)?.addEventListener('click', () => { close(); refreshFromServer(); });
    wireItemActions(p, it, close);
    const toggle = (done) => async () => { close(); try { await setEventDone(it, done); } catch (err) { handleError(err); } };
    $('.ev-done', p)?.addEventListener('click', toggle(true));
    $('.ev-undone', p)?.addEventListener('click', toggle(false));
    $('.to-later', p)?.addEventListener('click', async () => {
      close();
      const title = it.title || ev.summary || 'Event';
      const minutes = it.allDay ? 0 : Math.round((it.end - it.start) / T.MIN);
      const item = { id: S.newId('l'), text: title, created: Date.now(), ...(minutes > 0 ? { minutes } : {}), ...(it.catId ? { catId: it.catId } : {}) };
      set().later = [...(set().later || []), item];
      try {
        let scope = 'this';
        if (ev.recurringEventId) { scope = await askScope('Delete'); if (!scope) { set().later = (set().later || []).filter((x) => x.id !== item.id); return; } }
        setStatus('Moving to Later…');
        await EV.deleteEvent(st(), ev, scope);
        await E.persist(st(), ['settings', 'localEvents']);
        undoableEventDelete(ev, scope);
        await afterEventChange();
        toast(`"${title}" moved to Later`);
      } catch (err) { set().later = (set().later || []).filter((x) => x.id !== item.id); handleError(err); }
    });
    $('.pop-evcat', p).onclick = () => { close(); pickEventCategory(it); };
    $('.edit', p)?.addEventListener('click', () => { close(); editEvent(it); });
    $('.del', p)?.addEventListener('click', async () => {
      close();
      let scope = 'this';
      if (ev.recurringEventId) { scope = await askScope('Delete'); if (!scope) return; }
      try { setStatus('Deleting…'); await EV.deleteEvent(st(), ev, scope); undoableEventDelete(ev, scope); await afterEventChange(); toast('Event deleted'); }
      catch (err) { handleError(err); }
    });
  });
}

// Actions offered on both events and task sessions — one list, so a new one shows up on both popups (with the
// same rules for when it applies). `cls` keeps the class names other code and tests look for.
export const sessDone = (it) => it.kind === 'chunk' && (it.sess.kind === 'done' || (it.sess.kind === 'pinned' && it.sess.end <= Date.now())) && !it.sess.auto;
const canChange = (it) => (it.kind === 'chunk' ? !sessDone(it) : it.editable && !it.allDay);
const ITEM_ACTIONS = [
  { cls: 'done-at ev-done-at', label: '🕓 Done at another time…', tip: 'You did it at a different time (e.g. early this morning): move it there and mark it done',
    when: (it) => (it.kind === 'chunk' ? true : it.editable && !it.allDay && !it.evDone), run: (it) => (it.kind === 'chunk' ? doneAtAnotherTime(st().tasks.find((t) => t.id === it.task.id), it.sess) : eventDoneAtAnotherTime(it)) },
  { cls: 'fin-early', label: '⏹ Finished early', tip: (it) => (it.end > Date.now() ? 'You are done: end it now and keep the rest free or move tasks up' : 'You finished before its end: pick when, the rest is left unallocated'),
    when: (it, now) => canChange(it) && it.start <= now && it.end > now - 12 * T.HOUR, run: (it) => finishedEarly(it) },
  { cls: 'late', label: '⏰ Started late…', tip: 'You began later than planned: it starts when you began',
    when: (it, now) => canChange(it) && it.start < now && it.end > now + T.MIN, run: (it) => startedLate(it) },
  { cls: 'ghost add-during', label: '＋ Add during this', tip: 'Record something else you did during it, e.g. an hour of chores during childcare', when: (it) => !it.allDay, run: (it) => addDuring(it) },
  { cls: 'to-now', label: '⟶ Extend until now', tip: 'You kept going: make it end now', when: (it) => currentToNow()?.key === it.key, run: (it) => extendToNow(it) },
];
function itemActionsHTML(it) {
  const now = Date.now();
  return ITEM_ACTIONS.map((a, i) => (a.when(it, now) ? `<button type="button" class="btn small ${a.cls}" data-ia="${i}" title="${esc(typeof a.tip === 'function' ? a.tip(it) : a.tip)}">${a.label}</button>` : '')).join('');
}
function wireItemActions(root, it, close) {
  $$('[data-ia]', root).forEach((b) => (b.onclick = () => { close(); ITEM_ACTIONS[+b.dataset.ia].run(it); }));
}

// Record an event that overlaps another one (e.g. 1 h of chores during 4 h of childcare): quick create for one hour
// inside it — from now when it's under way, else from its start. In Analysis the shorter entry counts for that time.
function addDuring(it) {
  const step = 15 * T.MIN, now = Date.now();
  let start = it.start <= now && it.end > now ? Math.max(it.start, Math.floor(now / step) * step - 60 * T.MIN) : it.start;
  if (start >= it.end) start = it.start;
  const end = Math.min(it.end, start + 60 * T.MIN);
  const node = document.querySelector(`.ev[data-key="${CSS.escape(it.key)}"]`);
  const r = node?.getBoundingClientRect() || { left: innerWidth / 2 - 150, top: innerHeight / 3, right: innerWidth / 2 + 150, bottom: innerHeight / 3 + 40, width: 300, height: 40 };
  quickCreate(r, { start, end: Math.max(end, start + 15 * T.MIN), allDay: false });
}

function openChunk(it, rect) {
  const { task, sess } = it;
  const z = tz(), s = set();
  const p = S.progress(task);
  const now = Date.now();
  const isDone = sess.kind === 'done' || (sess.kind === 'pinned' && sess.end <= now);
  const badge = sess.kind === 'done' ? '<span class="pill ok">Done</span>' : sess.kind === 'pinned' ? '<span class="pill">Pinned</span>' : it.overdue ? '<span class="pill bad">After deadline</span>' : '<span class="pill soft">Planned</span>';
  popover(rect, `
    <div class="pop">
      <div class="pop-tools"><button class="icon-btn x" title="Close">✕</button></div>
      <div class="pop-title"><i style="--c:${task.color}"></i><h3>${esc(sess.label)}</h3></div>
      <div class="pop-row">${badge} ${esc(fmtWhen(it))}</div>
      <div class="pop-row small"><button class="cat-chip on pop-cat" ${task.categoryId ? `style="--c:${esc(task.color)}"` : ''}>${task.categoryId ? `<i></i>${esc(C.catLabel(C.catById(s, task.categoryId)) || task.categoryName || 'Category')}` : '+ Category'} ▾</button></div>
      <div class="pop-row small">Part of <b>${esc(task.title)}</b> · rank ${task.rank} · due ${esc(T.format(task.deadline, z, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: s.h12 }))}</div>
      <div class="pop-row"><div class="bar"><i style="width:${p.pct}%;background:${task.color}"></i></div><div class="muted small">${T.fmtDur(p.done)} of ${T.fmtDur(p.total)} done</div></div>
      ${gameXPLine(it)}
      <div class="pop-row small">${!E.connected(st()) ? '<span class="muted">Only in this browser (Google not connected)</span>' : sess.gid ? '<span class="g-ok">✓ On Google Calendar</span>' : '<span class="g-bad">Not on Google Calendar yet</span> <button class="link sync-now">Sync now</button>'}</div>
      <div class="pop-actions">
        ${isDone ? '<button class="btn small undone">↺ Mark undone</button>' : '<button class="btn small primary done">✓ Mark done</button>'}
        <button class="btn small partial">◐ Partly done…</button>
        ${p.pct < 100 || !isDone ? `<button class="btn small fin-task" title="${task.kind === 'reading' ? 'Count this session up to the last page and remove the sessions not done yet' : 'Count all remaining work as done in this session and remove the sessions not done yet'}">🏁 Task finished here</button>` : ''}
        ${!isDone ? `<button class="btn small ghost tm-start" title="Time this session">▶ Timer</button><button class="btn small ghost tm-pomo" title="Focus timer with breaks (${set().pomodoro?.work || 25}/${set().pomodoro?.rest || 5} min)">🍅 Focus</button>` : ''}
        ${sess.kind === 'pinned' ? '<button class="btn small ghost unpin">Unpin</button>' : ''}
        ${task.kind !== 'reading' && !task.repeat ? '<button class="btn small ghost extend-time">＋ Extend time…</button>' : ''}
        <button class="btn small ghost del">Delete…</button>
        <button class="btn small ghost edit">Edit task</button>
        ${itemActionsHTML(it)}
      </div>
      <div class="muted small hint">Tip: drag a session to pin it to a specific time — the rest of the series shifts around it.</div>
    </div>`, (pop, close) => {
    $('.x', pop).onclick = close;
    const act = async (fn, msg, log) => { close(); replaceTask(fn(st().tasks.find((t) => t.id === task.id))); if (log) logHistory(log); await saveTasks(msg.split(' —')[0].toLowerCase()); toast(msg); cycle(); };
    $('.done', pop)?.addEventListener('click', () => { close(); finishSession(st().tasks.find((t) => t.id === task.id), sess, timer?.chunkId === sess.id ? tmWork() / T.MIN : null); if (timer?.chunkId === sess.id) dropTimer(); });
    $('.undone', pop)?.addEventListener('click', () => act((t) => (sess.kind === 'pinned' ? S.unpinSession(t, sess.id) : S.markUndone(t, sess.id)), 'Marked undone — remaining sessions shifted', { kind: 'undone', task, sess }));
    $('.unpin', pop)?.addEventListener('click', () => act((t) => S.unpinSession(t, sess.id), 'Unpinned'));
    wireItemActions(pop, it, close);
    $('.fin-task', pop)?.addEventListener('click', async () => {
      close();
      const cur = st().tasks.find((t) => t.id === task.id); if (!cur) return;
      const left = S.sessions(cur).filter((c) => c.kind === 'planned' && c.id !== sess.id).length;
      const ok = await choose(`Finish “${task.title}” with this session?`, `${task.kind === 'reading' ? `This session will count up to page ${(+cur.reading?.startPage || 1) + (+cur.reading?.pages || 0) - 1}` : 'All remaining work will count as done in this session'}${left ? `, and the ${left} session${left > 1 ? 's' : ''} not done yet will be removed` : ''}.`, [{ value: 'yes', label: 'Yes, the task is finished' }]);
      if (ok !== 'yes') return;
      if (timer?.chunkId === sess.id) dropTimer();
      replaceTask(S.completeAt(st().tasks.find((t) => t.id === task.id), sess.id));
      await saveTasks('task finished'); toast(`🏁 ${task.title} finished${left ? ` — ${left} remaining session${left > 1 ? 's' : ''} removed` : ''}`, { ms: 6000 }); cycle();
    });
    $('.edit', pop).onclick = () => { close(); editTask(task); };
    $('.extend-time', pop)?.addEventListener('click', async () => {
      close();
      const cur = st().tasks.find((t) => t.id === task.id); if (!cur) return;
      const v = await choose(`Extend "${task.title}"`, `Add more time to this task. Current: ${T.fmtDur(S.totalMinutes(cur))}.`, [
        { value: '30', label: '+ 30 minutes' },
        { value: '60', label: '+ 1 hour' },
        { value: '120', label: '+ 2 hours' },
        { value: 'custom', label: 'Custom…' },
      ]);
      if (!v) return;
      let addMin;
      if (v === 'custom') {
        const h = await choose('How many hours to add?', '', [
          { value: '0.5', label: '30 min' }, { value: '1', label: '1 hour' },
          { value: '2', label: '2 hours' }, { value: '3', label: '3 hours' },
          { value: '4', label: '4 hours' }, { value: '5', label: '5 hours' },
        ]);
        if (!h) return;
        addMin = Math.round(+h * 60);
      } else { addMin = +v; }
      if (!(addMin > 0)) return;
      const t2 = st().tasks.find((t) => t.id === task.id); if (!t2) return;
      replaceTask({ ...t2, totalMinutes: (t2.totalMinutes || 0) + addMin });
      await saveTasks('extend time'); toast(`Added ${T.fmtDur(addMin)} to "${task.title}" — sessions replanned`); cycle();
    });
    $('.partial', pop).onclick = () => { close(); partialSession(task, sess); };
    $('.tm-start', pop)?.addEventListener('click', () => { close(); startTimer(task, sess, 'stopwatch'); });
    $('.tm-pomo', pop)?.addEventListener('click', () => { close(); startTimer(task, sess, 'pomodoro'); });
    $('.sync-now', pop)?.addEventListener('click', () => { close(); openSyncPanel(); });
    $('.pop-cat', pop).onclick = () => { close(); pickCategory(task); };
    $('.del', pop).onclick = async () => {
      close();
      if (isDone) return deleteDoneSession(task, sess);
      const v = await choose('Delete session', `“${sess.label}”`, [
        { value: 'one', label: 'Delete this session', desc: 'Its work moves to the next free time; later sessions in the series shift down.' },
        { value: 'all', label: 'Delete the entire series', desc: `Removes “${task.title}” and all ${sess.count} sessions.`, danger: true },
      ]);
      if (v === 'one') { replaceTask(S.skipSession(st().tasks.find((t) => t.id === task.id), sess.id)); logHistory({ kind: 'skipped', task, sess }); await saveTasks('delete session'); toast('Session deleted — series shifted'); cycle(); }
      if (v === 'all') deleteTask(task.id);
    };
  });
}

// Tasks loaded from Google may use a time period this browser doesn't have yet: add it.
export function adoptPeriodsFromTasks() {
  let changed = false;
  for (const t of st().tasks) {
    if (t.periodId && t.periodRules?.length && !(set().periods || []).some((p) => p.id === t.periodId)) {
      set().periods = [...(set().periods || []), { id: t.periodId, name: t.periodName || 'Period', rules: t.periodRules }];
      changed = true;
    }
  }
  return changed;
}

// A new task has no category: ask once, quickly (Skip keeps it uncategorised; "Don't ask again" turns this off).
export async function askCategoryOnce(task) {
  let picked = null;
  const r = await modal(`<div class="choice ask-cat"><h2>Which category is “${esc(task.title)}”?</h2>
    <p class="muted small">Tap one, or add a new one. Categories color-code tasks and group your time in Analysis.</p>
    <div class="cat-host" style="margin:10px 0 4px"></div>
    <div class="actions"><button type="button" class="btn ghost link never">Don't ask again</button><span class="grow"></span><button type="button" class="btn ghost" data-close>Skip</button></div></div>`, (dlg, close) => {
    C.categoryPicker($('.cat-host', dlg), {
      settings: set(), selected: null, allowNone: false,
      onChange: (c) => { picked = c; close('ok'); },
      onCreate: async (name, color, icon, parent) => { const c = C.newCategory(set(), name, color, icon, parent); await E.persist(st(), ['settings']); return c; },
    });
    $('.never', dlg).onclick = () => close('never');
  }, { cls: 'narrow' });
  if (r === 'never') {
    set().askCategory = false;
    await E.persist(st(), ['settings']);
    toast('Won’t ask again. Turn it back on in Settings → Categories.');
  }
  return r === 'ok' && picked ? C.applyCategory(task, picked) : task;
}

// Quick classify: pick (or create) a category for a task.
async function pickCategory(task) {
  let picked;
  const r = await modal(`<div class="choice"><h2>Category for “${esc(task.title)}”</h2><div class="cat-host" style="margin:10px 0 4px"></div>
    <div class="actions"><button type="button" class="btn ghost" data-close>Close</button></div></div>`, (dlg, close) => {
    C.categoryPicker($('.cat-host', dlg), {
      settings: set(), selected: task.categoryId,
      onChange: (c) => { picked = c; close('ok'); },
      onCreate: async (name, color, icon, parent) => { const c = C.newCategory(set(), name, color, icon, parent); await E.persist(st(), ['settings']); return c; },
    });
  }, { cls: 'narrow' });
  if (r !== 'ok') return;
  const cur = st().tasks.find((t) => t.id === task.id);
  if (!cur) return;
  replaceTask(C.applyCategory(cur, picked));
  await saveTasks('change category');
  toast(picked ? `“${task.title}” is now ${picked.name}` : 'Category removed');
  cycle();
}

// Classify an event (new or old) into a category. Stored on the event in Google; events you can't edit keep
// their category in this browser.
async function pickEventCategory(it) {
  let picked, chosen = false;
  await modal(`<div class="choice"><h2>Category for “${esc(it.title)}”</h2><div class="cat-host" style="margin:10px 0 4px"></div>
    <div class="actions"><button type="button" class="btn ghost" data-close>Close</button></div></div>`, (dlg, close) => {
    C.categoryPicker($('.cat-host', dlg), {
      settings: set(), selected: it.catId,
      onChange: (c) => { picked = c; chosen = true; close(); },
      onCreate: async (name, color, icon, parent) => { const c = C.newCategory(set(), name, color, icon, parent); await E.persist(st(), ['settings']); return c; },
    });
  }, { cls: 'narrow' });
  if (!chosen) return;
  const ev = it.ev;
  const saveLocally = async () => {
    const k = C.eventKey(ev);
    if (picked) st().eventCats[k] = picked.id; else delete st().eventCats[k];
    await E.persist(st(), ['eventCats']);
  };
  try {
    if (!it.editable) {
      await saveLocally();
      toast(picked ? `Marked as ${picked.name} (saved on this device — you can't edit this event in Google)` : 'Category removed', { ms: 6000 });
      return render();
    }
    let scope = 'this';
    if (ev.recurringEventId) { scope = await askScope('Categorize'); if (!scope) return; }
    setStatus('Saving…');
    await EV.updateEvent(st(), ev, C.eventCategoryChanges(ev, picked), scope);
    undoableEventChange('change category', ev, scope);
    await afterEventChange();
    toast(picked ? `“${it.title}” is now ${picked.name}` : 'Category removed');
  } catch (err) {
    if (err instanceof G.PermissionError || /forbidden|permission|403/i.test(err.message)) { await saveLocally(); toast('Saved on this device only (Google didn’t allow changing this event)'); render(); }
    else handleError(err);
  }
}

// Deleting a session that was already done.
// Partly done: credit the work that was done, reschedule the rest, and optionally split the block in two.
export async function partialSession(task, sess, opts = {}) {
  const r = await D.partialDialog(ctx, task, sess, opts);
  if (!r) return;
  const cur0 = st().tasks.find((t) => t.id === task.id);
  if (!cur0) return;
  if (r.allDone) return finishSession(cur0, sess, opts.actualMin);
  let cur = cur0;
  let start = sess.start, end = sess.end, other = null;
  if (r.split) {
    const cut = r.split.where === 'start' ? sess.start + r.split.minutes * T.MIN : sess.end - r.split.minutes * T.MIN;
    if (r.split.where === 'start') { start = cut; other = [sess.start, cut]; } else { end = cut; other = [cut, sess.end]; }
  }
  const spent = opts.actualMin != null ? opts.actualMin : (end - start) / T.MIN;
  let updated = S.markPartial(cur, sess.id, { credit: r.credit, start, end, squeeze: r.squeeze, pagesDone: r.pages, actualMin: opts.actualMin });
  logHistory({ kind: 'partial', task: cur, sess, act: Math.round(spent) });
  let msg = r.pages != null ? `${r.pages} page${r.pages === 1 ? '' : 's'} read` : `${r.pct}% done`;
  if (r.pages != null) { const sp = learnSpeed(updated, r.pages, spent); updated = sp.task; if (sp.msg) msg += ' · ' + sp.msg; }
  replaceTask(updated);
  msg += r.squeeze ? ' — the rest is spread over the remaining sessions' : ' — time added for the rest';
  try {
    if (other && r.split.kind === 'task') {
      const o = st().tasks.find((t) => t.id === r.split.taskId);
      if (o) { replaceTask(S.addDoneBlock(o, other[0], other[1])); msg += ` · ${r.split.minutes} min counted toward “${o.title}”`; }
    } else if (other) {
      const z = tz();
      await EV.createEvent(st(), r.split.calId, { summary: r.split.title, start: { dateTime: new Date(other[0]).toISOString(), timeZone: z }, end: { dateTime: new Date(other[1]).toISOString(), timeZone: z }, reminders: { useDefault: false, overrides: [] } });
      await E.persist(st(), ['localEvents']);
      E.invalidate();
      msg += ` · “${r.split.title}” added`;
    }
  } catch (err) { handleError(err); }
  await saveTasks('partly done');
  toast(msg, { ms: 6000 });
  cycle();
}

// Reading speed learned from reported pages and the time spent.
function learnSpeed(task, pages, minutes) {
  if (task.kind !== 'reading' || task.reading?.format === 'audio' || !(pages > 0) || !(minutes >= 5)) return { task };
  let t = { ...task, speedLog: [...(task.speedLog || []), { pages, minutes: Math.round(minutes), at: Date.now() }].slice(-8) };
  if (set().learnSpeed === false) return { task: t };
  const learned = S.learnedSpeed(t), cur = S.pagesPerHour(t.reading || {});
  if (!learned || Math.abs(learned - cur) / cur < 0.08) return { task: t };
  t = S.withReadingSpeed(t, { ...t.reading, speed: learned, unit: 'pph' });
  set().readingDefaults = { ...(set().readingDefaults || {}), speed: learned };
  E.persist(st(), ['settings']);
  return { task: t, msg: `reading speed now ${learned} pages/hour (was ${+cur.toFixed(1)}) — the plan is adjusted` };
}

// Timer stopped at (or past) the planned time, or "It's all done".
export async function finishSession(task, sess, actualMin) {
  let t = S.markDone(task, sess.id, { actualMin });
  let msg = actualMin != null ? `Recorded ${T.fmtDur(Math.round(actualMin))} — marked done` : 'Marked done';
  if (actualMin != null && actualMin > sess.minutes + 5) logHistory({ kind: 'overrun', task, sess, act: Math.round(actualMin) });
  if (task.kind === 'reading' && actualMin != null && sess.pages) { const sp = learnSpeed(t, sess.pages[1] - sess.pages[0] + 1, actualMin); t = sp.task; if (sp.msg) msg += ' · ' + sp.msg; }
  replaceTask(t);
  await saveTasks('mark done');
  toast(msg, { ms: 6000 });
  cycle();
}
