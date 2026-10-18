// Thin wrapper over extension storage; falls back to localStorage so the app also runs as a plain page
// (used for the demo build and for testing).
export const ext = globalThis.browser ?? globalThis.chrome;
// Running as a hosted web app (no extension APIs)?
export const isWeb = !(globalThis.browser ?? globalThis.chrome)?.runtime?.id;
export const isFirefox = typeof globalThis.browser !== 'undefined' && !!globalThis.browser?.runtime?.getBrowserInfo;
const area = ext?.storage?.local;
const PREFIX = 'tempo:';

export async function get(keys) {
  keys = [].concat(keys);
  if (area) return await area.get(keys);
  const out = {};
  for (const k of keys) {
    const v = localStorage.getItem(PREFIX + k);
    if (v != null) { try { out[k] = JSON.parse(v); } catch { /* ignore */ } }
  }
  return out;
}

export async function set(obj) {
  if (area) return await area.set(obj);
  for (const [k, v] of Object.entries(obj)) {
    try { localStorage.setItem(PREFIX + k, JSON.stringify(v)); } catch { /* quota or blocked */ }
  }
}

export async function remove(keys) {
  if (area) return await area.remove(keys);
  for (const k of [].concat(keys)) localStorage.removeItem(PREFIX + k);
}

export function onChanged(cb) {
  if (ext?.storage?.onChanged) ext.storage.onChanged.addListener((changes, a) => { if (a === 'local') cb(changes); });
}
