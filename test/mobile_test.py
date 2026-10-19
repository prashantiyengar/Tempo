# Phone tests for the web app: layout, touch gestures (tap, long-press drag, swipe), Google sign-in redirect,
# silent renewal, install manifest and offline use. Uses Chromium's touch emulation via CDP.
import asyncio, sys, subprocess, time, re, json, os, urllib.parse
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
PORT = 8790
srv = subprocess.Popen(['python3','-m','http.server',str(PORT),'-d','dist/web'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
BASE = f'http://localhost:{PORT}/'
FREEZE = """const FIX = Date.parse('2026-10-19T07:00:00Z'); const _Date = Date; const off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+off);} else super(...a);} static now(){ return _Date.now()+off; } } globalThis.Date = D;"""

async def touch(cdp, typ, x, y):
    pts = [] if typ == 'touchEnd' else [{'x': x, 'y': y}]
    await cdp.send('Input.dispatchTouchEvent', {'type': typ, 'touchPoints': pts})

async def long_drag(page, cdp, x0, y0, x1, y1, hold=0.6, steps=8):
    await touch(cdp, 'touchStart', x0, y0); await asyncio.sleep(hold)
    for i in range(1, steps + 1):
        await touch(cdp, 'touchMove', x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps); await asyncio.sleep(0.03)
    await touch(cdp, 'touchEnd', x1, y1)

async def swipe(cdp, x0, y0, dx):
    await touch(cdp, 'touchStart', x0, y0)
    for i in range(1, 7): await touch(cdp, 'touchMove', x0 + dx * i / 6, y0 + 3); await asyncio.sleep(0.02)
    await touch(cdp, 'touchEnd', x0 + dx, y0)

async def tap(cdp, x, y):
    await touch(cdp, 'touchStart', x, y); await asyncio.sleep(0.06); await touch(cdp, 'touchEnd', x, y)

async def main():
    errs = []
    async with async_playwright() as p:
        b = await p.chromium.launch()
        dev = p.devices['Pixel 7']
        ctx = await b.new_context(**dev, timezone_id='Europe/Berlin', locale='en-US')
        await ctx.add_init_script(FREEZE)
        g = MockGoogle()
        auth_requests = []
        async def google_auth(route):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(route.request.url).query)
            auth_requests.append({k: v[0] for k, v in q.items()})
            frag = urllib.parse.urlencode({'access_token': f'tok{len(auth_requests)}', 'expires_in': '3600', 'token_type': 'Bearer', 'state': q['state'][0], 'scope': q['scope'][0]})
            await route.fulfill(status=302, headers={'Location': q['redirect_uri'][0] + '#' + frag})
        await ctx.route(re.compile(r'https://accounts\.google\.com/o/oauth2/v2/auth.*'), google_auth)
        await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        page = await ctx.new_page()
        page.on('pageerror', lambda e: errs.append(str(e)))
        cdp = await ctx.new_cdp_session(page)
        await page.goto(BASE); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(800)
        vis = lambda sel: page.eval_on_selector(sel, 'e => !!(e.offsetWidth || e.offsetHeight) && getComputedStyle(e).visibility !== "hidden"')
        print('layout: view title =', await page.text_content('#range-title'), '| bottombar', await vis('#bottombar'), '| fab', await vis('#fab'), '| sidebar visible', await page.eval_on_selector('#side', 'e => e.getBoundingClientRect().right > 0'))
        await page.screenshot(path=f'{OUT}/m1-day.png')

        # FAB -> reading plan (full-screen dialog)
        await page.tap('#fab'); await page.wait_for_selector('dialog .sheet-menu'); await page.screenshot(path=f'{OUT}/m2-fab.png')
        await page.tap('dialog .sheet-menu button[data-i="2"]'); await page.wait_for_selector('dialog .task-form')
        box = await page.eval_on_selector('dialog.modal', 'e => { const r = e.getBoundingClientRect(); return [r.width, r.height, innerWidth, innerHeight]; }')
        print('task dialog size vs screen:', box)
        await page.fill('dialog [name=title]', 'Pride and Prejudice'); await page.fill('dialog [name=pages]', '200'); await page.fill('dialog [name=startPage]', '47'); await page.fill('dialog [name=speed]', '20')
        await page.fill('dialog [name=deadline]', '2026-10-30T17:00'); await page.wait_for_timeout(200)
        await page.screenshot(path=f'{OUT}/m3-task-dialog.png')
        await page.tap('dialog button[type=submit]'); await page.wait_for_timeout(900)
        print('sessions today:', await page.eval_on_selector_all('.ev.chunk', 'e => e.length'))
        await page.screenshot(path=f'{OUT}/m4-day-tasks.png')

        # Scroll the grid with a vertical swipe (must scroll, not create)
        sc0 = await page.eval_on_selector('.tg-scroll', 'e => e.scrollTop')
        col = await page.eval_on_selector('.tg-col', 'e => { const r = e.getBoundingClientRect(); return {x: r.left + r.width * 0.7, top: r.top}; }')
        scrollbox = await page.eval_on_selector('.tg-scroll', 'e => { const r = e.getBoundingClientRect(); return {top: r.top, bottom: r.bottom}; }')
        y = scrollbox['bottom'] - 80
        await touch(cdp, 'touchStart', col['x'], y)
        for i in range(1, 10): await touch(cdp, 'touchMove', col['x'], y - i * 30); await asyncio.sleep(0.016)
        await touch(cdp, 'touchEnd', col['x'], y - 270); await page.wait_for_timeout(500)
        sc1 = await page.eval_on_selector('.tg-scroll', 'e => e.scrollTop')
        print('vertical swipe scrolls grid:', sc0, '->', sc1, '| popover opened?', bool(await page.query_selector('.popover')))

        # Tap empty slot at 18:00 -> quick add sheet
        hh = await page.evaluate('window.__tempo.app.state.settings.hourHeight')
        colr = await page.eval_on_selector('.tg-col', 'e => { const r = e.getBoundingClientRect(); return {x: r.left + r.width * 0.5, top: r.top}; }')
        await tap(cdp, colr['x'], colr['top'] + 18.25 * hh); await page.wait_for_timeout(300)
        print('tap empty -> quick add:', await page.text_content('.popover .qc-when'))
        await page.screenshot(path=f'{OUT}/m5-quick-add.png')
        await page.fill('.popover input[name=title]', 'Gym'); await page.tap('.popover button[type=submit]'); await page.wait_for_timeout(500)
        print('events now:', await page.eval_on_selector_all('.ev:not(.chunk) .ev-t', 'e => e.map(x => x.textContent.trim())'))

        # Long-press + drag to create 19:30-21:00
        colr = await page.eval_on_selector('.tg-col', 'e => { const r = e.getBoundingClientRect(); return {x: r.left + r.width * 0.5, top: r.top}; }')
        await long_drag(page, cdp, colr['x'], colr['top'] + 19.6 * hh, colr['x'], colr['top'] + 20.9 * hh); await page.wait_for_timeout(300)
        print('long-press drag create ->', await page.text_content('.popover .qc-when') if await page.query_selector('.popover .qc-when') else 'NO POPOVER')
        await page.fill('.popover input[name=title]', 'Dinner'); await page.tap('.popover button[type=submit]'); await page.wait_for_timeout(500)

        # Long-press an event and drag it down by 1h
        gym = await page.eval_on_selector('.ev:not(.chunk):has-text("Gym")', 'e => { const r = e.getBoundingClientRect(); return {x: r.left + r.width/2, y: r.top + 8}; }')
        await long_drag(page, cdp, gym['x'], gym['y'], gym['x'], gym['y'] + hh); await page.wait_for_timeout(600)
        print('long-press move Gym ->', await page.eval_on_selector('.ev:not(.chunk):has-text("Gym") .ev-time', 'e => e.textContent.trim()'))

        # Tap a session -> bottom sheet -> mark done
        await page.eval_on_selector('.tg-scroll', 'e => e.scrollTop = 8 * 48')
        s1 = await page.eval_on_selector('.ev.chunk', 'e => { const r = e.getBoundingClientRect(); return {x: r.left + r.width/2, y: r.top + r.height/2}; }')
        await tap(cdp, s1['x'], s1['y']); await page.wait_for_timeout(300)
        sheet = await page.eval_on_selector('.popover', 'e => { const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.bottom), Math.round(r.width), innerWidth, innerHeight]; }')
        print('session sheet [left,bottom,width,vw,vh]:', sheet)
        await page.screenshot(path=f'{OUT}/m6-session-sheet.png')
        await page.tap('.popover .done'); await page.wait_for_timeout(600)
        print('done sessions:', await page.eval_on_selector_all('.ev.chunk.done', 'e => e.length'))

        # Swipe left -> next day; swipe right -> back
        t0 = await page.text_content('#range-title')
        mid = await page.eval_on_selector('.tg-scroll', 'e => { const r = e.getBoundingClientRect(); return {x: r.left + r.width/2, y: r.top + r.height/2}; }')
        await swipe(cdp, mid['x'] + 100, mid['y'], -220); await page.wait_for_timeout(400)
        t1 = await page.text_content('#range-title')
        await swipe(cdp, mid['x'] - 100, mid['y'], 220); await page.wait_for_timeout(400)
        print('swipe:', t0, '->', t1, '->', await page.text_content('#range-title'))

        # Drawer
        await page.tap('#btn-menu'); await page.wait_for_timeout(350)
        print('drawer open:', await page.eval_on_selector('#side', 'e => Math.round(e.getBoundingClientRect().left)'))
        await page.screenshot(path=f'{OUT}/m7-drawer.png')
        await page.touchscreen.tap(400, 400); await page.wait_for_timeout(350)
        print('drawer closed by tapping outside:', await page.eval_on_selector('#side', 'e => e.getBoundingClientRect().right <= 0'))

        # 3 days, month, analysis
        for v in ('3day', 'month', 'analysis'):
            await page.tap(f'#bottombar button[data-view="{v}"]'); await page.wait_for_timeout(600)
            await page.screenshot(path=f'{OUT}/m8-{v}.png')
        print('3day title check done')
        await page.tap('#bottombar button[data-view="day"]'); await page.wait_for_timeout(300)

        # Phone download: More -> This week as PDF -> save sheet -> tap Save
        await page.tap('#btn-more'); await page.wait_for_selector('dialog .sheet-menu')
        await page.tap('dialog .sheet-menu button:has-text("This week as PDF")')
        await page.wait_for_selector('dialog .save-sheet', timeout=20000); await page.screenshot(path=f'{OUT}/m12-save-sheet.png')
        async with page.expect_download() as dl:
            await page.tap('dialog .save-link')
        d = await dl.value; print('phone PDF download:', d.suggested_filename, os.path.getsize(await d.path()), 'bytes')
        await page.tap('dialog .save-sheet [data-close]'); await page.wait_for_timeout(300)

        # More menu -> settings (full screen) -> connect via manual client ID (web redirect sign-in)
        await page.tap('#btn-more'); await page.wait_for_selector('dialog .sheet-menu'); await page.screenshot(path=f'{OUT}/m9-more.png')
        await page.tap('dialog .sheet-menu button:has-text("Settings")'); await page.wait_for_selector('dialog .settings-form')
        await page.tap('dialog .tabs button[data-tab="2"]')
        await page.click('dialog details.adv summary')
        print('redirect URI shown:', await page.eval_on_selector('dialog details.adv input[readonly]', 'e => e.value'))
        await page.fill('dialog [name=clientId]', '1234-abc.apps.googleusercontent.com')
        await page.screenshot(path=f'{OUT}/m10-settings-google.png')
        await page.tap('dialog .connect')
        await page.wait_for_url(re.compile(r'localhost.*'), timeout=10000); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(2500)
        print('auth request:', {k: auth_requests[-1][k] for k in ('prompt', 'redirect_uri', 'response_type')})
        a = await page.evaluate("JSON.parse(localStorage.getItem('tempo:auth'))")
        print('after redirect: connected', a.get('connected'), 'token', a.get('token'), 'email', a.get('email'), '| url', page.url)
        print('status:', await page.text_content('#sync-status'), '| tasks on Google:', len(g.task_events()))

        # Token expires -> reopening the app renews silently (prompt=none)
        await page.evaluate("const a = JSON.parse(localStorage.getItem('tempo:auth')); a.expires = 1; localStorage.setItem('tempo:auth', JSON.stringify(a)); sessionStorage.clear();")
        n0 = len(auth_requests)
        await page.goto(BASE + '?view=week'); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(2000)
        print('silent renew:', len(auth_requests) - n0, 'request(s), prompt =', auth_requests[-1].get('prompt'), '| token now', json.loads(await page.evaluate("localStorage.getItem('tempo:auth')"))['token'], '| view kept:', await page.evaluate('window.__tempo.app.view'))

        # Installability bits + offline
        man = await page.evaluate("fetch('manifest.webmanifest').then(r => r.json())")
        print('manifest:', man['display'], [i['sizes'] + '/' + i['purpose'] for i in man['icons']])
        sw = await page.evaluate("navigator.serviceWorker.ready.then(r => !!r.active)")
        print('service worker active:', sw)
        await page.wait_for_timeout(1500)
        await ctx.set_offline(True)
        await page.reload(); await page.wait_for_timeout(1500)
        print('offline reload renders:', bool(await page.query_selector('.tg-col')))
        await ctx.set_offline(False)

        # iPhone layout snapshot
        ctx2 = await b.new_context(**p.devices['iPhone 13'], timezone_id='Europe/Berlin'); await ctx2.add_init_script(FREEZE)
        pg2 = await ctx2.new_page(); pg2.on('pageerror', lambda e: errs.append('iphone: ' + str(e)))
        await pg2.goto(BASE + '?view=3day'); await pg2.wait_for_selector('.tg-col'); await pg2.wait_for_timeout(600)
        await pg2.screenshot(path=f'{OUT}/m11-iphone-3day.png')
        print('ERRORS:', errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
