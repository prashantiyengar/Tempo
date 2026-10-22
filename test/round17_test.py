# Started late; icons grouped by theme; weekly review tab (newspaper) with done events, all events, pages read;
# separate "Till next event" buffer.
import asyncio, sys, subprocess, time, re, json
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8803','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
INIT = """
const FIX = Date.parse('2026-10-19T07:00:00Z'); const _Date = Date; if (globalThis.__off === undefined) globalThis.__off = FIX - _Date.now();
try { const o = sessionStorage.getItem('__off'); if (o) globalThis.__off = +o - _Date.now(); } catch {}
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false}));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2026-10-19'));
}"""
async def main():
    g = MockGoogle(); errs = []
    E = g.events['me@example.com']
    E['st'] = {'id': 'st', 'summary': 'Standup', 'status': 'confirmed', 'recurrence': ['RRULE:FREQ=DAILY'], 'start': {'dateTime': '2026-10-12T08:30:00+02:00', 'timeZone': 'Europe/Berlin'}, 'end': {'dateTime': '2026-10-12T08:45:00+02:00', 'timeZone': 'Europe/Berlin'}}
    E['ch'] = {'id': 'ch', 'summary': 'Choir', 'status': 'confirmed', 'recurrence': ['RRULE:FREQ=WEEKLY'], 'start': {'dateTime': '2026-10-13T19:00:00+02:00', 'timeZone': 'Europe/Berlin'}, 'end': {'dateTime': '2026-10-13T21:00:00+02:00', 'timeZone': 'Europe/Berlin'}}
    E['dn'] = {'id': 'dn', 'summary': 'Dentist', 'status': 'confirmed', 'start': {'dateTime': '2026-10-20T08:00:00+02:00'}, 'end': {'dateTime': '2026-10-20T08:30:00+02:00'}}
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1440, 'height': 900}, timezone_id='Europe/Berlin')
        await ctx.add_init_script(INIT)
        await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8803/app.html'); await page.wait_for_selector('.tg-col'); await page.wait_for_function('window.tempo'); await page.wait_for_timeout(1500)
        run = lambda c: page.evaluate('(c) => window.tempo.run(c)', c)
        async def at(iso):
            await page.evaluate(f"globalThis.__off = Date.parse('{iso}') - (Date.now() - globalThis.__off)")
        # Monday 9:00: a reading plan (sessions this week), and a task
        await run([{'cmd': 'addTask', 'title': 'Dune', 'pages': 120, 'pagesPerHour': 30, 'deadline': '2026-10-23 17:00'}]); await page.wait_for_timeout(1000)
        # Thursday 13:55: a task with 50-minute sessions
        await at('2026-10-22T11:55:00Z'); await run([{'cmd': 'replan'}]); await page.wait_for_timeout(800)
        await run([{'cmd': 'addTask', 'title': 'Essay', 'hours': 2.5, 'deadline': '2026-10-28 17:00', 'sessionMinutes': 50}]); await page.wait_for_timeout(1200)
        ss = await run([{'cmd': 'listSessions', 'from': '2026-10-22', 'to': '2026-10-29'}])
        essay = [x for x in ss[0]['result'] if 'Essay' in x['task']]
        print('1. Essay sessions:', [(x['start'][11:], x['end'][11:]) for x in essay])
        tot = lambda lst: sum((int(x['end'][11:13]) * 60 + int(x['end'][14:16])) - (int(x['start'][11:13]) * 60 + int(x['start'][14:16])) for x in lst)
        print('   planned minutes:', tot(essay))
        # 14:25: started late
        await at('2026-10-22T12:25:00Z'); await page.evaluate("window.__tempo && 0"); await run([{'cmd': 'today'}]); await page.wait_for_timeout(300)
        await page.click('#btn-today'); await page.wait_for_timeout(600)
        first = essay[0]
        await page.click('.ev.chunk:has-text("Essay") >> nth=0'); await page.wait_for_selector('.popover .late')
        await page.click('.popover .late'); await page.wait_for_selector('dialog .late-form')
        print('   dialog:', re.sub(r'\s+', ' ', await page.text_content('dialog .late-sum')), '|', await page.input_value('dialog [name=at]'))
        await page.screenshot(path=f'{OUT}/l1-dialog.png')
        await page.fill('dialog [name=evTitle]', 'Phone call'); await page.select_option('dialog [name=evCat]', label='💼 Work')
        await page.click('dialog button[type=submit]'); await page.wait_for_timeout(2500)
        ss = await run([{'cmd': 'listSessions', 'from': '2026-10-22', 'to': '2026-10-29'}])
        essay2 = [x for x in ss[0]['result'] if 'Essay' in x['task']]
        print('   after:', [(x['start'][11:], x['end'][11:]) for x in essay2][:2], '| planned+done minutes:', tot(essay2))
        call = [e for e in E.values() if e.get('summary') == 'Phone call']
        print('   fill event:', call and (call[0]['start']['dateTime'], call[0]['end']['dateTime'], call[0].get('extendedProperties', {}).get('private', {}).get('tempoCatName')))
        print('   toast:', await page.text_content('#toast'))
        # API, no reallocation, on the next session
        await at('2026-10-22T13:10:00Z'); await run([{'cmd': 'replan'}]); await page.wait_for_timeout(600)
        r = await run([{'cmd': 'startedLate', 'at': '15:20', 'reallocate': False}])
        print('   API (drop):', json.dumps(r[0].get('result') or r[0].get('error')))
        ss = await run([{'cmd': 'listSessions', 'from': '2026-10-22', 'to': '2026-10-29'}])
        print('   total after drop:', tot([x for x in ss[0]['result'] if 'Essay' in x['task']]))
        # 2. icons grouped, used ones hidden
        await page.click('#btn-new-task'); await page.wait_for_selector('dialog .cat-host'); await page.click('dialog .cat-chip.add'); await page.wait_for_selector('dialog .ic-group')
        print('2. icon groups:', await page.eval_on_selector_all('dialog .ic-gl', 'xs => xs.map(x => x.textContent)'), '| 💼 hidden:', not await page.query_selector('dialog .cat-new .ic-btn[data-ic="💼"]'), '| 💻 shown:', bool(await page.query_selector('dialog .cat-new .ic-btn[data-ic="💻"]')))
        await page.screenshot(path=f'{OUT}/l2-icons.png'); await page.keyboard.press('Escape'); await page.wait_for_timeout(300)
        # 3-5. review tab
        await run([{'cmd': 'markEventDone', 'event': 'Dentist'}]); await page.wait_for_timeout(800)
        await page.click('#view-seg button[data-view=review]'); await page.wait_for_selector('.np-title')
        txt = await page.inner_text('.np')
        print('3. paper:', await page.text_content('.np-title'), '|', await page.text_content('.np-lead .np-h1'))
        print('   finished:', await page.eval_on_selector_all('.np-check li', 'xs => xs.map(x => x.innerText)'))
        print('   books:', await page.text_content('.np-feuil .np-h3'), '|', await page.eval_on_selector_all('.np-feuil .np-list li', 'xs => xs.map(x => x.innerText)'))
        print('   horoscope:', (await page.text_content('.np-side .np-h3 >> nth=1')), '|', (await page.text_content('.np-side .np-small >> nth=1'))[:120])
        await page.screenshot(path=f'{OUT}/l3-paper.png', full_page=True)
        await page.check('[data-np=all]'); await page.wait_for_timeout(800)
        print('   all events:', await page.eval_on_selector_all('.np-feuil h4 + .np-list li', 'xs => xs.map(x => x.innerText)'), '|', await page.text_content('.np-feuil .np-small.np-mute') if await page.query_selector('.np-feuil .np-small.np-mute') else '')
        await page.select_option('[data-np=sign]', 'scorpio'); await page.wait_for_timeout(500)
        print('   sign saved:', await page.evaluate('window.__tempo.app.state.settings.zodiac'), '|', await page.text_content('.np-side .np-h3 >> nth=1'))
        await page.click('#btn-prev'); await page.wait_for_timeout(600); print('   previous week:', await page.text_content('#range-title'))
        await page.click('#btn-today'); await page.wait_for_timeout(600); print('   back:', await page.text_content('#range-title'))
        await page.screenshot(path=f'{OUT}/l4-paper-all.png', full_page=True)
        # 6. till next buffer separate from since last
        await page.click('#btn-settings'); await page.fill('dialog [name=sinceLastBuffer]', '0'); await page.fill('dialog [name=tillNextBuffer]', '10'); await page.click('dialog button[type=submit] >> nth=-1'); await page.wait_for_timeout(600)
        await page.click('#view-seg button[data-view=week]'); await page.wait_for_selector('.tg-col')
        await page.evaluate("document.querySelector('.tg-scroll').scrollTop = 18 * window.__tempo.app.state.settings.hourHeight - 100"); await page.wait_for_timeout(200)
        cols = await page.query_selector_all('.tg-col'); box = await cols[1].bounding_box(); hh = await page.evaluate('window.__tempo.app.state.settings.hourHeight')
        top = await page.evaluate("document.querySelector('.tg-col').getBoundingClientRect().top")
        await page.mouse.move(box['x'] + 20, top + 18 * hh + 2); await page.mouse.down(); await page.mouse.move(box['x'] + 20, top + 18.5 * hh - 2, steps=4); await page.mouse.up()
        await page.wait_for_selector('.popover .till-next'); await page.click('.popover .till-next'); await page.wait_for_timeout(300)
        print('6. till next (Tue 18:00, Choir 19:00, 10-min buffer):', await page.input_value('.popover [name=qe]'), '|', await page.text_content('#toast'))
        print('ERRORS:', errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
