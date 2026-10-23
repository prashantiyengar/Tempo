// Tempo command interface for AI assistants and automation (no API key needed).
//
// An assistant that can run JavaScript in the page (e.g. Claude in Chrome on the Tempo web app) calls
//   await tempo.help()                       → what's available
//   await tempo.run([{ cmd: 'addTask', title: 'Thesis', hours: 6, deadline: 'friday 17:00' }, …])
// Anyone else can open the AI console (⋯ → AI & automation, or add ?ai=1 to the address), paste the same JSON
// and press Run. Every command returns plain JSON; a batch is one step for Undo.
import * as T from './tz.js';
import * as S from './scheduler.js';
import * as E from './engine.js';
import * as EV from './events.js';
import * as C from './categories.js';
import * as N from './notify.js';
import * as GL from './goals.js';
import { parseTask, resolveDate } from './parse.js';

export function createApi(h) {
  // h = { st, set, tz, cycle, saveTasks, replaceTask, deleteTask, buildDraft, collectItems, freeSlots,
  //       undo, pushUndo, undoStack, finishedEarlyApi, fillGap, afterEventChange, A, toast }
  const tz = () => h.tz();
  const fmt = (ms) => (ms == null ? null : T.toDTInput(ms, tz()).replace('T', ' '));
  const err = (msg) => { const e = new Error(msg); e.api = true; throw e; };

  // ---- time input: ISO, "YYYY-MM-DD HH:MM" (local), "now", "today 14:00", "tomorrow", "friday 17:00", "in 2 days" …
  function when(v, { defaultTime = null, end = false } = {}) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v;
    const s = String(v).trim();
    if (/^now$/i.test(s)) return Date.now();
    if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/.test(s)) return Date.parse(s);
    let m = s.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/);
    if (m) return T.atTime(m[1], m[2] ? `${m[2].padStart(2, '0')}:${m[3]}` : (defaultTime || (end ? h.set().bounds.end : '00:00')), tz());
    m = s.match(/^(.*?)(?:\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/i);
    const key = m && resolveDate(m[1], h.set());
    if (key) {
      let hh = m[2] != null ? +m[2] : null;
      if (hh != null && m[4]?.toLowerCase() === 'pm' && hh < 12) hh += 12;
      if (hh != null && m[4]?.toLowerCase() === 'am' && hh === 12) hh = 0;
      return T.atTime(key, hh != null ? `${String(hh).padStart(2, '0')}:${m[3] || '00'}` : (defaultTime || (end ? h.set().bounds.end : h.set().bounds.start)), tz());
    }
    err(`Can't read the time "${s}". Use "YYYY-MM-DD HH:MM", an ISO time, "now", "today 14:00", "tomorrow 9am" or "friday 17:00".`);
  }
  const parseDay = (v) => { const ms = when(v, { defaultTime: '12:00' }); return ms == null ? null : T.dayKey(ms, tz()); };
  const range = (a) => {
    const from = when(a.from) ?? T.dayStart(T.dayKey(Date.now(), tz()), tz());
    const to = when(a.to, { end: true }) ?? from + 7 * T.DAY;
    return { from, to };
  };

  // ---- lookups
  const tasks = () => h.st().tasks.filter((t) => !t.archived);
  function findTask(ref) {
    if (!ref) err('Missing "task" (an id or the task title).');
    const list = tasks();
    const r = String(ref).toLowerCase();
    const hit = list.find((t) => t.id === ref) || list.find((t) => t.title.toLowerCase() === r);
    if (hit) return hit;
    const pre = list.filter((t) => t.title.toLowerCase().startsWith(r) || t.title.toLowerCase().includes(r));
    if (pre.length === 1) return pre[0];
    err(pre.length ? `"${ref}" matches several tasks: ${pre.map((t) => t.title).join(', ')} — use the id.` : `No task "${ref}". Tasks: ${list.map((t) => t.title).join(', ') || 'none'}.`);
  }
  function findSession(ref, taskRef, index) {
    if (taskRef && index != null) {
      const t = findTask(taskRef);
      const s = S.sessions(t).find((x) => x.index === +index);
      if (!s) err(`"${t.title}" has no session ${index}.`);
      return { task: t, sess: s };
    }
    for (const t of tasks()) { const s = S.sessions(t).find((x) => x.id === ref); if (s) return { task: t, sess: s }; }
    err(`No session "${ref}". Get ids from listSessions.`);
  }
  const catByName = (name) => {
    if (!name) return null;
    const n = String(name).toLowerCase();
    return (h.set().categories || []).find((c) => c.id === name || c.name.toLowerCase() === n) || err(`No category "${name}". Categories: ${(h.set().categories || []).map((c) => c.name).join(', ')}.`);
  };
  const calByName = (name) => {
    if (!name) return null;
    const n = String(name).toLowerCase();
    const cals = (h.st().gmeta.calendars || []);
    return (cals.find((c) => c.id === name || (c.summaryOverride || c.summary || '').toLowerCase() === n) || (n === 'local' ? { id: E.LOCAL_CAL } : null))?.id || err(`No calendar "${name}".`);
  };

  // ---- output shapes
  const taskOut = (t) => {
    const p = S.progress(t);
    const ss = S.sessions(t);
    return {
      id: t.id, title: t.title, kind: t.repeat ? 'repeating' : t.kind, rank: t.rank,
      category: C.catById(h.set(), t.categoryId)?.name || null, deadline: t.repeat ? null : fmt(t.deadline),
      hours: t.kind === 'reading' || t.repeat ? null : +(S.totalMinutes(t) / 60).toFixed(2), reading: t.kind === 'reading' ? { ...t.reading } : undefined,
      repeat: t.repeat ? { every: t.repeat.every, hours: +(t.repeat.minutes / 60).toFixed(2), until: fmt(S.repeatEnd(t, h.set()) - 1) } : undefined,
      progress: `${Math.round(p.done)} of ${p.total} min (${p.pct}%)`, sessions: ss.length, next: fmt(ss.find((c) => c.kind !== 'done' && c.end > Date.now())?.start),
      warning: t.lastPlan?.shortfall > 0 ? `not enough time before the deadline (${Math.round(t.lastPlan.shortfall)} min short)` : t.lastPlan?.late > 0 ? 'runs into its safety margin' : null,
      project: t.projectName || null, after: (t.after || []).map((id) => h.st().tasks.find((x) => x.id === id)?.title).filter(Boolean),
    };
  };
  const sessOut = (t, c) => ({ id: c.id, task: t.title, taskId: t.id, index: c.index, of: c.count, label: c.label, start: fmt(c.start), end: fmt(c.end), minutes: c.minutes, status: c.partial ? 'partly done' : c.kind });
  const evOut = (it) => ({ id: it.key, title: it.title, start: it.allDay ? it.startKey : fmt(it.start), end: it.allDay ? T.addDays(it.endKey, -1) : fmt(it.end), allDay: !!it.allDay,
    calendar: it.ev?._calName || (h.st().gmeta.calendars || []).find((c) => c.id === it.ev?._calId)?.summary || (it.ev?._calId === E.LOCAL_CAL ? 'Local' : it.ev?._calId),
    location: it.ev?.location || undefined, editable: !!it.editable, repeating: !!it.ev?.recurringEventId, category: C.catById(h.set(), it.catId)?.name || undefined, done: it.evDone || undefined });

  async function eventItems(from, to) {
    const days = [];
    for (let k = T.dayKey(from, tz()); T.dayStart(k, tz()) < to; k = T.addDays(k, 1)) days.push(k);
    return (await h.collectItems(days)).filter((it) => it.kind === 'event' && it.end > from && it.start < to);
  }
  function goalKey(p) {
    const z = h.tz(), today = T.dayKey(Date.now(), z), v = String(p || '').toLowerCase().trim();
    const wk = T.startOfWeek(today, h.set().weekStart ?? 1);
    if (/this week/.test(v)) return GL.weekKey(wk);
    if (/next week/.test(v)) return GL.weekKey(T.addDays(wk, 7));
    if (/year|12 months/.test(v)) return GL.YEAR;
    if (/this month/.test(v)) return GL.monthKey(today);
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const mi = months.findIndex((m) => v.startsWith(m));
    if (mi >= 0) { const { y, m } = T.parseKey(today); const yy = mi + 1 <= m ? y + 1 : y; return GL.monthKey(T.keyOf(yy, mi + 1, 1)); }
    if (/^\d{4}-\d{2}/.test(v)) return GL.monthKey(v);
    return err('Unknown "period". Use "this week", "next week", "this month", a month name, or "year".');
  }
  function profileByName(n) {
    return N.profiles(h.set()).find((p) => p.id === n || p.name.toLowerCase() === String(n).toLowerCase()) || err(`No notification profile "${n}". Profiles: ${N.profiles(h.set()).map((p) => p.name).join(', ')}.`);
  }
  async function findEvent(ref) {
    if (!ref) err('Missing "event" (an id from listEvents).');
    const items = await eventItems(Date.now() - 60 * T.DAY, Date.now() + 120 * T.DAY);
    const hit = items.find((it) => it.key === ref) || items.filter((it) => (it.title || '').toLowerCase() === String(ref).toLowerCase()).sort((a, b) => Math.abs(a.start - Date.now()) - Math.abs(b.start - Date.now()))[0];
    return hit || err(`No event "${ref}". Get ids from listEvents.`);
  }

  // ---- task spec → task
  function taskFromSpec(a) {
    let draft;
    if (a.text) draft = parseTask(a.text, h.set(), h.st().tasks).draft;
    else {
      draft = { title: a.title || err('Missing "title" (or give "text" in plain language).') };
      if (a.pages != null || a.reading) {
        draft.kind = 'reading';
        draft.reading = { pages: +(a.pages ?? a.reading?.pages ?? 100), startPage: +(a.startPage ?? a.reading?.startPage ?? 1), speed: +(a.pagesPerHour ?? a.reading?.speed ?? (h.set().readingDefaults?.speed || 15)), unit: 'pph', labels: 'actual' };
      } else draft.kind = 'generic';
      if (a.hours != null || a.minutes != null) draft.totalMinutes = Math.round((+a.hours || 0) * 60 + (+a.minutes || 0));
      if (a.repeat) {
        const every = a.repeat.every === 'day' || a.repeat.every === 'daily' ? 'day' : 'week';
        draft.repeat = { every, minutes: Math.round((+a.repeat.hours || 0) * 60 + (+a.repeat.minutes || 0)) || (every === 'week' ? 180 : 30) };
        if (a.repeat.days) draft.repeat.days = a.repeat.days.map((d) => (typeof d === 'number' ? d : ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(String(d).slice(0, 3).toLowerCase())));
        if (a.repeat.until) draft.repeat.until = when(a.repeat.until, { defaultTime: '23:59' });
        else draft.repeat.count = +(a.repeat.count || a.repeat.weeks || a.repeat.days_count || 12);
        draft.repeatStart = when(a.start) || Date.now();
      }
    }
    if (a.deadline) draft.deadline = when(a.deadline, { end: true });
    if (a.notBefore || a.earliestStart) draft.earliestStart = when(a.notBefore || a.earliestStart);
    if (a.rank) draft.rank = +a.rank;
    if (a.category) draft.categoryId = catByName(a.category).id;
    if (a.marginDays != null) draft.marginDays = +a.marginDays;
    if (a.sessionMinutes) draft.chunkMinutes = +a.sessionMinutes;
    if (a.maxPerDayMinutes) draft.maxPerDayMinutes = +a.maxPerDayMinutes;
    if (a.after) draft.after = [].concat(a.after).map((x) => findTask(x).id);
    if (a.period) { const p = (h.set().periods || []).find((x) => x.name.toLowerCase() === String(a.period).toLowerCase() || x.id === a.period) || err(`No time period "${a.period}".`); Object.assign(draft, { periodId: p.id, periodName: p.name, periodRules: p.rules }); }
    if (a.ignoreBounds) draft.ignoreBounds = true;
    if (a.notes) draft.notes = a.notes;
    if (a.notify) draft.notifyProfile = /^(none|off|no)$/i.test(a.notify) ? 'none' : profileByName(a.notify).id;
    if (a.project) {
      let p = (h.set().projects || []).find((x) => x.name.toLowerCase() === String(a.project).toLowerCase() || x.id === a.project);
      if (!p) { p = { id: S.newId('p'), name: String(a.project), sequential: a.projectInOrder !== false }; h.set().projects = [...(h.set().projects || []), p]; }
      draft.projectId = p.id; draft.projectName = p.name;
      draft.projectStep = Math.max(0, ...h.st().tasks.filter((t) => t.projectId === p.id).map((t) => t.projectStep || 0)) + 1;
    }
    return h.buildDraft(draft);
  }
  const EDITABLE = ['title', 'rank', 'notes', 'marginDays', 'ignoreBounds', 'chunkMinutes', 'maxPerDayMinutes'];
  function applyTaskChanges(t, a) {
    let n = { ...t };
    for (const k of EDITABLE) if (a[k] !== undefined) n[k] = a[k];
    if (a.sessionMinutes) n.chunkMinutes = +a.sessionMinutes;
    if (a.deadline) n.deadline = when(a.deadline, { end: true });
    if (a.notBefore !== undefined) n.earliestStart = a.notBefore ? when(a.notBefore) : null;
    if (a.hours != null && t.kind !== 'reading' && !t.repeat) n.totalMinutes = Math.round(+a.hours * 60);
    if (a.pages != null && t.kind === 'reading') n.reading = { ...n.reading, pages: +a.pages };
    if (a.pagesPerHour != null && t.kind === 'reading') n = S.withReadingSpeed(n, { ...n.reading, speed: +a.pagesPerHour, unit: 'pph' });
    if (a.category !== undefined) n = C.applyCategory(n, a.category ? catByName(a.category) : null);
    if (a.after !== undefined) n.after = [].concat(a.after || []).map((x) => findTask(x).id);
    if (a.repeat && t.repeat) { n.repeat = { ...t.repeat, ...(a.repeat.hours != null ? { minutes: Math.round(+a.repeat.hours * 60) } : {}), ...(a.repeat.until ? { until: when(a.repeat.until, { defaultTime: '23:59' }), count: undefined } : {}) }; n.deadline = S.repeatEnd(n, h.set()); }
    return n;
  }
  function eventBody(a, base = {}) {
    const z = tz(), body = {};
    if (a.title !== undefined) body.summary = a.title;
    if (a.location !== undefined) body.location = a.location;
    if (a.description !== undefined) body.description = a.description;
    if (a.allDay) {
      const s = T.dayKey(when(a.start ?? a.date) ?? base.start, z);
      const e = a.end ? T.dayKey(when(a.end), z) : s;
      body.start = { date: s }; body.end = { date: T.addDays(e, 1) };
    } else if (a.start !== undefined || a.end !== undefined || a.minutes) {
      const s = a.start !== undefined ? when(a.start) : base.start;
      let e = a.end !== undefined ? when(a.end) : (a.minutes ? s + +a.minutes * T.MIN : (base.end != null ? base.end + (s - base.start) : s + (h.set().defaultEventMinutes || 60) * T.MIN));
      if (a.minutes && a.end === undefined) e = s + +a.minutes * T.MIN;
      if (!(e > s)) err('The end must be after the start.');
      body.start = { dateTime: new Date(s).toISOString(), timeZone: z }; body.end = { dateTime: new Date(e).toISOString(), timeZone: z };
    }
    if (a.category) Object.assign(body, C.eventCategoryChanges({}, catByName(a.category)));
    return body;
  }

  // ---- commands
  const commands = {
    help: { about: 'This list.', run: () => helpText() },
    today: { about: 'Current time, time zone, work hours and what is going on now.', run: async () => {
      const now = Date.now(), k = T.dayKey(now, tz());
      const items = (await h.collectItems([k])).filter((it) => !it.allDay);
      return { now: fmt(now), timeZone: tz(), workHours: h.set().bounds, runningNow: items.filter((it) => it.start <= now && it.end > now).map((it) => it.title),
        next: items.filter((it) => it.start > now).sort((a, b) => a.start - b.start).slice(0, 5).map((it) => ({ title: it.title, start: fmt(it.start), end: fmt(it.end) })) };
    } },
    listTasks: { about: 'All tasks with progress, deadline, next session and warnings.', run: () => tasks().map(taskOut) },
    listSessions: { params: 'from?, to? (default: next 7 days), task?', about: 'Task sessions in a time range.', run: (a) => {
      const { from, to } = range(a);
      const list = a.task ? [findTask(a.task)] : tasks();
      return list.flatMap((t) => S.sessions(t).filter((c) => c.end > from && c.start < to).map((c) => sessOut(t, c))).sort((x, y) => x.start.localeCompare(y.start));
    } },
    listEvents: { params: 'from?, to? (default: next 7 days)', about: 'Calendar events (all visible calendars, incl. other accounts).', run: async (a) => {
      const { from, to } = range(a);
      return (await eventItems(from, to)).sort((x, y) => x.start - y.start).map(evOut);
    } },
    freeTime: { params: 'from?, to?, minMinutes? (15), within? ("work hours" | "any")', about: 'Free slots, after events, task sessions and travel buffers.', run: async (a) => {
      const { from, to } = range(a);
      return (await h.freeSlots(from, to, +(a.minMinutes || 15), a.within || 'work hours')).map((s) => ({ start: fmt(s.start), end: fmt(s.end), minutes: Math.round((s.end - s.start) / T.MIN) }));
    } },
    listCalendars: { about: 'Calendars you can add events to.', run: () => (h.st().gmeta.calendars || []).filter((c) => ['owner', 'writer'].includes(c.accessRole)).map((c) => ({ id: c.id, name: c.summary, primary: !!c.primary })) },
    listGoals: { about: 'Ranked goals: this week, next week, this month, the next months, and the next 12 months.', run: () => {
      const z = h.tz(), sec = GL.sections(h.set(), T.dayKey(Date.now(), z)).list;
      return sec.map((x) => ({ period: x.title || T.format(T.dayStart(x.month, z), z, { month: 'long', year: 'numeric' }), goals: GL.list(h.set(), x.key).map((g, i) => ({ rank: i + 1, head: GL.headOf(g), text: g.text, done: !!g.done, budgetMinutes: g.budget || undefined, tracks: g.words?.length ? g.words : undefined })) }));
    } },
    addGoal: { params: 'period ("this week" | "next week" | "this month" | a month name like "November" | "year"), text, head? ("work" | "fitness" | "personal"), hours? (time budget), repeat? (true: every week / month), track? (text to look for in event and task titles, e.g. "Moby Dick"; several separated by commas)', about: 'Add a goal (ranked last under its head).', write: true, run: async (a) => {
      const key = goalKey(a.period); const text = String(a.text || '').trim() || err('Missing "text".');
      const head = GL.HEADS.some(([x]) => x === String(a.head || '').toLowerCase()) ? String(a.head).toLowerCase() : 'personal';
      if (a.repeat && (key.startsWith('w:') || key.startsWith('m:'))) {
        h.set().goalRepeats = GL.addRepeat(h.set(), key.startsWith('w:') ? 'week' : 'month', key, { text, head, budget: +a.hours > 0 ? +a.hours * 60 : null, words: GL.parseWords(a.track) });
        h.set().goals = GL.materialize(h.set(), [key]) || h.set().goals;
      } else h.set().goals = GL.add(h.set(), key, text, { head, budget: +a.hours > 0 ? +a.hours * 60 : null, words: GL.parseWords(a.track) }); await E.persist(h.st(), ['settings']); h.render?.(); return { added: text, to: a.period };
    } },
    markGoal: { params: 'period, goal (text or rank), done? (default true)', about: 'Tick a goal off as reached (or reopen it).', write: true, run: async (a) => {
      const key = goalKey(a.period), l = GL.list(h.set(), key);
      const g = (/^\d+$/.test(String(a.goal)) ? l[+a.goal - 1] : l.find((x) => x.text.toLowerCase().includes(String(a.goal || '').toLowerCase()))) || err(`No goal "${a.goal}".`);
      h.set().goals = GL.update(h.set(), key, g.id, { done: a.done !== false }); await E.persist(h.st(), ['settings']); h.render?.(); return { goal: g.text, done: a.done !== false };
    } },
    listLater: { about: 'Notes in the "Later" list: things to schedule, but not yet.', run: () => (h.set().later || []).map((x) => ({ id: x.id, text: x.text, added: fmt(x.created), minutes: x.minutes || undefined, deadline: x.deadline ? fmt(x.deadline) : undefined })) },
    addLater: { params: 'text, hours? (likely duration), deadline? (date)', about: 'Add a note to the "Later" list.', write: true, run: async (a) => {
      const text = String(a.text || '').trim().slice(0, 300) || err('Missing "text".');
      const item = { id: S.newId('l'), text, created: Date.now(), ...(+a.hours > 0 ? { minutes: Math.round(+a.hours * 60) } : {}), ...(a.deadline ? { deadline: when(a.deadline, { end: true }) } : {}) };
      h.set().later = [...(h.set().later || []), item]; await E.persist(h.st(), ['settings']); h.render?.(); return { added: text, id: item.id };
    } },
    removeLater: { params: 'note (id or text)', about: 'Remove a note from the "Later" list (e.g. after scheduling it).', write: true, run: async (a) => {
      const list = h.set().later || [];
      const x = list.find((n) => n.id === a.note) || list.find((n) => n.text.toLowerCase() === String(a.note || '').toLowerCase()) || err(`No note "${a.note}".`);
      h.set().later = list.filter((n) => n !== x); await E.persist(h.st(), ['settings']); h.render?.(); return { removed: x.text };
    } },
    listProfiles: { about: 'Notification profiles (name and reminders) and which ones new events and task sessions use.', run: () => ({ profiles: N.profiles(h.set()).map((p) => ({ name: p.name, reminders: N.describeProfile(p) })), events: N.eventDefault(h.set())?.name, taskSessions: N.taskDefault(h.set())?.name }) },
    listCategories: { about: 'Categories (name, icon, preferred time of day).', run: () => (h.set().categories || []).map((c) => ({ name: c.name, icon: c.icon || '', prefer: c.prefer || null })) },
    addTask: { params: 'title, hours | pages (+ startPage, pagesPerHour) | repeat {every: "week"|"day", hours, until | weeks, days?}, deadline, rank?, category?, notify? (notification profile name, or "none"), notBefore?, marginDays?, after?, project?, period?, sessionMinutes? — or text: "Read Dune 200 pages by Friday, Study"', about: 'Create a task; Tempo splits it into sessions.', write: true, run: async (a) => {
      const t = taskFromSpec(a);
      h.st().tasks.push({ ...t, rev: Date.now() });
      await h.saveTasks(`AI: add “${t.title}”`);
      await h.cycle();
      return taskOut(h.st().tasks.find((x) => x.id === t.id));
    } },
    updateTask: { params: 'task, then any of: title, rank, deadline, hours, pages, pagesPerHour, category, notBefore, marginDays, after, notes, sessionMinutes, repeat {hours, until}', about: 'Change a task (it is re-planned).', write: true, run: async (a) => {
      const t = findTask(a.task);
      h.replaceTask(applyTaskChanges(t, a));
      await h.saveTasks(`AI: edit “${t.title}”`);
      await h.cycle();
      return taskOut(h.st().tasks.find((x) => x.id === t.id));
    } },
    deleteTask: { params: 'task', about: 'Delete a task and all its sessions.', write: true, run: async (a) => { const t = findTask(a.task); await h.deleteTask(t.id); return { deleted: t.title }; } },
    markDone: { params: 'session (id) | task + index', about: 'Mark a session done.', write: true, run: async (a) => {
      const { task, sess } = findSession(a.session, a.task, a.index);
      h.replaceTask(S.markDone(task, sess.id)); await h.saveTasks('AI: mark done'); await h.cycle(); return { done: sess.label };
    } },
    setLeave: { params: 'from (date), to? (date, default = from), kind ("vacation" | "sick" | "none" to clear), reschedule? ("all" default: move task sessions and events off those days | "tasks" | "keep")', about: 'Mark days as on leave or sick leave (task sessions avoid them), or clear them.', write: true, run: async (a) => {
      const from = parseDay(a.from), to = a.to ? parseDay(a.to) : from;
      if (!from || !to) throw new Error('Give from (and to) as dates, e.g. "2026-11-02"');
      const keys = []; for (let k = from <= to ? from : to; k <= (from <= to ? to : from) && keys.length < 400; k = T.addDays(k, 1)) keys.push(k);
      const kind = a.kind === 'none' || a.kind === null ? null : a.kind === 'sick' ? 'sick' : 'vacation';
      await h.setLeave(keys, kind, { ask: false, mode: kind ? (a.reschedule || 'all') : null });
      return { days: keys, kind: kind || 'none' };
    } },
    listLeave: { about: 'Days marked as on leave or sick leave.', run: () => Object.entries(h.set().leave || {}).filter(([, v]) => S.LEAVE_KINDS[v]).sort().map(([day, kind]) => ({ day, kind })) },
    finishTask: { params: 'session (id) | task + index', about: 'Declare the whole task finished in this session: it counts all remaining work (reading: up to the last page) and the sessions still to come are removed.', write: true, run: async (a) => {
      const { task, sess } = findSession(a.session, a.task, a.index);
      h.replaceTask(S.completeAt(task, sess.id)); await h.saveTasks('AI: task finished'); await h.cycle(); return { finished: task.title, at: sess.label };
    } },
    markUndone: { params: 'session | task + index', about: 'Mark a done session undone (its work is re-planned).', write: true, run: async (a) => {
      const { task, sess } = findSession(a.session, a.task, a.index);
      h.replaceTask(sess.kind === 'pinned' ? S.unpinSession(task, sess.id) : S.markUndone(task, sess.id)); await h.saveTasks('AI: mark undone'); await h.cycle(); return { undone: sess.label };
    } },
    markEventDone: { params: 'event (id or title), done? (default true; false = undone)', about: 'Tick an ordinary calendar event off as done, or mark it undone again.', write: true, run: async (a) => {
      const it = await findEvent(a.event); const done = a.done !== false && a.done !== 'false';
      await h.setEventDone(it, done, { quiet: true }); return { [done ? 'done' : 'undone']: it.title };
    } },
    startedLate: { params: 'session? (default: the one running now) | task + index, at ("14:25" or a date-time), reallocate? (default true: plan the missed time again later; false: drop it)', about: 'You started a session late: it then runs from "at" to its planned end.', write: true, run: async (a) => {
      let task, sess;
      if (a.session || a.task) ({ task, sess } = findSession(a.session, a.task, a.index));
      else {
        const now = Date.now();
        const run = h.st().tasks.filter((t) => !t.archived).flatMap((t) => S.sessions(t).filter((c) => c.start < now && c.end > now).map((c) => ({ task: t, sess: c })));
        if (run.length !== 1) err(run.length ? 'Several sessions are running — give "session".' : 'No task session is running right now.');
        ({ task, sess } = run[0]);
      }
      let at = /^\d{1,2}:\d{2}$/.test(String(a.at || '')) ? T.atTime(T.dayKey(sess.start, h.tz()), String(a.at).padStart(5, '0'), h.tz()) : a.at ? when(a.at) : Math.floor(Date.now() / T.MIN) * T.MIN;
      if (!(at > sess.start && at < sess.end - T.MIN)) err(`"at" must be between ${fmt(sess.start)} and ${fmt(sess.end)}.`);
      const re = a.reallocate !== false && a.reallocate !== 'false';
      h.replaceTask(S.startedLate(task, sess.id, at, { reallocate: re })); await h.saveTasks('AI: started late'); await h.cycle();
      return { session: sess.label, now: `${fmt(at)} – ${fmt(sess.end)}`, missedMinutes: Math.round((at - sess.start) / T.MIN), replanned: re };
    } },
    markPartial: { params: 'session | task + index, pages (reading) | percent, rest? ("add time" | "fit in")', about: 'Record a partly done session; the rest is re-planned.', write: true, run: async (a) => {
      const { task, sess } = findSession(a.session, a.task, a.index);
      const credit = task.kind === 'reading' ? S.minutesForPages(task, +(a.pages ?? err('Give "pages" for a reading session.'))) : (Math.max(0, Math.min(100, +(a.percent ?? err('Give "percent".')))) / 100) * sess.work;
      h.replaceTask(S.markPartial(task, sess.id, { credit, squeeze: /fit/i.test(a.rest || ''), pagesDone: task.kind === 'reading' ? +a.pages : null }));
      await h.saveTasks('AI: partly done'); await h.cycle(); return { partlyDone: sess.label };
    } },
    skipSession: { params: 'session | task + index', about: 'Delete one session; its work moves to later free time.', write: true, run: async (a) => {
      const { task, sess } = findSession(a.session, a.task, a.index);
      h.replaceTask(S.skipSession(task, sess.id)); await h.saveTasks('AI: skip session'); await h.cycle(); return { skipped: sess.label };
    } },
    moveSession: { params: 'session | task + index, start, end? (keeps the length)', about: 'Pin a session to a time; the rest of the task flows around it.', write: true, run: async (a) => {
      const { task, sess } = findSession(a.session, a.task, a.index);
      const s = when(a.start), e = a.end ? when(a.end) : s + (sess.end - sess.start);
      h.replaceTask(S.pinSession(task, sess.id, s, e)); await h.saveTasks('AI: move session'); await h.cycle(); return { moved: sess.label, start: fmt(s), end: fmt(e) };
    } },
    addEvent: { params: 'title, start, end | minutes, allDay?, calendar?, location?, description?, category?, notify? (notification profile name, e.g. "Important")', about: 'Create a calendar event (default calendar: the one for task sessions).', write: true, run: async (a) => {
      const calId = a.calendar ? calByName(a.calendar) : h.defaultCalendar();
      const prof = a.notify ? profileByName(a.notify) : N.eventDefault(h.set());
      const body = { reminders: { useDefault: false, overrides: N.overrides(prof?.rules, { google: calId !== E.LOCAL_CAL }) }, ...eventBody({ ...a, title: a.title ?? err('Missing "title".') }) };
      body.extendedProperties = { ...(body.extendedProperties || {}), private: { ...(body.extendedProperties?.private || {}), tempoNotify: prof?.id || '' } };
      if (!body.start) err('Give "start" (and "end" or "minutes").');
      const ev = await EV.createEvent(h.st(), calId, body);
      h.pushUndo(`AI: create “${a.title}”`, async () => { await EV.deleteEvent(h.st(), ev, 'this'); await h.afterEventChange(); });
      await h.afterEventChange();
      return { created: a.title, id: `${calId}|${ev.id}`, start: fmt(Date.parse(body.start.dateTime || body.start.date)) };
    } },
    updateEvent: { params: 'event (id or title), then any of: title, start, end, minutes, location, description, category', about: 'Change one event (a single occurrence if it repeats).', write: true, run: async (a) => {
      const it = await findEvent(a.event);
      if (!it.editable) err(`“${it.title}” can't be edited from here.`);
      const before = JSON.parse(JSON.stringify({ summary: it.ev.summary, start: it.ev.start, end: it.ev.end, location: it.ev.location, description: it.ev.description, colorId: it.ev.colorId, extendedProperties: it.ev.extendedProperties }));
      await EV.updateEvent(h.st(), it.ev, eventBody(a, { start: it.start, end: it.end }), 'this');
      h.pushUndo(`AI: edit “${it.title}”`, async () => { await EV.updateEvent(h.st(), it.ev, before, 'this'); await h.afterEventChange(); });
      await h.afterEventChange();
      return { updated: it.title };
    } },
    deleteEvent: { params: 'event (id or title)', about: 'Delete one event (a single occurrence if it repeats).', write: true, run: async (a) => {
      const it = await findEvent(a.event);
      if (!it.editable) err(`“${it.title}” can't be deleted from here.`);
      await EV.deleteEvent(h.st(), it.ev, 'this');
      if (!it.ev.recurringEventId) { const copy = JSON.parse(JSON.stringify(it.ev)); h.pushUndo(`AI: delete “${it.title}”`, async () => { await EV.createEvent(h.st(), copy._calId, copy); await h.afterEventChange(); }); }
      await h.afterEventChange();
      return { deleted: it.title };
    } },
    finishEarly: { params: 'item? (event id/title or session id; default: whatever is running now), then: "move tasks up" | "keep free" | "nothing"', about: 'End what is running now at the current time.', write: true, run: (a) => h.finishedEarlyApi(a) },
    replan: { about: 'Re-plan all tasks now.', write: true, run: async () => { await h.cycle(); return { ok: true }; } },
    setSettings: { params: 'workHours {start, end, days}, dailyCapMinutes, marginDays, breakMinutes, sessionMinutes, travelMinutes, gapMinutes (since last / till next buffer, 0–15), tillNextMinutes (till next only), eventProfile, taskProfile (notification profile names)', about: 'Change common settings.', write: true, run: async (a) => {
      const s = h.set();
      if (a.workHours) s.bounds = { ...s.bounds, ...a.workHours };
      if (a.gapMinutes != null || a.sinceLastBuffer != null) s.sinceLastBuffer = Math.max(0, Math.min(15, Math.round(+(a.gapMinutes ?? a.sinceLastBuffer) || 0)));
      if (a.tillNextMinutes != null || a.gapMinutes != null) s.tillNextBuffer = Math.max(0, Math.min(15, Math.round(+(a.tillNextMinutes ?? a.gapMinutes) || 0)));
      if (a.eventProfile) s.eventProfile = profileByName(a.eventProfile).id;
      if (a.taskProfile) s.taskProfile = profileByName(a.taskProfile).id;
      for (const [k, sk] of [['dailyCapMinutes', 'dailyCapMinutes'], ['marginDays', 'marginDays'], ['breakMinutes', 'breakMinutes'], ['sessionMinutes', 'chunkMinutes'], ['travelMinutes', 'travelMinutes']]) if (a[k] != null) s[sk] = +a[k];
      await E.persist(h.st(), ['settings']); await h.cycle();
      return { workHours: s.bounds, dailyCapMinutes: s.dailyCapMinutes, marginDays: s.marginDays, breakMinutes: s.breakMinutes, sessionMinutes: s.chunkMinutes, travelMinutes: s.travelMinutes };
    } },
    undo: { about: 'Undo the last change (a whole batch counts as one).', write: true, run: async () => { await h.undo(); return { ok: true }; } },
  };

  function helpText() {
    return {
      about: 'Tempo: calendar + auto-scheduler. Tasks are split into sessions and placed in free time by rank and deadline; events come from Google Calendar (and other connected calendars).',
      howTo: 'Call tempo.run(command) or tempo.run([commands]) — each command is { cmd: "<name>", ...params }. A list runs in order as ONE undo step. Add { dryRun: true } as the second argument to preview task changes without saving. Results are JSON; errors come back as { error } with a hint.',
      times: `Times are local (${tz()}): "YYYY-MM-DD HH:MM", ISO, "now", "today 14:00", "tomorrow 9am", "friday 17:00", "in 3 days". A date alone means the start of work hours (end of work hours for deadlines).`,
      refs: 'Tasks by id or title; sessions by id (from listSessions) or { task, index }; events by id (from listEvents) or title (nearest match).',
      commands: Object.entries(commands).map(([name, c]) => ({ cmd: name, params: c.params || '', about: c.about, changes: !!c.write })),
      examples: [
        { cmd: 'addTask', title: 'Thesis chapter 2', hours: 8, deadline: 'friday 17:00', rank: 1, category: 'Study' },
        { cmd: 'addTask', text: 'Exercise 3h per week for 8 weeks, Personal' },
        { cmd: 'addEvent', title: 'Dentist', start: 'tomorrow 14:00', minutes: 45 },
        { cmd: 'moveSession', task: 'Thesis chapter 2', index: 1, start: 'today 16:00' },
        { cmd: 'updateTask', task: 'Report', rank: 4, deadline: '2026-11-06 12:00' },
        { cmd: 'freeTime', from: 'today', to: 'friday', minMinutes: 60 },
      ],
    };
  }

  // Run one command, or a list as a single undo step. { dryRun } previews task-level changes only.
  async function run(input, { dryRun = false, label = null } = {}) {
    const list = Array.isArray(input) ? input : [input];
    if (dryRun) return preview(list);
    const mark = h.undoStack.length;
    const out = [];
    let changed = 0;
    for (const c of list) {
      const name = typeof c === 'string' ? c : c?.cmd;
      const def = commands[name];
      if (!def) { out.push({ cmd: name, error: `Unknown command "${name}". Call tempo.help().` }); break; }
      try { out.push({ cmd: name, result: await def.run(typeof c === 'object' ? c : {}) }); if (def.write) changed++; }
      catch (e) { out.push({ cmd: name, error: e.api ? e.message : `${e.message || e}` }); break; }
    }
    // the whole batch becomes one undo step
    const added = h.undoStack.splice(mark);
    if (added.length > 1 || (added.length && list.length > 1)) h.pushUndo(label || `AI: ${changed} change${changed === 1 ? '' : 's'}`, async () => { for (const u of added.reverse()) await u.undo(); });
    else if (added.length) h.undoStack.push(...added);
    if (changed && name0(list) !== 'undo') h.toast(`${label || 'AI'}: ${changed} change${changed === 1 ? '' : 's'} made`);
    return Array.isArray(input) ? out : out[0];
  }
  const name0 = (list) => (typeof list[0] === 'string' ? list[0] : list[0]?.cmd);

  // Preview: apply task commands to a copy and re-plan it; events are only listed.
  async function preview(list) {
    const saved = JSON.stringify(h.st().tasks);
    const savedSettings = JSON.stringify(h.set());
    const notes = [];
    try {
      for (const c of list) {
        const a = typeof c === 'object' ? c : { cmd: c };
        if (a.cmd === 'addTask') h.st().tasks.push(taskFromSpec(a));
        else if (a.cmd === 'updateTask') { const t = findTask(a.task); h.st().tasks = h.st().tasks.map((x) => (x.id === t.id ? applyTaskChanges(t, a) : x)); }
        else if (a.cmd === 'deleteTask') { const t = findTask(a.task); h.st().tasks = h.st().tasks.filter((x) => x.id !== t.id); }
        else if (a.cmd === 'moveSession') { const { task, sess } = findSession(a.session, a.task, a.index); const s = when(a.start); h.st().tasks = h.st().tasks.map((x) => (x.id === task.id ? S.pinSession(task, sess.id, s, a.end ? when(a.end) : s + (sess.end - sess.start)) : x)); }
        else if (commands[a.cmd]?.write) notes.push(`${a.cmd} would be applied (not simulated in preview)`);
      }
      const r = S.rescheduleAll(h.st().tasks, h.lastBusy() || [], h.set(), Date.now());
      return { preview: true, tasks: r.tasks.filter((t) => !t.archived).map(taskOut), pushedLater: r.moves.map((m) => ({ task: m.title, nextFrom: fmt(m.nextFrom), nextTo: fmt(m.nextTo), finishTo: fmt(m.finishTo) })), problems: r.problems.map((p) => ({ task: r.tasks.find((t) => t.id === p.taskId)?.title, shortMinutes: Math.round(p.shortfall) })), notes };
    } catch (e) { return { preview: true, error: e.message }; }
    finally { h.st().tasks = JSON.parse(saved); Object.assign(h.set(), JSON.parse(savedSettings)); }
  }

  const api = { run, help: () => helpText(), version: 1 };
  for (const name of Object.keys(commands)) if (name !== 'help') api[name] = (args = {}) => run({ cmd: name, ...args });
  return api;
}

// Text an assistant can be given to learn the interface.
export const AI_PROMPT = `You can control the Tempo calendar app in this browser tab.
Run JavaScript in the page: \`await tempo.help()\` lists the commands; \`await tempo.run([{ cmd: "...", ... }])\` runs them (a list is one undo step; add {dryRun: true} as a second argument to preview).
If you can't run JavaScript, open the AI console (⋯ → AI & automation, or add ?ai=1 to the address), type the JSON into the box, press Run and read the result below it.
Read before you change: use today, listTasks, listSessions, listEvents and freeTime first. Confirm destructive changes (deleting tasks or events) with the user.`;
