# Settings tab bar stays visible while scrolling; create popup stays fully on screen near the bottom; events can be marked done / undone.
import asyncio, sys, subprocess, time, re, json
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8797','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
INIT = """
const FIX = Date.parse('2026-10-20T08:00:00Z'); const _Date = Date; globalThis.__off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false, goalNotice: false, dayStart: '00:00', dayEnd: '24:00'}));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2026-10-19'));
}"""
async def main():
    g = MockGoogle(); errs = []
    g.events['me@example.com']['m'] = {'id': 'm', 'summary': 'Dentist', 'status': 'confirmed', 'start': {'dateTime': '2026-10-20T09:00:00+02:00'}, 'end': {'dateTime': '2026-10-20T09:45:00+02:00'}}
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1366, 'height': 700}, timezone_id='Europe/Berlin')
        await ctx.add_init_script(INIT)
        await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8797/app.html'); await page.wait_for_selector('.tg-col'); await page.wait_for_function('window.tempo'); await page.wait_for_timeout(1500)
        # 1. settings: scroll Scheduling, tab bar still visible
        await page.click('#btn-settings'); await page.click('dialog .tabs button[data-tab="1"]')
        await page.evaluate("document.querySelector('dialog[open] .dlg-body').scrollTop = 99999; document.querySelector('dialog[open]').scrollTop = 99999")
        await page.wait_for_timeout(200)
        r = await page.evaluate("""(() => { const b = document.querySelector('dialog[open] .tabs button[data-tab="1"]').getBoundingClientRect(); const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return [!!hit?.closest('.tabs') && b.height > 20, Math.round(b.top)]; })()""")
        print('1. tab bar visible after scrolling Scheduling:', r[0]); await page.screenshot(path=f'{OUT}/s1-settings.png')
        await page.click('dialog .tabs button[data-tab="5"]')
        print('   switching tab scrolls back to top:', await page.evaluate("document.querySelector('dialog[open] .dlg-body').scrollTop") == 0)
        await page.keyboard.press('Escape'); await page.wait_for_timeout(300)
        # 2. create near the bottom of the visible grid
        cols = await page.query_selector_all('.tg-col'); await page.evaluate("document.querySelector('.tg-scroll, #view .scroll, .tg-body') && 0")
        vis = await page.evaluate("(() => { const c = document.querySelectorAll('.tg-col')[1].getBoundingClientRect(); return [c.x, Math.min(c.bottom, innerHeight)]; })()")
        y = vis[1] - 30
        await page.mouse.move(vis[0] + 20, y - 40); await page.mouse.down(); await page.mouse.move(vis[0] + 20, y, steps=4); await page.mouse.up()
        await page.wait_for_selector('.popover .qc'); await page.wait_for_timeout(300)
        def inside(): return page.evaluate("(() => { const r = document.querySelector('.popover').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; })()")
        print('2. popup fully on screen:', await inside(), '| Save visible:', await page.evaluate("(() => { const r = document.querySelector('.popover .qc-actions button[type=submit], .popover .qc-actions .primary').getBoundingClientRect(); return r.bottom <= innerHeight; })()"))
        await page.screenshot(path=f'{OUT}/s2-bottom.png')
        await page.click('.popover .since-last'); await page.wait_for_timeout(400)
        print('   still on screen after it grows:', await inside())
        await page.click('.popover .qc-cancel')
        # small window
        await page.set_viewport_size({'width': 1100, 'height': 480}); await page.wait_for_timeout(300)
        vis = await page.evaluate("(() => { const c = document.querySelectorAll('.tg-col')[1].getBoundingClientRect(); return [c.x, Math.min(c.bottom, innerHeight)]; })()")
        y = vis[1] - 20
        await page.mouse.move(vis[0] + 20, y - 30); await page.mouse.down(); await page.mouse.move(vis[0] + 20, y, steps=4); await page.mouse.up(); await page.wait_for_selector('.popover .qc')
        print('   480px-tall window: on screen', await inside(), '| scrolls inside', await page.evaluate("(() => { const p = document.querySelector('.popover'); return p.scrollHeight > p.clientHeight; })()"))
        await page.click('.popover .qc-cancel'); await page.set_viewport_size({'width': 1366, 'height': 700}); await page.wait_for_timeout(300)
        # 3. mark an event done / undone
        await page.evaluate("document.querySelector('[data-key=\"me@example.com|m\"]').scrollIntoView({block:'center'})")
        await page.click('[data-key="me@example.com|m"]'); await page.wait_for_selector('.popover .ev-done'); await page.click('.popover .ev-done'); await page.wait_for_timeout(1200)
        cls = await page.get_attribute('[data-key="me@example.com|m"]', 'class')
        print('3. marked done: class done', 'done' in cls, '| saved in Google', g.events['me@example.com']['m'].get('extendedProperties', {}).get('private', {}).get('tempoDone'), '| toast', await page.text_content('#toast'))
        await page.click('[data-key="me@example.com|m"]'); await page.wait_for_selector('.popover .ev-undone')
        print('   popup shows Done pill:', bool(await page.query_selector('.popover .pill.ok')))
        await page.click('.popover .ev-undone'); await page.wait_for_timeout(1200)
        cls = await page.get_attribute('[data-key="me@example.com|m"]', 'class')
        print('   marked undone: class done', 'done' in cls, '| Google', g.events['me@example.com']['m']['extendedProperties']['private'].get('tempoDone'))
        await page.click('#btn-undo'); await page.wait_for_timeout(1500)
        print('   undo → done again:', 'done' in (await page.get_attribute('[data-key="me@example.com|m"]', 'class')))
        r = await page.evaluate("window.tempo.run([{cmd:'markEventDone', event:'Dentist', done:false}, {cmd:'listEvents', from:'2026-10-20', to:'2026-10-21'}])")
        print('   AI command:', json.dumps(r)[:400])
        print('ERRORS:', errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
