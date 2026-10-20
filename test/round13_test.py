# Quick-create Cancel; "Since last event" relative to the slot (16:30 → 16:00, or 16:05 with a 5-min buffer).
import asyncio, sys, subprocess, time, re
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8794','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
INIT = """
const FIX = Date.parse('2026-10-20T06:00:00Z'); const _Date = Date; globalThis.__off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false}));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2026-10-19'));
}"""
async def main():
    g = MockGoogle(); errs = []
    g.events['me@example.com']['m'] = {'id': 'm', 'summary': 'Client meeting', 'status': 'confirmed', 'start': {'dateTime': '2026-10-21T15:00:00+02:00'}, 'end': {'dateTime': '2026-10-21T16:00:00+02:00'}}
    g.events['me@example.com']['n'] = {'id': 'n', 'summary': 'Late call', 'status': 'confirmed', 'start': {'dateTime': '2026-10-21T18:00:00+02:00'}, 'end': {'dateTime': '2026-10-21T18:30:00+02:00'}}
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1440, 'height': 900}, timezone_id='Europe/Berlin')
        await ctx.add_init_script(INIT)
        await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8794/app.html'); await page.wait_for_selector('.tg-col'); await page.wait_for_function('window.tempo'); await page.wait_for_timeout(1500)
        cols = await page.query_selector_all('.tg-col'); box = await cols[2].bounding_box(); hh = await page.evaluate('window.__tempo.app.state.settings.hourHeight')
        async def slot(h0, h1):
            await page.mouse.move(box['x'] + 20, box['y'] + h0 * hh + 2); await page.mouse.down(); await page.mouse.move(box['x'] + 20, box['y'] + h1 * hh - 2, steps=5); await page.mouse.up()
            await page.wait_for_selector('.popover .qc')
        # 1. Cancel
        await slot(10, 11); await page.click('.popover .qc-cancel'); await page.wait_for_timeout(300)
        print('1. after Cancel: popover open', bool(await page.query_selector('.popover')), '| leftover ghost', bool(await page.query_selector('.ghost-sel')))
        # 2. slot 16:30–17:30 → since last = 16:00 (Late call at 18:00 is after, so ignored)
        await slot(16.5, 17.5); await page.click('.popover .since-last'); await page.wait_for_timeout(500)
        print('2. since last (no buffer):', await page.input_value('.popover [name=qs]'), '–', await page.input_value('.popover [name=qe]'), '|', await page.text_content('#toast'))
        await page.screenshot(path=f'{OUT}/c1-quick.png'); await page.click('.popover .qc-cancel')
        # 3. buffer 5 min
        await page.click('#btn-settings'); await page.fill('dialog [name=sinceLastBuffer]', '5'); await page.click('dialog button[type=submit] >> nth=-1'); await page.wait_for_timeout(800)
        await slot(16.5, 17.5); await page.click('.popover .since-last'); await page.wait_for_timeout(500)
        print('3. with 5-min buffer:', await page.input_value('.popover [name=qs]'), '–', await page.input_value('.popover [name=qe]'), '|', await page.text_content('#toast'))
        await page.click('.popover .qc-cancel')
        # 4. event dialog: start 16:30 → since last = 16:05; end kept
        await slot(16.5, 17.5); await page.click('.popover .more'); await page.wait_for_selector('dialog .since-last')
        await page.click('dialog .since-last'); await page.wait_for_timeout(500)
        print('4. event dialog:', await page.input_value('dialog [name=sTime]'), '–', await page.input_value('dialog [name=eTime]'), '|', await page.text_content('dialog .since-note'))
        await page.keyboard.press('Escape')
        # 5. buffer is capped at 15
        await page.click('#btn-settings'); await page.fill('dialog [name=sinceLastBuffer]', '40'); await page.click('dialog button[type=submit] >> nth=-1'); await page.wait_for_timeout(800)
        print('5. buffer saved as:', await page.evaluate('window.__tempo.app.state.settings.sinceLastBuffer'))
        print('ERRORS:', errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
