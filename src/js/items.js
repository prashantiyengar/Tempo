// Shared rules about calendar items (events and task sessions), used everywhere they are counted, matched or shown:
// what takes up time, what a category or word list matches, and how overlapping times add up.
// (No imports: game, goals, habits, analysis and the app all build on this.)

// ---------- what an item is ----------
export const isChunk = (it) => it.kind === 'chunk';
// a task session you chose not to do (it doesn't count anywhere)
export const isWaived = (it) => isChunk(it) && (it.status === 'waived' || it.sess?.kind === 'waived');
// an event marked "free" (transparent) on its calendar
export const isFree = (it) => it.ev?.transparency === 'transparent';
// Does it take up time? Not declined, not marked free, not a waived session — and all-day items only when `allDay`.
export function takesTime(it, { allDay = false } = {}) {
  if (it.declined || isFree(it) || isWaived(it)) return false;
  return !it.allDay || allDay;
}
export const catOf = (it) => (isChunk(it) ? it.task?.categoryId : it.catId) || null;
export const titleOf = (it) => (isChunk(it) ? `${it.task?.title || ''} ${it.title || ''}` : `${it.title || ''} ${it.ev?.summary || ''}`);

// ---------- matching words and categories ----------
// Text compared without case or accents ("Café" = "cafe")
export const fold = (x) => String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
export const reEscape = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Words match at the start of a word: "run" finds "Run", "running", "Morning run", but not "brunch".
// Returns (text) => boolean, or null when there are no words.
export function wordMatcher(words) {
  const ws = (words || []).map((w) => fold(String(w).trim())).filter(Boolean);
  if (!ws.length) return null;
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${ws.map(reEscape).join('|')})`, 'u');
  return (text) => re.test(fold(text));
}
// Category ids plus all their sub-categories (counting "Work" also counts "Work › Meetings")
export function withSubs(settings, ids) {
  const set = new Set(ids || []);
  for (const c of settings?.categories || []) if (c.parent && set.has(c.parent)) set.add(c.id);
  return set;
}
// (it) => boolean for "in these categories and/or with one of these words in the title".
// mode 'either' (default): any match counts; 'both': the category and a word. '__none' stands for no category.
// Items that take no time (declined, waived) never match; all-day items only with { allDay: true }.
export function itemMatcher({ cats = [], words = [], mode = 'either', allDay = false } = {}, settings = null) {
  const set = withSubs(settings, cats), wm = wordMatcher(words);
  return (it) => {
    if (it.declined || isWaived(it) || (it.allDay && !allDay)) return false;
    const byCat = set.size ? set.has(catOf(it) || '__none') : null, byText = wm ? wm(titleOf(it)) : null;
    if (byCat == null) return !!byText;
    if (byText == null) return byCat;
    return mode === 'both' ? byCat && byText : byCat || byText;
  };
}

// ---------- time ----------
// Total length of [start, end] pairs, overlaps counted once
export function unionLength(pairs) {
  const iv = [...pairs].filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let total = 0, cs = -Infinity, ce = -Infinity;
  for (const [a, b] of iv) { if (a > ce) { if (ce > cs) total += ce - cs; cs = a; ce = b; } else ce = Math.max(ce, b); }
  if (ce > cs) total += ce - cs;
  return total;
}
// Overlapping [start, end] pairs joined
export function mergePairs(pairs) {
  const out = [];
  for (const x of [...pairs].sort((a, b) => a[0] - b[0])) { const l = out[out.length - 1]; if (l && x[0] <= l[1]) l[1] = Math.max(l[1], x[1]); else out.push([...x]); }
  return out;
}
// The part of each item inside [from, to), as [start, end] pairs
export const clipPairs = (items, from, to) => items.map((it) => [Math.max(it.start, from), Math.min(it.end, to)]).filter(([a, b]) => b > a);
