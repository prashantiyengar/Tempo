# Round 27: weather refreshed every 30 minutes; events inside other events ("＋ Add during this", free strip, the
# shorter one counts in Analysis); projects (+ Project, chain of tasks and events, reorder, add later, title prefix,
# sidebar progress, newspaper, analysis by project); folding the calendars list.
import asyncio, sys, subprocess, time, re, json, datetime
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8821','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
INIT = """
const FIX = Date.parse('2026-10-23T12:30:00Z'); const _Date = Date; globalThis.__off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false, goalNotice: false, syncTasksToGoogle: true, weather: {on: true, name: 'Berlin, Germany', lat: 52.52, lon: 13.4, unit: 'C'}}));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2099-01-01'));
}"""
ok = []
def check(label, cond, extra=''):
    ok.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + label, extra)
def wx():
    d0 = datetime.date(2026, 9, 22)
    n = 47
    return {'daily': {'time': [(d0 + datetime.timedelta(i)).isoformat() for i in range(n)], 'weather_code': [2] * n, 'temperature_2m_max': [15.0] * n, 'temperature_2m_min': [7.0] * n, 'precipitation_probability_max': [20] * n, 'precipitation_sum': [0.0] * n}}

async def main():
    g = MockGoogle(); errs = []; calls = []
    g.events['me@example.com']['cc'] = {'id': 'cc', 'summary': 'Childcare', 'colorId': '2', 'status': 'confirmed', 'start': {'dateTime': '2026-10-23T14:00:00+02:00'}, 'end': {'dateTime': '2026-10-23T18:00:00+02:00'}}
    async with async_playwright() as p:
        b = await p.chromium.launch(); ctx = await b.new_context(viewport={'width': 1400, 'height': 900}, timezone_id='Europe/Berlin', compact_ui=True)
        await ctx.add_init_script(INIT); await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        async def meteo(route):
            calls.append(route.request.url); await route.fulfill(json=wx(), headers={'Access-Control-Allow-Origin': '*'})
        await ctx.route(re.compile(r'https://(api|geocoding-api)\.open-meteo\.com/.*'), meteo)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8821/app.html'); await page.wait_for_function('window.tempo'); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(1500)
        run = lambda c: page.evaluate(f"window.tempo.run({json.dumps(c)})")

        # ---------- 1. weather every 30 minutes
        n0 = len(calls)
        await page.evaluate("globalThis.__off += 20*60000; window.__tempo.render()"); await page.wait_for_timeout(600)
        n1 = len(calls)
        await page.evaluate("globalThis.__off += 15*60000; window.__tempo.render()"); await page.wait_for_timeout(800)
        n2 = len(calls)
        check('1. weather: not re-fetched after 20 min, re-fetched after 35 min', n0 >= 1 and n1 == n0 and n2 == n1 + 1, (n0, n1, n2))
        await page.evaluate("globalThis.__off -= 35*60000; window.__tempo.render()"); await page.wait_for_timeout(400)

        # ---------- 2. calendars list folds away
        await page.click('#cal-toggle'); await page.wait_for_timeout(200)
        check('2a. calendars list hidden after a click', not await page.is_visible('#cal-list') and (await page.text_content('.cal-count')).strip() != '')
        await page.reload(); await page.wait_for_function('window.tempo'); await page.wait_for_timeout(1200)
        check('2b. stays folded after reload', not await page.is_visible('#cal-list'))
        await page.click('#cal-toggle'); await page.wait_for_timeout(200)
        check('2c. unfolds again', await page.is_visible('#cal-list'))

        # ---------- 3. an event during another one
        cc = page.locator('.ev:has-text("Childcare")').first
        await cc.scroll_into_view_if_needed(); await cc.click(); await page.wait_for_selector('.popover .add-during')
        await page.click('.popover .add-during'); await page.wait_for_selector('.popover .qc')
        qs, qe = await page.input_value('.popover [name=qs]'), await page.input_value('.popover [name=qe]')
        check('3a. "Add during this" opens a one-hour slot inside the event', qs >= '14:00' and qe <= '18:00' and qs < qe, (qs, qe))
        await page.fill('.popover [name=qs]', '15:00'); await page.dispatch_event('.popover [name=qs]', 'change')
        await page.fill('.popover [name=qe]', '16:00'); await page.dispatch_event('.popover [name=qe]', 'change')
        await page.fill('.popover [name=title]', 'Chores'); await page.click('.popover button[type=submit]'); await page.wait_for_timeout(2000)
        chores = [e for e in g.events['me@example.com'].values() if e.get('summary') == 'Chores']
        check('3b. the overlapping event is saved', chores and chores[0]['start']['dateTime'].startswith('2026-10-23T13:00'), chores[:1])
        await page.screenshot(path=f'{OUT}/r27-overlap.png')
        # free strip on the right of a column: a drag there creates instead of moving the event
        col = page.locator('.tg-col[data-day="2026-10-23"]'); bb = await col.bounding_box(); hh = await page.evaluate('window.__tempo.app.state.settings.hourHeight')
        top = bb['y']; x = bb['x'] + bb['width'] - 5
        await page.mouse.move(x, top + 16.5 * hh); await page.mouse.down(); await page.mouse.move(x, top + 17.5 * hh, steps=4); await page.mouse.up()
        await page.wait_for_timeout(300)
        check('3c. dragging in the free strip over an event creates a new one', bool(await page.query_selector('.popover .qc')))
        await page.click('.popover .qc-cancel')
        # analysis: the hour of chores counts as chores, childcare keeps 3 h
        await page.click('#view-seg button[data-view=analysis]'); await page.wait_for_selector('[data-o=by]')
        await page.select_option('[data-o=period]', 'day') if await page.query_selector('[data-o=period] option[value=day]') else None
        await page.select_option('[data-o=scope]', 'full') if await page.query_selector('[data-o=scope] option[value=full]') else None
        await page.select_option('[data-o=by]', 'source'); await page.wait_for_timeout(300)
        await page.select_option('[data-o=by]', 'color'); await page.wait_for_timeout(800)
        rows = await page.eval_on_selector_all('.an-table tbody tr', 'rs => rs.map(r => [...r.children].map(c => c.textContent.trim()))')
        hours = {r[0]: r[1] for r in rows}
        print('   analysis rows:', rows[:6])
        tv = ' '.join(f'{k}={v}' for k, v in hours.items())
        ch = [r for r in rows if 'Childcare' in r[0]]; co = [r for r in rows if 'Chores' in r[0]]
        check('3d. analysis: the hour of chores counts as chores, not childcare too', co and co[0][1] == '1h' and ch and float(ch[0][1].rstrip('h')) <= 3, tv)

        # ---------- 4. projects
        await page.click('#view-seg button[data-view=week]'); await page.wait_for_timeout(500)
        await page.click('#btn-new-project'); await page.wait_for_selector('dialog[open] .project-form')
        await page.fill('dialog[open] [name=name]', 'Thesis')
        await page.click('dialog[open] .pj-add[data-kind=task]'); await page.fill('dialog[open] .pj-step[data-i="0"] .ps-title', 'Literature review')
        await page.fill('dialog[open] .pj-step[data-i="0"] .ps-sd', '2026-10-26'); await page.fill('dialog[open] .pj-step[data-i="0"] .ps-ed', '2026-10-30'); await page.fill('dialog[open] .pj-step[data-i="0"] .ps-h', '6')
        await page.click('dialog[open] .pj-add[data-kind=task]'); await page.fill('dialog[open] .pj-step[data-i="1"] .ps-title', 'Write chapter 1')
        await page.fill('dialog[open] .pj-step[data-i="1"] .ps-sd', '2026-11-02'); await page.fill('dialog[open] .pj-step[data-i="1"] .ps-ed', '2026-11-13'); await page.fill('dialog[open] .pj-step[data-i="1"] .ps-h', '10')
        await page.click('dialog[open] .pj-add[data-kind=event]'); await page.fill('dialog[open] .pj-step[data-i="2"] .ps-title', 'Meet supervisor')
        await page.fill('dialog[open] .pj-step[data-i="2"] .ps-sd', '2026-10-31'); await page.fill('dialog[open] .pj-step[data-i="2"] .ps-st', '10:00'); await page.fill('dialog[open] .pj-step[data-i="2"] .ps-ed', '2026-10-31'); await page.fill('dialog[open] .pj-step[data-i="2"] .ps-et', '11:00')
        # move the meeting up between the two tasks
        await page.click('dialog[open] .pj-step[data-i="2"] .ps-up'); await page.wait_for_timeout(100)
        order = await page.eval_on_selector_all('dialog[open] .pj-step .ps-title', 'xs => xs.map(x => x.value)')
        check('4a. steps reorder with ▲', order == ['Literature review', 'Meet supervisor', 'Write chapter 1'], order)
        await page.screenshot(path=f'{OUT}/r27-project-dialog.png')
        await page.click('dialog[open] button[type=submit]'); await page.wait_for_timeout(3000)
        tasks = await page.evaluate("window.__tempo.app.state.tasks.filter(t => t.projectId).map(t => ({title: t.title, step: t.projectStep, es: t.earliestStart, dl: t.deadline, min: t.totalMinutes}))")
        check('4b. tasks created with the project name at the start, in order', [t['title'] for t in sorted(tasks, key=lambda t: t['step'])] == ['Thesis: Literature review', 'Thesis: Write chapter 1'], tasks)
        meet = [e for e in g.events['me@example.com'].values() if e.get('summary') == 'Thesis: Meet supervisor']
        check('4c. the event is on the calendar, tagged with the project', meet and meet[0]['extendedProperties']['private'].get('tempoProject'), meet[:1])
        ss = (await run([{'cmd': 'listSessions', 'task': 'Thesis: Literature review', 'from': '2026-10-23', 'to': '2026-11-20'}]))[0]['result']
        check('4d. sessions between the step\'s start and end', ss and all('2026-10-26' <= x['start'][:10] <= '2026-10-30' for x in ss), [x['start'] for x in ss])
        ss2 = (await run([{'cmd': 'listSessions', 'task': 'Thesis: Write chapter 1', 'from': '2026-10-23', 'to': '2026-11-20'}]))[0]['result']
        check('4e. the next task starts after the meeting and its own start', ss2 and all(x['start'][:10] >= '2026-11-02' for x in ss2), [x['start'] for x in ss2][:3])
        card = await page.text_content('#proj-list .pj-card')
        check('4f. sidebar Projects tab shows progress', await page.is_visible('#proj-list') and 'Thesis' in card and '0/3 steps' in card, card)
        await page.screenshot(path=f'{OUT}/r27-sidebar.png')
        # edit: add an event later, move it, remove the first task
        await page.click('#proj-list .pj-card'); await page.wait_for_selector('dialog[open] .project-form')
        await page.click('dialog[open] .pj-add[data-kind=event]'); await page.fill('dialog[open] .pj-step[data-i="3"] .ps-title', 'Submit')
        await page.fill('dialog[open] .pj-step[data-i="3"] .ps-sd', '2026-11-16'); await page.fill('dialog[open] .pj-step[data-i="3"] .ps-ed', '2026-11-16')
        await page.click('dialog[open] .pj-step[data-i="0"] .ps-del'); await page.wait_for_timeout(100)
        await page.select_option('dialog[open] [name=titleMode]', 'suffix')
        await page.click('dialog[open] button[type=submit]'); await page.wait_for_timeout(3000)
        if await page.query_selector('dialog[open] .pj-err:not([hidden])'): print('   dialog error:', await page.text_content('dialog[open] .pj-err')); await page.screenshot(path=f'{OUT}/r27-err.png')
        titles = await page.evaluate("window.__tempo.app.state.tasks.filter(t => t.projectId).map(t => t.title)")
        check('4g. removed step\'s task is gone; titles now end with the project name', titles == ['Write chapter 1 — Thesis'], titles)
        evs = sorted(e['summary'] for e in g.events['me@example.com'].values() if e.get('status') != 'cancelled' and e.get('extendedProperties', {}).get('private', {}).get('tempoProject'))
        check('4h. events renamed and the new one added', evs == ['Meet supervisor — Thesis', 'Submit — Thesis'], evs)
        # newspaper
        await page.evaluate("window.__tempo.app.state.settings.paperPeriod = 'month'")
        await page.click('#view-seg button[data-view=review]'); await page.wait_for_selector('.np'); await page.wait_for_timeout(2500)
        pj = await page.text_content('.np-proj') if await page.query_selector('.np-proj') else ''
        check('4i. newspaper has a project section', 'Thesis' in pj and 'Next:' in pj, pj[:200])
        await page.screenshot(path=f'{OUT}/r27-paper.png', full_page=True)
        # analysis by project
        await page.click('#view-seg button[data-view=analysis]'); await page.wait_for_selector('[data-o=by]')
        await page.select_option('[data-o=by]', 'project'); await page.wait_for_timeout(800)
        an = await page.text_content('.an-table')
        check('4j. analysis groups by project', 'Thesis' in an or 'Not in a project' in an, an[:160])
        lp = (await run([{'cmd': 'listProjects'}]))[0]['result']
        check('4k. API lists the project with its steps', lp and lp[0]['name'] == 'Thesis' and len(lp[0]['steps']) == 3, lp)
        check('no page errors', not errs, errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
print('ALL PASS' if all(ok) else f'{ok.count(False)} FAILED')
