# Tests for: repeating tasks, category time preferences, daily cap, safety margin, projects / prerequisites,
# travel buffer, session timer (+ focus timer), reading-speed learning, planned vs actual history, weekly review,
# plain-language quick add, undo, "what moved and why", sharing all settings, and other calendars (ICS link,
# a second Google account, Outlook).
import asyncio, sys, subprocess, time, re, json, urllib.parse, datetime, os
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
os.makedirs('src/testdata', exist_ok=True)
open('src/testdata/choir.ics', 'w').write("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:c1\r\nSUMMARY:Choir rehearsal\r\nLOCATION:St. Mary's Hall\r\nDTSTART;TZID=Europe/Berlin:20261020T120000\r\nDTEND;TZID=Europe/Berlin:20261020T130000\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")
srv = subprocess.Popen(['python3','-m','http.server','8776','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
APP = 'http://localhost:8776/app.html'
INIT = """
const FIX = Date.parse('2026-10-19T05:30:00Z'); const _Date = Date; globalThis.__off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false}));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2026-10-19'));
}"""
BER = datetime.timezone(datetime.timedelta(hours=2))
def loc(iso): return datetime.datetime.fromisoformat(iso.replace('Z', '+00:00')).astimezone(BER)
def evs(g, word): return sorted([e for e in g.task_events() if word in e['summary']], key=lambda e: e['start']['dateTime'])

async def main():
    g = MockGoogle(); errs = []
    # an event with a place on Tuesday 10:00-11:00 (travel buffer)
    g.events['work']['cafe'] = {'id': 'cafe', 'summary': 'Coffee with Ana', 'location': 'Cafe Central, Vienna', 'status': 'confirmed', 'start': {'dateTime': '2026-10-20T10:00:00+02:00'}, 'end': {'dateTime': '2026-10-20T11:00:00+02:00'}}
    async with async_playwright() as p:
        b = await p.chromium.launch()
        async def auth_google(route):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(route.request.url).query)
            frag = urllib.parse.urlencode({'access_token': 'tok2', 'expires_in': '3600', 'state': q['state'][0], 'scope': q['scope'][0]})
            await route.fulfill(status=302, headers={'Location': q['redirect_uri'][0] + 'app.html#' + frag})
        async def auth_ms(route):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(route.request.url).query)
            frag = urllib.parse.urlencode({'access_token': 'mstok', 'expires_in': '3600', 'state': q['state'][0]})
            await route.fulfill(status=302, headers={'Location': q['redirect_uri'][0] + 'app.html#' + frag})
        async def graph(route):
            u = urllib.parse.urlparse(route.request.url)
            cors = {'access-control-allow-origin': '*', 'access-control-allow-headers': '*'}
            if route.request.method == 'OPTIONS': return await route.fulfill(status=204, headers=cors)
            if u.path.endswith('/me'): body = {'mail': 'me@outlook.com'}
            elif u.path.endswith('/me/calendars'): body = {'value': [{'id': 'olcal', 'name': 'Calendar', 'hexColor': '#0078d4'}]}
            elif 'calendarView' in u.path: body = {'value': [{'id': 'o1', 'subject': 'Dentist (Outlook)', 'start': {'dateTime': '2026-10-21T09:00:00.0000000'}, 'end': {'dateTime': '2026-10-21T10:00:00.0000000'}, 'isAllDay': False, 'showAs': 'busy', 'location': {'displayName': ''}, 'webLink': 'https://outlook.live.com/x'}]}
            else: body = {}
            await route.fulfill(status=200, headers=cors, content_type='application/json', body=json.dumps(body))
        async def device(name):
            ctx = await b.new_context(viewport={'width': 1440, 'height': 900}, timezone_id='Europe/Berlin')
            await ctx.add_init_script(INIT)
            await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
            await ctx.route(re.compile(r'https://accounts\.google\.com/o/oauth2/v2/auth.*'), auth_google)
            await ctx.route(re.compile(r'https://login\.microsoftonline\.com/.*'), auth_ms)
            await ctx.route(re.compile(r'https://graph\.microsoft\.com/.*'), graph)
            page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(f'{name}: {e}'))
            await page.goto(APP); await page.wait_for_selector('.tg-col'); await page.wait_for_function('window.__tempo', timeout=60000); await page.wait_for_timeout(1500)
            return ctx, page
        ctxA, A = await device('A')
        async def clear_toast(pg):
            # close "not enough time" prompts that may pop up after a change, and any toast
            for _ in range(4):
                if await pg.query_selector('dialog .problem'):
                    print('   (prompt:', (await pg.text_content('dialog .problem h2')).strip(), ')'); await pg.keyboard.press('Escape'); await pg.wait_for_timeout(400)
            await pg.evaluate("document.querySelector('#toast').classList.remove('show')")
        tasks = lambda pg: pg.evaluate("window.__tempo.app.state.tasks.map(t => t.title)")

        # 0. Settings: Study → mornings, daily cap 4h, travel 15 (default)
        await A.click('#btn-settings'); await A.click('dialog .tabs button[data-tab="5"]')
        await A.select_option('dialog .cat-row:has(.cat-nm[value="Study"]) .cat-pref', 'morning')
        await A.click('dialog .tabs button[data-tab="1"]'); await A.fill('dialog [name=dailyCapMinutes]', '240')
        await A.screenshot(path=f'{OUT}/p0-settings-planning.png')
        await A.click('dialog button[type=submit] >> nth=-1'); await A.wait_for_timeout(1500)

        # 1. Quick add in plain language
        await A.fill('#quick-add', 'Read Dune 200 pages by Friday, Study'); await A.wait_for_timeout(200)
        print('1. preview:', (await A.inner_text('#quick-preview')).replace('\n', ' | '))
        await A.screenshot(path=f'{OUT}/p1-quick-add.png')
        await A.press('#quick-add', 'Enter'); await A.wait_for_timeout(3000)
        dune = evs(g, 'Dune')
        print('   Dune on Google:', len(dune), dune[0]['summary'], '| in the morning:', sum(1 for e in dune if loc(e['start']['dateTime']).hour < 12), 'of', len(dune), '(Tue morning has the café meeting)', '| last ends', loc(dune[-1]['end']['dateTime']).strftime('%a %H:%M'))

        # 8. Timer on a Dune session: 20 min, stop early → partly done prefilled; report 4 pages → speed learned 12/h
        await clear_toast(A)
        await A.click('.ev.chunk:has-text("Dune") >> nth=0'); await A.click('.popover .tm-start'); await A.wait_for_timeout(500)
        await A.evaluate("globalThis.__off += 20 * 60000"); await A.wait_for_timeout(1300)
        print('8. timer bar:', (await A.inner_text('#timer-bar')).replace('\n', ' | '))
        await A.screenshot(path=f'{OUT}/p5-timer.png')
        await A.click('#timer-bar .tm-stop'); await A.wait_for_selector('dialog .partial')
        print('   prefilled pages:', await A.input_value('dialog [name=pages]'), '|', await A.text_content('dialog .timer-note'))
        await A.fill('dialog [name=pages]', '4'); await A.click('dialog .partial button[type=submit]'); await A.wait_for_timeout(2500)
        t = await A.evaluate("(() => { const t = window.__tempo.app.state.tasks.find(t => t.title === 'Dune'); return { speed: t.reading.speed, log: t.speedLog, first: window.__tempo.S.sessions(t)[0].label, act: t.frozen.find(c => c.partial)?.actualMin }; })()")
        print('   after stop:', t, '| toast:', await A.text_content('#toast'))
        # focus timer: break after 25 min
        await clear_toast(A)
        await A.click('.ev.chunk:has-text("Dune") >> nth=1'); await A.click('.popover .tm-pomo'); await A.wait_for_timeout(400)
        await A.evaluate("globalThis.__off += 25 * 60000 + 2000"); await A.wait_for_timeout(1300)
        print('   focus timer:', (await A.inner_text('#timer-bar')).replace('\n', ' | '), '| toast:', await A.text_content('#toast'))
        # stop during the break → partly done (25 min of focus); report 5 pages → second sample → speed learned
        await A.click('#timer-bar .tm-stop'); await A.wait_for_selector('dialog .partial')
        print('   focus stop prefill:', await A.input_value('dialog [name=pages]'))
        await A.fill('dialog [name=pages]', '5'); await A.click('dialog .partial button[type=submit]'); await A.wait_for_timeout(2500)
        t = await A.evaluate("(() => { const t = window.__tempo.app.state.tasks.find(t => t.title === 'Dune'); return { speed: t.reading.speed, log: t.speedLog.map(x => [x.pages, x.minutes]) }; })()")
        print('   after 2nd report:', t, '| toast:', await A.text_content('#toast'))
        await A.evaluate("globalThis.__off -= (45 * 60000 + 2000)")

        # 2. Repeating task (task dialog): Exercise 3h per week for 4 weeks, evenings via After hours
        await clear_toast(A)
        await A.click('#btn-new-task'); await A.wait_for_selector('dialog .task-form')
        await A.fill('dialog [name=title]', 'Exercise'); await A.select_option('dialog [name=repEvery]', 'week'); await A.fill('dialog [name=repHours]', '3'); await A.fill('dialog [name=repCount]', '4')
        await A.check('dialog [name=bmode][value="period:after-hours"]'); await A.wait_for_timeout(300)
        print('2. calc:', await A.text_content('dialog .calc'))
        await A.screenshot(path=f'{OUT}/p2-repeat-dialog.png')
        await A.click('dialog .task-form button[type=submit]'); await A.wait_for_timeout(3000)
        ex = evs(g, 'Exercise')
        weeks = {}
        for e in ex: weeks.setdefault(e['summary'].split('·')[1].strip().split(' ')[2:4].__str__(), 0)
        per = {}
        for e in ex: k = re.search(r'week of (\d+ \w+)', e['summary']).group(1); per[k] = per.get(k, 0) + (loc(e['end']['dateTime']) - loc(e['start']['dateTime'])).seconds // 60
        print('   Exercise per week (min):', per, '| e.g.', ex[0]['summary'])

        # 3. Daily cap across all tasks
        allsess = await A.evaluate("window.__tempo.app.state.tasks.flatMap(t => window.__tempo.S.sessions(t).map(s => [window.__tempo.T.dayKey(s.start, 'Europe/Berlin'), s.minutes]))")
        day = {}
        for k, m in allsess: day[k] = day.get(k, 0) + m
        print('3. max task minutes per day:', max(day.values()), '(cap 240)')

        # 4. Travel buffer: nothing between 09:45 and 11:15 on Tuesday; strips drawn
        tue = [s for s in await A.evaluate("window.__tempo.app.state.tasks.flatMap(t => window.__tempo.S.sessions(t).map(s => [s.start, s.end]))") if datetime.datetime.fromtimestamp(s[0] / 1000, BER).strftime('%a') == 'Tue']
        lo, hi = datetime.datetime(2026, 10, 20, 9, 45, tzinfo=BER).timestamp() * 1000, datetime.datetime(2026, 10, 20, 11, 15, tzinfo=BER).timestamp() * 1000
        print('4. sessions overlapping travel+meeting:', sum(1 for a, z in tue if a < hi and z > lo), '| travel strips:', await A.eval_on_selector_all('.travel', 'e => e.length'))

        # 5. Project with ordered steps + safety margin
        await clear_toast(A)
        await A.click('#btn-new-task'); await A.wait_for_selector('dialog .task-form')
        await A.fill('dialog [name=title]', 'Outline'); await A.fill('dialog [name=hours]', '3'); await A.fill('dialog [name=deadline]', '2026-10-30T17:00'); await A.fill('dialog [name=rank]', '4')
        await A.select_option('dialog [name=projectId]', '__new'); await A.fill('dialog [name=projName]', 'Thesis')
        await A.click('dialog .task-form button[type=submit]'); await A.wait_for_timeout(2500)
        await clear_toast(A)
        await A.click('#btn-new-task'); await A.wait_for_selector('dialog .task-form')
        await A.fill('dialog [name=title]', 'Draft'); await A.fill('dialog [name=hours]', '24'); await A.fill('dialog [name=deadline]', '2026-10-28T17:00'); await A.fill('dialog [name=rank]', '2'); await A.fill('dialog [name=margin]', '3')
        await A.evaluate("(() => { const s = document.querySelector('dialog [name=projectId]'); s.value = [...s.options].find(o => o.text.includes('Thesis')).value; s.dispatchEvent(new Event('change', {bubbles: true})); })()")
        await A.wait_for_timeout(400); print('5. preview:', (await A.inner_text('dialog .preview')).replace('\n', ' | ')[:300])
        print('   margin warning:', await A.text_content('dialog .preview .warn.soft') if await A.query_selector('dialog .preview .warn.soft') else None)
        await A.screenshot(path=f'{OUT}/p3-project-margin.png')
        await A.click('dialog .task-form button[type=submit]'); await A.wait_for_timeout(500)
        if await A.query_selector('dialog.narrow .choice-btn'): print('   limit:', await A.text_content('dialog.narrow h2')); await A.click('dialog.narrow .choice-btn')
        await A.wait_for_timeout(3000); await clear_toast(A)
        o, d = evs(g, 'Outline'), evs(g, 'Draft')
        print('   Draft starts after Outline ends:', d[0]['start']['dateTime'] >= o[-1]['end']['dateTime'], '| sidebar:', (await A.inner_text('#task-list')).split('\n')[:6])
        print('   Draft late sessions:', await A.evaluate("window.__tempo.app.state.tasks.find(t => t.title === 'Draft').lastPlan.late"), '| in-margin blocks shown:', await A.eval_on_selector_all('.ev.chunk.late', 'e => e.length'))

        # 6. What moved and why: a new rank-1 task pushes others later
        await clear_toast(A)
        await A.click('#btn-new-task'); await A.wait_for_selector('dialog .task-form')
        await A.fill('dialog [name=title]', 'Urgent fix'); await A.fill('dialog [name=hours]', '3'); await A.fill('dialog [name=deadline]', '2026-10-20T17:00'); await A.fill('dialog [name=rank]', '1')
        await A.click('dialog .task-form button[type=submit]'); await A.wait_for_timeout(3000)
        txt = await A.text_content('#toast'); print('6. toast:', txt)
        for _ in range(4):
            if await A.query_selector('dialog .problem'): await A.keyboard.press('Escape'); await A.wait_for_timeout(300)
        await A.click('#moved-pill'); await A.wait_for_selector('dialog .moves'); print('   why:', (await A.inner_text('dialog .moves')).replace('\n', ' | ')[:300])
        await A.screenshot(path=f'{OUT}/p4-moved-why.png'); await A.click('dialog .moves [data-close]')

        # 7. Undo: delete the Urgent fix series, then Ctrl+Z
        await clear_toast(A)
        await A.click('.task-row:has-text("Urgent fix")'); await A.wait_for_selector('dialog .task-form'); await A.click('dialog .task-form .del'); await A.click('dialog .choice-btn'); await A.wait_for_timeout(2500)
        print('7. after delete:', 'Urgent fix' in await tasks(A), '| Google:', len(evs(g, 'Urgent')))
        await A.keyboard.press('Control+z'); await A.wait_for_timeout(3500)
        print('   after undo:', 'Urgent fix' in await tasks(A), '| Google:', len(evs(g, 'Urgent')), '| toast:', await A.text_content('#toast'))
        # undo creating an event
        await clear_toast(A)
        await A.click('#btn-new-event'); await A.wait_for_selector('dialog [name=summary]'); await A.fill('dialog [name=summary]', 'Lunch'); await A.click('dialog button[type=submit] >> nth=-1'); await A.wait_for_timeout(2000)
        lunch = lambda: [e for es in g.events.values() for e in es.values() if e.get('summary') == 'Lunch']
        n1 = len(lunch()); await A.click('#btn-undo'); await A.wait_for_timeout(2000)
        print('   event created then undone:', n1, '->', len(lunch()))

        # 9. Slips → history and weekly review
        await clear_toast(A)
        await A.click('.ev.chunk:has-text("Outline") >> nth=0'); await A.click('.popover .del'); await A.click('dialog .choice-btn:has-text("Delete this session")'); await A.wait_for_timeout(2500)
        await clear_toast(A)
        await A.click('#view-seg button[data-view=analysis]'); await A.wait_for_selector('.an-mode'); await clear_toast(A); await A.click('.an-mode button[data-mode=history]'); await A.wait_for_selector('.hist')
        print('9. history tiles:', (await A.inner_text('.hist .an-tiles')).replace('\n', ' | '))
        await A.screenshot(path=f'{OUT}/p6-history.png', full_page=True)
        await A.click('.an-mode button[data-mode=review]'); await A.wait_for_selector('.np')
        print('   review:', (await A.inner_text('.np')).replace('\n', ' | ')[:400])
        await A.screenshot(path=f'{OUT}/p7-review.png')
        await A.click('#view-seg button[data-view=week]'); await A.wait_for_timeout(500)

        # 10. Other calendars: ICS link, another Google account, Outlook
        await A.click('#btn-settings'); await A.click('dialog .tabs button[data-tab="6"]')
        await A.click('dialog [data-add=ics]'); await A.fill('dialog .ics-url', 'http://localhost:8776/testdata/choir.ics'.replace('http:', 'https:'))
        # (the web app only accepts https links; for the test serve over http by patching the check)
        await A.evaluate("document.querySelector('dialog .ics-url').value = 'webcal://localhost:8776/testdata/choir.ics'")
        await A.route(re.compile(r'https://localhost:8776/testdata/.*'), lambda route: route.fulfill(status=200, content_type='text/calendar', body=open('src/testdata/choir.ics').read(), headers={'access-control-allow-origin': '*'}))
        await A.fill('dialog .ics-name', 'Choir'); await A.click('dialog .acct-form .go'); await A.wait_for_timeout(1200)
        async with A.expect_popup() as pop: await A.click('dialog [data-add=google]'); await A.click('dialog .acct-form .go')
        await A.wait_for_timeout(2500)
        await A.click('dialog [data-add=outlook]'); await A.fill('dialog .ol-id', '11111111-2222-3333-4444-555555555555')
        async with A.expect_popup() as pop2: await A.click('dialog .acct-form .go')
        await A.wait_for_timeout(2500)
        print('10. accounts:', (await A.inner_text('dialog .acct-list')).replace('\n', ' | ')[:400])
        await A.screenshot(path=f'{OUT}/p8-accounts.png')
        await A.click('dialog button[type=submit] >> nth=-1'); await A.wait_for_timeout(3000)
        shown = await A.eval_on_selector_all('.ev:not(.chunk) .ev-t', 'e => e.map(x => x.textContent.trim())')
        print('   shown:', [x for x in shown if 'Choir' in x or 'Dentist' in x], '| sidebar cals:', await A.eval_on_selector_all('#cal-list .cal-row span', 'e => e.map(x => x.textContent)'))
        busy = await A.evaluate("window.__tempo.app.state.tasks.flatMap(t => window.__tempo.S.sessions(t).filter(s => s.kind !== 'done').map(s => [s.start, s.end]))")
        lo, hi = datetime.datetime(2026, 10, 21, 9, 0, tzinfo=BER).timestamp() * 1000, datetime.datetime(2026, 10, 21, 10, 0, tzinfo=BER).timestamp() * 1000
        print('   sessions during Outlook dentist:', sum(1 for a, z in busy if a < hi and z > lo))
        await A.screenshot(path=f'{OUT}/p9-week.png')

        await clear_toast(A)
        # 11. All settings shared: device B gets work hours, cap, preferences, projects
        await A.click('#btn-settings'); await A.click('dialog .tabs button[data-tab="1"]'); await A.fill('dialog [name=bStart]', '08:30'); await A.click('dialog button[type=submit] >> nth=-1'); await A.wait_for_timeout(2500)
        ctxB, B = await device('B')
        await B.wait_for_timeout(2500); await clear_toast(B)
        sb = await B.evaluate("(() => { const s = window.__tempo.app.state.settings; return { bounds: s.bounds, cap: s.dailyCapMinutes, study: s.categories.find(c => c.id === 'study').prefer, projects: (s.projects || []).map(p => p.name + (p.sequential ? ' (in order)' : '')), history: (s.history || []).length }; })()")
        print('11. B settings:', sb, '| B tasks:', sorted(await tasks(B)))
        print('ERRORS:', errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
