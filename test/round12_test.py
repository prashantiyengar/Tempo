# Custom export (dates + hours) and side swipe on phones (day, week, month).
import asyncio, sys, subprocess, time, re, os
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8793','-d','dist/web'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
INIT = """
const FIX = Date.parse('2026-10-19T06:00:00Z'); const _Date = Date; globalThis.__off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false, goalNotice: false}));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2026-10-19'));
}"""
async def touch(cdp, typ, x, y):
    await cdp.send('Input.dispatchTouchEvent', {'type': typ, 'touchPoints': [] if typ == 'touchEnd' else [{'x': x, 'y': y}]})
async def swipe(cdp, x0, y0, dx, steps=8, pause=0.012):
    await touch(cdp, 'touchStart', x0, y0)
    for i in range(1, steps + 1): await touch(cdp, 'touchMove', x0 + dx * i / steps, y0 + 3); await asyncio.sleep(pause)
    await touch(cdp, 'touchEnd', x0 + dx, y0 + 3)
def setup_mock():
    g = MockGoogle()
    ev = lambda i, s, d, a, b: {'id': i, 'summary': s, 'status': 'confirmed', 'start': {'dateTime': f'{d}T{a}:00+02:00'}, 'end': {'dateTime': f'{d}T{b}:00+02:00'}}
    for i, (s, d, a, b) in enumerate([('Standup', '2026-10-19', '09:00', '09:30'), ('Choir', '2026-10-20', '19:00', '21:00'), ('Gym', '2026-10-21', '18:00', '19:00'), ('Climbing', '2026-10-24', '11:00', '13:00'), ('Planning', '2026-10-22', '14:00', '16:00')]):
        g.events['me@example.com'][f'e{i}'] = ev(f'e{i}', s, d, a, b)
    return g
async def main():
    errs = []
    async with async_playwright() as p:
        b = await p.chromium.launch()
        # ---- desktop: custom export
        g = setup_mock()
        ctx = await b.new_context(viewport={'width': 1440, 'height': 900}, timezone_id='Europe/Berlin', accept_downloads=True)
        await ctx.add_init_script(INIT)
        await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8793/'); await page.wait_for_selector('.tg-col'); await page.wait_for_function('window.tempo'); await page.wait_for_timeout(1500)
        await page.evaluate("tempo.addTask({ title: 'Report', hours: 6, deadline: '2026-10-23 17:00' })"); await page.wait_for_timeout(1500)
        async def export(setup, name):
            await page.click('#btn-export'); await page.click('#export-custom'); await page.wait_for_selector('dialog .custom-export')
            await setup()
            print('  ', name, '→', await page.text_content('dialog .summary'))
            async with page.expect_download() as dl: await page.click('dialog .custom-export button[type=submit]')
            d = await dl.value; path = f'{OUT}/{d.suggested_filename}'; await d.save_as(path); print('     saved', d.suggested_filename, os.path.getsize(path), 'bytes')
            return path
        async def after_hours():
            await page.fill('dialog [name=from]', '2026-10-19'); await page.fill('dialog [name=to]', '2026-10-23')
            await page.select_option('dialog [name=hours]', 'period:after-hours'); await page.click('dialog .seg label:has(input[value=png])')
            await page.screenshot(path=f'{OUT}/x0-dialog.png')
        async def nine_five():
            await page.click('dialog [data-r=next5]'); await page.select_option('dialog [name=hours]', 'custom')
            await page.fill('dialog [name=hStart]', '09:00'); await page.fill('dialog [name=hEnd]', '17:00'); await page.click('dialog .seg label:has(input[value=png])')
        async def two_weeks_pdf():
            await page.fill('dialog [name=from]', '2026-10-19'); await page.fill('dialog [name=to]', '2026-11-01'); await page.select_option('dialog [name=hours]', 'bounds')
        print('1. custom export:')
        await export(after_hours, 'after hours Oct 19–23'); await export(nine_five, '9–5 next 5 days'); await export(two_weeks_pdf, 'two weeks, work hours, PDF')
        await ctx.close()
        # ---- phone: swipes
        g = setup_mock()
        ctx = await b.new_context(**p.devices['Pixel 7'], timezone_id='Europe/Berlin')
        await ctx.add_init_script(INIT)
        await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        cdp = await ctx.new_cdp_session(page)
        await page.goto('http://localhost:8793/'); await page.wait_for_selector('.tg-col'); await page.wait_for_function('window.tempo'); await page.wait_for_timeout(1500)
        title = lambda: page.text_content('#range-title')
        mid = await page.eval_on_selector('.tg-scroll', 'e => { const r = e.getBoundingClientRect(); return {x: r.left + r.width/2, y: r.top + 200}; }')
        hdr = await page.eval_on_selector('.tg-head, .tg-days, .dayhead, .tg-col', 'e => { const r = e.getBoundingClientRect(); return {x: r.left + r.width/2, y: r.top + 10}; }')
        t0 = await title()
        await swipe(cdp, mid['x'] + 120, mid['y'], -260); await page.wait_for_timeout(600); t1 = await title()
        await swipe(cdp, mid['x'] - 120, mid['y'], 260); await page.wait_for_timeout(600); t2 = await title()
        await swipe(cdp, mid['x'] - 120, mid['y'], 260); await page.wait_for_timeout(600); t3 = await title()
        print('2. day view:', t0, '→ left:', t1, '→ right:', t2, '→ right:', t3)
        # slow drag past a third of the screen (no flick)
        await swipe(cdp, mid['x'] + 150, mid['y'], -200, steps=20, pause=0.04); await page.wait_for_timeout(600)
        print('   slow drag left:', await title())
        # short swipe: snaps back, no change
        await swipe(cdp, mid['x'], mid['y'], -30, steps=6, pause=0.05); await page.wait_for_timeout(500)
        print('   tiny swipe (no change):', await title(), '| no quick-add opened:', not await page.query_selector('.popover'))
        # vertical scroll still scrolls
        sc0 = await page.eval_on_selector('.tg-scroll', 'e => e.scrollTop')
        await touch(cdp, 'touchStart', mid['x'], mid['y'] + 200)
        for i in range(1, 10): await touch(cdp, 'touchMove', mid['x'] + 4, mid['y'] + 200 - i * 30); await asyncio.sleep(0.016)
        await touch(cdp, 'touchEnd', mid['x'] + 4, mid['y'] - 70); await page.wait_for_timeout(500)
        print('   vertical scroll still works:', sc0, '→', await page.eval_on_selector('.tg-scroll', 'e => e.scrollTop'), '| title unchanged:', await title())
        # week view
        await page.tap('#bottombar button[data-view=week]'); await page.wait_for_timeout(800)
        w0 = await title(); mid = await page.eval_on_selector('.tg-scroll', 'e => { const r = e.getBoundingClientRect(); return {x: r.left + r.width/2, y: r.top + 200}; }')
        await swipe(cdp, mid['x'] + 120, mid['y'], -260); await page.wait_for_timeout(600); w1 = await title()
        await swipe(cdp, mid['x'] - 120, mid['y'], 260); await page.wait_for_timeout(600); w2 = await title()
        print('3. week view:', w0, '→', w1, '→', w2)
        # swipe starting on the day header
        hdr = await page.eval_on_selector('#view', 'e => { const r = e.getBoundingClientRect(); return {x: r.left + r.width/2, y: r.top + 30}; }')
        await swipe(cdp, hdr['x'] + 120, hdr['y'], -260); await page.wait_for_timeout(600); print('   from the header:', await title())
        # month view
        await page.tap('#bottombar button[data-view=month]'); await page.wait_for_timeout(800)
        m0 = await title(); mm = await page.eval_on_selector('#view', 'e => { const r = e.getBoundingClientRect(); return {x: r.left + r.width/2, y: r.top + r.height/2}; }')
        await swipe(cdp, mm['x'] + 120, mm['y'], -260); await page.wait_for_timeout(600); m1 = await title()
        print('4. month view:', m0, '→', m1, '| no popover:', not await page.query_selector('.popover'))
        print('ERRORS:', errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
