// Weather forecast for the next 14 days, shown at the top of each day. Uses Open-Meteo (free, no account, no key):
// only the coordinates of the place you choose are sent. Refreshed every 30 minutes while Tempo is open (today's and
// tomorrow's forecasts change most), and whenever you come back to it after that.
import * as T from './tz.js';
import { ext } from './storage.js';

const API = 'https://api.open-meteo.com/v1/forecast';
const GEO = 'https://geocoding-api.open-meteo.com/v1/search';
export const ORIGINS = ['https://api.open-meteo.com/*', 'https://geocoding-api.open-meteo.com/*'];
const KEY = 'tempo:wx';
const FRESH = 30 * T.MIN;
export const DAYS = 14;

// WMO weather codes → icon + words
const CODES = [
  [[0], '☀️', 'Clear'], [[1], '🌤️', 'Mostly clear'], [[2], '⛅', 'Partly cloudy'], [[3], '☁️', 'Overcast'],
  [[45, 48], '🌫️', 'Fog'], [[51, 53, 55, 56, 57], '🌦️', 'Drizzle'], [[61, 63, 80, 81], '🌧️', 'Rain'], [[65, 82], '🌧️', 'Heavy rain'],
  [[66, 67], '🌧️', 'Freezing rain'], [[71, 73, 75, 77, 85, 86], '🌨️', 'Snow'], [[95], '⛈️', 'Thunderstorm'], [[96, 99], '⛈️', 'Thunderstorm with hail'],
];
export function describeCode(code) {
  const hit = CODES.find(([cs]) => cs.includes(+code));
  return hit ? { icon: hit[1], text: hit[2] } : { icon: '🌡️', text: 'Weather' };
}

export const enabled = (s) => !!(s?.weather?.on && Number.isFinite(+s.weather.lat) && Number.isFinite(+s.weather.lon));
// Fahrenheit only where it's the local custom (US and a few others) — judged by the time zone, since many
// browsers elsewhere are set to US English.
export const defaultUnit = (tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '') =>
  (/^(America\/(New_York|Chicago|Denver|Phoenix|Los_Angeles|Anchorage|Detroit|Boise|Indiana|Kentucky|North_Dakota|Juneau|Sitka|Nome|Adak|Menominee|Metlakatla|Yakutat|Puerto_Rico)|Pacific\/(Honolulu|Guam|Pago_Pago)|US\/|Africa\/Monrovia|Asia\/Yangon)/.test(tz) ? 'F' : 'C');
const locKey = (w) => `${(+w.lat).toFixed(2)},${(+w.lon).toFixed(2)},${w.model || 'best_match'}`;
// Forecast models (Open-Meteo). "Best match" picks the best local model for the place (e.g. DWD ICON in Germany).
export const MODELS = [['best_match', 'Best for the place (recommended)'], ['icon_seamless', 'DWD ICON — Germany & Europe'], ['ecmwf_ifs025', 'ECMWF — Europe, worldwide'], ['meteofrance_seamless', 'Météo-France — France & Europe'], ['ukmo_seamless', 'UK Met Office'], ['gfs_seamless', 'NOAA GFS — Americas, worldwide'], ['gem_seamless', 'Environment Canada GEM'], ['jma_seamless', 'JMA — Japan & Asia']];
const SEVERITY = (c) => (c >= 95 ? 9 : c >= 71 && c <= 77 || c >= 85 && c <= 86 ? 8 : c === 65 || c === 82 || c === 66 || c === 67 ? 7 : c >= 61 ? 6 : c >= 51 ? 5 : c >= 45 && c <= 48 ? 4 : c);
// What a day was really like while you're awake (07–22 local), from the hourly forecast. The daily weather code is the
// *worst* hour of the whole day (one shower at 3 am makes the day "rain"), so it overstates bad weather.
export function summarizeDay(hours, parts = true) {
  const wake = hours.filter((h) => h.hr >= 7 && h.hr < 22);
  if (!wake.length) return null;
  const wet = wake.filter((h) => (h.mm || 0) >= 0.1), mm = wake.reduce((a, h) => a + (h.mm || 0), 0);
  let code;
  if (wet.length >= 2 || mm >= 1) {
    const n = {}; for (const h of wet.length ? wet : wake) { const c = h.code ?? 61; n[c] = (n[c] || 0) + 1; }
    code = +Object.entries(n).sort((a, b) => b[1] - a[1] || SEVERITY(+b[0]) - SEVERITY(+a[0]))[0][0];
    if (code < 51) code = mm >= 4 ? 63 : 61;
  } else if (wake.filter((h) => h.code === 45 || h.code === 48).length >= 4) code = 45;
  else {
    const cc = wake.map((h) => h.cloud).filter((x) => x != null).sort((a, b) => a - b);
    const med = cc.length ? cc[Math.floor(cc.length / 2)] : null;
    if (med == null) { const n = {}; for (const h of wake) if (h.code != null && h.code <= 3) n[h.code] = (n[h.code] || 0) + 1; code = +(Object.entries(n).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 2); }
    else code = med < 20 ? 0 : med < 45 ? 1 : med < 75 ? 2 : 3;
    if (wet.length === 1 && code < 51) code = Math.max(code, 2); // one short shower: at most partly cloudy, noted below
  }
  const probs = wake.map((h) => h.prob).filter((x) => x != null);
  const part = (a, b) => { const hs = wake.filter((h) => h.hr >= a && h.hr < b); if (!hs.length) return null; const t = hs.map((h) => h.t).filter((x) => x != null); const s = summarizeDay(hs.map((h) => ({ ...h, hr: 12 })), false) || {}; return { code: s.code, t: t.length ? Math.round(t.reduce((x, y) => x + y, 0) / t.length * 10) / 10 : null, mm: +hs.reduce((x, h) => x + (h.mm || 0), 0).toFixed(1) }; };
  return { code, rain: probs.length ? Math.max(...probs) : null, wakeMM: +mm.toFixed(1), showers: wet.length, parts: parts && hours.length > 3 ? { morning: part(7, 12), afternoon: part(12, 18), evening: part(18, 22) } : null };
}

let mem = null;
function load() {
  if (mem) return mem;
  try { mem = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { mem = null; }
  return mem;
}
function save(v) { mem = v; try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* storage full or blocked */ } }

// Weather of past days is kept (per device), so days that have passed still show what the weather was.
const HIST = 'tempo:wxHistory';
let hist = null;
function loadHist() { if (!hist) { try { hist = JSON.parse(localStorage.getItem(HIST) || '{}'); } catch { hist = {}; } } return hist; }
function saveHist(todayKey, days, place) {
  const h = loadHist();
  for (const [k, d] of Object.entries(days)) if (k <= todayKey && d.max != null) h[k] = { ...d, place: place || h[k]?.place || '' };
  const keys = Object.keys(h).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - 800))) delete h[k];
  try { localStorage.setItem(HIST, JSON.stringify(h)); } catch { /* storage full or blocked */ }
}
export const history = () => loadHist();

export function forecast(s) {
  if (!enabled(s)) return null;
  const c = load();
  return c && c.loc === locKey(s.weather) ? c.days : null;
}
export function current(s) { const c = load(); return enabled(s) && c && c.loc === locKey(s.weather) ? { ...(c.cur || {}), updated: c.at } : null; }

// Fetch when missing or older than 30 minutes. Resolves true when new data arrived (so the caller re-renders).
let inflight = null;
export function refresh(s, { force = false } = {}) {
  if (!enabled(s)) return Promise.resolve(false);
  const c = load();
  if (!force && c && c.loc === locKey(s.weather) && Date.now() - c.at < FRESH) return Promise.resolve(false);
  if (inflight) return inflight;
  const q = new URLSearchParams({ latitude: (+s.weather.lat).toFixed(3), longitude: (+s.weather.lon).toFixed(3),
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum',
    hourly: 'weather_code,temperature_2m,precipitation,precipitation_probability,cloud_cover', current: 'temperature_2m,weather_code',
    timezone: s.tz || 'auto', forecast_days: '16', past_days: '31', ...(s.weather.model && s.weather.model !== 'best_match' ? { models: s.weather.model } : {}) });
  inflight = fetch(`${API}?${q}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error('Weather ' + r.status)))).then((j) => {
    const d = j.daily || {}, days = {};
    (d.time || []).forEach((k, i) => { days[k] = { code: d.weather_code?.[i], max: d.temperature_2m_max?.[i], min: d.temperature_2m_min?.[i], rain: d.precipitation_probability_max?.[i], mm: d.precipitation_sum?.[i] }; });
    // the hourly forecast says what the day is like while you're awake (the daily code is its worst hour)
    const hr = j.hourly || {}, byDay = {};
    (hr.time || []).forEach((t, i) => { const k = t.slice(0, 10); (byDay[k] ||= []).push({ hr: +t.slice(11, 13), code: hr.weather_code?.[i], t: hr.temperature_2m?.[i], mm: hr.precipitation?.[i], prob: hr.precipitation_probability?.[i], cloud: hr.cloud_cover?.[i] }); });
    for (const [k, hs] of Object.entries(byDay)) {
      if (!days[k] || hs.every((h) => h.code == null)) continue;
      const sm = summarizeDay(hs); if (!sm) continue;
      days[k] = { ...days[k], worst: days[k].code, code: sm.code, rain: sm.rain ?? days[k].rain, wakeMM: sm.wakeMM, showers: sm.showers, parts: sm.parts };
    }
    const cur = j.current && j.current.temperature_2m != null ? { t: j.current.temperature_2m, code: j.current.weather_code, at: Date.now() } : null;
    save({ loc: locKey(s.weather), at: Date.now(), days, cur });
    saveHist(T.dayKey(Date.now(), s.tz), days, (s.weather.name || '').split(',')[0]);
    return true;
  }).catch((e) => { console.warn('Tempo: weather unavailable', e); return false; }).finally(() => { inflight = null; });
  return inflight;
}

export const temp = (c, unit) => (c == null || !Number.isFinite(+c) ? '–' : `${Math.round(unit === 'F' ? (+c * 9) / 5 + 32 : +c)}°`);

// Small label for one day (only for today … 13 days ahead).
export function dayHTML(s, key, todayKey, { month = false } = {}) {
  if (!s?.weather?.on) return '';
  const past = key < todayKey;
  let d;
  if (past) d = loadHist()[key];
  else { const days = forecast(s); if (!days || key > T.addDays(todayKey, DAYS - 1)) return ''; d = days[key]; }
  if (!d) return '';
  const u = s.weather.unit || 'C', { icon, text } = describeCode(d.code);
  const where = past ? d.place : (s.weather.name || '').split(',')[0];
  const fmm = (x) => `${(+x).toFixed(+x < 10 ? 1 : 0)} mm`;
  const rainTxt = d.wakeMM != null ? (d.wakeMM >= 0.1 ? ` · ${fmm(d.wakeMM)} rain 7–22 h` : d.showers ? ' · a short shower' : ' · dry 7–22 h') + (!past && d.rain != null ? ` (chance ${d.rain}%)` : '') : past ? (d.mm != null ? ` · ${fmm(d.mm)} rain` : '') : d.rain != null ? ` · rain ${d.rain}%` : '';
  const P = d.parts ? [['Morning', d.parts.morning], ['Afternoon', d.parts.afternoon], ['Evening', d.parts.evening]].filter(([, x]) => x).map(([n, x]) => `${n} ${describeCode(x.code).icon} ${temp(x.t, u)}${x.mm >= 0.1 ? ` ${fmm(x.mm)}` : ''}`).join(' · ') : '';
  const cur = key === todayKey ? current(s) : null;
  const tip = `${past ? 'Weather that day: ' : ''}${cur?.t != null ? `Now ${temp(cur.t, u)} ${describeCode(cur.code).text.toLowerCase()} · ` : ''}${text} · ${temp(d.max, u)} / ${temp(d.min, u)}${rainTxt}${where ? ` · ${where}` : ''}${P ? `\n${P}` : ''}${d.worst != null && SEVERITY(+d.worst) > SEVERITY(+d.code) + 1 ? `\nAt some point: ${describeCode(d.worst).text.toLowerCase()}` : ''}${cur?.updated && !past ? `\nUpdated ${new Date(cur.updated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}`;
  const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return month
    ? `<span class="wx wx-m ${past ? 'past' : ''}" title="${esc(tip)}"><span class="wx-i">${icon}</span>${temp(d.max, u)}</span>`
    : `<span class="wx ${past ? 'past' : ''}" title="${esc(tip)}"><span class="wx-i">${icon}</span>${cur?.t != null ? `<span class="wx-now" title="Now">${temp(cur.t, u)}</span>` : ''}<span class="wx-hi">${temp(d.max, u)}</span><span class="wx-lo">${temp(d.min, u)}</span></span>`;
}

export async function geocode(name) {
  const q = new URLSearchParams({ name, count: '6', language: (globalThis.navigator?.language || 'en').slice(0, 2), format: 'json' });
  const r = await fetch(`${GEO}?${q}`);
  if (!r.ok) throw new Error('Place search failed (' + r.status + ')');
  const j = await r.json();
  return (j.results || []).map((x) => ({ name: [x.name, x.admin1, x.country].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', '), lat: x.latitude, lon: x.longitude }));
}

// Extension: ask for access to the weather service (no-op in the web app).
export async function askPermission() {
  const perms = ext?.permissions;
  if (!perms?.request) return true;
  try { if (await perms.contains({ origins: ORIGINS })) return true; } catch { /* ignore */ }
  return perms.request({ origins: ORIGINS }).catch(() => false);
}
