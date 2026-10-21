# Tempo Calendar — Privacy Policy

_Effective 18 October 2026_

Tempo Calendar ("Tempo") is a browser extension that shows your Google Calendar and schedules tasks into your free time. This policy explains what data Tempo handles and where that data goes.

## The short version
- Tempo has **no servers**. The developer never receives, sees or stores your data.
- Your data travels **only between your browser and Google**, and only when you connect your Google account.
- There is **no analytics, tracking, advertising or selling of data**, and no data is shared with anyone else.

## What Tempo handles and why

| Data | Why | Where it goes |
|---|---|---|
| Your Google account email address | Shown in Settings so you know which account is connected | Read from Google; stored only in your browser |
| Your calendar list and calendar events (titles, times, locations, guests, descriptions, reminders) | To display your calendar, create and edit events at your request, and find free time for tasks | Read from and written to **your own Google Calendar** |
| Tasks you create (name, deadline, rank, session settings, notes, done/undone status) | To schedule task sessions | Stored in your browser, and written into the matching session events in **your own Google Calendar**, so other browsers where you use Tempo can load them |
| Google sign-in token | To talk to Google Calendar on your behalf | Stored only in your browser's extension storage; revoked when you click **Disconnect** |
| Your settings (categories, work hours, limits, projects, recent history of skipped or moved sessions) | To keep your devices consistent | Stored in your browser and in one hidden event ("Tempo settings") in **your own Google Calendar** |
| Other calendars you add (optional): another Google account, Outlook / Microsoft 365, iCloud, or a calendar link | To show those events and treat them as busy time | Read directly from that provider; sign-in tokens, the iCloud app-specific password and links are stored **only in this browser** and never written anywhere else |
| Weather place (optional): a city you search for, or your device's location if you choose “My location” | To show the forecast for the next 14 days | The place's coordinates (rounded) are sent to **Open-Meteo** to get the forecast, and the city name you type to Open-Meteo's place search; the place is kept in your settings |
| Settings, local events and cached data | So the app works and remembers your preferences | Stored only in your browser's extension storage |

Tempo contacts only these addresses: `accounts.google.com` (sign-in), `www.googleapis.com` (Calendar API), `openidconnect.googleapis.com` (your email address) and `oauth2.googleapis.com` (revoking access when you disconnect). Only if you add other calendars: `login.microsoftonline.com` and `graph.microsoft.com` (Outlook), `caldav.icloud.com` (iCloud), or the address of a calendar link you paste. Only if you turn on the weather forecast: `api.open-meteo.com` and `geocoding-api.open-meteo.com`. The browser asks your permission before Tempo can reach these.

If you never connect a Google account, Tempo works fully offline and no data leaves your browser.

## Google user data
Tempo's use of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements. Google user data is used only to provide the calendar and scheduling features you see in the extension. It is not transferred to anyone else, not used for advertising, and not read by humans.

## Your control
- **Disconnect** (Settings → Google Calendar) revokes Tempo's access to your Google account. You can also remove access at <https://myaccount.google.com/permissions>.
- **Uninstalling** Tempo deletes everything it stored in your browser.
- Task sessions Tempo wrote to Google Calendar are ordinary events in your calendar. You can delete them there, or use Settings → Google Calendar → *Remove stray task events*.
- **Backups** (Settings → Data) are files you download yourself. Tempo never uploads them anywhere.

## Changes
If this policy changes, the new version ships with the extension update and the effective date above changes.

## Contact
Questions: [your contact email]
