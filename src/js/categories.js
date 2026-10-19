// Task categories (Work, Personal, …): a name and a color. A task's color follows its category.
// Category colors come from Google Calendar's own palette, so sessions show the same color in Google.
import { $$, esc, setHTML } from './ui.js';
import { nearestColorId } from './gcal.js';

export const CAT_COLORS = ['#039be5', '#33b679', '#f6bf26', '#8e24aa', '#e67c73', '#f4511e', '#7986cb', '#0b8043', '#3f51b5', '#d50000', '#616161'];

export const catById = (settings, id) => (id ? (settings.categories || []).find((c) => c.id === id) || null : null);

export function applyCategory(task, cat) {
  if (!cat) return { ...task, categoryId: null, categoryName: null, categoryColor: null };
  return { ...task, categoryId: cat.id, categoryName: cat.name, categoryColor: cat.color, color: cat.color };
}

export function newCategory(settings, name, color) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) || 'cat';
  const cat = { id: `${base}-${Math.random().toString(36).slice(2, 6)}`, name: name.trim(), color };
  settings.categories = [...(settings.categories || []), cat];
  return cat;
}

// Tasks loaded from Google may use categories this browser doesn't know yet: add them.
export function adoptCategoriesFromTasks(settings, tasks) {
  let changed = false;
  for (const t of tasks) {
    if (t.categoryId && !catById(settings, t.categoryId) && t.categoryName) {
      settings.categories = [...(settings.categories || []), { id: t.categoryId, name: t.categoryName, color: t.categoryColor || t.color || CAT_COLORS[0] }];
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
    if (c.name !== t.categoryName || c.color !== t.categoryColor || c.color !== t.color) { changed.push(t.id); return { ...applyCategory(t, c), rev: Date.now() }; }
    return t;
  });
  return { tasks: out, changed };
}

// Chips to pick a category, with "+ New" to add one on the spot.
// onChange(cat|null); onCreate(name, color) must return the new category (and save it).
export function categoryPicker(host, { settings, selected, onChange, onCreate, allowNone = true }) {
  let sel = selected || null;
  let adding = false;
  let newColor = CAT_COLORS.find((c) => !(settings.categories || []).some((x) => x.color === c)) || CAT_COLORS[0];
  const draw = () => {
    setHTML(host, `
      <div class="cat-chips">
        ${allowNone ? `<button type="button" class="cat-chip none ${!sel ? 'on' : ''}" data-cat="">None</button>` : ''}
        ${(settings.categories || []).map((c) => `<button type="button" class="cat-chip ${sel === c.id ? 'on' : ''}" data-cat="${esc(c.id)}" style="--c:${esc(c.color)}"><i></i>${esc(c.name)}</button>`).join('')}
        <button type="button" class="cat-chip add" data-add="1">+ New</button>
      </div>
      ${adding ? `<div class="cat-new">
        <input class="cat-name" placeholder="New category, e.g. Leisure" maxlength="30">
        <div class="swatches">${CAT_COLORS.map((c) => `<label class="sw"><input type="radio" name="catcolor" value="${c}" ${c === newColor ? 'checked' : ''}><i style="background:${c}"></i></label>`).join('')}</div>
        <div class="row"><button type="button" class="btn small primary cat-save">Add</button><button type="button" class="btn small ghost cat-cancel">Cancel</button></div>
      </div>` : ''}`);
    $$('[data-cat]', host).forEach((b) => (b.onclick = () => { sel = b.dataset.cat || null; draw(); onChange(catById(settings, sel)); }));
    host.querySelector('[data-add]').onclick = () => { adding = true; draw(); host.querySelector('.cat-name').focus(); };
    if (adding) {
      const name = host.querySelector('.cat-name');
      $$('input[name=catcolor]', host).forEach((r) => (r.onchange = () => { newColor = r.value; }));
      const save = async () => {
        const n = name.value.trim();
        if (!n) { name.focus(); return; }
        const cat = await onCreate(n, newColor);
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
  if (cat) Object.assign(priv, { tempoCategory: cat.id, tempoCatName: cat.name, tempoCatColor: cat.color });
  else Object.assign(priv, { tempoCategory: '', tempoCatName: '', tempoCatColor: '' });
  return { colorId: cat ? nearestColorId(cat.color) : null, extendedProperties: { ...(ev?.extendedProperties || {}), private: priv } };
}

export function adoptCategoriesFromEvents(settings, events) {
  let changed = false;
  for (const ev of events) {
    const p = ev?.extendedProperties?.private || {};
    if (p.tempoCategory && p.tempoCatName && !catById(settings, p.tempoCategory)) {
      settings.categories = [...(settings.categories || []), { id: p.tempoCategory, name: p.tempoCatName, color: p.tempoCatColor || CAT_COLORS[0] }];
      changed = true;
    }
  }
  return changed;
}
