// The sidebar: tasks, Later, projects, Bookcase, Google Keep shortcut, mini month.
import * as T from './tz.js';
import * as S from './scheduler.js';
import * as E from './engine.js';
import * as EV from './events.js';
import * as G from './gcal.js';
import * as D from './dialogs.js';
import * as C from './categories.js';
import * as AC from './accounts.js';
import { $, $$, esc, modal, setHTML } from './ui.js';
import * as P from './projects.js';
import * as GM from './game.js';
import { LOCAL_COLOR, app, set, st, tz } from './core.js';
import { closeDrawer, ctx, cycle, newEvent, openConnect, range, render, replaceTask, saveTasks, syncSharedSoon, toast } from './app.js';
import { gameOn, gameRefresh, renderGamePanel } from './game-ui.js';
import { renderHabits } from './habits-ui.js';
import { notesList, renderNotes } from './notes.js';
import { afterEventChange, createdEvents } from './popovers.js';
import { timer } from './timer.js';
import { editTask, newTask, pushUndo, undoStack } from './undo.js';
import { handleError, setStatus } from './status.js';
import { buildDraft } from './assistant.js';

// ======================================================================================
// Sidebar
// ======================================================================================
// Google Keep can't be shown inside other pages, so these open it in a narrow window beside Tempo
function renderKeep() {
  const box = $('#keep-box'); if (!box) return;
  box.hidden = !set().keepOn;
  if (box.dataset.wired) return; box.dataset.wired = '1';
  const open = (url) => { const w = Math.min(440, screen.availWidth / 3), h = Math.min(820, screen.availHeight - 40); const x = (window.screenX || 0) + window.outerWidth - w - 10; const win = window.open(url, 'tempo-keep', `popup=yes,width=${Math.round(w)},height=${Math.round(h)},left=${Math.max(0, Math.round(x))},top=${(window.screenY || 0) + 40}`); if (!win) window.open(url, '_blank', 'noopener'); else win.focus?.(); };
  $('#keep-new', box).onclick = () => open('https://keep.new');
  $('#keep-open', box).onclick = () => open('https://keep.google.com/');
}
export function renderSidebar() {
  renderMini();
  renderGamePanel();
  renderKeep();
  const s = set(), hidden = new Set(s.hiddenCalendars || []);
  const cals = [
    ...(E.connected(st()) ? (st().gmeta.calendars || []) : []),
    { id: E.LOCAL_CAL, summary: 'Local (this browser)', color: LOCAL_COLOR },
    { id: 'tasks', summary: 'Task sessions', color: '#8a5cf6' },
    ...AC.extCalendars().map((c) => ({ id: c.key, summary: `${c.name} · ${c.account.label}`, color: c.color || '#888' })),
  ];
  { const shown = cals.filter((c) => !hidden.has(c.id)).length; const cc = $('.cal-count'); if (cc) cc.textContent = shown === cals.length ? `${cals.length}` : `${shown}/${cals.length}`; }
  setHTML($('#cal-list'), cals.map((c) => `<label class="cal-row" title="${esc(c.summary)}">
    <input type="checkbox" data-cal="${esc(c.id)}" ${hidden.has(c.id) ? '' : 'checked'}><i style="--c:${c.color}"></i><span>${esc(c.summary)}</span></label>`).join('')
    + (E.connected(st()) ? '' : `<button class="btn small ghost wide" id="connect-cta">${G.builtinAvailable() ? 'Sign in with Google' : 'Connect Google Calendar…'}</button>`));
  $$('#cal-list input').forEach((cb) => cb.addEventListener('change', async () => {
    const id = cb.dataset.cal;
    const h = new Set(set().hiddenCalendars || []);
    cb.checked ? h.delete(id) : h.add(id);
    set().hiddenCalendars = [...h];
    await E.persist(st(), ['settings']);
    render();
    if (id !== 'tasks' && !set().busyCalendars) cycle();
  }));
  $('#connect-cta')?.addEventListener('click', openConnect);

  const now = Date.now();
  // finished tasks stay in the list for a week, then move to "Finished" (still there, just folded away)
  const filed = (t) => !t.repeat && taskFinishedAt(t, now) && taskFinishedAt(t, now) < now - 7 * T.DAY;
  const allTasks = S.sortTasks(st().tasks.filter((t) => !t.archived));
  const projDone = (pid) => { const kids = allTasks.filter((x) => x.projectId === pid); return kids.length && kids.every(filed); };
  const isFiled = (t) => (t.projectId && (set().projects || []).some((p) => p.id === t.projectId) ? projDone(t.projectId) : filed(t));
  const tasks = allTasks.filter((t) => !isFiled(t)), old = allTasks.filter(isFiled);
  const row = (t) => {
    const p = S.progress(t, now);
    const ss = S.sessions(t);
    const doneN = ss.filter((c) => c.kind === 'done' || (c.kind === 'pinned' && c.end <= now)).length;
    const complete = !t.repeat && p.pct >= 100;
    const warn = !complete && t.lastPlan?.shortfall > 0;
    const late = !complete && !warn && t.lastPlan?.late > 0;
    const next = ss.find((c) => c.kind !== 'done' && c.end > now);
    const waiting = t.lastPlan?.waitingFor?.length ? st().tasks.filter((x) => t.lastPlan.waitingFor.includes(x.id)).map((x) => x.title) : [];
    const meta = t.repeat
      ? `↻ ${T.fmtDur(p.done)} of ${T.fmtDur(p.total)} ${t.repeat.every === 'week' ? 'this week' : 'today'}`
      : complete ? 'Done ✓' : `${doneN}/${ss.length} · due ${T.fmtDate(t.deadline, tz())}`;
    return `<button class="task-row ${complete ? 'complete' : ''} ${t.projectId ? 'in-proj' : ''}" data-task="${t.id}" style="--c:${t.color}">
      <span class="rank" title="Rank ${t.rank}">${t.rank}</span>
      <span class="tr-main">
        <span class="tr-title">${t.categoryIcon ? esc(t.categoryIcon) + ' ' : (t.kind === 'reading' ? (t.reading?.format === 'audio' ? '🎧 ' : '📖 ') : '')}${esc(t.title)}${warn ? ' <span class="warn-ic" title="Not enough time before the deadline">⚠</span>' : ''}${late ? ' <span class="late-ic" title="Runs into the safety margin before the deadline">◔</span>' : ''}${timer?.taskId === t.id ? ' <span title="Timer running">⏱</span>' : ''}</span>
        <span class="tr-meta">${t.categoryId ? `<span class="tr-cat">${esc(C.catById(set(), t.categoryId)?.name || t.categoryName || '')}</span> · ` : ''}${esc(meta)}${waiting.length ? ` · ⏳ after ${esc(waiting.join(', '))}` : next && !complete ? ` · next ${esc(T.format(next.start, tz(), { weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: set().h12 }))}` : ''}</span>
        <span class="bar"><i style="width:${p.pct}%"></i></span>
      </span></button>`;
  };
  // Tasks of a project are grouped under it, in step order.
  const projects = set().projects || [];
  const html = [];
  const seen = new Set();
  for (const t of tasks) {
    if (seen.has(t.id)) continue;
    const proj = t.projectId && projects.find((p) => p.id === t.projectId);
    if (!proj) { html.push(row(t)); seen.add(t.id); continue; }
    const kids = st().tasks.filter((x) => x.projectId === proj.id && !x.archived).sort((a, b) => (a.projectStep ?? 1e9) - (b.projectStep ?? 1e9) || (a.created || 0) - (b.created || 0));
    const doneKids = kids.filter((x) => S.progress(x, now).pct >= 100).length;
    html.push(`<div class="proj-head" title="${proj.sequential ? 'Steps run in order' : 'Project'}">📁 <b>${esc(proj.name)}</b> <span class="muted small">${doneKids}/${kids.length} done${proj.sequential ? ' · in order' : ''}</span></div>`);
    for (const k of kids) { html.push(row(k)); seen.add(k.id); }
  }
  const books = st().tasks.filter((t) => t.kind === 'reading');
  const top = books.length ? `<button type="button" class="link small lib-open" title="Books you've read and are reading">📚 Bookcase (${books.length})</button>` : '';
  const oldHTML = old.length ? `<details class="tl-arch" ${app.archOpen ? 'open' : ''}><summary class="muted small">Finished more than a week ago (${old.length})</summary>${old.map(row).join('')}</details>` : '';
  setHTML($('#task-list'), (tasks.length || old.length) ? top + html.join('') + oldHTML : `${top}<p class="muted small empty">No tasks yet. Type one above, or use + Task — Tempo splits it into sessions around your calendar.</p>`);
  $('#task-list .tl-arch')?.addEventListener('toggle', (e) => { app.archOpen = e.target.open; });
  $('#task-list .lib-open')?.addEventListener('click', () => { closeDrawer?.(); openLibrary(); });
  $$('#task-list .task-row').forEach((b) => b.addEventListener('click', () => editTask(st().tasks.find((t) => t.id === b.dataset.task))));
  renderLater();
}

// When a task was finished: marked finished, or the end of its last done session once all of it is done
function taskFinishedAt(t, now = Date.now()) {
  if (t.repeat) return null;
  if (S.progress(t, now).pct < 100) return null;
  const done = (t.frozen || []).filter((c) => c.status === 'done');
  return t.completedAt || (done.length ? Math.max(...done.map((c) => c.end)) : null);
}
// ---------- Covers: from the book's ISBN (Open Library) or an image address you give. Each is downloaded once, made
// into a small picture of the same size, and kept on this device; if a site doesn't allow downloading, the image is
// shown straight from its address instead. ----------
const COVERS = 'tempo:covers';
const coverCache = () => { try { return JSON.parse(localStorage.getItem(COVERS) || '{}'); } catch { return {}; } };
const coverSrcOf = (r) => (r?.cover ? r.cover.trim() : r?.isbn ? `https://covers.openlibrary.org/b/isbn/${String(r.isbn).replace(/[^0-9Xx]/g, '')}-M.jpg?default=false` : '');
export function coverFor(t) { const src = coverSrcOf(t?.reading); if (!src) return ''; const c = coverCache()[src]; return c === 'none' ? '' : c || src; }
const coverBusy = new Set();
async function ensureCover(t) {
  const src = coverSrcOf(t?.reading); if (!src || coverBusy.has(src)) return null;
  const cache = coverCache(); if (cache[src]) return cache[src] === 'none' ? null : cache[src];
  coverBusy.add(src);
  try {
    const res = await fetch(src, { mode: 'cors' });
    if (!res.ok) { if (res.status === 404) { cache[src] = 'none'; try { localStorage.setItem(COVERS, JSON.stringify(cache)); } catch { /* full */ } } return null; }
    const bmp = await createImageBitmap(await res.blob());
    const W = 160, H = 240, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const sc = Math.max(W / bmp.width, H / bmp.height), w = bmp.width * sc, h = bmp.height * sc;
    cv.getContext('2d').drawImage(bmp, (W - w) / 2, (H - h) / 2, w, h);
    const data = cv.toDataURL('image/jpeg', 0.82);
    const c2 = coverCache(); c2[src] = data;
    try { localStorage.setItem(COVERS, JSON.stringify(c2)); } catch { /* storage full: shown from its address */ }
    return data;
  } catch { return null; } // (not allowed to download: shown straight from its address)
  finally { coverBusy.delete(src); }
}
const coverHTML = (t, cls = 'bc-cover') => { const src = coverFor(t); return src ? `<img class="${cls}" src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-title="${esc((t?.title || '').slice(0, 40))}" style="--c:${esc(t?.color || '#7c5cff')}">` : `<span class="${cls} none" style="--c:${esc(t?.color || '#7c5cff')}">${esc((t?.title || '').slice(0, 40))}</span>`; };
// a cover that doesn't load becomes a plain spine with the title
const wireCovers = (root) => $$('img.bc-cover, img.cov-prev', root).forEach((img) => { img.onerror = () => { const sp = document.createElement('span'); sp.className = img.className + ' none'; sp.style.cssText = img.style.cssText; sp.textContent = img.dataset.title || '📖'; img.replaceWith(sp); }; });
// The cover of a book: ISBN or an image address, with a preview — saved without re-planning the reading sessions
async function editCover(t) {
  const r0 = t.reading || {};
  const res = await modal(`<form class="choice cover-f"><h2>📚 ${esc(t.title)}</h2>
      <div class="row bk-cover-row"><span class="cov-box">${coverHTML(t, 'cov-prev')}</span>
        <div style="flex:1;display:flex;flex-direction:column;gap:6px"><label class="field"><span>ISBN <em class="muted">(finds the cover)</em></span><input name="isbn" value="${esc(r0.isbn || '')}" placeholder="e.g. 9780141182803" inputmode="numeric" autocomplete="off"></label>
        <label class="field"><span>…or a cover image address</span><input name="cover" value="${esc(r0.cover || '')}" placeholder="https://…/cover.jpg" autocomplete="off"></label></div></div>
      <div class="actions"><button type="button" class="btn ghost cov-plan">Edit the reading plan…</button><span class="grow"></span><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">Save cover</button></div></form>`,
  (dlg, close) => {
    const f = $('form', dlg); wireCovers(dlg);
    let tm = 0;
    const prev = () => { const box = $('.cov-box', dlg); setHTML(box, coverHTML({ ...t, reading: { isbn: f.isbn.value.trim(), cover: f.cover.value.trim() } }, 'cov-prev')); wireCovers(box); };
    for (const n of ['isbn', 'cover']) f[n].addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(prev, 500); });
    $('.cov-plan', dlg).onclick = () => close('plan');
    f.onsubmit = (e) => { e.preventDefault(); close({ isbn: f.isbn.value.trim(), cover: f.cover.value.trim() }); };
  }, { cls: 'narrow' });
  if (!res || res === 'plan') return res;
  const cur = st().tasks.find((x) => x.id === t.id); if (!cur) return null;
  const reading = { ...(cur.reading || {}) }; delete reading.isbn; delete reading.cover;
  if (res.isbn) reading.isbn = res.isbn; if (res.cover) reading.cover = res.cover;
  replaceTask({ ...cur, reading });
  await saveTasks(`cover of “${cur.title}”`);
  const nt = st().tasks.find((x) => x.id === t.id);
  await ensureCover(nt);
  toast('Cover saved');
  return true;
}
// ---------- Bookcase: the books you've read and are reading ----------
function libraryRows() {
  const now = Date.now();
  return st().tasks.filter((t) => t.kind === 'reading').map((t) => {
    const r = t.reading || {}, p = S.progress(t, now);
    const done = (t.frozen || []).filter((c) => c.status === 'done' && c.start < now);
    const mins = done.reduce((a, c) => a + (c.actualMin || Math.max(0, Math.min(c.end, now) - c.start) / T.MIN), 0);
    const pages = Math.max(0, (+r.pages || 0) - Math.max(0, (+r.startPage || 1) - 1));
    const fin = taskFinishedAt(t, now);
    const from = done.length ? Math.min(...done.map((c) => c.start)) : null;
    const sessions = done.map((c) => [c.start, Math.min(c.end, now)]);
    return { t, audio: r.format === 'audio', title: t.title, pages, total: +r.pages || 0, read: Math.round(pages * Math.min(100, p.pct) / 100), pct: Math.round(p.pct), mins, from, to: fin || (from ? now : null), finished: !!fin, sessions, color: t.color };
  }).sort((a, b) => (b.from || b.t.created || 0) - (a.from || a.t.created || 0));
}
// Books on a timeline: one row each (overlapping books sit on their own rows), with a mark for each reading session
function libraryTimeline(rows) {
  const z = tz(), withT = rows.filter((r) => r.from);
  if (!withT.length) return '<p class="muted small">The timeline fills in as you read.</p>';
  const t0 = Math.min(...withT.map((r) => r.from)), t1 = Math.max(Date.now(), ...withT.map((r) => r.to));
  const W = 680, Lw = 150, R = 48, rh = 24, Hh = withT.length * rh + 28, span = Math.max(T.DAY, t1 - t0);
  const x = (t) => Lw + ((t - t0) / span) * (W - Lw - R);
  const months = []; for (let k = T.dayKey(t0, z).slice(0, 7) + '-01'; T.dayStart(k, z) <= t1; k = T.addMonths(k, 1)) months.push(k);
  const every = Math.ceil(months.length / 8);
  return `<svg class="lib-tl" viewBox="0 0 ${W} ${Hh}" width="100%" role="img" aria-label="Which book was read when">
    ${months.map((k, i) => { const xx = Math.max(Lw, x(T.dayStart(k, z))); return `<line x1="${xx}" x2="${xx}" y1="0" y2="${Hh - 18}" stroke="currentColor" opacity=".08"/>${i % every === 0 ? `<text x="${xx + 2}" y="${Hh - 6}" font-size="9" fill="currentColor" opacity=".6">${esc(T.format(T.dayStart(k, z), z, { month: 'short', year: '2-digit' }))}</text>` : ''}`; }).join('')}
    ${withT.map((r, i) => { const y = i * rh + 4, a = x(r.from), b = Math.max(a + 3, x(r.to)); return `<g><title>${esc(`${r.title}: ${T.format(r.from, z, { day: 'numeric', month: 'short', year: 'numeric' })} – ${r.finished ? T.format(r.to, z, { day: 'numeric', month: 'short', year: 'numeric' }) : 'now'} · ${T.fmtDur(Math.round(r.mins))}`)}</title>
      <text x="${Lw - 6}" y="${y + 14}" font-size="10.5" text-anchor="end" fill="currentColor">${esc(r.title.length > 24 ? r.title.slice(0, 23) + '…' : r.title)}</text>
      <rect x="${a}" y="${y + 3}" width="${b - a}" height="${rh - 9}" rx="4" fill="${esc(r.color || '#7c5cff')}" opacity="${r.finished ? .85 : .45}"/>
      ${r.sessions.map(([s0]) => `<rect x="${x(s0) - 0.75}" y="${y + 3}" width="1.5" height="${rh - 9}" fill="#fff" opacity=".7"/>`).join('')}
      ${r.finished ? '' : `<text x="${b + 3}" y="${y + 14}" font-size="9" fill="currentColor" opacity=".7">reading</text>`}</g>`; }).join('')}
  </svg>`;
}
async function openLibrary() {
  const rows = libraryRows(), z = tz(), fmt = (t) => T.format(t, z, { day: 'numeric', month: 'short', year: 'numeric' });
  const read = rows.filter((r) => r.finished), now = rows.filter((r) => !r.finished && r.from), next = rows.filter((r) => !r.from);
  const tr = (r) => `<tr data-task="${esc(r.t.id)}"><td><span class="lib-dot" style="background:${esc(r.color || '#7c5cff')}"></span><b>${esc(r.title)}</b></td><td>${r.audio ? `🎧 ${r.finished ? T.fmtDur(r.pages) : `${T.fmtDur(r.read)} / ${T.fmtDur(r.pages)}`}` : `${r.finished ? r.pages : `${r.read} / ${r.pages}`} pp.`}</td><td>${r.from ? `${esc(fmt(r.from))} – ${r.finished ? esc(fmt(r.to)) : 'now'}` : '<span class="muted">not started</span>'}</td><td>${r.mins ? esc(T.fmtDur(Math.round(r.mins))) : '—'}</td><td>${r.finished ? '✓' : `${r.pct}%`}</td></tr>`;
  const table = (list, head) => list.length ? `<h3 class="gd-h">${head} <span class="muted small">${list.length}</span></h3><table class="lib-t"><thead><tr><th>Book</th><th>Pages</th><th>Read</th><th>Time</th><th></th></tr></thead><tbody>${list.map(tr).join('')}</tbody></table>` : '';
  const totPages = read.filter((r) => !r.audio).reduce((a, r) => a + r.pages, 0) + now.filter((r) => !r.audio).reduce((a, r) => a + r.read, 0), totMin = rows.reduce((a, r) => a + r.mins, 0);
  const shelf = (list) => list.map((r) => `<button type="button" class="bc-book" data-task="${esc(r.t.id)}" title="${esc(r.title)}${r.finished ? ' — read' : r.from ? ` — ${r.pct}%` : ' — up next'}">${coverHTML(r.t)}<span class="bc-t">${esc(r.title)}</span>${r.finished ? '' : r.from ? `<span class="bc-bar"><i style="width:${r.pct}%"></i></span>` : ''}</button>`).join('');
  await modal(`<div class="library bookcase"><header class="dlg-head"><h2>📚 Bookcase</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></header><div class="dlg-body">
    <p class="muted small" style="margin:0">${read.length} book${read.length === 1 ? '' : 's'} read · ${now.length} reading · ${totPages.toLocaleString()} pages · ${T.fmtDur(Math.round(totMin))} of reading</p>
    ${rows.length ? `<div class="bc-shelf">${shelf([...now, ...read, ...next])}</div>` : ''}
    ${libraryTimeline(rows)}
    ${table(now, 'Reading now')}${table(read, 'Read')}${table(next, 'Up next')}
    ${rows.length ? '' : '<p class="muted small">Plan a book with 📖 and it shows up here as you read it.</p>'}
  </div></div>`, (dlg, close) => {
    wireCovers(dlg);
    $$('.lib-t tr[data-task]', dlg).forEach((r) => (r.onclick = () => { close(); editTask(st().tasks.find((t) => t.id === r.dataset.task)); }));
    // a book on the shelf: change its cover (ISBN or image) right here — the plan isn't touched
    $$('.bc-book', dlg).forEach((b) => (b.onclick = async () => {
      const t = st().tasks.find((x) => x.id === b.dataset.task); if (!t) return;
      const r = await editCover(t);
      if (r === 'plan') { close(); editTask(st().tasks.find((x) => x.id === t.id)); return; }
      if (r) { const tmp = document.createElement('span'); setHTML(tmp, coverHTML(st().tasks.find((x) => x.id === t.id))); $('.bc-cover', b)?.replaceWith(tmp.firstElementChild); wireCovers(b); }
    }));
    // download covers not kept yet, then show the kept copy
    for (const r of rows) if (coverSrcOf(r.t.reading) && !coverCache()[coverSrcOf(r.t.reading)]) ensureCover(r.t).then(() => { const b = dlg.isConnected && $(`.bc-book[data-task="${CSS.escape(r.t.id)}"]`, dlg); if (b) { const old = $('.bc-cover', b); const tmp = document.createElement('span'); setHTML(tmp, coverHTML(r.t)); old?.replaceWith(tmp.firstElementChild); wireCovers(b); } });
  }, { cls: 'wide' });
}
// ---------- "Later": things to schedule, but not yet (synced with your other devices like settings) ----------
const laterList = () => set().later || [];
async function saveLater(list, label) {
  const before = laterList();
  set().later = list;
  await E.persist(st(), ['settings']);
  syncSharedSoon();
  if (label) pushUndo(label, async () => { set().later = before; await E.persist(st(), ['settings']); renderLater(); });
  renderLater();
}
// ---------- Projects: progress in the sidebar ----------
export function projectEventDone(stp) {
  if (stp.kind !== 'event' || !stp.ref) return false;
  const k = stp.ref; return !!st().eventDone?.[k];
}
function renderProjects(tab = app.sideTab || 'tasks') {
  const box = $('#proj-list'); if (!box) return;
  box.hidden = tab !== 'projects';
  const z = tz(), now = Date.now(), list = P.list(set());
  const n = $('#proj-n'); if (n) n.textContent = list.length ? String(list.filter((p) => !P.progress(p, st().tasks, now, projectEventDone).complete).length || '') : '';
  if (tab !== 'projects') return;
  const fmt = (ms) => T.fmtDate(ms, z);
  // finished projects stay for a week, then fold away under "Finished"
  const doneAt = (pr) => Math.max(0, ...pr.rows.map((r) => (r.task ? taskFinishedAt(r.task, now) || 0 : r.st.end || 0)));
  const prs = list.map((p) => ({ p, pr: P.progress(p, st().tasks, now, projectEventDone) }));
  const oldP = prs.filter((x) => x.pr.complete && doneAt(x.pr) < now - 7 * T.DAY), curP = prs.filter((x) => !oldP.includes(x));
  const card = ({ p, pr }) => {
      const nx = pr.next;
      const late = pr.rows.some((r) => r.late);
      const last = pr.rows.reduce((a, r) => Math.max(a, r.finish || r.st.end || 0), 0);
      return `<button type="button" class="pj-card ${pr.complete ? 'complete' : ''}" data-id="${esc(p.id)}">
        <span class="pj-t">📁 ${esc(p.name)}${late ? ' <span class="warn-ic" title="A task in it doesn\'t fit before its end date">⚠</span>' : ''}</span>
        <span class="pj-meta">${pr.complete ? 'Done ✓' : `${pr.finished}/${pr.count} steps · ${T.fmtDur(pr.done)} of ${T.fmtDur(pr.total)}${last ? ` · done by ${esc(fmt(last))}` : ''}`}</span>
        <span class="bar"><i style="width:${pr.pct}%"></i></span>
        ${nx && !pr.complete ? `<span class="pj-next">Next: ${nx.st.kind === 'event' ? '📅' : '⧉'} ${esc(nx.st.title)}${nx.next ? ` · ${esc(fmt(nx.next))}` : ''}</span>` : ''}
        <span class="pj-dots">${pr.rows.map((r) => `<i class="${r.finished ? 'd' : r.pct ? 'p' : ''} ${r.st.kind}" title="${esc(r.st.title)} — ${r.finished ? 'done' : r.pct + '%'}"></i>`).join('')}</span>
      </button>`;
  };
  setHTML(box, `<button type="button" class="btn small wide pj-new">+ New project</button>
    ${list.length ? curP.map(card).join('') + (oldP.length ? `<details class="tl-arch"><summary class="muted small">Finished more than a week ago (${oldP.length})</summary>${oldP.map(card).join('')}</details>` : '') : '<p class="muted small empty">A project is a chain of tasks and events — e.g. a thesis: research, a meeting, writing, a deadline. Create one to see its progress here.</p>'}`);
  $('.pj-new', box).onclick = () => openProject(null);
  $$('.pj-card', box).forEach((b) => (b.onclick = () => openProject(P.byId(set(), b.dataset.id))));
}
export async function openProject(p) {
  closeDrawer?.();
  const r = await D.projectDialog(ctx, p);
  if (!r) return;
  try { await saveProject(r, p); } catch (err) { handleError(err); }
}
// Create / update the steps' tasks and events, remove the ones taken out, and store the project.
async function saveProject(r, before) {
  const s = set(), z = tz();
  const evRef = (ref) => { const i = ref.indexOf('|'); return { _calId: ref.slice(0, i), id: ref.slice(i + 1) }; };
  setStatus('Saving project…', 'busy');
  for (const x of r.removed || []) {
    try {
      if (x.kind === 'task') { const t = st().tasks.find((y) => y.id === x.ref); if (t && (r.delete ? r.removeItems : true)) { st().orphanGids.push(...[...(t.planned || []), ...(t.frozen || [])].map((c) => c.gid).filter(Boolean), ...(t.orphanGids || [])); st().tasks = st().tasks.filter((y) => y.id !== t.id); st().tombstones = [...(st().tombstones || []), t.id].slice(-300); } else if (t) replaceTask({ ...t, projectId: null, projectName: null, projectStep: null }); }
      else if (x.ref && (r.delete ? r.removeItems : true)) await EV.deleteEvent(st(), evRef(x.ref), 'this');
    } catch (err) { if (!/not found|deleted|410/i.test(err.message)) handleError(err); }
  }
  if (r.delete) {
    s.projects = P.list(s).filter((x) => x.id !== before.id);
    st().tasks = st().tasks.map((t) => (t.projectId === before.id ? { ...t, projectId: null, projectName: null, projectStep: null, rev: Date.now() } : t));
    await E.persist(st(), ['settings']); syncSharedSoon(); await saveTasks('delete project'); await afterEventChange();
    toast(`Deleted project “${before.name}”`); return;
  }
  const p = r.project;
  // the project's category goes on its tasks and events (ones without a category, or still on the old project category)
  const pcat = p.catId ? C.catById(s, p.catId) : null, oldCat = before?.catId || null, catChanged = (p.catId || null) !== oldCat;
  const projectsBefore = JSON.parse(JSON.stringify(P.list(s))), createdEvents = [];
  let prevEventEnd = 0, made = 0;
  for (let i = 0; i < p.steps.length; i++) {
    const x = p.steps[i];
    const title = P.fullTitle(p, x.title);
    if (x.kind === 'task') {
      const fields = { title, earliestStart: Math.max(x.start || 0, p.sequential ? prevEventEnd : 0) || null, deadline: x.end, totalMinutes: Math.max(5, Math.round((+x.hours || 1) * 60)), projectId: p.id, projectName: p.name, projectStep: i + 1 };
      const t = x.ref && st().tasks.find((y) => y.id === x.ref);
      if (t) {
        const recat = pcat && catChanged && (!t.categoryId || t.categoryId === oldCat);
        const changed = recat || Object.entries(fields).some(([k, v]) => (t[k] ?? null) !== (v ?? null));
        if (changed) replaceTask(recat ? C.applyCategory({ ...t, ...fields }, pcat) : { ...t, ...fields });
      } else {
        const nt = buildDraft(pcat ? { ...fields, categoryId: pcat.id } : fields);
        st().tasks.push(nt); x.ref = nt.id; made++;
      }
    } else {
      const body = { summary: title, start: { dateTime: new Date(x.start).toISOString(), timeZone: z }, end: { dateTime: new Date(x.end).toISOString(), timeZone: z } };
      const evCat = pcat && (!x.ref || catChanged) ? C.eventCategoryChanges({ extendedProperties: { private: { tempoProject: p.id, tempoStep: x.id } } }, pcat) : null;
      if (evCat && x.ref) Object.assign(body, evCat);
      let done = false;
      if (x.ref) {
        try { await EV.updateEvent(st(), evRef(x.ref), body, 'this'); done = true; }
        catch (err) { if (!/not found|deleted|no longer exists|410/i.test(err.message)) throw err; }
      }
      if (!done) {
        const cal = ctx.defaultCalendar();
        const ev = await EV.createEvent(st(), cal, { ...body, reminders: { useDefault: true }, ...(evCat || {}), extendedProperties: { private: { ...(evCat?.extendedProperties.private || {}), tempoProject: p.id, tempoStep: x.id } } });
        x.ref = `${ev._calId || cal}|${ev.id}`; made++; createdEvents.push(x.ref);
      }
      prevEventEnd = Math.max(prevEventEnd, x.end);
    }
  }
  const exists = P.byId(s, p.id);
  s.projects = exists ? P.list(s).map((y) => (y.id === p.id ? p : y)) : [...P.list(s), p];
  await E.persist(st(), ['settings', 'localEvents']); syncSharedSoon();
  await saveTasks(exists ? `edit project “${p.name}”` : `new project “${p.name}”`);
  // undo also puts the project list back and removes the events it created
  const u = undoStack[undoStack.length - 1];
  if (u) { const f0 = u.undo; u.undo = async () => { await f0(); set().projects = projectsBefore; for (const ref of createdEvents) { try { await EV.deleteEvent(st(), evRef(ref), 'this'); } catch { /* already gone */ } } await E.persist(st(), ['settings', 'localEvents']); syncSharedSoon(); E.invalidate(); await render(); }; }
  E.invalidate();
  app.sideTab = 'projects'; try { localStorage.setItem('tempo:sideTab', 'projects'); } catch { /* storage blocked */ }
  await render();
  toast(exists ? `Project “${p.name}” saved` : `Project “${p.name}” created${made ? ` — ${made} step${made > 1 ? 's' : ''} planned` : ''}`);
  cycle();
}

// Game mode: what scheduling a Later item earns now (and doing it)
function laterChip(x) {
  if (!gameOn()) return '';
  const b = GM.laterBonus(set(), x.created);
  return `<span class="later-xp" title="${esc(`Game mode: scheduling it earns +${b.sched} life XP now (it has waited ${b.days} day${b.days === 1 ? '' : 's'} — the longer it waits, the more); doing it earns +${b.done} more`)}">🎮 <b class="xp-l">+${b.sched}</b> · <span class="xp-l">+${b.done}</span> when done</span>`;
}
const laterTip = (x) => { if (!gameOn()) return ''; const b = GM.laterBonus(set(), x.created); return ` — 🎮 +${b.sched} life XP now, +${b.done} when done`; };
function laterToast(item) {
  if (!gameOn()) return;
  const b = GM.laterBonus(set(), item.created);
  setTimeout(() => toast(`🎮 From Later: +${b.sched} life XP for scheduling it — +${b.done} more when it's done`, { ms: 5000, noUndo: true }), 400);
  setTimeout(() => gameRefresh(), 600);
}
export function renderLater() {
  const box = $('#later-list'); if (!box) return;
  const tab = app.sideTab || 'tasks';
  $$('.side-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.st === tab));
  $('#task-list').hidden = tab !== 'tasks';
  box.hidden = tab !== 'later';
  renderProjects(tab);
  const hl = $('#habit-list'); if (hl) { hl.hidden = tab !== 'habits'; if (tab === 'habits') renderHabits(hl, { days: 4 }); }
  const nl = $('#note-list'); if (nl) { nl.hidden = tab !== 'notes'; if (tab === 'notes') renderNotes(nl); }
  const nn = $('#notes-n'); if (nn) nn.textContent = notesList().length ? String(notesList().length) : '';
  $('#btn-resched').hidden = tab !== 'tasks';
  const list = laterList();
  const n = $('#later-n'); if (n) n.textContent = list.length ? String(list.length) : '';
  const z = tz();
  const today = T.dayKey(Date.now(), z);
  const due = (x) => { if (!x.deadline) return ''; const k = T.dayKey(x.deadline, z), d = T.daysBetween(today, k); return `<span class="later-due ${d < 0 ? 'over' : d <= 3 ? 'soon' : ''}" title="Deadline">by ${esc(T.fmtDate(x.deadline, z))}</span>`; };
  const oldIn = $('.later-add input[name=t]', box), lDraft = oldIn?.value || '', lHad = oldIn && document.activeElement === oldIn;
  setHTML(box, `<form class="later-add"><input name="t" placeholder="Something to schedule later…" maxlength="300" autocomplete="off" aria-label="Add a note"><button class="btn small" type="submit">Add</button>
      <div class="later-more"><label title="How long it will likely take">⏱ <input name="h" type="number" min="0" step="0.25" placeholder="h" aria-label="Hours"></label><label title="Must be done by">by <input name="d" type="date" aria-label="Deadline"></label><select name="c" class="later-cat-in" aria-label="Category" title="Category"><option value="">🏷 Category</option>${C.treeOptionsHTML(set(), app.laterCat || null)}</select></div></form>
    ${list.length ? list.map((x) => `<div class="later-row" data-id="${esc(x.id)}">
      <button type="button" class="later-t" title="Edit">${esc(x.text)}<span class="later-meta">${x.minutes ? `<span class="later-dur">⏱ ${T.fmtDur(x.minutes)}</span>` : ''}${due(x)}${(() => { const c = C.catById(set(), x.catId); return c ? `<span class="later-cat" style="--c:${esc(c.color)}" title="${esc(C.fullLabel(set(), c))}"><i></i>${esc(C.catLabel(c))}</span>` : ''; })()}<span class="muted small">added ${esc(T.format(x.created, z, { day: 'numeric', month: 'short' }))}</span>${laterChip(x)}</span></button>
      <span class="later-acts"><button type="button" class="icon-btn sm l-task" title="Make it a task (Tempo finds the time)${laterTip(x)}">⧉</button><button type="button" class="icon-btn sm l-event" title="Put it on the calendar as an event${laterTip(x)}">📅</button><button type="button" class="icon-btn sm l-del" title="Remove">✕</button></span>
    </div>`).join('') : '<p class="muted small empty">Jot down things you need to schedule, but not right away. Turn one into a task or an event when you\'re ready.</p>'}`);
  if (lDraft) { const i = $('.later-add input[name=t]', box); i.value = lDraft; if (lHad) i.focus(); }
  $('.later-add', box).onsubmit = async (e) => {
    e.preventDefault();
    const v = e.target.t.value.trim(); if (!v) return;
    const h = parseFloat(e.target.h.value), d = e.target.d.value, c = e.target.c.value;
    app.laterCat = c || null; // keep the category for the next note
    await saveLater([...laterList(), { id: S.newId('l'), text: v.slice(0, 300), created: Date.now(), ...(h > 0 ? { minutes: Math.round(h * 60) } : {}), ...(d ? { deadline: T.atTime(d, set().bounds?.end || '17:00', z) } : {}), ...(c ? { catId: c } : {}) }], `add “${v.slice(0, 30)}” to Later`);
    $('#later-list .later-add input')?.focus();
  };
  $$('.later-row', box).forEach((r) => {
    const item = laterList().find((x) => x.id === r.dataset.id); if (!item) return;
    const drop = () => saveLater(laterList().filter((x) => x.id !== item.id), `remove “${item.text.slice(0, 30)}” from Later`);
    $('.l-del', r).onclick = () => { drop(); toast('Removed from Later'); };
    $('.l-task', r).onclick = async () => {
      closeDrawer(); const ids = new Set(st().tasks.map((t) => t.id));
      const lc = C.catById(set(), item.catId);
      await newTask({ kind: 'generic', title: item.text, ...(item.minutes ? { totalMinutes: item.minutes } : {}), ...(item.deadline ? { deadline: item.deadline } : {}), ...(lc ? { draft: C.applyCategory({}, lc) } : {}) });
      const nt = st().tasks.find((t) => !ids.has(t.id));
      if (nt) { replaceTask({ ...nt, fromLater: { created: item.created || Date.now(), at: Date.now() } }); await saveTasks(false); drop(); laterToast(item); }
    };
    $('.l-event', r).onclick = async () => {
      closeDrawer();
      const start = Math.ceil((Date.now() + 15 * T.MIN) / (15 * T.MIN)) * 15 * T.MIN;
      const n0 = createdEvents;
      app.laterTag = { created: item.created };
      try { await newEvent({ start, end: start + Math.min(8 * 60, item.minutes || set().defaultEventMinutes || 60) * T.MIN, title: item.text, ...(C.catById(set(), item.catId) ? { categoryId: item.catId } : {}) }); } finally { app.laterTag = null; }
      if (createdEvents > n0) { drop(); laterToast(item); }
    };
    $('.later-t', r).onclick = async () => {
      const v = await modal(`<form class="choice"><h2>Edit note</h2><textarea name="v" rows="3" maxlength="300" style="width:100%">${esc(item.text)}</textarea>
        <div class="row"><label class="field"><span>Likely takes (hours)</span><input name="h" type="number" min="0" step="0.25" value="${item.minutes ? +(item.minutes / 60).toFixed(2) : ''}" placeholder="—"></label>
        <label class="field"><span>Must be done by</span><input name="d" type="date" value="${item.deadline ? T.dayKey(item.deadline, z) : ''}"></label></div>
        <label class="field"><span>Category</span><select name="c"><option value="">— none —</option>${C.treeOptionsHTML(set(), item.catId || null)}</select></label>
        <div class="actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">Save</button></div></form>`,
      (dlg, close) => { const f = $('form', dlg); f.onsubmit = (e) => { e.preventDefault(); close({ text: f.v.value.trim(), h: parseFloat(f.h.value), d: f.d.value, c: f.c.value }); }; setTimeout(() => f.v.focus(), 30); }, { cls: 'narrow' });
      if (v == null) return;
      if (!v.text) return drop();
      const upd = { text: v.text.slice(0, 300), minutes: v.h > 0 ? Math.round(v.h * 60) : undefined, deadline: v.d ? T.atTime(v.d, set().bounds?.end || '17:00', z) : undefined, catId: v.c || undefined };
      await saveLater(laterList().map((x) => (x.id === item.id ? { ...x, ...upd } : x)), 'edit note');
    };
  });
}

const miniMin = () => { try { return localStorage.getItem('tempo:miniCollapsed') === '1'; } catch { return false; } };
function renderMini() {
  const z = tz();
  const mk = app.miniCursor;
  const { y, m } = T.parseKey(mk);
  const first = T.keyOf(y, m, 1);
  const start = T.startOfWeek(first, set().weekStart);
  const todayK = T.dayKey(Date.now(), z);
  const { days } = range();
  const inRange = new Set(app.view === 'month' ? [] : days);
  setHTML($('#mini'), `
    <div class="mini-head"><button type="button" class="mini-toggle" aria-expanded="${!miniMin()}" title="${miniMin() ? 'Show the month' : 'Minimise the month'}"><span class="sec-caret">▾</span> ${esc(T.format(T.dayStart(first, z), z, { month: 'long', year: 'numeric' }))}</button>
      <span ${miniMin() ? 'hidden' : ''}><button class="icon-btn sm" data-mini="-1" aria-label="Previous month">‹</button><button class="icon-btn sm" data-mini="1" aria-label="Next month">›</button></span></div>
    <div class="mini-grid" ${miniMin() ? 'hidden' : ''}>
      ${Array.from({ length: 7 }, (_, i) => `<span class="mw">${esc(T.format(T.dayStart(T.addDays(start, i), z), z, { weekday: 'narrow' }))}</span>`).join('')}
      ${Array.from({ length: 42 }, (_, i) => { const k = T.addDays(start, i); return `<button class="md ${T.parseKey(k).m !== m ? 'out' : ''} ${k === todayK ? 'today' : ''} ${inRange.has(k) ? 'sel' : ''} ${k === app.cursor ? 'cur' : ''}" data-day="${k}">${T.parseKey(k).d}</button>`; }).join('')}
    </div>`);
  $$('#mini [data-mini]').forEach((b) => b.addEventListener('click', () => { app.miniCursor = T.addMonths(app.miniCursor, +b.dataset.mini); renderMini(); }));
  $('#mini .mini-toggle').onclick = () => { try { localStorage.setItem('tempo:miniCollapsed', miniMin() ? '0' : '1'); } catch { /* storage blocked */ } renderMini(); };
  $$('#mini .md').forEach((b) => b.addEventListener('click', () => { app.cursor = b.dataset.day; if (app.view === 'analysis') app.view = 'week'; render(); }));
}
