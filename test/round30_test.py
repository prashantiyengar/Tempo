# Round 30: on phones the habit dialog (with automatic tracking open) shows its buttons and scrolls to the end.
import asyncio, sys, subprocess, time, re
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8824','-d','dist/web'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
INIT = """
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false, goalNotice: false, habits: [{id: 'h1', name: 'Exercise', color: '#388e3c', type: 'yesno', freq: {times: 1, per: 'day'}, log: {}, created: Date.now()}]}));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2099-01-01'));
}"""
ok = []
def check(label, cond, extra=''):
    ok.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + label, extra)
async def run(p, name):
    g = MockGoogle(); errs = []
    b = await p.chromium.launch(); ctx = await b.new_context(**p.devices[name], timezone_id='Europe/Berlin', compact_ui=True)
    await ctx.add_init_script(INIT); await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
    page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
    await page.goto('http://localhost:8824/'); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(1500)
    await page.tap('#bottombar button[data-view=goals]'); await page.wait_for_timeout(1200)
    await page.tap('.g-habits .hb-name:has-text("Exercise")'); await page.wait_for_selector('dialog[open] .hb-detail'); await page.wait_for_timeout(900)
    await page.tap('dialog[open] .hb-edit'); await page.wait_for_selector('dialog[open] .habit-form'); await page.wait_for_timeout(900)
    if not await page.is_visible('dialog[open] [name=amode]'): await page.tap('dialog[open] details[data-sect=hb-adv] > summary')
    await page.select_option('dialog[open] [name=amode]', 'untick'); await page.wait_for_timeout(300)
    vh = await page.evaluate('innerHeight')
    btn = await page.evaluate("(() => { const b = document.querySelector('dialog[open] .habit-form button[type=submit]').getBoundingClientRect(); return [Math.round(b.top), Math.round(b.bottom)]; })()")
    check(f'{name}: Save button inside the screen', btn[1] <= vh and btn[0] >= 0, (btn, vh))
    await page.evaluate("document.querySelector('dialog[open] .habit-form .dlg-body').scrollTop = 1e5"); await page.wait_for_timeout(200)
    last = await page.evaluate("(() => { const p = [...document.querySelectorAll('dialog[open] .habit-form .dlg-body > p')].pop().getBoundingClientRect(); const f = document.querySelector('dialog[open] .habit-form footer').getBoundingClientRect(); return [Math.round(p.bottom), Math.round(f.top)]; })()")
    check(f'{name}: the end of the form scrolls into view above the buttons', last[0] <= last[1] + 1, last)
    await page.fill('dialog[open] [name=awords]', 'computer games')
    await page.tap('dialog[open] .habit-form button[type=submit]'); await page.wait_for_timeout(1200)
    check(f'{name}: saving works', not await page.query_selector('dialog[open] .habit-form'))
    await page.screenshot(path=f'{OUT}/r30-{name.replace(" ", "")}.png')
    check(f'{name}: no page errors', not errs, errs)
    await b.close()
async def main():
    async with async_playwright() as p:
        for d in ['iPhone SE', 'iPhone 13', 'Pixel 5']: await run(p, d)
try: asyncio.run(main())
finally: srv.terminate()
print('ALL PASS' if all(ok) else f'{ok.count(False)} FAILED')
