# No "next session" hint; short gaps not counted as free; finished early (keep free / move tasks up);
# fill time since last event; length shortcuts; more icons; event titles in the analysis pulldowns.
import asyncio, sys, subprocess, time, re, datetime
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8778','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
INIT = """
const FIX = Date.parse('2026-10-19T07:30:00Z'); const _Date = Date; globalThis.__off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false, goalNotice: false}));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2026-10-19'));
}"""
BER = datetime.timezone(datetime.timedelta(hours=2))
def hm(ms): return datetime.datetime.fromtimestamp(ms / 1000, BER).strftime('%a %H:%M')
async def main():
    g = MockGoogle(); errs = []
    ev = lambda i, s, a, b, d='2026-10-19': {'id': i, 'summary': s, 'status': 'confirmed', 'start': {'dateTime': f'{d}T{a}:00+02:00'}, 'end': {'dateTime': f'{d}T{b}:00+02:00'}}
    g.events['me@example.com']['m1'] = ev('m1', 'Strategy workshop', '09:00', '10:30')
    g.events['me@example.com']['m2'] = ev('m2', 'Lunch with Sam', '12:00', '13:00', '2026-10-20')
    g.events['me@example.com']['m3'] = ev('m3', 'Dentist', '14:00', '15:00', '2026-10-21')
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1440, 'height': 900}, timezone_id='Europe/Berlin')
        await ctx.add_init_script(INIT)
        await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8778/app.html'); await page.wait_for_selector('.tg-col'); await page.wait_for_function('window.__tempo'); await page.wait_for_timeout(1500)
        print('1. next-session hint shown:', bool(await page.query_selector('.next-hint')))
        await page.click('#btn-new-task'); await page.wait_for_selector('dialog .task-form')
        await page.fill('dialog [name=title]', 'Report'); await page.fill('dialog [name=hours]', '4'); await page.fill('dialog [name=deadline]', '2026-10-23T17:00')
        await page.click('dialog .task-form button[type=submit]'); await page.wait_for_timeout(2500)
        sess = lambda: page.evaluate("window.__tempo.S.sessions(window.__tempo.app.state.tasks[0]).map(s => [s.start, s.end, s.kind])")
        print('   Report sessions:', [(hm(a), hm(z)[4:], k) for a, z, k in await sess()])

        # 3a. Finished the workshop early (09:30 instead of 10:30) → keep the time free
        await page.click('.ev:has-text("Strategy workshop")'); await page.click('.popover .fin-early'); await page.wait_for_selector('dialog.narrow h2')
        print('3a. prompt:', await page.text_content('dialog.narrow h2'), '|', await page.text_content('dialog.narrow p'))
        await page.screenshot(path=f'{OUT}/f1-finished-early.png')
        await page.click('dialog.narrow .choice-btn:has-text("Leave it free")'); await page.wait_for_timeout(2500)
        w = g.events['me@example.com']['m1']
        print('    workshop on Google now ends:', w['end']['dateTime'], '| holds:', await page.evaluate("JSON.stringify((window.__tempo.app.state.settings.holds||[]).map(h => [h.start, h.end]))") != '[]', '| kept-free strip:', await page.eval_on_selector_all('.hold', 'e => e.length'))
        print('    Report sessions:', [(hm(a), hm(z)[4:], k) for a, z, k in await sess()])
        await page.screenshot(path=f'{OUT}/f2-kept-free.png')

        # 3b. A Report session is running; finish it early → move tasks up
        first = (await sess())[0]
        await page.evaluate(f"globalThis.__off += ({first[0]} + 20*60000) - Date.now()"); await page.evaluate("window.__tempo.cycle()"); await page.wait_for_timeout(1500)
        await page.keyboard.press('f'); await page.wait_for_timeout(500)
        if await page.query_selector('dialog.narrow .choice-btn:has-text("Report")'): await page.click('dialog.narrow .choice-btn:has-text("Report")')
        await page.wait_for_selector('dialog.narrow h2:has-text("early")'); print('3b. prompt:', await page.text_content('dialog.narrow h2'))
        await page.click('dialog.narrow .choice-btn:has-text("Move tasks up")'); await page.wait_for_timeout(2500)
        print('    Report sessions:', [(hm(a), hm(z)[4:], k) for a, z, k in await sess()], '| toast:', await page.text_content('#toast'))

        # 4. Fill time since last event
        await page.evaluate("globalThis.__off += 47 * 60000"); await page.keyboard.press('l'); await page.wait_for_selector('dialog [name=sTime]')
        print('4. fill since last:', await page.input_value('dialog [name=sTime]'), '→', await page.input_value('dialog [name=eTime]'), '| length', await page.text_content('dialog .dur-now'))
        # 5. length shortcuts (repeatable)
        for _ in range(2): await page.click('dialog .dur-add[data-add="5"]')
        await page.click('dialog .dur-add[data-add="15"]'); await page.click('dialog .dur-add[data-add="60"]')
        print('5. after +5 +5 +15 +1h:', await page.input_value('dialog [name=eTime]'), '| length', await page.text_content('dialog .dur-now'))
        await page.screenshot(path=f'{OUT}/f3-fill-since-last.png')
        await page.fill('dialog [name=summary]', 'Email catch-up'); await page.click('dialog button[type=submit] >> nth=-1'); await page.wait_for_timeout(1500)
        e = [x for x in g.events['me@example.com'].values() if x.get('summary') == 'Email catch-up']
        print('   created:', e[0]['start']['dateTime'][11:16] if e else None, '→', e[0]['end']['dateTime'][11:16] if e else None, '(UTC)')
        # quick create length chips
        cols = await page.query_selector_all('.tg-col'); box = await cols[3].bounding_box(); hh = await page.evaluate('window.__tempo.app.state.settings.hourHeight')
        await page.mouse.move(box['x'] + 20, box['y'] + 16 * hh + 2); await page.mouse.down(); await page.mouse.move(box['x'] + 20, box['y'] + 16.5 * hh - 2, steps=5); await page.mouse.up()
        await page.wait_for_selector('.popover .qc'); await page.click('.popover .dur-add[data-add="30"]'); await page.click('.popover .dur-add[data-add="30"]')
        print('   quick create after +30 +30:', await page.text_content('.popover .qc-when')); await page.keyboard.press('Escape')

        # 6. icons
        await page.click('#btn-settings'); await page.click('dialog .tabs button[data-tab="5"]')
        print('6. icons to choose from:', await page.eval_on_selector_all('dialog .cat-row >> nth=0 >> .ic-btn', 'e => e.length - 1')); await page.keyboard.press('Escape')

        # 2 + 7. Analysis: gaps not free; event titles in pulldowns
        await page.click('#view-seg button[data-view=analysis]'); await page.wait_for_selector('.an-det'); await page.wait_for_timeout(500)
        print('2. free tile:', (await page.inner_text('.an-tiles .tile:nth-child(3)')).replace('\n', ' | '), '| gap note:', await page.text_content('.an-gaps') if await page.query_selector('.an-gaps') else None)
        for d in await page.query_selector_all('.an-det'): await d.evaluate('e => e.open = true')
        items = await page.eval_on_selector_all('.an-items li', "e => e.map(li => [li.querySelector('.an-it-k').textContent, li.querySelector('.an-it-t').textContent, Math.round(li.querySelector('.an-it-t').getBoundingClientRect().width)])")
        print('7. pulldown items (kind, title, title width px):', items)
        await page.screenshot(path=f'{OUT}/f4-analysis.png', full_page=True)
        await page.set_viewport_size({'width': 420, 'height': 860}); await page.wait_for_timeout(600)
        items = await page.eval_on_selector_all('.an-items li', "e => e.map(li => Math.round(li.querySelector('.an-it-t').getBoundingClientRect().width))")
        print('   narrow screen title widths:', items)
        print('ERRORS:', errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
