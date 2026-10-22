# Work-hours change (move / keep), untitled events and tasks, "Till next event", notification profiles.
import asyncio, sys, subprocess, time, re, json
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8800','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
INIT = """
const FIX = Date.parse('2026-10-21T07:21:00Z'); const _Date = Date; globalThis.__off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false, goalNotice: false}));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2026-10-19'));
}"""
async def main():
    g = MockGoogle(); errs = []
    E = g.events['me@example.com']
    E['a'] = {'id': 'a', 'summary': 'Standup', 'status': 'confirmed', 'start': {'dateTime': '2026-10-22T15:00:00+02:00'}, 'end': {'dateTime': '2026-10-22T15:30:00+02:00'}}
    E['b'] = {'id': 'b', 'summary': 'Review', 'status': 'confirmed', 'start': {'dateTime': '2026-10-22T17:00:00+02:00'}, 'end': {'dateTime': '2026-10-22T18:00:00+02:00'}}
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1440, 'height': 900}, timezone_id='Europe/Berlin')
        await ctx.add_init_script(INIT)
        await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8800/app.html'); await page.wait_for_selector('.tg-col'); await page.wait_for_function('window.tempo'); await page.wait_for_timeout(1500)
        run = lambda c: page.evaluate('(c) => window.tempo.run(c)', c)
        ss = lambda: page.evaluate("window.tempo.run([{cmd:'listSessions', from:'2026-10-21', to:'2026-10-24'}])")
        # 1. a session started at 9:00 (before "now" 9:21); hours change to 9:15
        globalOff = "globalThis.__off"
        await page.evaluate("globalThis.__off -= 30*60000")  # 8:51
        await run([{'cmd': 'addTask', 'title': 'Report', 'hours': 6, 'deadline': '2026-10-23 17:00'}]); await page.wait_for_timeout(1200)
        await page.evaluate("globalThis.__off += 30*60000")  # back to 9:21
        await run([{'cmd': 'replan'}]); await page.wait_for_timeout(1200)
        first = lambda r: [(x['start'], x['end'], x.get('status')) for x in r[0]['result']][:3]
        print('1. before:', first(await ss()))
        await page.click('#btn-settings'); await page.click('dialog .tabs button[data-tab="1"]')
        await page.fill('dialog [name=bStart]', '09:15'); await page.click('dialog button[type=submit] >> nth=-1')
        await page.wait_for_selector('dialog .choice-btn'); print('   asked:', await page.text_content('dialog h2'))
        await page.click('dialog .choice-btn:has-text("Move")'); await page.wait_for_timeout(2000)
        print('   moved:', first(await ss()))
        # keep, via setting
        await page.click('#btn-settings'); await page.click('dialog .tabs button[data-tab="1"]')
        await page.select_option('dialog [name=hoursChange]', 'keep'); await page.fill('dialog [name=bStart]', '10:00'); await page.click('dialog button[type=submit] >> nth=-1'); await page.wait_for_timeout(2000)
        print('   keep (no prompt):', not await page.query_selector('dialog .choice-btn'), first(await ss()))
        await run([{'cmd': 'setSettings', 'hoursChange': 'ask'}]) if False else None
        # 2. untitled event: prompt; pick a category → its name
        cols = await page.query_selector_all('.tg-col'); box = await cols[3].bounding_box(); hh = await page.evaluate('window.__tempo.app.state.settings.hourHeight')
        async def slot(h0, h1):
            await page.evaluate(f"document.querySelector('.tg-scroll, .tg-body, #view')?.scrollTo?.(0, {int(h0*hh) - 200})"); await page.wait_for_timeout(150)
            box = await (await page.query_selector_all('.tg-col'))[3].bounding_box()
            await page.mouse.move(box['x'] + 20, box['y'] + h0 * hh + 2); await page.mouse.down(); await page.mouse.move(box['x'] + 20, box['y'] + h1 * hh - 2, steps=5); await page.mouse.up()
            await page.wait_for_selector('.popover .qc')
        await slot(13, 14); await page.click('.popover button[type=submit]'); await page.wait_for_selector('dialog .ask-title')
        print('2. untitled event → asks:', await page.text_content('dialog h2'))
        await page.click('dialog .ask-title .cat-chip:has-text("Work")'); await page.wait_for_timeout(1500)
        made = [e for e in E.values() if not (e.get('extendedProperties') or {}).get('private', {}).get('tempoTask') and e['id'] not in ('a', 'b') and 'dateTime' in e['start']]
        print('   saved as:', [(e['summary'], e['start']['dateTime'][11:16], (e.get('extendedProperties') or {}).get('private', {}).get('tempoCatName')) for e in made])
        # untitled with category chosen in quick create → no prompt
        await slot(11, 12); await page.click('.popover .qc-cat .cat-cur'); await page.click('dialog .cat-chip:has-text("Study")'); await page.click('.popover button[type=submit]'); await page.wait_for_timeout(1500)
        made = [e for e in E.values() if not (e.get('extendedProperties') or {}).get('private', {}).get('tempoTask') and e['id'] not in ('a', 'b') and 'dateTime' in e['start']]
        print('   with category, no prompt:', not await page.query_selector('dialog .ask-title'), [(e['summary'], e['start']['dateTime'][11:16]) for e in made])
        # typed title in prompt
        await slot(19, 20); await page.click('.popover button[type=submit]'); await page.wait_for_selector('dialog .ask-title')
        await page.fill('dialog [name=t]', 'Gym'); await page.click('dialog .ask-title button[type=submit]'); await page.wait_for_timeout(1500)
        print('   typed in prompt:', [(e['summary'], e['start']['dateTime'][11:16]) for e in E.values() if e.get('summary') == 'Gym'])
        # untitled task
        await page.click('#btn-new-task, button:has-text("+ Task") >> nth=0'); await page.wait_for_selector('dialog [name=title]')
        await page.click('dialog button[type=submit] >> nth=-1'); await page.wait_for_selector('dialog .ask-title')
        print('   untitled task → asks:', await page.text_content('dialog .ask-title h2')); await page.screenshot(path=f'{OUT}/q-ask.png')
        await page.click('dialog .ask-title [data-close]'); await page.wait_for_timeout(200)
        print('   Back keeps task dialog open:', bool(await page.query_selector('dialog [name=title]')))
        await page.keyboard.press('Escape'); await page.wait_for_timeout(300)
        # 3. till next event: slot 15:30 → 17:00; with 5-min buffer 16:55
        await slot(15.5, 16); await page.click('.popover .till-next'); await page.wait_for_timeout(400)
        print('3. till next:', await page.input_value('.popover [name=qs]'), '–', await page.input_value('.popover [name=qe]'), '|', await page.text_content('#toast'))
        await page.click('.popover .qc-cancel')
        await run([{'cmd': 'setSettings', 'gapMinutes': 5}])
        await slot(15.5, 16); await page.click('.popover .till-next'); await page.wait_for_timeout(400)
        print('   with buffer:', await page.input_value('.popover [name=qe]')); await page.screenshot(path=f'{OUT}/q-quick.png')
        await page.click('.popover .more'); await page.wait_for_selector('dialog .till-next')
        await page.fill('dialog [name=eTime]', '16:00'); await page.click('dialog .till-next'); await page.wait_for_timeout(300)
        print('   event dialog:', await page.input_value('dialog [name=eTime]'), '|', await page.text_content('dialog .since-note'))
        # 4. profiles: dialog shows Default for new; switch to Important → rows
        print('4. new event profile:', await page.input_value('dialog [name=nprofile]'), '| rows', await page.eval_on_selector_all('dialog .rem-row', 'rs => rs.map(r => r.querySelector(".rm-method").value + ":" + r.querySelector(".rm-val").value + r.querySelector(".rm-unit").value[0])'))
        await page.select_option('dialog [name=nprofile]', 'important')
        print('   Important rows:', await page.eval_on_selector_all('dialog .rem-row', 'rs => rs.map(r => r.querySelector(".rm-method").value + ":" + r.querySelector(".rm-val").value + r.querySelector(".rm-unit").value[0])'))
        await page.fill('dialog [name=summary]', 'Board meeting'); await page.click('dialog button[type=submit] >> nth=-1'); await page.wait_for_timeout(1500)
        bm = [e for e in E.values() if e.get('summary') == 'Board meeting'][0]
        print('   saved reminders:', bm['reminders'], '| profile', bm['extendedProperties']['private'].get('tempoNotify'))
        # reopen: profile recognised
        await page.evaluate("window.__tempo && 0")
        el = await page.query_selector(f'[data-key="me@example.com|{bm["id"]}"]'); await el.click(); await page.click('.popover .edit'); await page.wait_for_selector('dialog [name=nprofile]')
        print('   reopened shows:', await page.input_value('dialog [name=nprofile]'))
        await page.keyboard.press('Escape'); await page.wait_for_timeout(300)
        # quick create with Important
        await slot(9.5, 10); await page.fill('.popover [name=title]', 'Pitch'); await page.select_option('.popover [name=np]', 'important'); await page.click('.popover button[type=submit]'); await page.wait_for_timeout(1500)
        print('   quick create Important:', [e['reminders'] for e in E.values() if e.get('summary') == 'Pitch'])
        # task with Important → sessions get email reminders; default task → popup 10
        await run([{'cmd': 'addTask', 'title': 'Grant', 'hours': 2, 'deadline': '2026-10-26 17:00', 'notify': 'Important'}]); await page.wait_for_timeout(3000)
        gs = [e for e in E.values() if (e.get('extendedProperties') or {}).get('private', {}).get('tempoTask') and 'Grant' in e.get('summary', '')]
        rs = [e for e in E.values() if (e.get('extendedProperties') or {}).get('private', {}).get('tempoTask') and 'Report' in e.get('summary', '')]
        print('   task Important sessions:', gs and gs[0]['reminders'], '| default task:', rs and rs[-1]['reminders'])
        # settings: edit profile, add one
        await page.click('#btn-settings'); await page.click('dialog .tabs button[data-tab="3"]')
        print('   settings profiles:', await page.eval_on_selector_all('dialog .nprof .np-name', 'xs => xs.map(x => x.value)'))
        await page.screenshot(path=f'{OUT}/q-settings.png'); await page.click('dialog .add-nprof'); await page.fill('dialog .nprof >> nth=2 >> .np-name', 'Travel'); await page.select_option('dialog [name=eventProfile]', label='Travel')
        await page.click('dialog button[type=submit] >> nth=-1'); await page.wait_for_timeout(1000)
        st = await page.evaluate("({p: window.__tempo.app.state.settings.notifyProfiles.map(x => x.name), e: window.__tempo.app.state.settings.eventProfile})")
        print('   saved profiles:', st['p'], '| events use Travel:', st['e'].startswith('profile'))
        print('   AI listProfiles:', json.dumps((await run([{'cmd': 'listProfiles'}]))[0]['result'])[:200])
        await page.screenshot(path=f'{OUT}/n1.png')
        print('ERRORS:', errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
