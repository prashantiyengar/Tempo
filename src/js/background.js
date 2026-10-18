// Background: opens the app from the toolbar button, fires desktop reminders, and keeps the task plan and
// Google sync fresh every 15 minutes even when no Tempo tab is open.
import * as E from './engine.js';
import { ext, get, set } from './storage.js';

const APP = 'app.html';
const action = ext.action || ext.browserAction;

action.onClicked.addListener(async () => {
  const url = ext.runtime.getURL(APP);
  const tabs = await ext.tabs.query({ url });
  if (tabs.length) { await ext.tabs.update(tabs[0].id, { active: true }); await ext.windows.update(tabs[0].windowId, { focused: true }); }
  else await ext.tabs.create({ url });
});

ext.runtime.onInstalled.addListener(() => {
  ext.alarms.create('tick', { periodInMinutes: 1 });
  ext.alarms.create('resched', { periodInMinutes: 15 });
});
ext.runtime.onStartup?.addListener(() => {
  ext.alarms.create('tick', { periodInMinutes: 1 });
  ext.alarms.create('resched', { periodInMinutes: 15 });
});

ext.alarms.onAlarm.addListener(async (a) => {
  if (a.name === 'tick') await fireReminders();
  if (a.name === 'resched') await backgroundCycle();
});

async function fireReminders() {
  const { reminderQueue = [], firedReminders = {} } = await get(['reminderQueue', 'firedReminders']);
  const now = Date.now();
  let changed = false;
  for (const r of reminderQueue) {
    if (r.when > now || firedReminders[r.id]) continue;
    if (now - r.when > 10 * 60 * 1000) { firedReminders[r.id] = now; changed = true; continue; } // stale: skip quietly
    firedReminders[r.id] = now; changed = true;
    ext.notifications.create(r.id, { type: 'basic', iconUrl: ext.runtime.getURL('icons/icon128.png'), title: r.title, message: r.body || '', priority: 2 });
  }
  if (changed) {
    for (const [k, v] of Object.entries(firedReminders)) if (now - v > 4 * 86400000) delete firedReminders[k];
    await set({ firedReminders });
  }
}

ext.notifications.onClicked.addListener(async (id) => {
  ext.notifications.clear(id);
  const url = ext.runtime.getURL(APP);
  const tabs = await ext.tabs.query({ url });
  if (tabs.length) ext.tabs.update(tabs[0].id, { active: true });
  else ext.tabs.create({ url });
});

let running = false;
async function backgroundCycle() {
  if (running) return;
  const { appHeartbeat = 0 } = await get('appHeartbeat');
  if (Date.now() - appHeartbeat < 90 * 1000) return; // an open tab is handling it
  running = true;
  try {
    const state = await E.loadState();
    if (E.connected(state)) { try { await E.pullTasks(state); } catch (e) { console.warn('Tempo pull:', e.message); } }
    if (!state.tasks.length && !state.localEvents.length) return;
    await E.reschedule(state);
    await E.persist(state, ['tasks', 'reminderQueue']);
    if (E.connected(state) && state.settings.syncTasksToGoogle) {
      try { await E.syncTasks(state, (fn) => fn(state)); }
      finally { await E.persist(state, ['tasks', 'orphanGids', 'syncInfo']); }
    }
  } catch (e) {
    console.warn('Tempo background cycle:', e.message);
  } finally { running = false; }
}
