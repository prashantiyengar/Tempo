// Google Calendar API v3 client.
// Sign-in paths:
//   • Chrome with a built-in "Chrome extension" client  → identity.getAuthToken (one click, auto refresh)
//   • extension otherwise → identity.launchWebAuthFlow with either the built-in web client or the user's own client ID
//   • web app (phones, any browser) → full-page OAuth redirect back to the app; renewed silently when the app opens
import { ext, isFirefox, isWeb, get, set } from './storage.js';
import { WEB_CLIENT_ID, CHROME_CLIENT_ID } from './config.js';

const API = 'https://www.googleapis.com/calendar/v3';
export const CAL_SCOPE = 'https://www.googleapis.com/auth/calendar';
const SCOPES = [CAL_SCOPE, 'openid', 'email'];

export class AuthError extends Error { constructor(msg) { super(msg); this.name = 'AuthError'; } }
export class PermissionError extends Error { constructor(msg) { super(msg); this.name = 'PermissionError'; } }

export function redirectUri() {
  if (isWeb) return location.origin + location.pathname.replace(/index\.html$/, '').replace(/app\.html$/, '');
  try { return ext?.identity?.getRedirectURL?.() || ''; } catch { return ''; }
}
export function identityAvailable() { return isWeb || !!ext?.identity?.launchWebAuthFlow; }
const chromeNative = () => !isFirefox && !!CHROME_CLIENT_ID && !!ext?.identity?.getAuthToken && !!ext?.runtime?.getManifest?.()?.oauth2;
export const builtinAvailable = () => !!WEB_CLIENT_ID || chromeNative();

// Which client a given auth record uses.
export function clientFor(a) {
  if (a.mode === 'builtin') return chromeNative() ? { kind: 'chrome' } : (WEB_CLIENT_ID ? { kind: 'web', id: WEB_CLIENT_ID } : null);
  return a.clientId ? { kind: 'web', id: a.clientId.trim() } : null;
}
export const hasClient = (a) => !!(a && clientFor(a));

async function getAuth() { return (await get('auth')).auth || {}; }
async function setAuth(patch) { const a = await getAuth(); await set({ auth: { ...a, ...patch } }); }

// Firefox MV3 does not grant host permissions at install time. Must be called from a click handler.
export async function ensureHostPermission() {
  if (!ext?.permissions?.request) return true;
  const origins = ['https://www.googleapis.com/*', 'https://openidconnect.googleapis.com/*', 'https://oauth2.googleapis.com/*'];
  try { if (await ext.permissions.contains({ origins })) return true; return await ext.permissions.request({ origins }); }
  catch { return true; }
}

let pendingToken = null;

export async function getToken(interactive = false) {
  const a = await getAuth();
  const client = clientFor(a);
  if (!client) throw new AuthError('Google Calendar is not set up yet. Open Settings → Google Calendar.');
  if (!interactive && !a.connected) throw new AuthError('Not connected to Google.');
  if (client.kind === 'web' && a.token && a.expires > Date.now() + 60000) return a.token;
  if (!identityAvailable()) throw new AuthError('Signing in only works when Tempo is installed as an extension.');
  if (isWeb) {
    if (interactive) return redirectToGoogle(client.id, a, 'interactive');
    await setAuth({ needsReconnect: true });
    throw new AuthError('Google sign-in expired — tap Reconnect.');
  }
  if (pendingToken) return pendingToken;
  pendingToken = (client.kind === 'chrome' ? chromeToken(interactive) : webToken(client.id, a, interactive));
  try { return await pendingToken; } finally { pendingToken = null; }
}

async function chromeToken(interactive) {
  let r;
  try { r = await ext.identity.getAuthToken({ interactive, scopes: SCOPES }); }
  catch (e) { throw new AuthError(interactive ? (e.message || String(e)) : 'Google sign-in expired — click Reconnect.'); }
  const token = typeof r === 'string' ? r : r?.token;
  if (!token) throw new AuthError('Google did not return a sign-in token.');
  const granted = typeof r === 'object' && r?.grantedScopes ? r.grantedScopes : null;
  if (granted && !granted.includes(CAL_SCOPE)) throw new PermissionError(SCOPE_MSG);
  await setAuth({ token, expires: Date.now() + 50 * 60000, connected: true, needsReconnect: false, lastAuthError: null });
  return token;
}

// Show Google's permission screen only the first time (or after permissions went missing); afterwards just let the
// user pick the account, which skips the "unverified app" screen.
const promptFor = (a, interactive) => (!interactive ? 'none' : a.consented ? 'select_account' : 'select_account consent');

export const SCOPE_MSG = 'Google did not grant calendar access. Reconnect and tick the box “See, edit, share and permanently delete all the calendars…” on Google’s permission screen.';

async function webToken(clientId, a, interactive) {
  const params = new URLSearchParams({
    client_id: clientId, response_type: 'token', redirect_uri: redirectUri(),
    scope: SCOPES.join(' '), include_granted_scopes: 'true',
  });
  params.set('prompt', promptFor(a, interactive));
  if (a.email) params.set('login_hint', a.email);
  const details = { url: 'https://accounts.google.com/o/oauth2/v2/auth?' + params, interactive };
  if (!isFirefox && !interactive) { details.abortOnLoadForNonInteractive = false; details.timeoutMsForNonInteractive = 10000; }
  let resultUrl;
  try { resultUrl = await ext.identity.launchWebAuthFlow(details); }
  catch (e) {
    if (!interactive) await setAuth({ needsReconnect: true, lastAuthError: e.message || String(e) });
    throw new AuthError(interactive ? (e.message || String(e)) : 'Google sign-in expired — click Reconnect.');
  }
  const frag = new URLSearchParams(new URL(resultUrl).hash.slice(1));
  if (frag.get('error')) {
    const err = frag.get('error');
    if (!interactive) await setAuth({ needsReconnect: true, lastAuthError: err });
    const hint = { redirect_uri_mismatch: ' The redirect URI is not registered on your OAuth client — copy it from Settings into the Google Cloud console.', access_denied: ' Access was denied (are you added as a Test user on the consent screen?).', invalid_client: ' The client ID is wrong.' }[err] || '';
    throw new AuthError('Google: ' + err + '.' + hint);
  }
  const token = frag.get('access_token');
  if (!token) throw new AuthError('No access token returned.');
  const scope = frag.get('scope') || '';
  if (scope && !scope.split(' ').includes(CAL_SCOPE)) { await setAuth({ token, expires: 0, consented: false }); throw new PermissionError(SCOPE_MSG); }
  const expires = Date.now() + (+frag.get('expires_in') || 3600) * 1000;
  await setAuth({ token, expires, connected: true, needsReconnect: false, lastAuthError: null, consented: true });
  return token;
}

// ---------- Web app: OAuth by redirecting the whole page to Google and back ----------
const RS = 'tempo:oauth';
export function redirectToGoogle(clientId, a, kind = 'interactive', returnState = {}) {
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  sessionStorage.setItem(RS, JSON.stringify({ nonce, kind, at: Date.now(), ret: returnState }));
  const params = new URLSearchParams({
    client_id: clientId, response_type: 'token', redirect_uri: redirectUri(),
    scope: SCOPES.join(' '), include_granted_scopes: 'true', state: nonce,
    prompt: promptFor(a, kind !== 'silent'),
  });
  if (a.email) params.set('login_hint', a.email);
  location.assign('https://accounts.google.com/o/oauth2/v2/auth?' + params);
  return new Promise(() => {}); // the page is navigating away
}

// Call once at startup: picks up the token Google sent back in the URL fragment.
// Returns null (nothing to do) or { ok, kind, error, ret }.
export async function completeRedirect() {
  if (!isWeb || !location.hash.includes('state=')) return null;
  const frag = new URLSearchParams(location.hash.slice(1));
  let pending = null;
  try { pending = JSON.parse(sessionStorage.getItem(RS) || 'null'); } catch { /* ignore */ }
  sessionStorage.removeItem(RS);
  history.replaceState(null, '', location.pathname + location.search);
  if (!pending || frag.get('state') !== pending.nonce) return { ok: false, error: 'Sign-in response did not match — please try again.' };
  const kind = pending.kind, ret = pending.ret || {};
  const err = frag.get('error');
  if (err) {
    await setAuth({ needsReconnect: true, lastAuthError: err });
    const hint = { redirect_uri_mismatch: ' The app address is not registered on your OAuth client — add it under “Authorized redirect URIs”.', access_denied: ' Access was denied (are you added as a Test user on the consent screen?).', invalid_client: ' The client ID is wrong.', interaction_required: '', login_required: '' }[err] ?? '';
    if (err === 'consent_required') await setAuth({ consented: false });
    return { ok: false, kind, ret, code: err, error: 'Google: ' + err + '.' + hint };
  }
  const token = frag.get('access_token');
  const scope = frag.get('scope') || '';
  if (!token) return { ok: false, kind, ret, error: 'No access token returned.' };
  if (scope && !scope.split(' ').includes(CAL_SCOPE)) { await setAuth({ token: null, expires: 0, needsReconnect: true, consented: false }); return { ok: false, kind, ret, error: SCOPE_MSG, code: 'scope' }; }
  await setAuth({ token, expires: Date.now() + (+frag.get('expires_in') || 3600) * 1000, connected: true, needsReconnect: false, lastAuthError: null, consented: true });
  if (kind === 'interactive') {
    try { const info = await req('GET', 'https://openidconnect.googleapis.com/v1/userinfo'); await setAuth({ email: info.email }); } catch { /* cosmetic */ }
  }
  return { ok: true, kind, ret };
}

// Web app: token missing/expired but the user has connected before → renew without a prompt.
export async function needsSilentRenew() {
  if (!isWeb) return false;
  const a = await getAuth();
  return !!(a.connected && clientFor(a) && !(a.token && a.expires > Date.now() + 60000));
}
export async function silentRenew(returnState) {
  const a = await getAuth();
  const c = clientFor(a);
  if (c) return redirectToGoogle(c.id, a, 'silent', returnState);
}
export async function reconnect(returnState) {
  const a = await getAuth();
  const c = clientFor(a);
  if (!c) throw new AuthError('Google Calendar is not set up yet. Open Settings → Google Calendar.');
  if (isWeb) return redirectToGoogle(c.id, a, 'interactive', returnState);
  return connect(a.mode || 'custom');
}

export async function connect(mode = 'custom') {
  const a = await getAuth();
  if (a.token && clientFor(a)?.kind === 'chrome') { try { await ext.identity.removeCachedAuthToken({ token: a.token }); } catch { /* ignore */ } }
  await setAuth({ mode, token: null, expires: 0, connected: false });
  await getToken(true);
  try {
    const info = await req('GET', 'https://openidconnect.googleapis.com/v1/userinfo');
    await setAuth({ email: info.email });
  } catch { /* email is cosmetic */ }
  // Prove we can actually read calendars before calling it connected.
  await req('GET', '/users/me/calendarList', { query: { maxResults: 1 } });
}

export async function disconnect() {
  const a = await getAuth();
  if (a.token) {
    try { await fetch('https://oauth2.googleapis.com/revoke?token=' + a.token, { method: 'POST' }); } catch { /* ignore */ }
    if (clientFor(a)?.kind === 'chrome') { try { await ext.identity.removeCachedAuthToken({ token: a.token }); } catch { /* ignore */ } }
  }
  await setAuth({ token: null, expires: 0, connected: false, email: null, needsReconnect: false });
}

export async function isConnected() { const a = await getAuth(); return !!(a.connected && hasClient(a)); }

async function dropToken() {
  const a = await getAuth();
  if (a.token && clientFor(a)?.kind === 'chrome') { try { await ext.identity.removeCachedAuthToken({ token: a.token }); } catch { /* ignore */ } }
  await setAuth({ token: null, expires: 0 });
}

async function req(method, path, { query, body, retry = true } = {}) {
  const token = await getToken(false);
  const url = new URL(path.startsWith('http') ? path : API + path);
  if (query) for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && retry) { await dropToken(); return req(method, path, { query, body, retry: false }); }
  if (res.status === 429 && retry) { await new Promise((r) => setTimeout(r, 1500)); return req(method, path, { query, body, retry: false }); }
  if (res.status === 204 || res.status === 410) return null;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || `Google API error ${res.status}`;
    if (res.status === 403 && /insufficient|scope|permission/i.test(msg) && !/writer|owner|access to/i.test(msg)) await setAuth({ consented: false });
    if (res.status === 403 && /insufficient|scope|permission/i.test(msg)) throw new PermissionError(/writer|owner|access to/i.test(msg) ? `You don't have write access to that calendar (${msg}).` : SCOPE_MSG);
    if (res.status === 401) { await setAuth({ needsReconnect: true }); throw new AuthError('Google sign-in expired — click Reconnect.'); }
    throw new Error(msg);
  }
  return json;
}

const enc = encodeURIComponent;

export async function listCalendars() {
  const out = [];
  let pageToken;
  do {
    const r = await req('GET', '/users/me/calendarList', { query: { pageToken, maxResults: 250 } });
    out.push(...(r.items || []));
    pageToken = r.nextPageToken;
  } while (pageToken);
  return out;
}

export async function listEvents(calId, timeMin, timeMax) {
  const out = [];
  let pageToken;
  do {
    const r = await req('GET', `/calendars/${enc(calId)}/events`, {
      query: {
        timeMin: new Date(timeMin).toISOString(), timeMax: new Date(timeMax).toISOString(),
        singleEvents: 'true', orderBy: 'startTime', maxResults: 2500, pageToken,
      },
    });
    out.push(...(r.items || []));
    pageToken = r.nextPageToken;
  } while (pageToken);
  return out;
}

// Changes in this calendar after `sinceMs` (Google's clock). Returns { n, max } — max is the newest change time seen,
// to be used as the next cursor so a device with a wrong clock never loops.
export async function changedSince(calId, sinceMs) {
  const r = await req('GET', `/calendars/${enc(calId)}/events`, {
    query: { updatedMin: new Date(sinceMs).toISOString(), showDeleted: 'true', maxResults: 20, singleEvents: 'true', fields: 'items(id,updated,status)' },
  });
  const ts = (r.items || []).map((e) => Date.parse(e.updated)).filter((t) => t > sinceMs);
  return { n: ts.length, max: ts.length ? Math.max(...ts) : sinceMs };
}
export const getEvent = (calId, id) => req('GET', `/calendars/${enc(calId)}/events/${enc(id)}`);
export const insertEvent = (calId, body, { conference = false } = {}) =>
  req('POST', `/calendars/${enc(calId)}/events`, { body, query: { conferenceDataVersion: conference ? 1 : null, sendUpdates: body.attendees?.length ? 'all' : null } });
export const patchEvent = (calId, id, body, { conference = false, notify = false } = {}) =>
  req('PATCH', `/calendars/${enc(calId)}/events/${enc(id)}`, { body, query: { conferenceDataVersion: conference ? 1 : null, sendUpdates: notify ? 'all' : null } });
export const deleteEvent = (calId, id) => req('DELETE', `/calendars/${enc(calId)}/events/${enc(id)}`).catch((e) => {
  if (/not found|deleted/i.test(e.message)) return null; throw e;
});
// Calendar-level notification settings (e.g. Google's daily agenda email).
export const patchCalendarListEntry = (calId, body) => req('PATCH', `/users/me/calendarList/${enc(calId)}`, { body });
export const createCalendar = (summary, timeZone) => req('POST', '/calendars', { body: { summary, timeZone } });
export const getSettingTz = () => req('GET', '/users/me/settings/timezone').then((r) => r?.value);
export const getColors = () => req('GET', '/colors');

export async function listTaskEvents(calId, timeMin, timeMax) {
  const r = await req('GET', `/calendars/${enc(calId)}/events`, {
    query: { timeMin: new Date(timeMin).toISOString(), timeMax: new Date(timeMax).toISOString(), privateExtendedProperty: 'tempoTask=1', maxResults: 2500, singleEvents: 'true' },
  });
  return r.items || [];
}

// Google's fixed event palette (colorId -> background)
export const EVENT_COLORS = {
  1: '#7986cb', 2: '#33b679', 3: '#8e24aa', 4: '#e67c73', 5: '#f6bf26', 6: '#f4511e',
  7: '#039be5', 8: '#616161', 9: '#3f51b5', 10: '#0b8043', 11: '#d50000',
};
export function nearestColorId(hex) {
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const a = rgb(hex);
  let best = '7', bd = Infinity;
  for (const [id, c] of Object.entries(EVENT_COLORS)) {
    const b = rgb(c);
    const d = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
    if (d < bd) { bd = d; best = id; }
  }
  return best;
}
