# Round 33: game mode — start date in the past, a rank every 5 levels (61, with descriptions and emblems), little XP
# for sleep, a click on a day's XP shows the breakdown, goals earn XP for defining / progress / reaching.
import asyncio, sys, subprocess, time, re, json
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8827','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
INIT = """
const FIX = Date.parse('2026-10-24T12:00:00Z'); const _Date = Date; globalThis.__off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false, goalNotice: false,
    game: {on: true, started: '2026-10-24', lifeCats: ['study'], active: ['2026-10-24']}}));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2099-01-01'));
}"""
ok = []
def check(label, cond, extra=''):
    ok.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + label, extra)
def ev(i, title, d0, h0, d1, h1, cat=None):
    e = {'id': i, 'summary': title, 'status': 'confirmed', 'start': {'dateTime': f'{d0}T{h0}:00+02:00'}, 'end': {'dateTime': f'{d1}T{h1}:00+02:00'}}
    if cat: e['extendedProperties'] = {'private': {'tempoCategory': cat}}
    return e

async def main():
    g = MockGoogle(); errs = []
    E = g.events['me@example.com']
    E['a'] = ev('a', 'Study block', '2026-10-21', '09:00', '2026-10-21', '12:00', 'study')
    E['b'] = ev('b', 'Study block', '2026-10-22', '09:00', '2026-10-22', '11:00', 'study')
    E['sl'] = ev('sl', '😴 Sleep', '2026-10-21', '23:00', '2026-10-22', '07:00')
    async with async_playwright() as p:
        b = await p.chromium.launch(); ctx = await b.new_context(viewport={'width': 1400, 'height': 900}, timezone_id='Europe/Berlin', compact_ui=True)
        await ctx.add_init_script(INIT); await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8827/app.html'); await page.wait_for_function('window.tempo'); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(2500)
        # 1. start date in the past
        await page.evaluate("document.querySelector('#btn-settings').click()"); await page.wait_for_selector('dialog[open] .settings-form')
        await page.click('dialog[open] details[data-sect=s-game] > summary')
        await page.fill('dialog[open] [name=gameStart]', '2026-10-19')
        await page.click('dialog[open] button[type=submit]'); await page.wait_for_timeout(3500)
        led = await page.evaluate("window.__tempo.app.state.settings.game.ledger")
        check('1. a start date in the past counts the days since then', all(k in led for k in ['2026-10-19', '2026-10-21', '2026-10-22', '2026-10-23']) and led['2026-10-21']['l'] > 0, list(led))
        # 3. sleep earns little
        sl = [l for k in ['2026-10-21', '2026-10-22'] for l in led[k]['top'] if 'Sleep' in l[0]]
        check('3. 8 h of sleep earns only a little', sl and 0 < sl[0][2] <= 16, sl)
        # 4. breakdown
        await page.click('.tg-dayhead[data-day="2026-10-21"] .xp-chip'); await page.wait_for_selector('.popover .xb')
        txt = await page.text_content('.popover .xb')
        check('4. clicking a day\'s XP shows how it was reached', 'Busy' in txt and 'Life' in txt and 'Study block' in txt, txt[:200])
        await page.screenshot(path=f'{OUT}/r33-breakdown.png')
        await page.keyboard.press('Escape')
        # 2. ranks
        await page.click('#game-panel .gp-more'); await page.wait_for_selector('dialog[open] .g-details')
        n = await page.locator('dialog[open] .gd-tier').count(); descs = await page.locator('dialog[open] .gd-desc').count()
        eras = await page.eval_on_selector_all('dialog[open] .gd-era', 'es => es.map(e => e.textContent.trim().split(" levels")[0])')
        check('2. a rank every 5 levels, each with a description and emblem', n == 61 and descs == 61 and await page.locator('dialog[open] .gd-tier .g-emblem').count() == 61, (n, descs, eras))
        await page.screenshot(path=f'{OUT}/r33-ranks.png')
        await page.click('dialog[open] [data-close]'); await page.wait_for_timeout(300)
        # 5. goals
        await page.click('#view-seg button[data-view=goals]'); await page.wait_for_timeout(1200)
        await page.click('.g-card:has-text("Next week") .g-plus[data-head=personal]'); await page.wait_for_selector('dialog[open] .g-addform')
        await page.fill('dialog[open] [name=t]', 'Study 10 hours')
        p0 = await page.text_content('dialog[open] .g-xp-prev')
        await page.fill('dialog[open] [name=b]', '10'); await page.wait_for_timeout(100)
        p1 = await page.text_content('dialog[open] .g-xp-prev')
        num = lambda t, w: int(re.search(w + r': \+(\d+)', t).group(1))
        check('5a. the goal dialog shows what it will earn; more hours earn more; ahead of time ×1.5', num(p1, 'reaching it') > num(p0, 'reaching it') and 'planned ahead' in p1, (p0, p1))
        await page.click('dialog[open] button.primary'); await page.wait_for_timeout(800)
        badge = await page.locator('.g-card:has-text("Next week") .g-row:has-text("Study 10 hours") .g-xp').text_content()
        check('5b. the goal shows its XP', badge.startswith('🎮 +'), badge)
        # this week's goal, reached via its rule: earns XP today
        await page.click('.g-card:has-text("This week") .g-plus[data-head=personal]'); await page.wait_for_selector('dialog[open] .g-addform')
        await page.fill('dialog[open] [name=t]', 'Study 4 hours')
        await page.click('dialog[open] details[data-sect=g-rule] > summary')
        await page.select_option('dialog[open] [name=rop]', 'atLeast'); await page.fill('dialog[open] [name=rh]', '4'); await page.check('dialog[open] input[name=rcat][value=study]')
        await page.click('dialog[open] button.primary'); await page.wait_for_timeout(800)
        await page.evaluate("window.__tempo.cycle()"); await page.wait_for_timeout(3500)
        today = await page.evaluate("window.__tempo.app.gameToday.lines")
        names = [l[0] for l in today]
        check('5c. defining goals and reaching one earn XP today', any(n.startswith('set goal: Study 10') for n in names) and any(n.startswith('goal reached: Study 4') for n in names), names)
        led2 = await page.evaluate("window.__tempo.app.state.settings.game.ledger")
        check('5d. progress on the goal counted on the days the hours were put in', any('progress on goal' in l[0] for l in led2['2026-10-21']['top']), led2['2026-10-21']['top'])
        await page.screenshot(path=f'{OUT}/r33-goals.png')
        check('no page errors', not errs, errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
print('ALL PASS' if all(ok) else f'{ok.count(False)} FAILED')
