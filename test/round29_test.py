# Round 29: habits ticked / unticked automatically from words in event and task titles (only what has started).
import asyncio, sys, subprocess, time, re, json
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8823','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
INIT = """
const FIX = Date.parse('2026-10-24T10:00:00Z'); const _Date = Date; globalThis.__off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false, goalNotice: false}));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2099-01-01'));
}"""
ok = []
def check(label, cond, extra=''):
    ok.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + label, extra)
def ev(i, title, day, h0, h1):
    return {'id': i, 'summary': title, 'status': 'confirmed', 'start': {'dateTime': f'{day}T{h0}:00+02:00'}, 'end': {'dateTime': f'{day}T{h1}:00+02:00'}}

async def main():
    g = MockGoogle(); errs = []
    E = g.events['me@example.com']
    E['a'] = ev('a', 'Morning run', '2026-10-21', '07:00', '07:45')
    E['b'] = ev('b', 'Brunch with Anna', '2026-10-22', '11:00', '12:00')       # "run" inside a word: no
    E['c'] = ev('c', 'Running club', '2026-10-23', '18:00', '19:00')
    E['d'] = ev('d', 'Evening run', '2026-10-24', '18:00', '19:00')            # later today: not yet
    E['e'] = ev('e', 'Computer games with Max', '2026-10-22', '20:00', '22:00')
    async with async_playwright() as p:
        b = await p.chromium.launch(); ctx = await b.new_context(viewport={'width': 1400, 'height': 900}, timezone_id='Europe/Berlin', compact_ui=True)
        await ctx.add_init_script(INIT); await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8823/app.html'); await page.wait_for_function('window.tempo'); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(1500)
        await page.click('#view-seg button[data-view=goals]'); await page.wait_for_timeout(1000)
        # Exercise: tick when a title contains "run"
        await page.click('.g-habits .hb-add'); await page.wait_for_selector('dialog[open] .habit-form')
        await page.fill('dialog[open] [name=name]', 'Exercise')
        await page.click('dialog[open] details[data-sect=hb-adv] > summary')
        check('1a. the automatic section is offered for yes/no habits', await page.is_visible('dialog[open] [name=amode]'))
        await page.select_option('dialog[open] [name=amode]', 'tick'); await page.fill('dialog[open] [name=awords]', 'run, gym'); await page.fill('dialog[open] [name=afrom]', '2026-10-18')
        await page.screenshot(path=f'{OUT}/r29-dialog.png')
        await page.click('dialog[open] button[type=submit]'); await page.wait_for_timeout(2500)
        cells = lambda name: page.eval_on_selector_all(f'.g-habits .hb-row:has-text("{name}") .hb-c', 'cs => cs.map(c => c.textContent.trim() + (c.classList.contains("auto") ? "a" : ""))')
        ex = await cells('Exercise')   # Sat 24, Fri 23, Thu 22, Wed 21, Tue 20, Mon 19, Sun 18
        check('1b. ticked on days with "run" (Running club, Morning run); not for Brunch; not for tonight\'s run', ex == ['✕a', '✓a', '✕a', '✓a', '✕a', '✕a', '✕a'], ex)
        tip = await page.get_attribute('.g-habits .hb-row:has-text("Exercise") .hb-c[data-k="2026-10-21"]', 'title')
        check('1c. tooltip says why', 'Morning run' in tip, tip)
        # "Didn't play computer games": ticked unless a title contains it
        await page.click('.g-habits .hb-add'); await page.wait_for_selector('dialog[open] .habit-form')
        await page.fill('dialog[open] [name=name]', 'No computer games')
        await page.click('dialog[open] details[data-sect=hb-adv] > summary')
        await page.select_option('dialog[open] [name=amode]', 'untick'); await page.fill('dialog[open] [name=awords]', 'computer games'); await page.fill('dialog[open] [name=afrom]', '2026-10-20')
        await page.click('dialog[open] button[type=submit]'); await page.wait_for_timeout(2500)
        ng = await cells('No computer games')
        check('2. unticked on the day with "Computer games", ticked on the others since "from"', ng[:5] == ['✓a', '✓a', '✕a', '✓a', '✓a'] and ng[5] == '✕', ng)
        # manual override wins, and clicking again goes back to automatic
        c = page.locator('.g-habits .hb-row:has-text("Exercise") .hb-c[data-k="2026-10-22"]')
        await c.click(); await page.wait_for_timeout(300)
        ex2 = await cells('Exercise')
        check('3a. a day ticked by hand stays ticked (not automatic any more)', ex2[2] == '✓', ex2)
        await page.evaluate("window.__tempo.cycle()"); await page.wait_for_timeout(2500)
        await page.evaluate("window.__tempo.render()"); await page.wait_for_timeout(800)
        ex3 = await cells('Exercise')
        check('3b. ...also after the next refresh', ex3[2] == '✓', ex3)
        await page.locator('.g-habits .hb-row:has-text("Exercise") .hb-c[data-k="2026-10-22"]').click(); await page.wait_for_timeout(300)
        ex4 = await cells('Exercise')
        check('3c. clicking again returns it to automatic', ex4[2] == '✕a', ex4)
        # time passes: tonight's run has started -> today ticks
        await page.evaluate("globalThis.__off += 8.5*3600000")
        await page.evaluate("window.__tempo.cycle()"); await page.wait_for_timeout(3000)
        await page.evaluate("window.__tempo.render()"); await page.wait_for_timeout(800)
        ex5 = await cells('Exercise')
        check('4. once tonight\'s run has started, today is ticked', ex5[0] == '✓a', ex5)
        await page.screenshot(path=f'{OUT}/r29-habits.png')
        lh = (await run_api(page, [{'cmd': 'listHabits'}]))[0]['result']
        check('5. API sees the automatic ticks', lh[0]['last7'][1]['value'] == 'done', lh[0]['last7'][:3])
        check('no page errors', not errs, errs)
        await b.close()
async def run_api(page, c): return await page.evaluate(f"window.tempo.run({json.dumps(c)})")
try: asyncio.run(main())
finally: srv.terminate()
print('ALL PASS' if all(ok) else f'{ok.count(False)} FAILED')
