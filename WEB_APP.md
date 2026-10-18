# Tempo on your phone (web app)

The web app is the same Tempo as the extension, packaged as a website you add to your home screen. It runs in any phone browser (Firefox, Chrome, Safari, Samsung Internet) and on any computer. It syncs with the extension through your Google Calendar, so desktop and phone show the same tasks.

There's no server: the site is just static files. Your calendar data goes only between your phone and Google.

## 1. Put it online (free, about 5 minutes)

**Your setup: GitHub Pages from `prashantiyengar/Tempo`.** The repository includes a workflow (`.github/workflows/pages.yml`) that tests, builds and publishes the web app on every push to `main`.
1. Once, in the repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Push to `main` (or run the workflow from the **Actions** tab). After about a minute the app is live at **https://prashantiyengar.github.io/Tempo/**.
3. In Google Cloud, add exactly `https://prashantiyengar.github.io/Tempo/` (capital T, trailing slash) to your OAuth client's *Authorized redirect URIs*.

Other hosts work the same way:

You need the contents of `dist/web` (or `tempo-calendar-web.zip`, unzipped) on any static host with **https**.

**Easiest: Netlify Drop (no account needed to try)**
1. Go to <https://app.netlify.com/drop>.
2. Drag the **`web` folder** onto the page.
3. Netlify gives you an address like `https://cheerful-otter-123.netlify.app`. Sign up (free) to keep it permanently and to rename it, e.g. `https://tempo-nemo.netlify.app`.

**Alternatives:** GitHub Pages (push the folder's contents to a repo → Settings → Pages), or Cloudflare Pages (drag-and-drop upload). Any host that serves plain files over https works.

## 2. Allow Google sign-in from that address (one time)

In the Google Cloud console, open the same OAuth client you made for the extension (**APIs & Services → Credentials** or **Google Auth Platform → Clients**). Under **Authorized redirect URIs**, add your app's exact address **with the trailing slash**, for example:

```
https://tempo-nemo.netlify.app/
```

Save. (Tempo shows the exact address to paste under Settings → Google Calendar → Manual setup.) If you use the setup wizard in the web app, it shows this address in step 4.

Your Google account must still be listed as a **Test user** on the consent screen.

## 3. Install it on your phone

Open your app address in the phone's browser, sign in under ⋯ → Settings → Google Calendar, then:
- **Firefox (Android):** ⋮ menu → **Add app to Home screen** (on some versions: *Install*).
- **Chrome (Android):** ⋮ menu → **Add to Home screen → Install**.
- **Safari (iPhone/iPad):** Share button → **Add to Home Screen**.
- **Firefox / Chrome on iPhone:** Share → **Add to Home Screen** (iOS 16.4 or later).

It opens full screen like an app and works offline. Changes made offline appear on Google once you're back online.

## Using it on a phone
- **Tap** an empty time to add an event (or turn it into a task or reading plan). **Tap** an event or session to open it.
- **Press and hold**, then drag on empty time to choose a longer range. **Press and hold** an event, then drag to move it. Drag the bottom edge to resize.
- **Swipe left/right** for the next or previous day(s). The bottom bar switches between Day, 3 days, Week, Month and Analysis.
- **＋** adds an event, task or reading plan. **☰** opens tasks, calendars and the mini calendar. **⋯** has refresh, sync status, settings and export.

## Good to know
- **Sign-in renewal:** Google's sign-in for web apps lasts about an hour. When you reopen Tempo after that, it renews automatically with a quick redirect to Google and back. If you keep Tempo open for over an hour, a banner offers a one-tap **Reconnect**.
- **Reminders:** the web app shows notifications only while it's open (browsers don't let a closed website run timers). Task sessions are written to Google Calendar with reminders, so **your phone's Google Calendar app notifies you even when Tempo is closed**.
- **Exports** (PDF, PNG, TIFF) download to your phone's Downloads folder.
- **Updating:** upload the new `web` folder to the same host. The app picks up the new version the next time it opens.
