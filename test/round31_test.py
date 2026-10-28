# Round 31: hour-based automatic habits and goals; automatic sleep blocks around events; game mode (XP, levels,
# ledger, day chips, popup XP, quests, penalties, details, fireworks).
import asyncio, sys, subprocess, time, re, json
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8825','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
INIT = """
const FIX = Date.parse('2026-10-24T10:00:00Z'); const _Date = Date; globalThis.__off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false, goalNotice: false,
    sleepEvents: true, sleepEventsFrom: '2026-10-23', sleepStart: '23:00', sleepEnd: '07:00',
    game: {on: true, started: '2026-10-19', lifeCats: ['study'], restCats: ['leisure'], active: ['2026-10-19','2026-10-20','2026-10-21','2026-10-22','2026-10-23']},
    history: [{id: 'x1', at: Date.parse('2026-10-22T09:00:00Z'), kind: 'moved', taskId: 't1', title: 'Essay'}, {id: 'x2', at: Date.parse('2026-10-22T15:00:00Z'), kind: 'skipped', taskId: 't1', title: 'Essay'}]}));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2099-01-01'));
}"""
ok = []
def check(label, cond, extra=''):
    ok.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + label, extra)
def ev(i, title, day, h0, h1, cat=None, d2=None):
    e = {'id': i, 'summary': title, 'status': 'confirmed', 'created': '2026-10-19T08:00:00Z', 'start': {'dateTime': f'{day}T{h0}:00+02:00'}, 'end': {'dateTime': f'{d2 or day}T{h1}:00+02:00'}}
    if cat: e['extendedProperties'] = {'private': {'tempoCategory': cat}}
    return e

async def main():
    g = MockGoogle(); errs = []
    E = g.events['me@example.com']
    for d, h in [('2026-10-20', '10:00'), ('2026-10-21', '10:00'), ('2026-10-23', '09:00')]:
        E['s' + d] = ev('s' + d, 'Study session', d, h, f"{int(h[:2]) + 2:02d}:00", 'study')
    E['w1'] = ev('w1', 'Workshop', '2026-10-22', '09:00', '17:00', 'work')
    E['night'] = ev('night', 'Night call', '2026-10-24', '02:00', '03:00')
    E['later'] = ev('later', 'Read a book', '2026-10-24', '15:00', '17:00', 'study')
    async with async_playwright() as p:
        b = await p.chromium.launch(); ctx = await b.new_context(viewport={'width': 1400, 'height': 900}, timezone_id='Europe/Berlin', compact_ui=True)
        await ctx.add_init_script(INIT); await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8825/app.html'); await page.wait_for_function('window.tempo'); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(4000)

        # ---------- 2. sleep blocks for last night, around the 2–3 am call
        sl = sorted((e['start']['dateTime'], e['end']['dateTime']) for e in E.values() if e.get('extendedProperties', {}).get('private', {}).get('tempoSleep'))
        check('2a. sleep blocks 23:00–02:00 and 03:00–07:00 for last night', sl == [('2026-10-23T21:00:00.000Z', '2026-10-24T00:00:00.000Z'), ('2026-10-24T01:00:00.000Z', '2026-10-24T05:00:00.000Z')], sl)
        await page.evaluate("window.__tempo.cycle()"); await page.wait_for_timeout(2500)
        n = sum(1 for e in E.values() if e.get('status') != 'cancelled' and e.get('extendedProperties', {}).get('private', {}).get('tempoSleep'))
        check('2b. not added twice', n == 2, n)

        # ---------- 3. game mode
        await page.wait_for_selector('#game-panel:not([hidden])')
        panel = await page.text_content('#game-panel')
        check('3a. sidebar game panel shows level and XP types', 'Level' in panel and 'App' in panel and 'Busy' in panel and 'Life' in panel, panel[:200])
        led = await page.evaluate("window.__tempo.app.state.settings.game.ledger")
        check('3b. past days settled into the ledger', all(k in led for k in ['2026-10-19', '2026-10-20', '2026-10-22', '2026-10-23']), list(led.keys()))
        check('3c. study days earn life XP', led['2026-10-20']['l'] > 0, led['2026-10-20'])
        check('3d. rescheduling the same task twice in a day costs XP once (round 53)', led['2026-10-22']['p'] == 8 and led['2026-10-22']['penN'] == 1, led['2026-10-22'])
        check('3e. the full workday counts as a full day', any('full day' in l[0] for l in led['2026-10-22']['top']), led['2026-10-22']['top'])
        chips = await page.eval_on_selector_all('.tg-dayhead .xp-chip', 'cs => cs.map(c => c.textContent.trim())')
        check('3f. XP next to each date (earned, today\'s to-go, possible)', len(chips) >= 6 and any('to go' in c for c in chips), chips)
        await page.screenshot(path=f'{OUT}/r31-week.png')
        await page.locator('.ev:has-text("Read a book")').first.click(); await page.wait_for_selector('.popover .xp-line')
        xl = await page.text_content('.popover .xp-line')
        check('3g. clicking an event says what completing it earns', 'Completing this earns' in xl and 'life' in xl, xl)
        await page.keyboard.press('Escape')
        await page.click('#game-panel .gp-more'); await page.wait_for_selector('dialog[open] .g-details')
        dt = await page.text_content('dialog[open] .g-details')
        check('3h. details: ranks with emblems, achievements, XP log', 'Seedling' in dt and 'Master of Time' in dt and 'Achievements' in dt and 'XP log' in dt and await page.locator('dialog[open] .g-emblem').count() >= 16, dt[:100])
        await page.screenshot(path=f'{OUT}/r31-details.png')
        await page.click('dialog[open] [data-close]'); await page.wait_for_timeout(300)
        # level up -> fireworks
        await page.evaluate("window.__tempo.app.state.settings.game.celebrated = 1")
        await page.evaluate("window.__tempo.gameRefresh()"); await page.wait_for_timeout(600)
        check('3i. levelling up is celebrated with fireworks', bool(await page.query_selector('canvas.fireworks')))
        await page.screenshot(path=f'{OUT}/r31-fireworks.png')
        await page.wait_for_timeout(3000)

        # ---------- 1. hour-based habit and goal
        await page.click('#view-seg button[data-view=goals]'); await page.wait_for_timeout(1200)
        await page.click('.g-habits .hb-add'); await page.wait_for_selector('dialog[open] .habit-form')
        await page.fill('dialog[open] [name=name]', 'Study 2h')
        check('1a. automatic tracking sits in an Advanced block', await page.locator('dialog[open] details[data-sect=hb-adv]').count() == 1)
        await page.click('dialog[open] details[data-sect=hb-adv] > summary')
        await page.select_option('dialog[open] [name=amode]', 'hours'); await page.fill('dialog[open] [name=ahours]', '2'); await page.check('dialog[open] input[name=acat][value=study]'); await page.fill('dialog[open] [name=afrom]', '2026-10-18')
        await page.screenshot(path=f'{OUT}/r31-habit-hours.png')
        await page.click('dialog[open] button[type=submit]'); await page.wait_for_timeout(2500)
        cells = await page.eval_on_selector_all('.g-habits .hb-row:has-text("Study 2h") .hb-c', 'cs => cs.map(c => c.textContent.trim())')
        check('1b. habit ticked on days with ≥ 2 h of Study (Fri, Wed, Tue), not others; not today (reading is later)', cells == ['✕', '✓', '✕', '✓', '✓', '✕', '✕'], cells)
        # goal: at least 5 h of study this week
        await page.click('.g-card:has-text("This week") .g-plus[data-head=personal]'); await page.wait_for_selector('dialog[open] .g-addform')
        await page.fill('dialog[open] [name=t]', 'Study 5 hours')
        await page.click('dialog[open] details[data-sect=g-rule] > summary')
        await page.select_option('dialog[open] [name=rop]', 'atLeast'); await page.fill('dialog[open] [name=rh]', '5'); await page.check('dialog[open] input[name=rcat][value=study]')
        await page.click('dialog[open] button.primary'); await page.wait_for_timeout(1200)
        row = page.locator('.g-card:has-text("This week") .g-row:has-text("Study 5 hours")')
        badge = await row.locator('.g-rule-b').text_content()
        check('1c. goal reached automatically (6 h of ≥ 5 h)', await row.locator('.g-done').is_checked() and '6 h' in badge, badge)
        await page.click('.g-card:has-text("This week") .g-plus[data-head=work]'); await page.wait_for_selector('dialog[open] .g-addform')
        await page.fill('dialog[open] [name=t]', 'No more than 6 h work a day')
        await page.click('dialog[open] details[data-sect=g-rule] > summary')
        await page.select_option('dialog[open] [name=rop]', 'atMost'); await page.fill('dialog[open] [name=rh]', '6'); await page.select_option('dialog[open] [name=rper]', 'day'); await page.check('dialog[open] input[name=rcat][value=work]')
        await page.click('dialog[open] button.primary'); await page.wait_for_timeout(1200)
        b2 = await page.locator('.g-card:has-text("This week") .g-row:has-text("No more than") .g-rule-b').get_attribute('class')
        check('1d. "at most 6 h a day" shows as missed after the 8-hour workshop', 'bad' in b2, b2)
        await page.screenshot(path=f'{OUT}/r31-goals.png')
        check('no page errors', not errs, errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
print('ALL PASS' if all(ok) else f'{ok.count(False)} FAILED')
