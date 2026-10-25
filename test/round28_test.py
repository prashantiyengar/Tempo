# Round 28: goals tracking text show scheduled time; changing "From" moves "To" (event dialog, quick create, task
# dialog, project steps, leave range); habit tracker (Loop-style list, tick / skip / amounts, details, newspaper).
import asyncio, sys, subprocess, time, re, json
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8822','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
INIT = """
const FIX = Date.parse('2026-10-24T06:30:00Z'); const _Date = Date; globalThis.__off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false, goalNotice: false, syncTasksToGoogle: true}));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2099-01-01'));
}"""
ok = []
def check(label, cond, extra=''):
    ok.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + label, extra)

async def main():
    g = MockGoogle(); errs = []
    async with async_playwright() as p:
        b = await p.chromium.launch(); ctx = await b.new_context(viewport={'width': 1400, 'height': 900}, timezone_id='Europe/Berlin', compact_ui=True)
        await ctx.add_init_script(INIT); await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        page = await ctx.new_page(); page.on('pageerror', lambda e: (errs.append(str(e)), print('   PAGEERROR', e.stack[:600] if hasattr(e, 'stack') and e.stack else e)))
        await page.goto('http://localhost:8822/app.html'); await page.wait_for_function('window.tempo'); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(1500)
        run = lambda c: page.evaluate(f"window.tempo.run({json.dumps(c)})")

        # ---------- 1. goal tracking text shows scheduled task time
        await run([{'cmd': 'addTask', 'title': 'Moby Dick', 'pages': 60, 'pagesPerHour': 20, 'deadline': '2026-10-30 17:00'},
                   {'cmd': 'addGoal', 'period': 'next week', 'text': 'Read Moby Dick', 'track': 'Moby Dick'}]); await page.wait_for_timeout(1500)
        await page.click('#view-seg button[data-view=goals]'); await page.wait_for_timeout(1500)
        bud = await page.locator('.g-row:has-text("Read Moby Dick") .g-bud').first.text_content()
        check('1. goal shows the scheduled time of matching task sessions', 'scheduled' in bud and '3h' in bud, bud)

        # ---------- 2. habits
        await page.click('.g-habits .hb-add'); await page.wait_for_selector('dialog[open] .habit-form')
        await page.fill('dialog[open] [name=name]', 'Exercise'); await page.fill('dialog[open] [name=question]', 'Did you exercise today?')
        await page.select_option('dialog[open] [name=per]', 'week'); await page.fill('dialog[open] [name=times]', '3')
        await page.click('dialog[open] button[type=submit]'); await page.wait_for_timeout(600)
        await page.click('.g-habits .hb-add'); await page.wait_for_selector('dialog[open] .habit-form')
        await page.click('dialog[open] .hb-type label:has(input[value=number])')
        await page.fill('dialog[open] [name=name]', 'Water'); await page.fill('dialog[open] [name=target]', '8'); await page.fill('dialog[open] [name=unit]', 'glasses')
        await page.click('dialog[open] button[type=submit]'); await page.wait_for_timeout(600)
        rows = await page.eval_on_selector_all('.g-habits .hb-row[data-id]', 'rs => rs.map(r => r.textContent.trim().slice(0, 30))')
        check('2a. two habits in the list', len(rows) == 2, rows)
        heads = await page.eval_on_selector_all('.g-habits .hb-day', 'ds => ds.map(d => d.textContent)')
        check('2b. today first, like Loop', heads[0].startswith('SAT') and '24' in heads[0], heads[:3])
        ex = page.locator('.g-habits .hb-row:has-text("Exercise")')
        for i in [0, 1, 3]: await ex.locator('.hb-c').nth(i).click(); await page.wait_for_timeout(150)
        await ex.locator('.hb-c').nth(2).click(button='right'); await page.wait_for_timeout(200)
        cells = await page.eval_on_selector_all('.g-habits .hb-row:has-text("Exercise") .hb-c', 'cs => cs.map(c => c.textContent.trim())')
        check('2c. tick (✓), skip (») and not done (✕)', cells[:5] == ['✓', '✓', '»', '✓', '✕'], cells)
        wa = page.locator('.g-habits .hb-row:has-text("Water")')
        await wa.locator('.hb-c').nth(0).click(); await page.wait_for_selector('dialog[open] .hb-amount'); await page.fill('dialog[open] [name=v]', '8'); await page.click('dialog[open] button.primary'); await page.wait_for_timeout(300)
        await wa.locator('.hb-c').nth(1).click(); await page.wait_for_selector('dialog[open] .hb-amount'); await page.fill('dialog[open] [name=v]', '5'); await page.click('dialog[open] button.primary'); await page.wait_for_timeout(300)
        w = await page.eval_on_selector_all('.g-habits .hb-row:has-text("Water") .hb-c', 'cs => cs.slice(0,2).map(c => c.className + ":" + c.textContent.trim())')
        check('2d. amounts shown, full target highlighted', 'full' in w[0] and '8' in w[0] and 'full' not in w[1] and '5' in w[1], w)
        await page.screenshot(path=f'{OUT}/r28-habits.png')
        # detail page
        await ex.locator('.hb-name').click(); await page.wait_for_selector('dialog[open] .hb-detail')
        await page.wait_for_timeout(300)
        txt = await page.text_content('dialog[open] .hb-detail')
        check('2e. detail: score, history, calendar, streaks, frequency', all(x in txt for x in ['Score', 'History', 'Calendar', 'Best streaks', 'Frequency']) and '3 times a week' in txt, txt[:120])
        n0 = await page.eval_on_selector_all('dialog[open] .hb-cd', 'cs => cs.filter(c => c.title.includes("done")).length')
        await page.click('dialog[open] .hb-cd[data-k="2026-10-17"]'); await page.wait_for_timeout(400)
        n1 = await page.eval_on_selector_all('dialog[open] .hb-cd', 'cs => cs.filter(c => c.title.includes("done")).length')
        check('2f. clicking a calendar day ticks it', n1 == n0 + 1, (n0, n1))
        await page.screenshot(path=f'{OUT}/r28-habit-detail.png')
        await page.click('dialog[open] [data-close]'); await page.wait_for_timeout(300)
        # sidebar tab
        await page.click('.side-tabs [data-st=habits]'); await page.wait_for_timeout(300)
        check('2g. sidebar Habits tab', await page.is_visible('#habit-list .hb-row[data-id]'))
        await page.screenshot(path=f'{OUT}/r28-sidebar.png')
        lh = (await run([{'cmd': 'listHabits'}]))[0]['result']
        check('2h. API lists habits with score and streak', len(lh) == 2 and lh[0]['score'] > 0, lh[0])
        await run([{'cmd': 'checkHabit', 'habit': 'water', 'day': '2026-10-21', 'value': 8}])
        # newspaper
        await page.click('#view-seg button[data-view=review]'); await page.wait_for_timeout(2500)
        if not await page.query_selector('.np'): print('   paper errors:', errs, await page.text_content('#view'))
        hb = await page.text_content('.np-habits') if await page.query_selector('.np-habits') else ''
        check('2i. newspaper reports habits', 'Exercise' in hb and 'Water' in hb and 'score' in hb, hb[:240])
        await page.screenshot(path=f'{OUT}/r28-paper.png', full_page=True)

        # ---------- 3. From moves To
        await page.click('#view-seg button[data-view=week]'); await page.wait_for_timeout(500)
        await page.evaluate("document.querySelector('#btn-new-event').click()"); await page.wait_for_selector('dialog[open] .event-form')
        await page.fill('dialog[open] [name=sTime]', '10:00'); await page.dispatch_event('dialog[open] [name=sTime]', 'change')
        await page.fill('dialog[open] [name=eTime]', '11:30'); await page.dispatch_event('dialog[open] [name=eTime]', 'change')
        await page.focus('dialog[open] [name=sTime]'); await page.keyboard.type('0200P'); await page.keyboard.press('Tab'); await page.wait_for_timeout(200)
        st, en = await page.input_value('dialog[open] [name=sTime]'), await page.input_value('dialog[open] [name=eTime]')
        check('3a. event dialog: typing a new From moves To (length kept)', st == '14:00' and en == '15:30', (st, en))
        d0 = await page.input_value('dialog[open] [name=sDate]')
        await page.locator('dialog[open] [name=sDate]').click(); await page.keyboard.press('ArrowUp'); await page.keyboard.press('Tab'); await page.wait_for_timeout(200)
        sd, ed = await page.input_value('dialog[open] [name=sDate]'), await page.input_value('dialog[open] [name=eDate]')
        check('3b. a new From date moves the To date', sd != d0 and ed == sd, (d0, sd, ed))
        await page.click('dialog[open] [data-close] >> nth=-1'); await page.wait_for_timeout(300)
        # quick create
        col = page.locator('.tg-col').nth(1); bb = await col.bounding_box(); hh = await page.evaluate('window.__tempo.app.state.settings.hourHeight')
        await page.mouse.move(bb['x'] + 20, bb['y'] + 9 * hh + 2); await page.mouse.down(); await page.mouse.move(bb['x'] + 20, bb['y'] + 10.5 * hh - 2, steps=4); await page.mouse.up()
        await page.wait_for_selector('.popover .qc')
        q0 = (await page.input_value('.popover [name=qs]'), await page.input_value('.popover [name=qe]'))
        await page.fill('.popover [name=qs]', '13:00'); await page.dispatch_event('.popover [name=qs]', 'change'); await page.wait_for_timeout(150)
        q1 = (await page.input_value('.popover [name=qs]'), await page.input_value('.popover [name=qe]'))
        check('3c. quick create: new From moves To', q1 == ('13:00', '14:30'), (q0, q1))
        await page.click('.popover .qc-cancel')
        # task dialog
        await page.evaluate("document.querySelector('#btn-new-task').click()"); await page.wait_for_selector('dialog[open] .task-form')
        dl0 = await page.input_value('dialog[open] [name=deadline]')
        await page.evaluate("document.querySelector('dialog[open] .es-add[data-add=\"1440\"]').click()"); await page.wait_for_timeout(100)
        es1, dl1 = await page.input_value('dialog[open] [name=earliest]'), await page.input_value('dialog[open] [name=deadline]')
        await page.evaluate("document.querySelector('dialog[open] .es-add[data-add=\"1440\"]').click()"); await page.wait_for_timeout(100)
        es2, dl2 = await page.input_value('dialog[open] [name=earliest]'), await page.input_value('dialog[open] [name=deadline]')
        check('3d. task: the From ± buttons move only From, not the deadline', es2 > es1 and dl2 == dl1 == dl0, (dl0, es1, dl1, es2, dl2))
        await page.click('dialog[open] [data-close] >> nth=-1'); await page.wait_for_timeout(300)
        # project step
        await page.click('#btn-new-project'); await page.wait_for_selector('dialog[open] .project-form')
        await page.click('dialog[open] .pj-add[data-kind=event]')
        e0 = (await page.input_value('dialog[open] input.ps-st'), await page.input_value('dialog[open] input.ps-et'))
        await page.focus('dialog[open] input.ps-st'); await page.keyboard.type('0300P'); await page.keyboard.press('Tab'); await page.wait_for_timeout(200)
        e1 = (await page.input_value('dialog[open] input.ps-st'), await page.input_value('dialog[open] input.ps-et'))
        check('3e. project event step: new start moves the end', e1 == ('15:00', '16:00'), (e0, e1))
        await page.click('dialog[open] [data-close] >> nth=-1'); await page.wait_for_timeout(300)
        check('no page errors', not errs, errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
print('ALL PASS' if all(ok) else f'{ok.count(False)} FAILED')
