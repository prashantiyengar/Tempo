# Tempo Calendar — Chrome & Firefox extension

A full-page calendar that syncs with Google Calendar and auto-schedules long tasks into your free time.

## Features
- **Google Calendar sync**: see, create, edit, drag, resize and delete events across all your calendars. Supports time zones (per event and display), recurring events (daily / weekly on chosen days / monthly by date or "2nd Tuesday" / "last Friday" / yearly, with an end date or count), and edits or deletes scoped to *this event*, *this and following*, or *all events*. Also notifications (popup and email, several per event), guests, Google Meet, location, color, busy/free and visibility.
- **Week view** shows the calendar week by default, or *Today + next 6 days* (Settings → General → Week view shows). If the visible days have no task sessions, a pointer shows the next one with a **Show it** button.
- **Visual editing**: drag across empty time to create an event; drag across the all-day row or month cells for multi-day events; drag to move, drag the bottom edge to resize. Keyboard: `D/W/M/Y` switch views (day, week, month, analysis), `R` refreshes from Google, `T` jumps to today, `←/→` move between periods, `C` makes a new event, `A` makes a new task.
- **Splittable tasks**: give the total hours, a deadline and a rank. Tempo splits the task into sessions (60 min by default, adjustable per task and in Settings) and places them in free time inside your day bounds (9–5 by default, adjustable per task and in Settings). Optional per-task settings: max minutes per day, break between sessions, shortest session, "don't start before", and a reminder.
- **Ranking**: rank 1 is the most important. Higher-ranked tasks get the earliest free time, so adding a rank-2 task pushes rank-3 sessions to later slots automatically.
- **Reading plans**: set the pages to read, the start page and your speed (pages per hour, pages per minute or minutes per page). Example: 200 pages of *Pride and Prejudice* from page 47 at 20 pages/hour gives 10 sessions labelled `Pride and Prejudice page 47-66, task 1/10` … `page 227-246, task 10/10`. You can switch the labels to relative numbering (page 1-20…).
- **Series actions**: click a session to **mark it done**, **mark it undone** (its work goes back into the plan and later sessions shift), **delete it** (later sessions shift down), or **delete the entire series**. Drag a session to pin it to a time; the rest of the series reflows around it. Sessions whose time has passed count as done unless you mark them undone.
- **Not enough time?** Tempo prompts you to set a new deadline (it suggests the earliest one that fits), to ignore day bounds for that task (it then also uses evenings and weekends, 07:00–23:00 by default), or to keep the deadline and leave the overflow marked as overdue. The task dialog shows a live preview and warns you before you save.
- **Export**: the current week or month as **PDF**, **PNG**, **JPEG** or **TIFF**. **Several weeks or months** (up to 52 pages) export as one multi-page **PDF** or multi-page **TIFF** (Export → *Several weeks or months…*).
- **Analysis view** (press `Y`): shows how much of the next 7 or 30 days, this or next week, this or next month, or a custom range is free or occupied. You can measure it **within day bounds**, **outside day bounds**, over extended hours, or over the full 24 hours. Occupied time is broken down by **color category** (you can rename colors, e.g. Indigo → "Deep work"), by **task or calendar**, or by **events vs tasks**. The view has summary figures, a share bar, a per-day stacked chart, a table and a CSV download.
- **Google is the source of truth for tasks**: every session event stores its task's settings, so a fresh install, another browser or another computer rebuilds the full task list (ranks, deadlines, done/undone, reading pages) straight from Google Calendar. Edits and deletions made on one device show up on the others. Tasks are found in whichever of your calendars they live in (e.g. a dedicated "Tempo Tasks" calendar), and each task remembers its calendar. Once loaded, a series can be fully edited from any browser: rank, deadline, done/undone, delete one session or the whole series. Use the **⟳ refresh** button next to the date (or press `R`) to re-read everything from Google right away. Tempo also refreshes on startup, every 5 minutes, and when you come back to the tab.
- **Sync health**: click the status pill next to the date for a checklist (connected? sign-in valid? which calendar? how many sessions are on Google?). A banner appears whenever task sessions can't reach Google, with a one-click fix.
- Desktop notifications, a background re-plan every 15 minutes, dark mode, and backup/restore as JSON. It also works without Google, using a local calendar.

## Phones: the web app
`dist/web` (also `dist/tempo-calendar-web.zip`) is the same app as an installable web app for any phone browser, with a touch layout: bottom bar, ＋ button, slide-out menu, tap to add, press-and-hold to drag, swipe between days. It syncs with the extension through Google Calendar. See **`WEB_APP.md`** for free hosting, the one Google setting to add, and installing it on Android or iPhone.

## Install
Build once: `./build.sh` (or use the prebuilt folders in `dist/`).

**Updating to a new version:** replace the folder's contents and click the **reload ⟳** icon on the extension card (Chrome) or **Reload** (Firefox `about:debugging`). Don't remove the extension: removing it wipes local settings. Your tasks come back from Google either way.

**Chrome / Edge / Brave**: go to `chrome://extensions`, turn on *Developer mode*, click **Load unpacked** and pick `dist/chrome`. Click the toolbar icon to open Tempo.
The manifest has a fixed key, so the extension ID is always `adheclccdehmdhjjfklageapjifndojo`.

**Firefox (140+)**: go to `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on…** and pick `dist/firefox/manifest.json`. To install it permanently, submit `dist/tempo-calendar-firefox.zip` to addons.mozilla.org; `AMO_SUBMISSION.md` has the listing text, reviewer notes and screenshots (`docs/`). The add-on ID is `tempo-calendar@nemo`. Privacy policy: `PRIVACY.md` (also shipped in the add-on as `privacy.html`).
In Firefox, open `about:addons` → Tempo → Permissions and allow access to googleapis.com.

## Connect Google Calendar
### Option A — guided wizard (always available)
Go to ⚙ Settings → Google Calendar → **Set up Google Calendar**. The wizard links straight to each Google Cloud page, gives you the redirect URI to copy, checks the client ID you paste (it warns you if you pasted the client *secret*), connects, and tells you exactly what went wrong if it fails. It takes about 5 minutes, once.

The steps it walks you through (you can also do them by hand):
1. Create a project at <https://console.cloud.google.com/projectcreate>.
2. Enable the **Google Calendar API** for that project.
3. Set up the consent screen as **External**, then add your own Gmail under **Audience → Test users**.
4. Create an OAuth client of type **Web application**. Under *Authorized redirect URIs*, paste:
   - Chrome: `https://adheclccdehmdhjjfklageapjifndojo.chromiumapp.org/`
   - Firefox: copy it from Settings (it looks like `https://<hash>.extensions.allizom.org/`). One client can list both URIs.
5. Paste the **Client ID** and click **Connect**. On Google's screen, click *Continue* past "unverified app", then **tick every checkbox**.

### Option B — one-click "Sign in with Google" for everyone using your build
Google doesn't allow any calendar app to work without being registered once. If you do that registration once as the *publisher*, every user of your build gets a single **Sign in with Google** button:
1. In your Google Cloud project (set up as above), create:
   - an OAuth client of type **Chrome extension** with Item ID `adheclccdehmdhjjfklageapjifndojo`. This uses Chrome's own account picker, and tokens renew automatically.
   - an OAuth client of type **Web application** with both redirect URIs (for Firefox, Edge and Brave).
2. Put the two IDs in `src/js/config.js` (`CHROME_CLIENT_ID`, `WEB_CLIENT_ID`) and run `./build.sh`. The build adds the `oauth2` block to the Chrome manifest automatically.
3. While the app is in *Testing* status, only people you list as **Test users** (up to 100) can sign in, and they see an "unverified app" notice. To open it to anyone, submit the app for Google's OAuth verification. The calendar scope is "sensitive", so verification needs a privacy policy and a short demo video, but no paid security audit.

The manual client-ID setup stays available under *Manual setup* in Settings.

### If task sessions don't show up in Google Calendar
Click the status pill next to the date (or **Details** in the banner). The usual causes:
- **"Local only"**: Google isn't connected, so sessions only live in this browser. Connect it.
- **Permission needed**: the calendar checkbox was left unticked on Google's consent screen. Click **Reconnect** and tick it.
- **Sign-in expired**: some browsers block silent renewal after about an hour. Click **Reconnect**. With one-click Chrome sign-in this doesn't happen.
- **Wrong calendar hidden**: the panel shows which calendar sessions go to. In Google Calendar, make sure that calendar is ticked under *My calendars*, then refresh the page (Google Calendar doesn't live-update other tabs instantly).

Every sync also checks what is really on Google. Sessions that were deleted on the Google side are re-created, and duplicates are removed.

Task sessions are written with reminders, so they show on your phone and other people see you as busy. Edit tasks in Tempo: it overwrites changes made to those events in Google.

## Project layout
```
src/js/scheduler.js  splitting / ranking / deadline engine (pure functions)
src/js/engine.js     reschedule cycle, Google sync of task sessions, reminders
src/js/gcal.js       Google Calendar API + OAuth (identity.launchWebAuthFlow)
src/js/events.js     event create/edit/move/delete incl. recurring scopes
src/js/rrule.js      RRULE build/parse/expand     src/js/tz.js  time zones (Intl)
src/js/app.js        UI: views, drag interactions  src/js/dialogs.js  dialogs
src/js/export.js     PNG/JPEG + multi-page PDF/TIFF src/js/background.js  alarms & notifications
src/js/analysis.js   free/occupied analysis        src/js/config.js  built-in client IDs (one-click sign-in)
vendor/purify.es.mjs DOMPurify 3.2.6 (unmodified): every HTML string is sanitised before reaching the page
platform/            per-browser manifests (chrome-key.pem keeps the Chrome ID stable — keep it private)
test/                node test/scheduler.test.js · python3 test/mobile_test.py <outdir> (phones, web build) · python3 test/ui_test.py <outdir> · python3 test/sync_test.py <outdir> · python3 test/multidevice_test.py <outdir> · python3 test/repro_test.py <outdir> (fake Google API)
```
