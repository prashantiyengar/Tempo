# Round 34: game — ranks page scrolls on phones, categories that never score, advanced settings, life items earn
# little busy XP, a busy week lands between level 10 and 15.
import asyncio, sys, subprocess, time, re, json
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8828','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
def INIT(extra=''):
    return """
const FIX = Date.parse('2026-10-26T06:00:00Z'); const _Date = Date; globalThis.__off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false, goalNotice: false,
    game: {on: true, started: '2026-10-19', lifeCats: ['study'], noCats: ['personal'], active: ['2026-10-19','2026-10-20','2026-10-21','2026-10-22','2026-10-23','2026-10-24','2026-10-25','2026-10-26']""" + extra + """}}));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2099-01-01'));
}"""
ok = []
def check(label, cond, extra=''):
    ok.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + label, extra)
def ev(i, title, d, h0, h1, cat=None):
    e = {'id': i, 'summary': title, 'status': 'confirmed', 'created': '2026-10-18T10:00:00Z', 'start': {'dateTime': f'{d}T{h0}:00+02:00'}, 'end': {'dateTime': f'{d}T{h1}:00+02:00'}}
    if cat: e['extendedProperties'] = {'private': {'tempoCategory': cat}}
    return e
def busy_week(g):
    E = g.events['me@example.com']; n = 0
    for d in ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']:
        for h in [8, 9, 10, 11, 13, 14, 15, 16, 17]:
            n += 1; E[f'e{n}'] = ev(f'e{n}', f'Meeting {n}', d, f'{h:02d}:00', f'{h + 1:02d}:00', 'work')
        n += 1; E[f'e{n}'] = ev(f'e{n}', 'Reading', d, '19:00', '20:00', 'study')
        n += 1; E[f'e{n}'] = ev(f'e{n}', 'Family dinner', d, '20:00', '21:00', 'personal')

async def run_desktop(p):
    g = MockGoogle(); errs = []; busy_week(g)
    b = await p.chromium.launch(); ctx = await b.new_context(viewport={'width': 1400, 'height': 900}, timezone_id='Europe/Berlin', compact_ui=True)
    await ctx.add_init_script(INIT()); await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
    page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
    await page.goto('http://localhost:8828/app.html'); await page.wait_for_function('window.tempo'); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(4500)
    lvl = int(re.search(r'Level (\d+)', await page.text_content('#game-panel')).group(1))
    check('5. a busy week (45 h of meetings, daily reading) lands between level 10 and 15', 10 <= lvl <= 15, lvl)
    led = await page.evaluate("window.__tempo.app.state.settings.game.ledger")
    print('   week:', {k: v['net'] for k, v in led.items()})
    await page.click('#btn-prev'); await page.wait_for_timeout(1200)
    await page.locator('.ev:has-text("Reading")').first.click(); await page.wait_for_selector('.popover .xp-line')
    xl = await page.text_content('.popover .xp-line')
    m = re.search(r'\+(\d+) busy', xl); l = re.search(r'\+(\d+) life', xl)
    check('4. a life-growth event earns mostly life XP, little busy', l and m and int(m.group(1)) * 4 < int(l.group(1)), xl)
    await page.keyboard.press('Escape')
    await page.locator('.ev:has-text("Family dinner")').first.click(); await page.wait_for_selector('.popover'); await page.wait_for_timeout(300)
    check('2. a category that never scores earns nothing', not await page.query_selector('.popover .xp-line'))
    await page.keyboard.press('Escape')
    # advanced settings
    await page.evaluate("document.querySelector('#btn-settings').click()"); await page.wait_for_selector('dialog[open] .settings-form')
    await page.click('dialog[open] details[data-sect=s-game] > summary'); await page.click('dialog[open] .game-adv > summary')
    n = await page.locator('dialog[open] .gc-v').count()
    check('3a. advanced settings list the adjustable values', n >= 15, n)
    await page.screenshot(path=f'{OUT}/r34-advanced.png')
    await page.fill('dialog[open] .gc-v[data-k=pace]', '2')
    await page.click('dialog[open] button[type=submit]'); await page.wait_for_timeout(4000)
    lvl2 = int(re.search(r'Level (\d+)', await page.text_content('#game-panel')).group(1))
    check('3b. doubling the level pace lowers the level', lvl2 < lvl, (lvl, lvl2))
    check('no page errors (desktop)', not errs, errs)
    await b.close()

async def run_phone(p):
    g = MockGoogle(); errs = []
    b = await p.chromium.launch(); ctx = await b.new_context(**p.devices['iPhone 13'], timezone_id='Europe/Berlin', compact_ui=True)
    await ctx.add_init_script(INIT()); await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
    page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
    await page.goto('http://localhost:8828/app.html'); await page.wait_for_function('window.tempo'); await page.wait_for_timeout(3000)
    await page.tap('#btn-menu'); await page.wait_for_timeout(500)
    await page.tap('#game-panel .gp-more'); await page.wait_for_selector('dialog[open] .g-details'); await page.wait_for_timeout(500)
    sc = await page.evaluate("(() => { const b = document.querySelector('dialog[open] .g-details .dlg-body'); b.scrollTop = 1e6; return [b.scrollHeight > b.clientHeight, b.scrollTop > 0]; })()")
    await page.wait_for_timeout(200)
    vis = await page.evaluate("(() => { const e = [...document.querySelectorAll('dialog[open] .gd-era')].pop().getBoundingClientRect(); return e.top < innerHeight; })()")
    check('1. on a phone the ranks page scrolls down past the first era', sc[0] and sc[1] and vis, (sc, vis))
    await page.screenshot(path=f'{OUT}/r34-phone-ranks.png')
    check('no page errors (phone)', not errs, errs)
    await b.close()

async def main():
    async with async_playwright() as p:
        await run_desktop(p); await run_phone(p)
try: asyncio.run(main())
finally: srv.terminate()
print('ALL PASS' if all(ok) else f'{ok.count(False)} FAILED')
