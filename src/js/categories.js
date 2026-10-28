// Task categories (Work, Personal, …): a name and a color. A task's color follows its category.
// Category colors come from Google Calendar's own palette, so sessions show the same color in Google.
import { $$, esc, setHTML, modal } from './ui.js';
import { nearestColorId } from './gcal.js';

// Icons for categories, grouped by theme (the pickers show them under these headings).
export const CAT_ICON_GROUPS = [
  ['Work & office', ['💼', '💻', '🖥️', '⌨️', '🖨️', '📊', '📈', '🗂️', '🗃️', '📋', '📎', '🖊️', '📝', '✏️', '📅', '🗓️', '📞', '☎️', '✉️', '📤', '📥', '💬', '📣', '🏢', '🤝', '🎤', '🗣️', '🧑‍💻', '🛠️', '🔧', '🔍']],
  ['Learning', ['📚', '📖', '🎓', '🧑‍🏫', '🔬', '🧪', '🧮', '📐', '🧩', '🧠', '💡']],
  ['Home & errands', ['🏠', '🏡', '🛏️', '🧹', '🧺', '🧼', '🚿', '🪥', '👕', '🛒', '🛍️', '📦', '🎒', '💰', '🧾', '🏦', '🌱', '🪴']],
  ['Food & drink', ['🍳', '🍲', '🥪', '🍕', '🍰', '🥗', '🍎', '🍽️', '☕', '🥤', '🍷', '🍿']],
  ['Health & rest', ['🩺', '🧑‍⚕️', '🏥', '💊', '🦷', '🩹', '🧴', '🫁', '🦶', '😴', '😌', '❤️', '❤️‍🩹']],
  ['Sport & outdoors', ['💪', '🏃', '🚶', '🧘', '🤸', '🏋️', '🏊', '🚴', '🚣', '🧗', '🥾', '⛷️', '🏄', '⚽', '🏀', '🎾', '⛰️', '🌳', '🏖️']],
  ['Travel', ['🚗', '🚲', '🚌', '🚆', '🚕', '⛽', '✈️', '🧳', '🗺️', '🌍', '🏛️']],
  ['Fun & culture', ['🎉', '🎨', '🎭', '🎵', '🎧', '🎸', '🎹', '🎻', '🥁', '🎬', '📺', '🎮', '♟️', '🎲', '🧶', '📷', '📸', '🎟️', '✍️', '🎁']],
  ['People & pets', ['👪', '👨‍👩‍👧', '👫', '👶', '🧓', '🎂', '🥳', '💞', '🫶', '🙌', '🙏', '🕊️', '🐶', '🐱', '🐾', '🐦']],
  ['Nature & time', ['🌞', '🌙', '💧', '🔥', '⚡', '⭐', '⏰']],
  ['Symbols & colors', ['🎯', '🚀', '📌', '✅', '❗', '❓', '⚠️', '🔔', '🔒', '♻️', '🏁', '🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '⚫', '⚪']],
];
// The icon grid, by theme. Icons other categories already use are left out (except `keep`, the current one).
export function iconGridHTML(settings, { keep = '', exceptId = null } = {}) {
  const used = new Set((settings?.categories || []).filter((c) => c.id !== exceptId).map((c) => c.icon).filter(Boolean));
  return CAT_ICON_GROUPS.map(([name, list]) => {
    const free = list.filter((ic) => ic === keep || !used.has(ic));
    return free.length ? `<div class="ic-group"><span class="ic-gl">${esc(name)}</span><div class="ic-gi">${free.map((ic) => `<button type="button" class="ic-btn ${ic === keep ? 'on' : ''}" data-ic="${ic}">${ic}</button>`).join('')}</div></div>` : '';
  }).join('');
}
// Keep only the first emoji/symbol (or 2 letters) a person typed.
export function cleanIcon(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  const seg = typeof Intl !== 'undefined' && Intl.Segmenter ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].map((x) => x.segment) : [...s];
  return /\p{Extended_Pictographic}|\p{Emoji_Presentation}/u.test(seg[0]) ? seg[0] : seg.slice(0, 2).join('');
}
export const catLabel = (c) => (c ? `${c.icon ? c.icon + ' ' : ''}${c.name}` : '');

// The first 11 are Google Calendar's own event colors (shown identically there); the rest show in Tempo exactly and
// in Google as the nearest of its colors. Any other color can be picked with the custom swatch.
export const CAT_COLORS = ['#039be5', '#33b679', '#f6bf26', '#8e24aa', '#e67c73', '#f4511e', '#7986cb', '#0b8043', '#3f51b5', '#d50000', '#616161',
  '#00897b', '#43a047', '#7cb342', '#c0ca33', '#fdd835', '#ffb300', '#fb8c00', '#6d4c41', '#ec407a', '#ad1457', '#5e35b1', '#1e88e5', '#00acc1', '#546e7a', '#000000'];
// Swatch row with a custom color picker at the end. `name` = radio group name.
export function swatchesHTML(name, selected) {
  const custom = selected && !CAT_COLORS.includes(selected.toLowerCase()) ? selected : '';
  return `<div class="swatches">${CAT_COLORS.map((c) => `<label class="sw" title="${c}"><input type="radio" name="${esc(name)}" value="${c}" ${c === (selected || '').toLowerCase() ? 'checked' : ''}><i style="background:${c}"></i></label>`).join('')}
    <label class="sw custom" title="Custom color"><input type="radio" name="${esc(name)}" value="${esc(custom || '#888888')}" ${custom ? 'checked' : ''} class="sw-custom-radio"><i style="${custom ? `background:${esc(custom)}` : ''}"></i><input type="color" class="sw-color" value="${esc(custom || '#888888')}" aria-label="Custom color"></label></div>`;
}
// Wire a swatch row: onPick(color) for both preset and custom colors.
export function wireSwatches(host, onPick) {
  $$('.swatches input[type=radio]', host).forEach((r) => r.addEventListener('change', () => onPick(r.value)));
  $$('.sw.custom', host).forEach((lab) => {
    const col = lab.querySelector('.sw-color'), radio = lab.querySelector('.sw-custom-radio'), dot = lab.querySelector('i');
    col.addEventListener('input', () => { radio.value = col.value; radio.checked = true; dot.style.background = col.value; onPick(col.value); });
    dot.addEventListener('click', (e) => { e.preventDefault(); try { col.showPicker(); } catch { col.click(); } });
  });
}

export const catById = (settings, id) => (id ? (settings.categories || []).find((c) => c.id === id) || null : null);

// ---------- Sub-categories (one level: a category can sit inside a main category) ----------
export const parentOf = (settings, c) => (c?.parent ? catById(settings, c.parent) : null);
// Main categories, each followed by its sub-categories.
// Categories in alphabetical order, each main category followed by its sub-categories (also alphabetical).
const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base', numeric: true });
export function ordered(settings) {
  const all = [...(settings.categories || [])].sort(byName), out = [];
  for (const c of all) if (!c.parent || !all.some((p) => p.id === c.parent)) { out.push(c); for (const k of all) if (k.parent === c.id) out.push(k); }
  return out;
}
// The category tree: [{ main, subs: [...] }] in alphabetical order (sub-categories under their main one).
export function tree(settings) {
  const all = ordered(settings), out = [];
  for (const c of all) { if (!c.parent || !all.some((p) => p.id === c.parent)) out.push({ main: c, subs: [] }); else out[out.length - 1]?.subs.push(c); }
  return out;
}
// Chips laid out as the tree: a main category with sub-categories gets its own line (main, then ↳ subs); main
// categories without any flow together. chip(c) renders one chip.
export const treeChipsHTML = (settings, chip) => tree(settings).map(({ main, subs }) => (subs.length
  ? `<div class="cat-tree">${chip(main)}<span class="cat-tree-subs">${subs.map(chip).join('')}</span></div>` : chip(main))).join('');
// <option>s in tree order: sub-categories indented under their main category
export const treeOptionsHTML = (settings, selected = null, escFn = esc) => ordered(settings).map((c) => `<option value="${escFn(c.id)}" ${c.id === selected ? 'selected' : ''}>${c.parent ? '\u00a0\u00a0\u00a0↳ ' : ''}${escFn(catLabel(c))}</option>`).join('');
// "Work › Meetings" (with icons) for sub-categories.
export const fullLabel = (settings, c) => { const p = parentOf(settings, c); return p ? `${catLabel(p)} › ${catLabel(c)}` : catLabel(c); };
// A set of category ids plus all their sub-categories (counting "Work" also counts "Work › Meetings").
// Main categories that can take sub-categories (not themselves inside another).
export const mainCats = (settings, exceptId = null) => (settings.categories || []).filter((c) => !c.parent && c.id !== exceptId).sort(byName);

export function applyCategory(task, cat) {
  if (!cat) return { ...task, categoryId: null, categoryName: null, categoryColor: null, categoryIcon: null };
  return { ...task, categoryId: cat.id, categoryName: cat.name, categoryColor: cat.color, categoryIcon: cat.icon || null, color: cat.color };
}

export function newCategory(settings, name, color, icon = '', parent = null) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) || 'cat';
  const cat = { id: `${base}-${Math.random().toString(36).slice(2, 6)}`, name: name.trim(), color, icon: cleanIcon(icon), ...(parent && catById(settings, parent) ? { parent } : {}) };
  settings.categories = [...(settings.categories || []), cat];
  return cat;
}

// Tasks loaded from Google may use categories this browser doesn't know yet: add them.
export function adoptCategoriesFromTasks(settings, tasks) {
  let changed = false;
  for (const t of tasks) {
    if (t.categoryId && !catById(settings, t.categoryId) && t.categoryName) {
      settings.categories = [...(settings.categories || []), { id: t.categoryId, name: t.categoryName, color: t.categoryColor || t.color || CAT_COLORS[0], icon: t.categoryIcon || '' }];
      changed = true;
    }
  }
  return changed;
}

// After categories are renamed or recolored: bring tasks in line (returns ids of tasks that changed).
export function refreshTaskCategories(settings, tasks) {
  const changed = [];
  const out = tasks.map((t) => {
    if (!t.categoryId) return t;
    const c = catById(settings, t.categoryId);
    if (!c) { changed.push(t.id); return { ...applyCategory(t, null), rev: Date.now() }; }
    if (c.name !== t.categoryName || c.color !== t.categoryColor || c.color !== t.color || (c.icon || null) !== (t.categoryIcon || null)) { changed.push(t.id); return { ...applyCategory(t, c), rev: Date.now() }; }
    return t;
  });
  return { tasks: out, changed };
}

// Chips to pick a category, with "+ New" to add one on the spot.
// onChange(cat|null); onCreate(name, color) must return the new category (and save it).
// Compact picker for forms: one box showing the chosen category; clicking it opens a popup with all of them.
export function categoryPicker(host, opts) {
  if (!opts.compact) return chipPicker(host, opts);
  const { settings, onChange, allowNone = true } = opts;
  let sel = opts.selected || null;
  const draw = () => {
    const c = catById(settings, sel);
    setHTML(host, `<button type="button" class="cat-cur ${c ? 'set' : ''}" ${c ? `style="--c:${esc(c.color)}"` : ''} title="${c ? esc(fullLabel(settings, c)) + ' — click to change' : 'Pick a category'}">
      ${c ? `<i></i>${c.icon || parentOf(settings, c)?.icon ? `<span class="cat-ic">${esc(c.icon || parentOf(settings, c)?.icon)}</span>` : ''}<span class="cat-cur-n">${esc(c.parent ? `${parentOf(settings, c)?.name || ''} › ${c.name}` : c.name)}</span>` : '<span class="cat-cur-none">🏷 Category</span>'}<span class="cat-cur-caret">▾</span></button>`);
    host.querySelector('.cat-cur').onclick = async () => {
      let chosen;
      await modal(`<div class="choice cat-pop"><h2>Category</h2><div class="cat-pop-host"></div>
            <div class="actions"><button type="button" class="btn ghost" data-close>Cancel</button></div></div>`, (dlg, close) => {
          chipPicker(dlg.querySelector('.cat-pop-host'), { ...opts, selected: sel, allowNone, onChange: (x) => { chosen = { c: x }; close(); } });
        }, { cls: 'narrow' });
      const picked = chosen;
      if (!picked) return;
      sel = picked.c?.id || null; draw(); onChange(picked.c || null);
    };
  };
  draw();
  return { get value() { return catById(settings, sel); } };
}
function chipPicker(host, { settings, selected, onChange, onCreate, allowNone = true }) {
  let sel = selected || null;
  let adding = false;
  let newIcon = '', newParent = '';
  let newColor = CAT_COLORS.find((c) => !(settings.categories || []).some((x) => x.color === c)) || CAT_COLORS[0];
  const draw = () => {
    setHTML(host, `
      <div class="cat-chips">
        ${allowNone ? `<button type="button" class="cat-chip none ${!sel ? 'on' : ''}" data-cat="">None</button>` : ''}
        ${treeChipsHTML(settings, (c) => `<button type="button" class="cat-chip ${c.parent ? 'sub' : ''} ${sel === c.id ? 'on' : ''}" data-cat="${esc(c.id)}" style="--c:${esc(c.color)}" title="${esc(fullLabel(settings, c))}"><i></i>${c.parent ? '<span class="cat-sub">↳</span>' : ''}${c.icon ? `<span class="cat-ic">${esc(c.icon)}</span>` : ''}${esc(c.name)}</button>`)}
        <button type="button" class="cat-chip add" data-add="1">+ New</button>
      </div>
      ${adding ? `<div class="cat-new">
        <div class="row"><input class="cat-icon" placeholder="🙂" maxlength="8" aria-label="Icon" value="${esc(newIcon)}"><input class="cat-name" placeholder="New category, e.g. Leisure" maxlength="30">
          ${mainCats(settings).length ? `<select class="cat-parent" aria-label="Inside"><option value="">Main category</option>${mainCats(settings).map((c) => `<option value="${esc(c.id)}" ${newParent === c.id ? 'selected' : ''}>inside ${esc(catLabel(c))}</option>`).join('')}</select>` : ''}</div>
        <div class="icon-grid grouped">${iconGridHTML(settings, { keep: newIcon })}</div>
        ${swatchesHTML('catcolor', newColor)}
        <div class="row"><button type="button" class="btn small primary cat-save">Add</button><button type="button" class="btn small ghost cat-cancel">Cancel</button></div>
      </div>` : ''}`);
    $$('[data-cat]', host).forEach((b) => (b.onclick = () => { sel = b.dataset.cat || null; draw(); onChange(catById(settings, sel)); }));
    host.querySelector('[data-add]').onclick = () => { adding = true; draw(); host.querySelector('.cat-name').focus(); };
    if (adding) {
      const name = host.querySelector('.cat-name');
      wireSwatches(host.querySelector('.cat-new'), (c) => { newColor = c; });
      const iconIn = host.querySelector('.cat-icon');
      iconIn.oninput = () => { newIcon = iconIn.value; };
      host.querySelector('.cat-parent')?.addEventListener('change', (e) => { newParent = e.target.value; });
      $$('.ic-btn', host).forEach((b) => (b.onclick = () => { newIcon = iconIn.value = b.dataset.ic; $$('.ic-btn', host).forEach((x) => x.classList.toggle('on', x === b)); }));
      const save = async () => {
        const n = name.value.trim();
        if (!n) { name.focus(); return; }
        const cat = await onCreate(n, newColor, cleanIcon(newIcon), newParent || null);
        newIcon = ''; newParent = '';
        adding = false; sel = cat.id; draw(); onChange(cat);
      };
      host.querySelector('.cat-save').onclick = save;
      name.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } };
      host.querySelector('.cat-cancel').onclick = () => { adding = false; draw(); };
    }
  };
  draw();
  return { get value() { return catById(settings, sel); } };
}

// ---------- Events ----------
// An event's category is stored on the event itself (private extended properties, which only you see), so it
// travels with the event to every device. Events you can't edit keep their category in this browser only.
export function eventCategoryId(ev, localMap = {}) {
  const p = ev?.extendedProperties?.private || {};
  if (p.tempoCategory) return p.tempoCategory;
  return localMap[eventKey(ev)] || null;
}
export const eventKey = (ev) => `${ev._calId}|${ev.recurringEventId || ev.id}`;

// Fields to send to Google (or store locally) to give an event a category (or remove it).
export function eventCategoryChanges(ev, cat) {
  const priv = { ...(ev?.extendedProperties?.private || {}) };
  if (cat) Object.assign(priv, { tempoCategory: cat.id, tempoCatName: cat.name, tempoCatColor: cat.color, tempoCatIcon: cat.icon || '' });
  else Object.assign(priv, { tempoCategory: '', tempoCatName: '', tempoCatColor: '', tempoCatIcon: '' });
  return { colorId: cat ? nearestColorId(cat.color) : null, extendedProperties: { ...(ev?.extendedProperties || {}), private: priv } };
}

export function adoptCategoriesFromEvents(settings, events) {
  let changed = false;
  for (const ev of events) {
    const p = ev?.extendedProperties?.private || {};
    if (p.tempoCategory && p.tempoCatName && !catById(settings, p.tempoCategory)) {
      settings.categories = [...(settings.categories || []), { id: p.tempoCategory, name: p.tempoCatName, color: p.tempoCatColor || CAT_COLORS[0], icon: p.tempoCatIcon || '' }];
      changed = true;
    }
  }
  return changed;
}
