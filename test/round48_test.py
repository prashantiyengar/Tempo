# Round 48: title suggestions as a small dropdown that never covers the title (phones); a task session can be
# marked done at another time (moved there, even outside the task's hours).
import asyncio, sys, subprocess, time, re, json
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8844','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
INIT = """
const FIX = Date.parse('2026-10-26T05:00:00Z'); const _Date = Date; globalThis.__off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false, goalNotice: false}));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2099-01-01'));
}"""
ok = []
def check(label, cond, extra=''):
    ok.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + label, extra)
def ev(i, t, d, a, b): return {'id': i, 'summary': t, 'status': 'confirmed', 'start': {'dateTime': f'{d}T{a}:00+01:00'}, 'end': {'dateTime': f'{d}T{b}:00+01:00'}}
async def main():
    g = MockGoogle(); errs = []
    E = g.events['me@example.com']
    E['br'] = ev('br', 'Breakfast with Anna', '2026-10-25', '08:30', '09:30'); E['bk'] = ev('bk', 'Book club', '2026-10-24', '19:00', '21:00')
    async with async_playwright() as p:
        b = await p.chromium.launch()
        # ---- phone: the dropdown stays under the title
        ctx = await b.new_context(**p.devices['Pixel 7'], timezone_id='Europe/Berlin')
        await ctx.add_init_script(INIT); await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8844/app.html'); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(2000)
        await page.click('#fab'); await page.wait_for_timeout(300)
        await page.click('dialog[open] .sheet-menu button:has-text("New event")'); await page.wait_for_selector('dialog[open] [name=summary]'); await page.wait_for_timeout(600)
        w0 = await page.evaluate("document.querySelector('dialog[open] [name=summary]').getBoundingClientRect().width")
        await page.fill('dialog[open] [name=summary]', ''); await page.type('dialog[open] [name=summary]', 'b'); await page.wait_for_timeout(300)
        geo = await page.evaluate("""(() => { const i = document.querySelector('dialog[open] [name=summary]').getBoundingClientRect(), d = document.querySelector('dialog[open] .ts-host').getBoundingClientRect(); return [Math.round(i.width), Math.round(i.bottom), Math.round(d.top), Math.round(d.height), [...document.querySelectorAll('dialog[open] .ts-item')].map(x => x.textContent)]; })()""")
        await page.screenshot(path=f'{OUT}/r48-phone-suggest.png')
        check('1. on the phone the suggestions are a small dropdown under the title — the title keeps its size', abs(geo[0] - w0) < 2 and geo[2] >= geo[1] and geo[3] < 140 and geo[4] == ['Breakfast with Anna', 'Book club'], (w0, geo))
        await page.click('dialog[open] .ts-item >> nth=1')
        v = await page.input_value('dialog[open] [name=summary]')
        hid = await page.evaluate("document.querySelector('dialog[open] .ts-host').hidden")
        check('2. picking one fills the title and closes the list', v == 'Book club' and hid, (v, hid))
        await ctx.close()
        # ---- done at another time
        ctx = await b.new_context(viewport={'width': 1400, 'height': 900}, timezone_id='Europe/Berlin', compact_ui=True)
        await ctx.add_init_script(INIT); await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8844/app.html'); await page.wait_for_function('window.tempo'); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(1500)
        await page.evaluate("window.tempo.run([{ cmd: 'addTask', title: 'Essay', hours: 2, deadline: '2026-10-28 17:00' }])"); await page.wait_for_timeout(2000)
        first = await page.evaluate("(async () => { const S = await import('./js/scheduler.js'); const t = window.__tempo.app.state.tasks.find(t => t.title === 'Essay'); return S.sessions(t).map(c => [c.id, c.start]); })()")
        await page.evaluate("document.querySelector('.tg-scroll').scrollTop = 300")
        await page.click('.tg-col .ev.chunk >> nth=0'); await page.wait_for_selector('.popover .done-at')
        await page.click('.popover .done-at'); await page.wait_for_selector('dialog[open] .done-at-f')
        await page.fill('dialog[open] [name=d]', '2026-10-26'); await page.fill('dialog[open] [name=a]', '03:00'); await page.dispatch_event('dialog[open] [name=a]', 'change')
        await page.fill('dialog[open] [name=b]', '04:00'); await page.dispatch_event('dialog[open] [name=b]', 'change')
        say = await page.text_content('dialog[open] .dat-say')
        await page.screenshot(path=f'{OUT}/r48-done-at.png')
        await page.click('dialog[open] button.primary'); await page.wait_for_timeout(2500)
        t = await page.evaluate("(async () => { const S = await import('./js/scheduler.js'); const t = window.__tempo.app.state.tasks.find(t => t.title === 'Essay'); return [S.sessions(t).map(c => [c.id, c.kind, new Date(c.start).toISOString(), new Date(c.end).toISOString()]), S.progress(t).done]; })()")
        moved = [s for s in t[0] if s[0] == first[0][0]]
        check('3. a session can be marked done at another time: it moves there (03:00–04:00, outside its hours) and counts as done', moved and moved[0][1] == 'done' and moved[0][2] == '2026-10-26T02:00:00.000Z' and moved[0][3] == '2026-10-26T03:00:00.000Z' and t[1] == 60 and '1h done' in say, (moved, t[1], say))
        later = [s for s in t[0] if s[1] != 'done']
        check('4. the rest of the task is still planned (1 h left)', len(later) >= 1, later)
        await page.screenshot(path=f'{OUT}/r48-after.png')
        check('no page errors', not errs, errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
print('ALL PASS' if all(ok) else f'{ok.count(False)} FAILED')
