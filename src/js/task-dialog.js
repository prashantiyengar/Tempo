// The task dialog: create or edit a task or reading task (one block or split into sessions), with live preview.
import * as T from './tz.js';
import * as S from './scheduler.js';
import { $, $$, esc, modal, TASK_COLORS, setHTML, linkRange } from './ui.js';
import * as C from './categories.js';
import * as N from './notify.js';
import { NUDGE_DAY, askTitle, checkCount, checkSpan, deadlinePreset, describeDays, describeRules, nudgesHTML, sect, weekdayToggles, wireSects } from './dialogs.js';

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
      <div class="row blockmode-row"><div class="seg blockmode" role="radiogroup" aria-label="How to schedule the hours">
        <label title="Tempo splits the hours into sessions around your calendar"><input type="radio" name="blockmode" value="split" ${!t.single ? 'checked' : ''}><span>✂ Split into sessions</span></label>
        <label title="All the hours in one uninterrupted block"><input type="radio" name="blockmode" value="single" ${t.single ? 'checked' : ''}><span>▭ One block</span></label>
      </div></div>
      <div class="row catcol">
        <div class="field grow"><span>Category</span><div class="cat-host"></div></div>
        <div class="field color-field"><span>Color</span><div class="swatches small">${TASK_COLORS.map((c) => `<label class="sw"><input type="radio" name="color" value="${c}" ${t.color === c ? 'checked' : ''}><i style="background:${c}"></i></label>`).join('')}</div></div>
      </div>
      ${prog ? `<div class="progress-line"><div class="bar"><i style="width:${prog.pct}%;background:${t.color}"></i></div><span class="muted small">${T.fmtDur(prog.done)} of ${T.fmtDur(prog.total)} done</span></div>` : ''}

      <div class="row only-reading"><div class="seg rformat"><label><input type="radio" name="rformat" value="book" ${r.format !== 'audio' ? 'checked' : ''}><span>📖 Book (pages)</span></label><label><input type="radio" name="rformat" value="audio" ${r.format === 'audio' ? 'checked' : ''}><span>🎧 Audiobook (hours)</span></label></div></div>
      <div class="row only-reading bk-cover-row">
        <span class="cov-box">${(() => { const src = ctx.coverFor?.(t); return src ? `<img class="cov-prev" src="${esc(src)}" alt="" referrerpolicy="no-referrer" data-title="📖">` : '<span class="cov-prev none">📖</span>'; })()}</span>
        <label class="field"><span>ISBN <em class="muted">(finds the cover)</em></span><input name="isbn" value="${esc(r.isbn || '')}" placeholder="e.g. 9780141182803" inputmode="numeric" autocomplete="off"></label>
        <label class="field grow"><span>…or a cover image address</span><input name="cover" value="${esc(r.cover || '')}" placeholder="https://…/cover.jpg" autocomplete="off"></label>
      </div>
      <div class="grid3 only-reading only-audio">
        ${(() => { const len = r.format === 'audio' ? (+r.pages || 0) + Math.max(0, (+r.startPage || 1) - 1) : 480, done = r.format === 'audio' ? Math.max(0, (+r.startPage || 1) - 1) : 0;
          const hm = (n, h, m) => `<div class="join hm"><input type="number" name="${h}" min="0" max="200" step="1" value="${Math.floor(n / 60)}" class="num" aria-label="Hours"><span class="muted">h</span><input type="number" name="${m}" min="0" max="59" step="1" value="${n % 60}" class="num" aria-label="Minutes"><span class="muted">min</span></div>`;
          return `<label class="field"><span>Length of the audiobook</span>${hm(len, 'ah', 'am')}</label><label class="field"><span>Already listened</span>${hm(done, 'adh', 'adm')}</label>`; })()}
        <label class="field"><span>Playback speed</span><select name="aspeed">${[0.8, 1, 1.1, 1.2, 1.25, 1.5, 1.75, 2, 2.5, 3].map((v) => `<option value="${v}" ${(r.format === 'audio' ? +r.speed / 60 : 1) === v ? 'selected' : ''}>×${v}</option>`).join('')}</select></label>
      </div>
      <div class="grid3 only-reading only-book">
        <label class="field"><span>Pages to read</span><input type="number" name="pages" min="1" value="${r.format === 'audio' ? 100 : r.pages}"></label>
        <label class="field"><span>Start page</span><input type="number" name="startPage" min="1" value="${r.format === 'audio' ? 1 : r.startPage}"></label>
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
          <label class="field"><span>Session length (min)</span><input type="number" class="t-sessions-only" name="chunk" min="5" step="5" placeholder="${s.chunkMinutes} (default)" value="${t.chunkMinutes ?? ''}"></label>
          <label class="field"><span>Shortest session (min)</span><input type="number" class="t-sessions-only" name="minChunk" min="5" step="5" placeholder="${s.minChunkMinutes ? s.minChunkMinutes + ' (default)' : '= session length'}" value="${t.minChunkMinutes ?? ''}"></label>
          <label class="field"><span>Max per day (min)</span><input type="number" class="t-sessions-only" name="maxDay" min="5" step="5" placeholder="no limit" value="${t.maxPerDayMinutes ?? ''}"></label>
          <label class="field"><span>Break between (min)</span><input type="number" name="break" min="0" step="5" placeholder="${s.breakMinutes} (default)" value="${t.breakMinutes ?? ''}"></label>
          <label class="field"><span>Wiggle room (min)</span><input type="number" class="t-sessions-only" name="wiggle" min="0" step="5" placeholder="${s.wiggleMinutes ?? 15} (default)" value="${t.wiggleMinutes ?? ''}" title="Also use free slots up to this much shorter than the session length"></label>
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
    // the cover preview follows the ISBN / image address
    const covPrev = () => {
      const box = $('.cov-box', dlg); if (!box) return;
      const src = ctx.coverFor?.({ ...t, reading: { isbn: f.isbn.value.trim(), cover: f.cover.value.trim() } });
      setHTML(box, src ? `<img class="cov-prev" src="${esc(src)}" alt="" referrerpolicy="no-referrer">` : '<span class="cov-prev none">📖</span>');
      const img = $('img', box); if (img) img.onerror = () => setHTML(box, '<span class="cov-prev none" title="No cover found">?</span>');
    };
    let covT = 0;
    for (const n of ['isbn', 'cover']) f[n]?.addEventListener('input', () => { clearTimeout(covT); covT = setTimeout(covPrev, 500); });
    { const img = $('.cov-box img', dlg); if (img) img.onerror = () => setHTML($('.cov-box', dlg), '<span class="cov-prev none">📖</span>'); }
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
    // each −/+ button changes only its own field (From doesn't move the deadline; the deadline is pushed on only
    // when From would otherwise end up less than a day before it)
    const nudgeDT = (inp, add, from) => {
      const v = T.fromDTInput(inp.value, tz) ?? from(); inp.value = T.toDTInput(Math.max(Date.now() - T.DAY * 365, v + add * T.MIN), tz);
      if (inp === f.earliest) { const es = T.fromDTInput(f.earliest.value, tz), dl = T.fromDTInput(f.deadline.value, tz); if (es != null && dl != null && dl < es + T.DAY) f.deadline.value = T.toDTInput(es + T.DAY, tz); }
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    };
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
        // an audiobook is kept as "pages" = minutes of audio still to hear, at (60 × playback speed) per hour
        reading: { ...(f.isbn?.value.trim() ? { isbn: f.isbn.value.trim() } : {}), ...(f.cover?.value.trim() ? { cover: f.cover.value.trim() } : {}), ...(f.rformat?.value === 'audio'
          ? (() => { const len = Math.max(5, (+f.ah.value || 0) * 60 + (+f.am.value || 0)), done = Math.min(len - 1, Math.max(0, (+f.adh.value || 0) * 60 + (+f.adm.value || 0))); return { format: 'audio', pages: len - done, startPage: done + 1, speed: 60 * (+f.aspeed.value || 1), unit: 'pph', labels: 'actual' }; })()
          : { pages: Math.max(1, +f.pages.value || 1), startPage: Math.max(1, +f.startPage.value || 1), speed: Math.max(0.1, +f.speed.value || 1), unit: f.unit.value, labels: f.labels.value }) },
        deadline: T.fromDTInput(f.deadline.value, tz),
        earliestStart: T.fromDTInput(f.earliest.value, tz),
        rank: Math.max(1, Math.round(+f.rank.value || 3)),
        chunkMinutes: num(f.chunk.value), minChunkMinutes: num(f.minChunk.value), maxPerDayMinutes: num(f.maxDay.value), single: f.blockmode.value === 'single' || undefined,
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
      const audio = kind === 'reading' && f.rformat?.value === 'audio';
      $$('.only-audio', dlg).forEach((e) => (e.style.display = audio ? '' : 'none'));
      $$('.only-book', dlg).forEach((e) => (e.style.display = kind === 'reading' && !audio ? '' : 'none'));
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
      const one = !!draft.single;
      $$('.t-sessions-only', dlg).forEach((x) => { x.disabled = one; });
      dlg.classList.toggle('single-block', one);
      $('.calc', dlg).textContent = one ? (draft.repeat ? `One block of ${T.fmtDur(draft.repeat.minutes)} each ${draft.repeat.every}` : `One block of ${T.fmtDur(total)} — not split into sessions`) : kind === 'reading' && draft.reading?.format === 'audio'
        ? `≈ ${T.fmtDur(total)} of listening (${T.fmtDur(draft.reading.pages)} of audio at ×${+(draft.reading.speed / 60).toFixed(2)}) · ≈ ${Math.ceil(total / p.chunk)} sessions of ${p.chunk} min`
        : kind === 'reading'
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
