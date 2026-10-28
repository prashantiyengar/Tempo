// The Analysis view.
import * as T from './tz.js';
import * as E from './engine.js';
import * as A from './analysis.js';
import { set as storeSet } from './storage.js';
import { $, $$, esc, el, download, modal, setHTML } from './ui.js';
import * as RV from './review.js';
import { app, set, st, tz } from './core.js';
import { calColor, collectItems, render } from './app.js';
import { openReview } from './review-ui.js';

// ======================================================================================
// Analysis view
// ======================================================================================
app.anOpts = { period: 'next7', scope: 'bounds', by: 'category' };

export async function renderAnalysisView(seq) {
  const s = set(), z = tz(), o = app.anOpts;
  const view = $('#view');
  const modeBar = `<div class="seg an-mode"><button data-mode="use" class="${app.anMode === 'history' ? '' : 'on'}">Time use</button><button data-mode="history" class="${app.anMode === 'history' ? 'on' : ''}">Plan vs actual</button><button data-mode="review">Weekly review…</button></div>`;
  const bindMode = (root) => $$('.an-mode button', root).forEach((b) => (b.onclick = () => { if (b.dataset.mode === 'review') return openReview(); app.anMode = b.dataset.mode; render(); }));
  if (app.anMode === 'history') {
    const weeks = app.histWeeks || 8;
    setHTML(view, `<div class="analysis">${modeBar}<div class="row an-ctl"><label class="field inline"><span>Show the last</span><select class="hist-w">${[4, 8, 12, 26].map((w) => `<option value="${w}" ${w === weeks ? 'selected' : ''}>${w} weeks</option>`).join('')}</select></label></div>${RV.renderHistory(st(), weeks)}</div>`);
    bindMode(view);
    $('.hist-w', view).onchange = (e) => { app.histWeeks = +e.target.value; render(); };
    bindTips(view);
    return;
  }
  if (!$('.analysis', view)) setHTML(view, '<div class="analysis"><p class="muted">Calculating…</p></div>');
  const rng = A.periodRange(o.period, s, Date.now(), { from: o.from, to: o.to });
  const days = [];
  for (let k = T.dayKey(rng.from, z); T.dayStart(k, z) < rng.to; k = T.addDays(k, 1)) days.push(k);
  // one extra day before, so a night that starts the evening before the range can see what's in it
  const items = await collectItems(o.scope === 'full' ? [T.addDays(days[0], -1), ...days] : days);
  if (seq !== app.renderSeq) return;
  const groups = {};
  const actx = { settings: s, gmeta: st().gmeta, calColor };
  const occ = items.filter((it) => A.isOccupying(it, s)).map((it) => {
    const g = A.groupOf(it, o.by, actx);
    const G0 = groups[g.key] ||= { ...g, contains: new Set() };
    G0.contains.add(it.kind === 'chunk' ? it.task.title : (it.title || '(No title)'));
    return { start: it.start, end: it.end, group: g.key, prio: it.kind === 'chunk' ? 1 : 0, title: it.kind === 'chunk' ? it.task.title : (it.title || '(No title)'), kind: it.kind, uid: it.key };
  });
  const wins = A.scopeWindows(o.scope, rng.from, rng.to, s);
  let sleep = null;
  if (o.scope === 'full' && s.sleepAssume !== false) {
    sleep = A.assumedSleep(occ, rng.from, rng.to, s);
    if (sleep.blocks.length) {
      const sg = A.sleepGroup(s, o.by);
      occ.push(...A.sleepItems(sleep, sg));
      (groups[sg.key] ||= { ...sg, contains: new Set() }).contains.add('Sleep (assumed)');
    }
  }
  const data = A.compute(occ, wins, z);
  for (const k of days) data.days[k] ||= { available: 0, free: 0, groups: {} };
  app.anLast = { data, groups };
  const root = $('.analysis', view) || view.appendChild(el('<div class="analysis"></div>'));
  setHTML(root, modeBar + A.renderAnalysis({ data, groups, opts: o, settings: s, rangeInfo: rng, sleep }));
  bindMode(root);
  $$('[data-sleep]', root).forEach((c) => (c.onchange = async () => {
    const k = c.dataset.sleep;
    if (k === 'on') s.sleepAssume = c.checked; else if (k === 'cat') s.sleepCategory = c.value || null; else if (c.value) s[k === 'start' ? 'sleepStart' : 'sleepEnd'] = c.value;
    await E.persist(st(), ['settings']); render();
  }));
  $$('[data-o]', root).forEach((c) => {
    if (c.dataset.o === 'csv') { c.onclick = () => { download(new Blob([A.toCsv(data, groups, z)], { type: 'text/csv' }), `tempo-analysis-${T.dayKey(rng.from, z)}.csv`); }; return; }
    c.onchange = () => {
      // custom range: moving "From" moves "To" with it (same number of days)
      if (c.dataset.o === 'from' && o.from && o.to && c.value) o.to = T.addDays(o.to, T.daysBetween(o.from, c.value));
      o[c.dataset.o] = c.value;
      if (o.period === 'custom' && !o.from) { o.from = T.dayKey(Date.now(), z); o.to = T.addDays(o.from, 13); }
      storeSet({ analysisOpts: o });
      render();
    };
  });
  $$('.lbl-edit', root).forEach((b) => (b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); renameColor(b.dataset.hex); }));
  bindTips(root);
}

async function renameColor(hex) {
  const cur = (set().colorLabels || {})[hex] || A.colorName(hex) || '';
  const v = await modal(`<form class="choice"><h2>Name this color category</h2>
      <p class="muted small">e.g. “Deep work”, “Meetings”, “Reading”. Used in the analysis.</p>
      <div class="row"><span class="sw-dot big" style="background:${esc(hex)}"></span><input name="v" value="${esc(cur)}" autofocus style="flex:1"></div>
      <div class="actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">Save</button></div></form>`,
  (dlg, close) => { $('form', dlg).onsubmit = (e) => { e.preventDefault(); close($('[name=v]', dlg).value.trim()); }; }, { cls: 'narrow' });
  if (v == null) return;
  set().colorLabels = { ...(set().colorLabels || {}), [hex]: v || undefined };
  await E.persist(st(), ['settings']);
  render();
}

function bindTips(root) {
  let tip = $('#chart-tip');
  if (!tip) { tip = el('<div id="chart-tip" class="chart-tip" hidden></div>'); document.body.appendChild(tip); }
  root.addEventListener('pointermove', (e) => {
    const t = e.target.closest('[data-tip]');
    if (!t) { tip.hidden = true; return; }
    tip.textContent = t.dataset.tip;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    tip.style.left = Math.min(innerWidth - r.width - 8, e.clientX + 14) + 'px';
    tip.style.top = Math.max(8, e.clientY - r.height - 10) + 'px';
  });
  root.addEventListener('pointerleave', () => (tip.hidden = true));
}
