# Round 35: XP drains — activities that cost XP (tolerated hours at a % of the day, beyond that a growing % of the
# week up to a maximum), editable in settings; changing them recounts from the start.
import asyncio, sys, subprocess, time, re, json
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8829','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
INIT = """
const FIX = Date.parse('2026-10-24T13:00:00Z'); const _Date = Date; globalThis.__off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false, goalNotice: false,
    game: {on: true, started: '2026-10-12', lifeCats: ['study'], active: ['2026-10-24']}}));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2099-01-01'));
}"""
ok = []
def check(label, cond, extra=''):
    ok.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + label, extra)
def ev(i, title, d, h0, h1, cat=None):
    e = {'id': i, 'summary': title, 'status': 'confirmed', 'start': {'dateTime': f'{d}T{h0}:00+02:00'}, 'end': {'dateTime': f'{d}T{h1}:00+02:00'}}
    if cat: e['extendedProperties'] = {'private': {'tempoCategory': cat}}
    return e

async def main():
    g = MockGoogle(); errs = []
    E = g.events['me@example.com']
    for i, d in enumerate(['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-20', '2026-10-21', '2026-10-22']):
        for h in [9, 10, 11, 14, 15]: E[f'w{i}{h}'] = ev(f'w{i}{h}', 'Work block', d, f'{h:02d}:00', f'{h + 1:02d}:00', 'work')
    E['g1'] = ev('g1', 'Gaming', '2026-10-14', '20:00', '21:30')                     # last week: 1.5 h → tolerated
    E['g2'] = ev('g2', 'Gaming night', '2026-10-21', '19:00', '23:00')               # this week: 4 h → 2 h over
    async with async_playwright() as p:
        b = await p.chromium.launch(); ctx = await b.new_context(viewport={'width': 1400, 'height': 900}, timezone_id='Europe/Berlin', compact_ui=True)
        await ctx.add_init_script(INIT); await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8829/app.html'); await page.wait_for_function('window.tempo'); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(3500)
        xp0 = await page.evaluate("(() => { const t = window.__tempo.app; return null; })()")
        total0 = int(re.search(r'⭐ ([\d,]+) XP', await page.text_content('#game-panel')).group(1).replace(',', ''))
        # add the default "Gameplay" drain
        await page.evaluate("document.querySelector('#btn-settings').click()"); await page.wait_for_selector('dialog[open] .settings-form')
        await page.click('dialog[open] details[data-sect=s-game] > summary')
        await page.click('dialog[open] .add-drain'); await page.wait_for_timeout(200)
        say = await page.text_content('dialog[open] .dr-say')
        check('1. a drain explains itself in a sentence', 'Up to 2 h a week' in say and '75%' in say, say)
        await page.screenshot(path=f'{OUT}/r35-drain-settings.png')
        await page.click('dialog[open] button[type=submit]'); await page.wait_for_timeout(4500)
        weeks = await page.evaluate("window.__tempo.app.state.settings.game.weeks")
        lw = weeks.get('2026-10-12', {})
        check('2. last week: 1.5 h of gaming tolerated → 10% of that day only', lw.get('drain', 0) > 0 and any('tolerated' in l[0] and l[2] == '2026-10-14' for l in lw.get('dl', [])), lw.get('dl'))
        live = await page.evaluate("window.__tempo.app.gameDrain")
        check('3. this week: 4 h → 2 h over the tolerated 2 h → 10% + 2 × 15% = 40% of the week', live['lines'] and '−40% of the week' in live['lines'][0][0], live['lines'])
        panel = await page.text_content('#game-panel')
        total1 = int(re.search(r'⭐ ([\d,]+) XP', panel).group(1).replace(',', ''))
        check('4. the panel shows XP drained and the total goes down', 'drained' in panel and total1 < total0, (total0, total1))
        await page.click('.tg-dayhead[data-day="2026-10-21"] .xp-chip'); await page.wait_for_selector('.popover .xb')
        bd = await page.text_content('.popover .xb')
        check('5. the day breakdown lists the drain', 'XP drains' in bd and 'Gameplay' in bd, bd[:240])
        await page.screenshot(path=f'{OUT}/r35-breakdown.png'); await page.keyboard.press('Escape')
        # changing it recounts from the start
        await page.evaluate("document.querySelector('#btn-settings').click()"); await page.wait_for_selector('dialog[open] .settings-form')
        await page.click('dialog[open] details[data-sect=s-game] > summary')
        await page.fill('dialog[open] .dr-max', '20'); await page.dispatch_event('dialog[open] .dr-max', 'input')
        await page.click('dialog[open] button[type=submit]'); await page.wait_for_timeout(4500)
        live2 = await page.evaluate("window.__tempo.app.gameDrain")
        check('6. lowering the maximum to 20% recounts: this week now costs 20%', '−20% of the week' in live2['lines'][0][0], live2['lines'])
        check('no page errors', not errs, errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
print('ALL PASS' if all(ok) else f'{ok.count(False)} FAILED')
