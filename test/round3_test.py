# Tests for: custom scheduling periods ("After hours"), creation limits, category icons and the one-time category prompt.
import asyncio, sys, subprocess, time, re
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8772','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
INIT = """
const FIX = Date.parse('2026-10-19T07:30:00Z'); const _Date = Date; const off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+off);} else super(...a);} static now(){ return _Date.now()+off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  // saved by an older version: categories without icons
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', hoursChange: 'move', settingsVersion: 2, categories: [{id:'work',name:'Work',color:'#039be5'},{id:'study',name:'Study',color:'#8e24aa'},{id:'x1',name:'Gardening',color:'#0b8043'}]}));
}"""
BERLIN_OFF = 2

def hm(e): return e['start']['dateTime'][11:16]

async def main():
    g = MockGoogle(); errs = []
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1440, 'height': 900}, timezone_id='Europe/Berlin')
        await ctx.add_init_script(INIT)
        await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8772/app.html'); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(1500)
        stt = await page.evaluate("window.__tempo.app.state.settings")
        print('1. icons after upgrade:', [(c['name'], c.get('icon')) for c in stt['categories']], '| limits', stt['sessionWarn'], stt['sessionMax'], stt['maxSpanDays'], '| periods', [x['name'] for x in stt['periods']])

        async def task_form(title, hours, deadline):
            await page.click('#btn-new-task'); await page.wait_for_selector('dialog .task-form')
            await page.fill('dialog [name=title]', title); await page.fill('dialog [name=hours]', str(hours)); await page.fill('dialog [name=deadline]', deadline)

        # 2. No category -> asked once; pick Study -> icon in the session titles on Google
        await task_form('Tax return', 2, '2026-10-23T17:00')
        await page.click('dialog .task-form button[type=submit]'); await page.wait_for_selector('dialog .ask-cat')
        await page.screenshot(path=f'{OUT}/r1-ask-category.png')
        await page.click('dialog .ask-cat .cat-chip:has-text("Study")'); await page.wait_for_timeout(2500)
        ev = sorted([e for e in g.task_events() if 'Tax return' in e['summary']], key=lambda e: e['start']['dateTime'])
        print('2. google titles:', [e['summary'] for e in ev])
        print('   sidebar:', (await page.text_content('.task-row .tr-title')).strip())

        # 3. Task in the "After hours" period, skip the category prompt
        await task_form('Side project', 4, '2026-10-26T22:00')
        await page.check('dialog [name=bmode][value="period:after-hours"]'); await page.wait_for_timeout(300)
        await page.screenshot(path=f'{OUT}/r2-after-hours-task.png')
        await page.click('dialog .task-form button[type=submit]'); await page.wait_for_selector('dialog .ask-cat'); await page.click('dialog .ask-cat [data-close]'); await page.wait_for_timeout(2500)
        ev = sorted([e for e in g.task_events() if 'Side project' in e['summary']], key=lambda e: e['start']['dateTime'])
        print('3. after-hours sessions:', [(e['start']['dateTime'][:10], hm(e)) for e in ev], '| title', ev[0]['summary'])

        # 4. Change "After hours" to Mon, Wed, Thu evenings only (no weekends) in Settings
        await page.click('#btn-settings'); await page.click('dialog .tabs button[data-tab="1"]')
        rule0 = 'dialog .period >> nth=0 >> .per-rule >> nth=0'
        for d, on in ((1, True), (2, False), (3, True), (4, True), (5, False)):
            box = page.locator(f'{rule0} >> .r-day[value="{d}"]')
            if await box.is_checked() != on: await page.locator(f'{rule0} >> .wd:has(.r-day[value="{d}"])').click()
        await page.click('dialog .period >> nth=0 >> .per-rule >> nth=1 >> .r-del')
        await page.locator('dialog .period').first.scroll_into_view_if_needed()
        await page.screenshot(path=f'{OUT}/r3-periods-settings.png')
        # limits fields exist
        print('4. limit fields:', await page.input_value('dialog [name=sessionWarn]'), await page.input_value('dialog [name=sessionMax]'), await page.input_value('dialog [name=maxSpanDays]'))
        await page.click('dialog form > .actions button[type=submit], dialog button[type=submit] >> nth=-1'); await page.wait_for_timeout(2500)
        stt = await page.evaluate("window.__tempo.app.state.settings.periods")
        ev = sorted([e for e in g.task_events() if 'Side project' in e['summary']], key=lambda e: e['start']['dateTime'])
        import datetime
        days = sorted({datetime.date.fromisoformat(e['start']['dateTime'][:10]).strftime('%a') for e in ev})
        print('   period now:', stt[0]['rules'], '| sessions moved to days:', days)

        # 5. Limits: 30 sessions -> warning (go back); 60 -> blocked; deadline 2 years out -> blocked
        await task_form('Thesis', 30, '2026-12-20T17:00')
        await page.click('dialog .task-form button[type=submit]'); await page.wait_for_selector('dialog.narrow h2')
        print('5. warn:', await page.text_content('dialog.narrow h2'))
        await page.screenshot(path=f'{OUT}/r4-warn-limit.png')
        await page.click('dialog.narrow [data-close]'); await page.wait_for_timeout(300)
        print('   still editing:', bool(await page.query_selector('dialog .task-form')))
        await page.fill('dialog [name=hours]', '60'); await page.click('dialog .task-form button[type=submit]'); await page.wait_for_selector('dialog.narrow h2')
        print('   block:', await page.text_content('dialog.narrow h2'), '| buttons', await page.eval_on_selector_all('dialog.narrow button', 'e => e.map(x => x.textContent.trim())'))
        await page.screenshot(path=f'{OUT}/r5-block-limit.png')
        await page.click('dialog.narrow [data-close]'); await page.wait_for_timeout(300)
        await page.fill('dialog [name=hours]', '5'); await page.fill('dialog [name=deadline]', '2028-10-01T17:00'); await page.click('dialog .task-form button[type=submit]'); await page.wait_for_selector('dialog.narrow h2')
        print('   span:', await page.text_content('dialog.narrow h2'))
        await page.click('dialog.narrow [data-close]'); await page.wait_for_timeout(300)
        await page.keyboard.press('Escape'); await page.wait_for_timeout(300)
        print('   Thesis created:', await page.evaluate("window.__tempo.app.state.tasks.some(t => t.title === 'Thesis')"))

        # 6. Repeating event: daily, never ends -> blocked; after 30 -> warning; after 10 -> fine
        await page.click('#btn-new-event'); await page.wait_for_selector('dialog [name=freq]')
        await page.fill('dialog [name=summary]', 'Standup'); await page.select_option('dialog [name=freq]', 'DAILY')
        await page.click('dialog button[type=submit] >> nth=-1'); await page.wait_for_selector('dialog.narrow h2')
        print('6. never-ending:', await page.text_content('dialog.narrow h2')); await page.click('dialog.narrow [data-close]')
        await page.select_option('dialog [name=ends]', 'after'); await page.fill('dialog [name=count]', '30')
        await page.click('dialog button[type=submit] >> nth=-1'); await page.wait_for_selector('dialog.narrow h2')
        print('   30 times:', await page.text_content('dialog.narrow h2')); await page.click('dialog.narrow [data-close]')
        await page.select_option('dialog [name=ends]', 'on'); await page.fill('dialog [name=until]', '2028-01-01')
        await page.click('dialog button[type=submit] >> nth=-1'); await page.wait_for_selector('dialog.narrow h2')
        print('   until 2028:', await page.text_content('dialog.narrow h2')); await page.click('dialog.narrow [data-close]')
        await page.select_option('dialog [name=ends]', 'after'); await page.fill('dialog [name=count]', '10')
        await page.click('dialog button[type=submit] >> nth=-1'); await page.wait_for_timeout(2000)
        su = [e for evs in g.events.values() for e in evs.values() if e.get('summary') == 'Standup']
        print('   10 times saved:', bool(su), su[0].get('recurrence') if su else None)

        # 7. Icons: new category with an icon from the "+ New" form; then pick an icon in Settings for Gardening
        await task_form('Repot plants', 1, '2026-10-23T17:00')
        await page.click('dialog .cat-chip.add'); await page.fill('dialog .cat-name', 'Fitness'); await page.click('dialog .cat-new .ic-btn:has-text("💪")')
        await page.screenshot(path=f'{OUT}/r6-new-category-icon.png')
        await page.click('dialog .cat-save'); await page.wait_for_timeout(200)
        print('7. chips:', await page.eval_on_selector_all('dialog .cat-chip', 'e => e.map(x => x.textContent.trim())'))
        await page.click('dialog .task-form button[type=submit]'); await page.wait_for_timeout(2500)
        print('   prompt skipped (has category):', not await page.query_selector('dialog .ask-cat'), '| title', [e['summary'] for e in g.task_events() if 'Repot' in e['summary']][:1])
        await page.click('#btn-settings'); await page.click('dialog .tabs button[data-tab="5"]')
        row = 'dialog .cat-row:has(.cat-nm[value="Gardening"])'
        await page.click(f'{row} .cat-icbtn'); await page.click(f'{row} .ic-btn:has-text("🌱")')
        await page.click(f'{row} .cat-icbtn'); await page.screenshot(path=f'{OUT}/r7-settings-icons.png'); await page.click(f'{row} .cat-icbtn')
        await page.click('dialog button[type=submit] >> nth=-1'); await page.wait_for_timeout(1500)
        print('   Gardening icon:', await page.evaluate("window.__tempo.app.state.settings.categories.find(c => c.name === 'Gardening').icon"))

        # 7b. Changing a category's icon renames the sessions on Google
        await page.click('#btn-settings'); await page.click('dialog .tabs button[data-tab="5"]')
        row = 'dialog .cat-row:has(.cat-nm[value="Study"])'
        await page.click(f'{row} .cat-icbtn'); await page.fill(f'{row} .cat-icin', '🧾'); await page.click(f'{row} .cat-icbtn')
        await page.click('dialog button[type=submit] >> nth=-1'); await page.wait_for_timeout(3000)
        print('7b. renamed:', [e['summary'] for e in g.task_events() if 'Tax return' in e['summary']][:1])

        # 8. Events show their category icon; "Don't ask again"
        await page.click('.ev:not(.chunk):has-text("Standup") >> nth=0'); await page.click('.popover .pop-evcat'); await page.click('dialog .cat-chip:has-text("Work")'); await page.wait_for_timeout(600)
        if await page.query_selector('dialog.narrow .choice-btn:has-text("All events")'): await page.click('dialog.narrow .choice-btn:has-text("All events")')  # repeating event
        await page.wait_for_timeout(2000)
        print('8. event chips with icons:', await page.eval_on_selector_all('.ev:not(.chunk) .ev-t', 'e => e.map(x => x.textContent.trim()).filter(t => /^\\p{Extended_Pictographic}/u.test(t))'))
        await task_form('Call bank', 1, '2026-10-23T17:00')
        await page.click('dialog .task-form button[type=submit]'); await page.wait_for_selector('dialog .ask-cat'); await page.click('dialog .ask-cat .never'); await page.wait_for_timeout(2000)
        print('   askCategory:', await page.evaluate("window.__tempo.app.state.settings.askCategory"))
        await task_form('Call mum', 1, '2026-10-23T17:00')
        await page.click('dialog .task-form button[type=submit]'); await page.wait_for_timeout(1500)
        print('   no prompt now:', not await page.query_selector('dialog .ask-cat'), '| created:', await page.evaluate("window.__tempo.app.state.tasks.some(t => t.title === 'Call mum')"))
        await page.screenshot(path=f'{OUT}/r8-week.png')

        print('ERRORS:', errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
