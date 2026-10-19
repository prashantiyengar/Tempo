# Submitting Tempo Calendar to addons.mozilla.org

Upload `dist/tempo-calendar-firefox.zip` at <https://addons.mozilla.org/developers/addon/submit/>.

- **Distribution:** *On this site* (public listing) or *On your own* (unlisted: you get a signed .xpi to install yourself, with a lighter review).
- **Platforms:** tick **Firefox for desktop** only. The layout hasn't been tested on Android.
- **Source code:** answer **No**. Nothing is minified, transpiled or bundled; `build.sh` only copies files. The one third-party library is the unmodified official DOMPurify build (details below).

## Listing text (copy and paste)

**Name:** Tempo Calendar

**Summary (≤250 characters):**
Google Calendar in a full-page view with drag-to-create events, plus an auto-scheduler that splits long tasks and reading plans into your free time by rank and deadline. Also has time analysis and PDF/TIFF export.

**Description:**
Tempo is a calendar for people who plan their work, not just their meetings.

• Your Google Calendar: day, week and month views. Drag to create, move or resize events. Supports recurring events (this event / following / all), time zones, notifications, guests and Google Meet.
• Splittable tasks: say "10 hours, due Friday, rank 2" and Tempo splits the work into sessions in your free time, within your working hours. Higher-ranked tasks get the earliest slots and push lower-ranked ones later.
• Reading plans: pages, start page and reading speed become sessions like "Pride and Prejudice page 47-66, task 1/10".
• Mark sessions done or undone, or delete one, and the rest of the series shifts automatically. If time runs out before a deadline, Tempo suggests a new one.
• Analysis: how much of the next week or month is free or booked, within or outside your working hours, by color category, task or calendar.
• Export one or many weeks or months as multi-page PDF, TIFF, PNG or JPEG.
• Works offline with a local calendar. With Google connected, task sessions sync to your calendar and to any other browser where you use Tempo.

Privacy: Tempo has no servers. Your data travels only between your browser and your own Google account.

**Categories:** Productivity (alternative: Other)
**Tags:** calendar, google calendar, scheduling, planner, time management, tasks
**Support email/site:** your choice
**License:** your choice (e.g. MIT or MPL-2.0)
**Privacy policy:** paste the contents of `PRIVACY.md` (fill in the contact line first). The same text ships inside the add-on as `privacy.html`.
**Screenshots:** 1280×800 PNGs of week view, task dialog, analysis and export (see `docs/`).

## Notes to reviewer (copy and paste)

How to test without a Google account: click the toolbar button to open Tempo in a tab. Everything except Google sync works in "Local only" mode:
1. Drag across empty hours in the week view to create an event.
2. Click "📖" (reading plan): pages 200, start page 47, speed 20 pages/hour, deadline next Friday, then Schedule. This creates 10 one-hour sessions.
3. Click "+ Task", enter 6 hours with rank 2. The reading sessions move to later slots.
4. Click a session to mark it done, mark it undone, or delete it; the series shifts.
5. "Analysis" view; Export → "Several weeks or months…" for a multi-page PDF or TIFF.

Google Calendar (optional): the add-on talks to Google Calendar API v3 directly from the browser using `identity.launchWebAuthFlow` with the user's own OAuth client ID (Settings → Google Calendar → setup wizard). No developer servers are involved. Network requests go only to accounts.google.com, www.googleapis.com, openidconnect.googleapis.com and oauth2.googleapis.com. Host permissions are requested at the moment the user clicks Connect.

Data collection declaration: `personallyIdentifyingInfo` (the connected account email and event guests' emails) and `personalCommunications` (calendar event content). This data is sent only to the user's own Google account, at their request.

Third-party library: `vendor/purify.es.mjs` is DOMPurify 3.2.6, unmodified, from npm (`dompurify@3.2.6`, file `dist/purify.es.mjs`, SHA-256 `4b95c409255f7253ea09bc348e2467702224594adf021ba013295d829c1bd30f`). All HTML built from strings goes through `DOMPurify.sanitize(..., { RETURN_DOM_FRAGMENT: true })` in `js/ui.js` (`setHTML` / `el`) before reaching the DOM, and interpolated values are also escaped with `esc()`. The one remaining linter warning is the innerHTML inside DOMPurify itself.

## After the add-on ID change
The Firefox add-on ID is now `tempo-calendar@nemo`, which changes the Firefox sign-in redirect address. If you already set up a Google OAuth client, open Tempo → Settings → Google Calendar → Manual setup, copy the redirect URI shown there, and add it to your OAuth client's *Authorized redirect URIs* in Google Cloud.

### Optional permissions (reviewer note)
`optional_host_permissions` (graph.microsoft.com, *.icloud.com, https://*/*) are requested at runtime **only** when the user adds an Outlook, iCloud or calendar-link (.ics) source in Settings → Other calendars. The broad https pattern is needed because a calendar link can be on any host; Tempo requests just that one origin (`permissions.request({origins:[<origin>/*]})`).
