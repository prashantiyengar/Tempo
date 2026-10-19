# Tests for: settings upgrade (5-min breaks / 15-min min session), categories, email reminders, daily agenda email,
# deleting a done session (reschedule or not + replacement), auto-refresh, and the reconnect permission prompt.
import asyncio, sys, subprocess, time, re, json, urllib.parse
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8771','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
INIT = """
const FIX = Date.parse('2026-10-19T09:30:00Z'); const _Date = Date; const off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+off);} else super(...a);} static now(){ return _Date.now()+off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({breakMinutes: 0, minChunkMinutes: null, tz: 'Europe/Berlin'}));  // saved by an older version
}"""
async def main():
    g = MockGoogle(); errs = []; auth_reqs = []
    async def google_auth(route):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(route.request.url).query)
        auth_reqs.append({k: v[0] for k, v in q.items()})
        frag = urllib.parse.urlencode({'access_token': f'tok{len(auth_reqs)}', 'expires_in': '3600', 'state': q['state'][0], 'scope': q['scope'][0]})
        await route.fulfill(status=302, headers={'Location': q['redirect_uri'][0].rstrip('/') + '/app.html#' + frag})
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1440, 'height': 900}, timezone_id='Europe/Berlin')
        await ctx.add_init_script(INIT)
        await ctx.route(re.compile(r'https://accounts\.google\.com/o/oauth2/v2/auth.*'), google_auth)
        await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8771/app.html'); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(1500)
        stt = await page.evaluate("window.__tempo.app.state.settings")
        print('1. settings upgraded: break', stt['breakMinutes'], '| shortest', stt['minChunkMinutes'], '| categories', [c['name'] for c in stt['categories']])

        # 2. New task with a NEW category created on the fly
        await page.click('#btn-new-task'); await page.wait_for_selector('dialog .task-form')
        await page.fill('dialog [name=title]', 'Guitar practice'); await page.fill('dialog [name=hours]', '3'); await page.fill('dialog [name=deadline]', '2026-10-23T17:00')
        await page.click('dialog .cat-chip.add'); await page.fill('dialog .cat-name', 'Music')
        await page.click('dialog .cat-new .sw:nth-child(6)'); await page.click('dialog .cat-save'); await page.wait_for_timeout(200)
        print('2. chips:', await page.eval_on_selector_all('dialog .cat-chip', 'e => e.map(x => x.textContent.trim() + (x.classList.contains("on") ? "*" : ""))'), '| color row hidden:', await page.eval_on_selector('dialog .color-field', 'e => e.style.display === "none"'))
        await page.screenshot(path=f'{OUT}/f1-category-dialog.png')
        await page.click('dialog button[type=submit]'); await page.wait_for_timeout(2500)
        t = await page.evaluate("window.__tempo.app.state.tasks.find(t => t.title === 'Guitar practice')")
        ev = [e for e in g.task_events() if e['summary'].startswith('Guitar')]
        print('   task category:', t['categoryName'], t['color'], '| google colorId', ev[0].get('colorId'), '| def carries category:', 'Music' in ''.join(v for k, v in ev[0]['extendedProperties']['private'].items() if k.startswith('tdef_')))
        print('   sessions (break check):', [ (e['start']['dateTime'][11:16], e['end']['dateTime'][11:16]) for e in sorted(ev, key=lambda e: e['start']['dateTime'])][:3])

        # 3. Quick change of category from a session
        await page.click('.ev.chunk:has-text("Guitar") >> nth=0'); await page.click('.popover .pop-cat'); await page.wait_for_selector('dialog .cat-chips')
        await page.screenshot(path=f'{OUT}/f2-quick-category.png')
        await page.click('dialog .cat-chip:has-text("Leisure")'); await page.wait_for_timeout(1500)
        print('3. quick change ->', await page.evaluate("window.__tempo.app.state.tasks.find(t => t.title === 'Guitar practice').categoryName"), '| sidebar:', await page.text_content('.task-row .tr-meta'))

        # 4/5. Email reminder default + daily agenda via Settings
        await page.click('#btn-settings'); await page.click('dialog .tabs button[data-tab="3"]')
        await page.fill('dialog [name=taskEmailReminderMinutes]', '30'); await page.check('dialog [name=agendaEmail]')
        await page.screenshot(path=f'{OUT}/f3-email-settings.png')
        await page.click('dialog .tabs button[data-tab="5"]'); await page.screenshot(path=f'{OUT}/f4-categories-tab.png')
        await page.click('dialog button[type=submit]'); await page.wait_for_timeout(3000)
        ev = [e for e in g.task_events() if e['summary'].startswith('Guitar')]
        print('4. session reminders on Google:', ev[0]['reminders'])
        print('5. agenda email on primary:', g.cals['primary'].get('notificationSettings'))

        # 6. Delete a DONE session: don't reschedule, record a meeting instead
        await page.click('.ev.chunk:has-text("Guitar") >> nth=0'); await page.click('.popover .done'); await page.wait_for_timeout(1500)
        n_before = await page.evaluate("window.__tempo.S.sessions(window.__tempo.app.state.tasks.find(t => t.title === 'Guitar practice')).length")
        await page.click('.ev.chunk.done:has-text("Guitar") >> nth=0'); await page.click('.popover .del'); await page.wait_for_selector('dialog .deldone')
        await page.uncheck('dialog [name=resched]'); await page.check('dialog [name=rep][value=event]'); await page.fill('dialog [name=evTitle]', 'Band meeting')
        await page.screenshot(path=f'{OUT}/f5-delete-done.png')
        await page.click('dialog button[type=submit]'); await page.wait_for_timeout(2500)
        tt = await page.evaluate("(() => { const t = window.__tempo.app.state.tasks.find(t => t.title === 'Guitar practice'); return { n: window.__tempo.S.sessions(t).length, done: window.__tempo.S.progress(t).done, waived: t.frozen.filter(c => c.status === 'waived').length }; })()")
        meeting = [e for evs in g.events.values() for e in evs.values() if e.get('summary') == 'Band meeting']
        print('6a. no reschedule: sessions', n_before, '->', tt['n'], '| waived', tt['waived'], '| counted done', tt['done'], '| meeting on Google:', bool(meeting), meeting[0]['start']['dateTime'][11:16] if meeting else '')
        # reschedule (default) + count the time toward another task
        await page.click('#btn-new-reading'); await page.wait_for_selector('dialog .task-form')
        await page.fill('dialog [name=title]', 'Pride and Prejudice'); await page.fill('dialog [name=pages]', '100'); await page.fill('dialog [name=speed]', '20'); await page.fill('dialog [name=deadline]', '2026-10-30T17:00')
        await page.click('dialog button[type=submit]'); await page.wait_for_timeout(2000)
        await page.click('.ev.chunk:has-text("Guitar"):not(.done) >> nth=0'); await page.click('.popover .done'); await page.wait_for_timeout(1500)
        g_before = await page.evaluate("(() => { const t = window.__tempo.app.state.tasks.find(t => t.title === 'Guitar practice'); return window.__tempo.S.sessions(t).filter(s => s.kind !== 'done').length; })()")
        await page.click('.ev.chunk.done:has-text("Guitar") >> nth=0'); await page.click('.popover .del'); await page.wait_for_selector('dialog .deldone')
        await page.check('dialog [name=rep][value=task]'); await page.select_option('dialog [name=repTask]', label='Pride and Prejudice')
        await page.click('dialog button[type=submit]'); await page.wait_for_timeout(2500)
        r = await page.evaluate("(() => { const st = window.__tempo.app.state, S = window.__tempo.S; const g = st.tasks.find(t => t.title === 'Guitar practice'), b = st.tasks.find(t => t.title === 'Pride and Prejudice'); return { gPlanned: S.sessions(g).filter(s => s.kind !== 'done').length, bookDone: S.progress(b).done }; })()")
        print('6b. reschedule: Guitar planned sessions', g_before, '->', r['gPlanned'], '| book credited minutes', r['bookDone'])

        # 7. Analysis grouped by category (default)
        await page.click('#view-seg button[data-view=analysis]'); await page.wait_for_selector('.an-legend'); await page.wait_for_timeout(400)
        print('7. analysis legend:', (await page.inner_text('.an-legend')).replace('\n', ' '))
        await page.screenshot(path=f'{OUT}/f6-analysis-category.png')
        await page.click('#view-seg button[data-view=week]'); await page.wait_for_timeout(300)

        # 8. Auto-refresh: an event added in Google elsewhere appears without pressing refresh
        await page.evaluate("window.__tempo.checkGoogle()")  # initialises cursors
        g.events['work']['elsewhere'] = {'id': 'elsewhere', 'summary': 'Added on my phone', 'status': 'confirmed', 'updated': '2026-10-19T23:59:00.000Z',
            'start': {'dateTime': '2026-10-20T15:00:00+02:00'}, 'end': {'dateTime': '2026-10-20T16:00:00+02:00'}}
        await page.wait_for_timeout(300)
        changed = await page.evaluate("window.__tempo.checkGoogle()"); await page.wait_for_timeout(1500)
        shown = await page.eval_on_selector_all('.ev:not(.chunk) .ev-t', 'e => e.map(x => x.textContent.trim())')
        again = await page.evaluate("window.__tempo.checkGoogle()")
        print('8. change detected:', changed, '| shown:', 'Added on my phone' in shown, '| no loop afterwards:', not again)

        # 9. Reconnect prompt: consent only the first time
        await page.click('#btn-settings'); await page.click('dialog .tabs button[data-tab="2"]'); await page.eval_on_selector('dialog details.adv', 'e => e.open = true')
        await page.fill('dialog [name=clientId]', '999-new.apps.googleusercontent.com'); await page.click('dialog .connect')
        await page.wait_for_timeout(3000)
        print('   after connect: url', page.url, '| auth reqs', [r_['prompt'] for r_ in auth_reqs], '| body class', await page.evaluate('document.body.className'), '| has grid', bool(await page.query_selector('.tg-col')))
        await page.screenshot(path=f'{OUT}/f7-after-connect.png')
        await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(2500)
        await page.evaluate("window.__tempo.app && null")
        # second time: banner/toast Reconnect path -> silent first, then select_account
        await page.evaluate("(() => { const a = JSON.parse(localStorage.getItem('tempo:auth')); a.expires = 1; a.token = null; localStorage.setItem('tempo:auth', JSON.stringify(a)); })()")
        await page.click('#btn-settings'); await page.click('dialog .tabs button[data-tab="2"]'); await page.eval_on_selector('dialog details.adv', 'e => e.open = true'); await page.click('dialog .connect')
        await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(2000)
        print('9. prompts:', [r_['prompt'] for r_ in auth_reqs])
        print('ERRORS:', errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
