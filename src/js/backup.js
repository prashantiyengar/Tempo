// Backups to Google Drive, into Tempo's own hidden app folder (Tempo can't see your other Drive files, and the
// backups don't show up among them): one a day while Tempo is open, the last KEEP kept, any of them restorable.
import * as T from './tz.js';
import * as G from './gcal.js';
import * as E from './engine.js';
import { isWeb, get as storeGet } from './storage.js';
import { app, st, set, tz } from './core.js';
import { choose, esc } from './ui.js';
import { toast, cycle, render, returnState } from './app.js';
import { handleError } from './status.js';
import { job } from './autoblocks.js';

const KEEP = 14;
const PREFIX = 'tempo-backup-';
export const backupData = () => { const { settings, tasks, localEvents } = st(); return { app: 'tempo', version: 1, at: Date.now(), settings, tasks, localEvents }; };
const deviceTag = () => (isWeb ? 'web' : 'extension');

// Ask for Drive access if it hasn't been given yet. Web app: a trip to Google and back (returns false meanwhile).
export async function ensureDrive() {
  if (!E.connected(st())) { toast('Connect Google Calendar first (Settings → Google Calendar).'); return false; }
  const a = st().auth || {};
  if (a.drive && a.driveOk !== false) return true;
  const ok = await G.enableDrive(returnState({ after: 'driveBackup' }));
  st().auth = (await storeGet('auth')).auth || st().auth;
  return ok;
}

export async function backupNow({ quiet = false } = {}) {
  const z = tz(), now = Date.now();
  const name = `${PREFIX}${T.dayKey(now, z)}-${T.format(now, z, { hour: '2-digit', minute: '2-digit', hour12: false }).replace(':', '')}-${deviceTag()}.json`;
  const f = await G.driveUpload(name, backupData());
  set().driveBackupAt = now;
  await E.persist(st(), ['settings']);
  // keep the newest KEEP
  try {
    const old = (await G.driveList()).filter((x) => x.name.startsWith(PREFIX)).slice(KEEP);
    for (const x of old) await G.driveDelete(x.id);
  } catch (err) { console.warn('Tempo: tidying old backups', err); }
  if (!quiet) toast(`☁ Backed up to Google Drive (${Math.max(1, Math.round((+f?.size || JSON.stringify(backupData()).length) / 1024))} KB)`);
  return f;
}

// Once a day (at most), while Tempo is open, when backups are on
export const dailyBackup = job(async () => {
  const a = st().auth || {};
  if (!set().driveBackup || !E.connected(st()) || !a.drive || a.driveOk === false) return;
  if (Date.now() - (+set().driveBackupAt || 0) < 20 * T.HOUR) return;
  await backupNow({ quiet: true });
}, { every: 30 * T.MIN, quiet: true });

export async function restoreFromDrive() {
  try {
    if (!(await ensureDrive())) return;
    const files = (await G.driveList()).filter((x) => x.name.startsWith(PREFIX));
    if (!files.length) { toast('No backups on Google Drive yet.'); return; }
    const z = tz();
    const id = await choose('Restore from Google Drive', 'This replaces your tasks, settings and local events with the backup’s (Google Calendar events are not touched).',
      files.slice(0, KEEP).map((x) => ({ value: x.id, label: `${T.fmtDate(Date.parse(x.modifiedTime), z)} ${T.fmtTime(Date.parse(x.modifiedTime), z, set().h12)}`, desc: `${/-web\.json$/.test(x.name) ? 'web app' : /-extension\.json$/.test(x.name) ? 'extension' : ''} · ${Math.max(1, Math.round((+x.size || 0) / 1024))} KB` })));
    if (!id) return;
    await applyBackup(await G.driveGet(id));
    toast('Backup restored from Google Drive');
  } catch (err) { handleError(err); }
}

// Take on a backup (from Drive or a file)
export async function applyBackup(data) {
  if (data?.app !== 'tempo') throw new Error('Not a Tempo backup');
  const keep = { driveBackup: set().driveBackup, driveBackupAt: set().driveBackupAt };
  st().settings = { ...st().settings, ...data.settings, ...keep };
  st().tasks = data.tasks || [];
  st().localEvents = data.localEvents || [];
  await E.persist(st());
  E.invalidate();
  await render();
  cycle();
}

// Settings → Backup: the Drive part
export const driveBoxHTML = (s, a) => `<div class="drive-box">
  <label class="chk"><input type="checkbox" name="driveBackup" ${s.driveBackup ? 'checked' : ''}> ☁ Back up to Google Drive every day</label>
  <p class="muted small" style="margin:2px 0 6px">Into Tempo's own hidden folder in your Drive — Tempo can't see your other files, and the backups don't appear among them. The last ${KEEP} are kept. Turning this on asks Google for that permission once.</p>
  <div class="row"><button type="button" class="btn small drive-now">Back up now</button><button type="button" class="btn small ghost drive-restore">Restore from Drive…</button>
  <span class="muted small">${s.driveBackupAt ? `Last backup: ${esc(T.fmtDate(s.driveBackupAt, s.tz))} ${esc(T.fmtTime(s.driveBackupAt, s.tz, s.h12))}` : a?.drive ? 'No backup yet' : ''}</span></div></div>`;

// After a sign-in round trip that asked for Drive access (web app)
export async function afterDriveGrant() {
  if (!(st().auth || {}).drive) { toast('Google Drive access wasn’t given, so backups stay off.'); set().driveBackup = false; await E.persist(st(), ['settings']); return; }
  set().driveBackup = true; await E.persist(st(), ['settings']);
  try { await backupNow(); } catch (err) { handleError(err); }
  app.driveJustGranted = true;
}
