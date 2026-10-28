// Notification profiles: named sets of reminders ("Default": a notification 10 minutes before; "Important": that plus
// emails 4 hours and 1 day before). Events and tasks pick a profile; Google sends the emails and phone/desktop
// notifications, Tempo shows desktop notifications for the popup reminders when that is switched on.

export const DEFAULT_PROFILES = [
  { id: 'default', name: 'Default', rules: [{ method: 'popup', minutes: 10 }] },
  { id: 'important', name: 'Important', rules: [{ method: 'popup', minutes: 10 }, { method: 'email', minutes: 240 }, { method: 'email', minutes: 1440 }] },
];
export const MAX_RULES = 5; // Google keeps at most 5 reminders per event

export const profiles = (s) => (s?.notifyProfiles?.length ? s.notifyProfiles : DEFAULT_PROFILES);
export const profileById = (s, id) => profiles(s).find((p) => p.id === id) || null;
export const eventDefault = (s) => profileById(s, s?.eventProfile) || profiles(s)[0];
export const taskDefault = (s) => profileById(s, s?.taskProfile) || profiles(s)[0];

// Reminders for Google (or local) events: emails only exist in Google; duplicates dropped; at most 5.
export function overrides(rules, { google = true } = {}) {
  const seen = new Set();
  return (rules || [])
    .filter((r) => r && (r.method === 'popup' || (google && r.method === 'email')) && +r.minutes >= 0)
    .map((r) => ({ method: r.method, minutes: Math.round(+r.minutes) }))
    .filter((r) => { const k = r.method + r.minutes; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.minutes - b.minutes || a.method.localeCompare(b.method))
    .slice(0, MAX_RULES);
}

export function fmtBefore(m) {
  if (!m) return 'at the start';
  if (m % 1440 === 0) return `${m / 1440} day${m === 1440 ? '' : 's'} before`;
  if (m % 60 === 0) return `${m / 60} h before`;
  return `${m} min before`;
}
export const describeRule = (r) => `${r.method === 'email' ? 'Email' : 'Notification'} ${fmtBefore(+r.minutes)}`;
export const describeProfile = (p) => (p?.rules?.length ? p.rules.map(describeRule).join(' · ') : 'No reminders');

// Which reminders a task's sessions get: the task's profile, "none", or the old per-task minutes ("custom").
export function taskRules(task, s) {
  const id = task?.notifyProfile;
  if (id === 'none') return [];
  const legacy = (v) => v != null && v !== '';
  if (id === 'custom' || (!id && (legacy(task?.reminderMinutes) || legacy(task?.emailReminderMinutes)))) {
    const rem = legacy(task.reminderMinutes) ? +task.reminderMinutes : s.taskReminderMinutes;
    const em = legacy(task.emailReminderMinutes) ? +task.emailReminderMinutes : s.taskEmailReminderMinutes;
    return [...(rem == null || rem < 0 ? [] : [{ method: 'popup', minutes: rem }]), ...(em == null || em < 0 ? [] : [{ method: 'email', minutes: em }])];
  }
  return (profileById(s, id) || taskDefault(s))?.rules || [];
}

// Which profile an event's reminders match (for showing it in the dialog); null = custom.
export function matchProfile(s, ev) {
  const id = ev?.extendedProperties?.private?.tempoNotify;
  if (id && profileById(s, id)) return id;
  if (!ev?.reminders || ev.reminders.useDefault) return null;
  const mine = JSON.stringify(overrides(ev.reminders.overrides));
  return profiles(s).find((p) => JSON.stringify(overrides(p.rules)) === mine)?.id || null;
}

export const newProfileId = (name) => `${(name || 'profile').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 16) || 'profile'}-${Math.random().toString(36).slice(2, 6)}`;
export const unitOf = (m) => (m && m % 1440 === 0 ? ['days', m / 1440] : m && m % 60 === 0 ? ['hours', m / 60] : ['minutes', m]);
export const toMinutes = (v, unit) => Math.max(0, Math.round(+v || 0)) * (unit === 'days' ? 1440 : unit === 'hours' ? 60 : 1);
