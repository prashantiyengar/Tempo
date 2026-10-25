# Phone: tap an empty slot → the create sheet has editable From and To times, each with − and + shortcuts.
import asyncio, sys, subprocess, time, re
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8791','-d','dist/web'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
INIT = """
const FIX = Date.parse('2026-10-20T06:00:00Z'); const _Date = Date; globalThis.__off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false, goalNotice: false}));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2026-10-19'));
}"""
async def touch(cdp, typ, x, y):
    await cdp.send('Input.dispatchTouchEvent', {'type': typ, 'touchPoints': [] if typ == 'touchEnd' else [{'x': x, 'y': y}]})
async def main():
    g = MockGoogle(); errs = []
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(**p.devices['Pixel 7'], timezone_id='Europe/Berlin')
        await ctx.add_init_script(INIT)
        await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        cdp = await ctx.new_cdp_session(page)
        await page.goto('http://localhost:8791/'); await page.wait_for_selector('.tg-col'); await page.wait_for_function('window.__tempo'); await page.wait_for_timeout(1500)
        hh = await page.evaluate('window.__tempo.app.state.settings.hourHeight')
        col = await page.eval_on_selector('.tg-col', 'e => { const r = e.getBoundingClientRect(); return {x: r.left + r.width / 2, top: r.top}; }')
        await page.eval_on_selector('.tg-scroll', f'e => e.scrollTop = {14 * hh}'); await page.wait_for_timeout(300)
        col = await page.eval_on_selector('.tg-col', 'e => { const r = e.getBoundingClientRect(); return {x: r.left + r.width / 2, top: r.top}; }')
        y = col['top'] + 18.25 * hh
        await touch(cdp, 'touchStart', col['x'], y); await asyncio.sleep(0.06); await touch(cdp, 'touchEnd', col['x'], y); await page.wait_for_timeout(500)
        v = lambda: asyncio.gather(page.input_value('.popover [name=qs]'), page.input_value('.popover [name=qe]'))
        print('1. sheet times:', await v(), '|', await page.text_content('.popover .qc-when'))
        await page.screenshot(path=f'{OUT}/m1-create-sheet.png')
        await page.evaluate("document.querySelector('.popover .st-add[data-add=\"-30\"]').click()"); await page.evaluate("document.querySelector('.popover .st-add[data-add=\"-10\"]').click()")
        await page.evaluate("document.querySelector('.popover .dur-add[data-add=\"15\"]').click()"); await page.evaluate("document.querySelector('.popover .dur-add[data-add=\"-5\"]').click()")
        print('2. after From −30 −10, To +15 −5:', await v(), '|', await page.text_content('.popover .qc-when'))
        await page.fill('.popover [name=qe]', '20:00'); await page.dispatch_event('.popover [name=qe]', 'change')
        print('3. typed To 20:00:', await v(), '|', await page.text_content('.popover .qc-when'))
        await page.fill('.popover input[name=title]', 'Yoga'); await page.tap('.popover button[type=submit]'); await page.wait_for_timeout(1500)
        e = [x for x in g.events['me@example.com'].values() if x.get('summary') == 'Yoga']
        print('4. saved:', e[0]['start']['dateTime'], '→', e[0]['end']['dateTime'] if e else None)
        print('ERRORS:', errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
