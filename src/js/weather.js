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
const locKey = (w) => `${(+w.lat).toFixed(2)},${(+w.lon).toFixed(2)}`;

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

// Fetch when missing or older than 30 minutes. Resolves true when new data arrived (so the caller re-renders).
let inflight = null;
export function refresh(s, { force = false } = {}) {
  if (!enabled(s)) return Promise.resolve(false);
  const c = load();
  if (!force && c && c.loc === locKey(s.weather) && Date.now() - c.at < FRESH) return Promise.resolve(false);
  if (inflight) return inflight;
  const q = new URLSearchParams({ latitude: (+s.weather.lat).toFixed(3), longitude: (+s.weather.lon).toFixed(3),
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum', timezone: 'auto', forecast_days: '16', past_days: '31' });
  inflight = fetch(`${API}?${q}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error('Weather ' + r.status)))).then((j) => {
    const d = j.daily || {}, days = {};
    (d.time || []).forEach((k, i) => { days[k] = { code: d.weather_code?.[i], max: d.temperature_2m_max?.[i], min: d.temperature_2m_min?.[i], rain: d.precipitation_probability_max?.[i], mm: d.precipitation_sum?.[i] }; });
    save({ loc: locKey(s.weather), at: Date.now(), days });
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
  const tip = `${past ? 'Weather that day: ' : ''}${text} · ${temp(d.max, u)} / ${temp(d.min, u)}${past ? (d.mm != null ? ` · ${(+d.mm).toFixed(+d.mm < 10 ? 1 : 0)} mm rain` : '') : d.rain != null ? ` · rain ${d.rain}%` : ''}${where ? ` · ${where}` : ''}`;
  const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return month
    ? `<span class="wx wx-m ${past ? 'past' : ''}" title="${esc(tip)}"><span class="wx-i">${icon}</span>${temp(d.max, u)}</span>`
    : `<span class="wx ${past ? 'past' : ''}" title="${esc(tip)}"><span class="wx-i">${icon}</span><span class="wx-hi">${temp(d.max, u)}</span><span class="wx-lo">${temp(d.min, u)}</span></span>`;
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
