# Minus length shortcuts; "since last event" across midnight (max 12 h) from the event dialog, quick create and L.
import asyncio, sys, subprocess, time, re
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8779','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
INIT = """
const FIX = Date.parse('2026-10-20T04:00:00Z'); const _Date = Date; globalThis.__off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false, goalNotice: false}));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2026-10-19'));
}"""
async def main():
    g = MockGoogle(); errs = []
    g.events['me@example.com']['d1'] = {'id': 'd1', 'summary': 'Dinner', 'status': 'confirmed', 'start': {'dateTime': '2026-10-19T20:30:00+02:00'}, 'end': {'dateTime': '2026-10-19T22:00:00+02:00'}}
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1440, 'height': 900}, timezone_id='Europe/Berlin')
        await ctx.add_init_script(INIT)
        await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8779/app.html'); await page.wait_for_selector('.tg-col'); await page.wait_for_function('window.__tempo'); await page.wait_for_timeout(1500)
        vals = lambda: asyncio.gather(*[page.input_value(f'dialog [name={n}]') for n in ('sDate', 'sTime', 'eDate', 'eTime')])
        # 1. In the + Event dialog: "Since last event" at 06:00 → yesterday 22:00 – today 06:00
        await page.click('#btn-new-event'); await page.wait_for_selector('dialog .since-last')
        await page.click('dialog .since-last'); await page.wait_for_timeout(800)
        print('1. since last:', await vals(), '| length', await page.text_content('dialog .dur-now'), '|', await page.text_content('dialog .since-note'))
        await page.screenshot(path=f'{OUT}/s1-since-last.png')
        # 2. minus shortcuts
        await page.click('dialog .dur-add[data-add="-60"]'); a = await vals()
        await page.click('dialog .dur-add[data-add="-30"]'); await page.click('dialog .dur-add[data-add="-10"]'); await page.click('dialog .dur-add[data-add="-5"]'); b2 = await vals()
        print('2. −1h →', a[2:], '| −30 −10 −5 →', b2[2:], '| length', await page.text_content('dialog .dur-now'))
        await page.fill('dialog [name=summary]', 'Sleep'); await page.click('dialog button[type=submit] >> nth=-1'); await page.wait_for_timeout(1500)
        sl = [e for e in g.events['me@example.com'].values() if e.get('summary') == 'Sleep']
        print('   saved:', sl[0]['start']['dateTime'], '→', sl[0]['end']['dateTime'])
        # 3. L key (no event in the last 12 h after moving the clock forward 20 h)
        await page.evaluate("globalThis.__off += 20 * 3600000"); await page.keyboard.press('l'); await page.wait_for_selector('dialog [name=sTime]'); await page.wait_for_timeout(400)
        print('3. L with nothing in 12h:', await vals(), '| toast:', await page.text_content('#toast'))
        await page.keyboard.press('Escape')
        print('ERRORS:', errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
