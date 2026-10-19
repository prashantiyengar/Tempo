// Other calendars shown next to your main Google account: more Google accounts, Outlook / Microsoft 365, iCloud
// (CalDAV, browser extension only), and calendar links (.ics). They are shown in the views and can count as busy
// time for task planning; creating and editing events stays in your main Google account.
// Accounts (with their sign-in tokens or app passwords) are kept on this device only.
import { ext, isWeb, get, set } from './storage.js';
import * as T from './tz.js';
import { parseRRule, expand } from './rrule.js';
import { OUTLOOK_CLIENT_ID } from './config.js';

let ACC = null;
const cache = new Map();
const TTL = 3 * 60 * 1000;
export const GRAPH = 'https://graph.microsoft.com/v1.0';
const GAPI = 'https://www.googleapis.com/calendar/v3';

export async function loadAccounts() { if (!ACC) ACC = (await get('accounts')).accounts || []; return ACC; }
export async function saveAccounts() { await set({ accounts: ACC || [] }); }
export const accounts = () => ACC || [];
export function invalidateExternal() { cache.clear(); }
export const extCalId = (acct, cal) => `x:${acct.id}:${cal.id}`;
export function extCalendars() {
  return accounts().flatMap((a) => (a.calendars || []).map((c) => ({ ...c, account: a, key: extCalId(a, c) })));
}
const newId = () => Math.random().toString(36).slice(2, 10);
const redirectUri = () => (isWeb ? location.origin + location.pathname.replace(/(index|app)\.html$/, '') : ext?.identity?.getRedirectURL?.() || '');

// ---------- Sign-in (implicit OAuth: popup on the web, identity API in the extension) ----------
async function oauth(url, interactive = true) {
  if (!isWeb) {
    const res = await ext.identity.launchWebAuthFlow({ url, interactive });
    return new URLSearchParams(new URL(res).hash.slice(1));
  }
  if (!interactive) throw new Error('Sign-in expired');
  return new Promise((resolve, reject) => {
    const w = window.open(url, 'tempo-auth', 'width=520,height=680');
    if (!w) { reject(new Error('The sign-in window was blocked — allow pop-ups for this site and try again.')); return; }
    const onMsg = (e) => {
      if (e.origin !== location.origin || e.data?.type !== 'tempo-auth') return;
      cleanup(); resolve(new URLSearchParams(String(e.data.hash).replace(/^#/, '')));
    };
    const timer = setInterval(() => { if (w.closed) { cleanup(); reject(new Error('Sign-in window closed')); } }, 800);
    const cleanup = () => { clearInterval(timer); removeEventListener('message', onMsg); };
    addEventListener('message', onMsg);
  });
}
// In the web app the sign-in popup lands on the app itself: hand the result to the opener and close.
export function handlePopupReturn() {
  if (!isWeb || !window.opener || !/state=acct\./.test(location.hash)) return false;
  try { window.opener.postMessage({ type: 'tempo-auth', hash: location.hash }, location.origin); } catch { /* opener gone */ }
  window.close();
  return true;
}
function checkFrag(frag, nonce) {
  if (frag.get('error')) throw new Error(`${frag.get('error')}${frag.get('error_description') ? ': ' + frag.get('error_description').split('\n')[0] : ''}`);
  if (frag.get('state') !== nonce) throw new Error('Sign-in response did not match — please try again.');
  const token = frag.get('access_token');
  if (!token) throw new Error('No access token returned.');
  return { token, expires: Date.now() + (+frag.get('expires_in') || 3600) * 1000 };
}

async function googleSignIn(clientId, acct, interactive) {
  const nonce = 'acct.' + newId();
  const p = new URLSearchParams({ client_id: clientId, response_type: 'token', redirect_uri: redirectUri(), state: nonce,
    scope: 'https://www.googleapis.com/auth/calendar.readonly openid email', prompt: acct?.email && !interactive ? 'none' : 'select_account' });
  if (acct?.email) p.set('login_hint', acct.email);
  const t = checkFrag(await oauth('https://accounts.google.com/o/oauth2/v2/auth?' + p, interactive), nonce);
  let email = acct?.email;
  if (!email) { try { email = (await (await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: 'Bearer ' + t.token } })).json()).email; } catch { /* cosmetic */ } }
  return { ...t, email };
}
async function outlookSignIn(clientId, acct, interactive) {
  const nonce = 'acct.' + newId();
  const p = new URLSearchParams({ client_id: clientId, response_type: 'token', redirect_uri: redirectUri(), state: nonce, nonce,
    scope: 'openid profile email https://graph.microsoft.com/Calendars.Read', response_mode: 'fragment', prompt: interactive ? 'select_account' : 'none' });
  if (acct?.email) p.set('login_hint', acct.email);
  const t = checkFrag(await oauth('https://login.microsoftonline.com/common/oauth2/v2.0/authorize?' + p, interactive), nonce);
  let email = acct?.email;
  if (!email) { try { const me = await (await fetch(GRAPH + '/me', { headers: { Authorization: 'Bearer ' + t.token } })).json(); email = me.mail || me.userPrincipalName; } catch { /* cosmetic */ } }
  return { ...t, email };
}

async function tokenFor(acct, interactive = false) {
  if (acct.token && acct.expires > Date.now() + 60000) return acct.token;
  const t = acct.type === 'google' ? await googleSignIn(acct.clientId, acct, interactive) : await outlookSignIn(acct.clientId, acct, interactive);
  Object.assign(acct, { token: t.token, expires: t.expires, needsReconnect: false, error: null });
  await saveAccounts();
  return t.token;
}

async function api(acct, url, opts = {}) {
  let token;
  try { token = await tokenFor(acct); }
  catch (e) { acct.needsReconnect = true; acct.error = 'Sign-in expired — reconnect'; await saveAccounts(); throw e; }
  const res = await fetch(url, { ...opts, headers: { Authorization: 'Bearer ' + token, ...(opts.headers || {}) } });
  if (res.status === 401) { acct.token = null; acct.needsReconnect = true; acct.error = 'Sign-in expired — reconnect'; await saveAccounts(); throw new Error(acct.error); }
  if (!res.ok) throw new Error(`${acct.label}: error ${res.status}`);
  return res.json();
}

// ---------- Adding accounts ----------
export async function addGoogle(clientId) {
  if (!clientId) throw new Error('Another Google account needs a Google OAuth client of type “Web application” (the one from the setup wizard).');
  await loadAccounts();
  const t = await googleSignIn(clientId, null, true);
  const acct = { id: newId(), type: 'google', label: t.email || 'Google account', email: t.email, clientId, token: t.token, expires: t.expires, calendars: [] };
  await refreshCalendarsOf(acct);
  ACC.push(acct); await saveAccounts(); invalidateExternal();
  return acct;
}
export async function addOutlook(clientId = OUTLOOK_CLIENT_ID) {
  if (!clientId) throw new Error('Outlook needs a Microsoft app (client) ID — see the steps under “Outlook / Microsoft 365”.');
  await loadAccounts();
  if (!isWeb) await requestOrigins(['https://graph.microsoft.com/*']);
  const t = await outlookSignIn(clientId, null, true);
  const acct = { id: newId(), type: 'outlook', label: t.email || 'Outlook', email: t.email, clientId, token: t.token, expires: t.expires, calendars: [] };
  await refreshCalendarsOf(acct);
  ACC.push(acct); await saveAccounts(); invalidateExternal();
  return acct;
}
export async function addICloud(user, pass) {
  if (isWeb) throw new Error('Apple doesn’t let web pages read iCloud calendars. Use the Tempo browser extension for iCloud, or add the calendar’s public link (.ics) there.');
  await loadAccounts();
  await requestOrigins(['https://*.icloud.com/*']);
  const acct = { id: newId(), type: 'icloud', label: user, email: user, user, pass: pass.replace(/\s+/g, ''), calendars: [] };
  await refreshCalendarsOf(acct);
  ACC.push(acct); await saveAccounts(); invalidateExternal();
  return acct;
}
export async function addIcs(url, name) {
  await loadAccounts();
  url = url.trim().replace(/^webcal:/i, 'https:');
  if (!/^https:\/\//i.test(url)) throw new Error('Paste a calendar link that starts with https:// or webcal://');
  if (!isWeb) await requestOrigins([new URL(url).origin + '/*']);
  const acct = { id: newId(), type: 'ics', label: name || new URL(url).hostname, url, calendars: [{ id: 'ics', name: name || new URL(url).hostname, color: '#8d6e63', show: true, busy: true }] };
  await fetchIcs(acct); // check it can be read
  ACC.push(acct); await saveAccounts(); invalidateExternal();
  return acct;
}
export async function removeAccount(id) { await loadAccounts(); ACC = ACC.filter((a) => a.id !== id); await saveAccounts(); invalidateExternal(); }
export async function reconnect(id) {
  await loadAccounts();
  const a = ACC.find((x) => x.id === id);
  if (!a) return;
  if (a.type === 'google' || a.type === 'outlook') { a.token = null; await tokenFor(a, true); }
  await refreshCalendarsOf(a); await saveAccounts(); invalidateExternal();
}
export async function setCalendarFlags(acctId, calId, flags) {
  await loadAccounts();
  const c = ACC.find((a) => a.id === acctId)?.calendars?.find((x) => x.id === calId);
  if (c) Object.assign(c, flags);
  await saveAccounts(); invalidateExternal();
}
async function requestOrigins(origins) {
  const perms = ext?.permissions;
  if (!perms?.request) return;
  try { if (await perms.contains({ origins })) return; } catch { /* ignore */ }
  const ok = await perms.request({ origins }).catch(() => false);
  if (!ok) throw new Error('Tempo needs permission to reach ' + origins.join(', ') + '.');
}

export async function refreshCalendarsOf(acct) {
  const keep = new Map((acct.calendars || []).map((c) => [c.id, c]));
  let list = [];
  if (acct.type === 'google') {
    const r = await api(acct, GAPI + '/users/me/calendarList?maxResults=250');
    list = (r.items || []).map((c) => ({ id: c.id, name: c.summaryOverride || c.summary, color: c.backgroundColor || '#7986cb' }));
  } else if (acct.type === 'outlook') {
    const r = await api(acct, GRAPH + '/me/calendars?$top=100&$select=id,name,hexColor,color');
    list = (r.value || []).map((c) => ({ id: c.id, name: c.name, color: c.hexColor || '#0078d4' }));
  } else if (acct.type === 'icloud') {
    list = await caldavCalendars(acct);
  } else return;
  acct.calendars = list.map((c) => ({ ...c, show: keep.get(c.id)?.show ?? true, busy: keep.get(c.id)?.busy ?? true }));
  acct.error = null;
}

// ---------- Events ----------
// Events from all other calendars between from and to, shaped like Google events (read-only).
export async function externalEvents(state, from, to) {
  await loadAccounts();
  const hidden = new Set(state?.settings?.hiddenCalendars || []);
  const out = [];
  await Promise.all(accounts().map(async (a) => {
    const cals = (a.calendars || []).filter((c) => c.show !== false || c.busy !== false);
    if (!cals.length) return;
    const key = `${a.id}|${from}|${to}`;
    let evs = cache.get(key);
    if (!evs || Date.now() - evs.at > TTL) {
      try {
        const items = await fetchAccount(a, cals, from, to);
        evs = { at: Date.now(), items };
        cache.set(key, evs);
        if (a.error) { a.error = null; saveAccounts(); }
      } catch (e) {
        a.error = a.error || e.message; console.warn('Tempo:', a.label, e);
        evs = cache.get(key) || { items: [] };
      }
    }
    for (const ev of evs.items) {
      const cal = cals.find((c) => extCalId(a, c) === ev._calId);
      if (!cal) continue;
      out.push({ ...ev, _busy: cal.busy !== false && !hidden.has(ev._calId), _show: cal.show !== false && !hidden.has(ev._calId), _color: cal.color, _calName: `${cal.name} (${a.label})` });
    }
  }));
  return out;
}

async function fetchAccount(a, cals, from, to) {
  const iso = (ms) => new Date(ms).toISOString();
  const out = [];
  if (a.type === 'google') {
    await Promise.all(cals.map(async (c) => {
      let pageToken = '';
      do {
        const r = await api(a, `${GAPI}/calendars/${encodeURIComponent(c.id)}/events?singleEvents=true&orderBy=startTime&maxResults=2500&timeMin=${iso(from)}&timeMax=${iso(to)}${pageToken ? '&pageToken=' + pageToken : ''}`);
        for (const e of r.items || []) if (e.status !== 'cancelled') out.push({ ...e, id: `${a.id}:${e.id}`, _calId: extCalId(a, c), _ext: a.type });
        pageToken = r.nextPageToken || '';
      } while (pageToken);
    }));
  } else if (a.type === 'outlook') {
    await Promise.all(cals.map(async (c) => {
      let url = `${GRAPH}/me/calendars/${encodeURIComponent(c.id)}/calendarView?startDateTime=${iso(from)}&endDateTime=${iso(to)}&$top=500&$select=id,subject,start,end,isAllDay,location,showAs,webLink,bodyPreview,isCancelled,responseStatus`;
      while (url) {
        const r = await api(a, url, { headers: { Prefer: 'outlook.timezone="UTC"' } });
        for (const e of r.value || []) if (!e.isCancelled) out.push(fromGraph(e, a, c));
        url = r['@odata.nextLink'] || '';
      }
    }));
  } else if (a.type === 'icloud') {
    await Promise.all(cals.map(async (c) => {
      const ics = await caldavEvents(a, c, from, to);
      for (const ev of ics) out.push(...icsToEvents(ev, a, c, from, to));
    }));
  } else if (a.type === 'ics') {
    const text = await fetchIcs(a);
    out.push(...icsToEvents(text, a, a.calendars[0], from, to));
  }
  return out;
}

function fromGraph(e, a, c) {
  const utc = (s) => new Date(s.endsWith('Z') ? s : s + 'Z').toISOString();
  const allDay = e.isAllDay;
  return {
    id: `${a.id}:${e.id}`, summary: e.subject || '(No title)', location: e.location?.displayName || '', description: e.bodyPreview || '',
    start: allDay ? { date: e.start.dateTime.slice(0, 10) } : { dateTime: utc(e.start.dateTime) },
    end: allDay ? { date: e.end.dateTime.slice(0, 10) } : { dateTime: utc(e.end.dateTime) },
    transparency: e.showAs === 'free' || e.showAs === 'workingElsewhere' ? 'transparent' : 'opaque',
    htmlLink: e.webLink, _calId: extCalId(a, c), _ext: 'outlook',
    attendees: e.responseStatus?.response === 'declined' ? [{ self: true, responseStatus: 'declined' }] : undefined,
  };
}

// ---------- iCloud (CalDAV) ----------
const DAV = 'https://caldav.icloud.com';
const tagRe = (name) => new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'gi');
const firstTag = (xml, name) => { const m = tagRe(name).exec(xml); return m ? m[1].trim() : ''; };
const allTags = (xml, name) => [...xml.matchAll(tagRe(name))].map((m) => m[1]);
const unxml = (s) => s.replace(/^<!\[CDATA\[|\]\]>$/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#13;/g, '\r').replace(/&amp;/g, '&');
async function dav(a, url, method, body, depth = '0') {
  const res = await fetch(url, { method, headers: { Authorization: 'Basic ' + btoa(`${a.user}:${a.pass}`), Depth: depth, 'Content-Type': 'application/xml; charset=utf-8' }, body });
  if (res.status === 401) throw new Error('iCloud rejected the Apple ID or app-specific password.');
  if (!res.ok && res.status !== 207) throw new Error(`iCloud: error ${res.status}`);
  return { text: await res.text(), url: res.url };
}
async function caldavCalendars(a) {
  const p1 = await dav(a, DAV + '/', 'PROPFIND', '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>');
  const principal = firstTag(firstTag(p1.text, 'current-user-principal'), 'href');
  if (!principal) throw new Error('iCloud: could not find your calendars.');
  const base = new URL(p1.url).origin;
  const p2 = await dav(a, new URL(principal, base).href, 'PROPFIND', '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>');
  const home = new URL(firstTag(firstTag(p2.text, 'calendar-home-set'), 'href'), base).href;
  a.home = home;
  const p3 = await dav(a, home, 'PROPFIND', '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/"><d:prop><d:displayname/><d:resourcetype/><a:calendar-color/><c:supported-calendar-component-set/></d:prop></d:propfind>', '1');
  return allTags(p3.text, 'response')
    .filter((r) => /calendar\s*\/?>|:calendar\s*\/?>/i.test(firstTag(r, 'resourcetype')) && (!/supported-calendar-component-set/i.test(r) || /VEVENT/.test(r)))
    .map((r) => ({ id: new URL(unxml(firstTag(r, 'href')), home).href, name: unxml(firstTag(r, 'displayname')) || 'iCloud', color: (unxml(firstTag(r, 'calendar-color')) || '#ff9500').slice(0, 7) }));
}
async function caldavEvents(a, c, from, to) {
  const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const body = `<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-data><c:expand start="${stamp(from)}" end="${stamp(to)}"/></c:calendar-data></d:prop>
    <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${stamp(from)}" end="${stamp(to)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
  const r = await dav(a, c.id, 'REPORT', body, '1');
  return allTags(r.text, 'calendar-data').map(unxml);
}
async function fetchIcs(a) {
  const res = await fetch(a.url).catch(() => { throw new Error(isWeb ? 'This calendar link can’t be read from the web app (the site doesn’t allow it). Add it in the Tempo browser extension instead.' : 'Couldn’t reach that calendar link.'); });
  if (!res.ok) throw new Error(`Calendar link: error ${res.status}`);
  const text = await res.text();
  if (!/BEGIN:VCALENDAR/.test(text)) throw new Error('That link isn’t a calendar (.ics) file.');
  return text;
}

// ---------- ICS parsing ----------
export function parseIcs(text) {
  const lines = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
  const out = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = { exdates: [] }; continue; }
    if (line === 'END:VEVENT') { if (cur) out.push(cur); cur = null; continue; }
    if (!cur) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const head = line.slice(0, i), val = line.slice(i + 1);
    const [name, ...params] = head.split(';');
    const pm = Object.fromEntries(params.map((x) => x.split('=')));
    const unesc = (v) => v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
    if (name === 'SUMMARY') cur.summary = unesc(val);
    else if (name === 'LOCATION') cur.location = unesc(val);
    else if (name === 'DESCRIPTION') cur.description = unesc(val);
    else if (name === 'UID') cur.uid = val;
    else if (name === 'STATUS') cur.status = val;
    else if (name === 'TRANSP') cur.transp = val;
    else if (name === 'RRULE') cur.rrule = 'RRULE:' + val;
    else if (name === 'DURATION') cur.duration = val;
    else if (name === 'DTSTART' || name === 'DTEND' || name === 'RECURRENCE-ID' || name === 'EXDATE') {
      const vals = val.split(',').map((v) => ({ v, tz: pm.TZID, date: pm.VALUE === 'DATE' || /^\d{8}$/.test(v) }));
      if (name === 'EXDATE') cur.exdates.push(...vals); else cur[name] = vals[0];
    }
  }
  return out;
}
function icsTime(t, fallbackTz) {
  const m = t.v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (t.date || h == null) return { date: `${y}-${mo}-${d}` };
  if (z) return { ms: Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) };
  const zone = t.tz && T.isValidTz(t.tz.replace(/"/g, '')) ? t.tz.replace(/"/g, '') : fallbackTz;
  return { ms: T.zonedMs(+y, +mo, +d, +h, +mi, zone) };
}
function durMs(d) {
  const m = (d || '').match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 0;
  return ((+m[2] || 0) * 7 * 86400 + (+m[3] || 0) * 86400 + (+m[4] || 0) * 3600 + (+m[5] || 0) * 60 + (+m[6] || 0)) * 1000;
}
export function icsToEvents(text, a, c, from, to, tz = T.systemTz()) {
  const raw = parseIcs(text);
  const overrides = new Set(raw.filter((e) => e['RECURRENCE-ID']).map((e) => `${e.uid}|${JSON.stringify(icsTime(e['RECURRENCE-ID'], tz))}`));
  const out = [];
  const mk = (e, s, en, idx) => ({
    id: `${a.id}:${e.uid || Math.random()}:${idx}`, summary: e.summary || '(No title)', location: e.location || '', description: e.description || '',
    start: s.date ? { date: s.date } : { dateTime: new Date(s.ms).toISOString() }, end: en.date ? { date: en.date } : { dateTime: new Date(en.ms).toISOString() },
    transparency: e.transp === 'TRANSPARENT' ? 'transparent' : 'opaque', _calId: extCalId(a, c), _ext: a.type,
  });
  for (const e of raw) {
    if (!e.DTSTART || e.status === 'CANCELLED') continue;
    const s = icsTime(e.DTSTART, tz);
    if (!s) continue;
    let en = e.DTEND ? icsTime(e.DTEND, tz) : null;
    const allDay = !!s.date;
    const len = allDay ? (en?.date ? T.daysBetween(s.date, en.date) : 1) : ((en?.ms ?? s.ms + durMs(e.duration)) - s.ms) || 0;
    if (!e.rrule || e['RECURRENCE-ID']) {
      if (!en) en = allDay ? { date: T.addDays(s.date, len) } : { ms: s.ms + len };
      const a0 = allDay ? T.dayStart(s.date, tz) : s.ms, b0 = allDay ? T.dayStart(en.date, tz) : en.ms;
      if (b0 > from && a0 < to) out.push(mk(e, s, en, a0));
      continue;
    }
    const rule = parseRRule([e.rrule]);
    if (!rule) continue;
    const ex = new Set(e.exdates.map((x) => JSON.stringify(icsTime(x, tz))));
    const occ = expand({ rule, startMs: allDay ? T.dayStart(s.date, tz) : s.ms, startKey: s.date, allDay, tz: e.DTSTART.tz && T.isValidTz(e.DTSTART.tz) ? e.DTSTART.tz : tz, durationMs: allDay ? len * T.DAY : len }, from, to, tz);
    for (const o of occ) {
      const st = allDay ? { date: o } : { ms: o };
      const k = JSON.stringify(st);
      if (ex.has(k) || overrides.has(`${e.uid}|${k}`)) continue;
      out.push(mk(e, st, allDay ? { date: T.addDays(o, len) } : { ms: o + len }, o));
    }
  }
  return out;
}
