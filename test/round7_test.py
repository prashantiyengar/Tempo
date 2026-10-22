# Recurring event: moving one occurrence must not duplicate it; date shortcuts; export analysis panel;
# new events default to the task calendar.
import asyncio, sys, subprocess, time, re, json, datetime, os
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8777','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
INIT = """
const FIX = Date.parse('2026-10-19T05:30:00Z'); const _Date = Date; globalThis.__off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false, goalNotice: false, taskCalendarId: 'work'}));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2026-10-19'));
}"""
async def main():
    g = MockGoogle(); errs = []
    # weekly series on Tuesdays 10:00-11:00, created in Google with an RRULE written slightly differently from Tempo's
    g.events['me@example.com']['wk'] = {'id': 'wk', 'summary': 'Team sync', 'status': 'confirmed', 'recurrence': ['RRULE:FREQ=WEEKLY;WKST=SU;BYDAY=TU;INTERVAL=1'],
        'start': {'dateTime': '2026-10-13T10:00:00+02:00', 'timeZone': 'Europe/Berlin'}, 'end': {'dateTime': '2026-10-13T11:00:00+02:00', 'timeZone': 'Europe/Berlin'}}
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1440, 'height': 900}, timezone_id='Europe/Berlin', accept_downloads=True)
        await ctx.add_init_script(INIT)
        await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8777/app.html'); await page.wait_for_selector('.tg-col'); await page.wait_for_function('window.__tempo'); await page.wait_for_timeout(1500)
        def week_list():
            q = {'singleEvents': ['true'], 'timeMin': ['2026-10-19T00:00:00Z'], 'timeMax': ['2026-11-02T00:00:00Z']}
            return sorted((e['start']['dateTime'][:16], e['summary']) for e in g.single_events('me@example.com', list(g.events['me@example.com'].values()), q) if e.get('summary') == 'Team sync')
        shown = lambda: page.eval_on_selector_all('.ev:not(.chunk) .ev-t', "e => e.map(x => x.textContent.trim()).filter(t => t.includes('Team sync')).length")
        print('before:', week_list(), '| shown', await shown())
        # 1a. Edit one occurrence's time in the dialog → "This event"
        await page.click('.ev:has-text("Team sync")'); await page.click('.popover .edit'); await page.wait_for_selector('dialog [name=sTime]')
        await page.fill('dialog [name=sTime]', '14:00'); await page.fill('dialog [name=eTime]', '15:00')
        await page.click('dialog button[type=submit] >> nth=-1'); await page.wait_for_selector('dialog.narrow .choice-btn')
        await page.click('dialog.narrow .choice-btn:has-text("This event")'); await page.wait_for_timeout(2500)
        print('1a. after edit:', week_list(), '| shown this week:', await shown(), '| masters:', len([e for e in g.events['me@example.com'].values() if e.get('summary') == 'Team sync']))
        # 1b. Drag the moved occurrence back to 16:00 → "This event"
        ev = await page.query_selector('.ev:has-text("Team sync")'); box = await ev.bounding_box()
        hh = await page.evaluate('window.__tempo.app.state.settings.hourHeight')
        await page.mouse.move(box['x'] + 20, box['y'] + 8); await page.mouse.down(); await page.mouse.move(box['x'] + 20, box['y'] + 8 + 2 * hh, steps=8); await page.mouse.up()
        await page.wait_for_selector('dialog.narrow .choice-btn'); await page.click('dialog.narrow .choice-btn:has-text("This event")'); await page.wait_for_timeout(2500)
        print('1b. after drag:', week_list(), '| shown this week:', await shown())
        # 2. Quick date shortcuts
        await page.click('#btn-new-task'); await page.wait_for_selector('dialog .task-form')
        print('2. shortcut menus in task dialog:', await page.eval_on_selector_all('dialog .dt-quick', 'e => e.length'), '| options:', await page.eval_on_selector_all('dialog .dt-quick >> nth=0 >> option', 'e => e.map(o => o.textContent)'))
        d0 = await page.input_value('dialog [name=deadline]')
        await page.select_option('dialog [name=deadline] + .dt-quick', 'd'); d1 = await page.input_value('dialog [name=deadline]')
        await page.select_option('dialog [name=deadline] + .dt-quick', 'w'); d2 = await page.input_value('dialog [name=deadline]')
        await page.select_option('dialog [name=earliest] + .dt-quick', 'now'); e0 = await page.input_value('dialog [name=earliest]')
        await page.select_option('dialog [name=earliest] + .dt-quick', 'h'); e1 = await page.input_value('dialog [name=earliest]')
        print('   deadline', d0, '→ +1 day', d1, '→ +1 week', d2, '| earliest now', e0, '→ +1 hour', e1)
        await page.screenshot(path=f'{OUT}/q1-task-shortcuts.png')
        await page.keyboard.press('Escape')
        # 4. New events default to the task calendar (Work)
        await page.click('#btn-new-event'); await page.wait_for_selector('dialog [name=summary]')
        print('4. new event calendar:', await page.input_value('dialog [name=calId]'))
        s0 = (await page.input_value('dialog [name=sDate]'), await page.input_value('dialog [name=sTime]'), await page.input_value('dialog [name=eTime]'))
        await page.select_option('dialog [name=sDate] + .dt-quick', 'h')
        s1 = (await page.input_value('dialog [name=sDate]'), await page.input_value('dialog [name=sTime]'), await page.input_value('dialog [name=eTime]'))
        await page.select_option('dialog [name=sDate] + .dt-quick', 'd')
        s2 = (await page.input_value('dialog [name=sDate]'), await page.input_value('dialog [name=sTime]'), await page.input_value('dialog [name=eDate]'), await page.input_value('dialog [name=eTime]'))
        print('2b. event start', s0, '→ +1 hour', s1, '→ +1 day', s2, '| repeat-until menu hidden:', await page.eval_on_selector('dialog [name=until]', 'e => getComputedStyle(e.parentElement).display === "none"'))
        await page.screenshot(path=f'{OUT}/q2-event-shortcuts.png')
        await page.fill('dialog [name=summary]', 'Planning'); await page.click('dialog button[type=submit] >> nth=-1'); await page.wait_for_timeout(1500)
        print('   created in:', [c for c, es in g.events.items() for e in es.values() if e.get('summary') == 'Planning'])
        cols = await page.query_selector_all('.tg-col'); box = await cols[3].bounding_box(); hh = await page.evaluate('window.__tempo.app.state.settings.hourHeight')
        await page.mouse.move(box['x'] + 20, box['y'] + 15 * hh + 2); await page.mouse.down(); await page.mouse.move(box['x'] + 20, box['y'] + 16 * hh - 2, steps=5); await page.mouse.up()
        await page.wait_for_selector('.popover .qc'); print('   quick-create calendar:', await page.input_value('.popover select[name=cal]')); await page.keyboard.press('Escape')
        # 3. Printout with the time-used panel
        await page.evaluate("window.__tempo.app.state.tasks.length")
        await page.click('#btn-new-task'); await page.wait_for_selector('dialog .task-form'); await page.fill('dialog [name=title]', 'Report'); await page.fill('dialog [name=hours]', '6'); await page.fill('dialog [name=deadline]', '2026-10-23T17:00'); await page.click('dialog .task-form button[type=submit]'); await page.wait_for_timeout(2500)
        for kind, fmt in (('week', 'png'), ('month', 'png'), ('week', 'pdf')):
            await page.click('#btn-export')
            async with page.expect_download() as dl: await page.click(f'#export-menu [data-kind={kind}][data-fmt={fmt}]')
            d = await dl.value; path = f'{OUT}/export-{kind}.{fmt}'; await d.save_as(path)
            print(f'3. exported {kind} {fmt}:', os.path.getsize(path), 'bytes')
        print('ERRORS:', errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
