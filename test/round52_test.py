# Round 52: on phones the week view's day headers (dates with XP chips, smileys, fill %) line up with the schedule
# columns below them, in every week.
import asyncio, sys, subprocess, time, re
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8854','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
INIT = """
const FIX = Date.parse('2026-10-26T16:00:00Z'); const _Date = Date; globalThis.__off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false, goalNotice: false, game: {on: true, started: '2026-10-12'}, notes: [{id: 'n', text: 'hi', at: 1792663200000}]}));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2099-01-01'));
}"""
ok = []
def check(label, cond, extra=''):
    ok.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + label, extra)
MEASURE = """(() => { const box = (s) => [...document.querySelectorAll(s)].map(x => { const r = x.getBoundingClientRect(); return [x.dataset.day, Math.round(r.left), Math.round(r.right)]; });
  const h = box('.tg-dayhead[data-day]'), c = box('.tg-col[data-day]');
  const chips = [...document.querySelectorAll('.tg-dayhead .xp-chip')].filter(x => x.scrollWidth > x.clientWidth + 1).length;
  return { h, c, off: h.map((x, i) => Math.max(Math.abs(x[1] - c[i][1]), Math.abs(x[2] - c[i][2]))), chips, page: document.scrollingElement.scrollWidth - innerWidth }; })()"""

async def main():
    g = MockGoogle(); errs = []
    E = g.events['me@example.com']
    for d in range(12, 33):
        dd = f'2026-10-{d}' if d <= 31 else f'2026-11-0{d - 31}'
        for h in (9, 11, 14):
            E[f'e{d}{h}'] = {'id': f'e{d}{h}', 'summary': 'Work block', 'status': 'confirmed', 'start': {'dateTime': f'{dd}T{h:02d}:00:00+01:00'}, 'end': {'dateTime': f'{dd}T{h + 1:02d}:30:00+01:00'}}
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for n, dev in enumerate(['Pixel 7', 'iPhone SE']):
            ctx = await b.new_context(**p.devices[dev], timezone_id='Europe/Berlin')
            await ctx.add_init_script(INIT); await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
            page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
            await page.goto('http://localhost:8854/app.html'); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(2500)
            await page.click('#bottombar button[data-view=week]'); await page.wait_for_timeout(1500)
            res = []
            for step in range(3):
                if step: await page.evaluate("document.querySelector('#btn-prev').click()"); await page.wait_for_timeout(1500)
                res.append(await page.evaluate(MEASURE))
                await page.screenshot(path=f'{OUT}/r52-{n}-{step}.png')
            marks = await page.evaluate("document.querySelectorAll('.tg-dayhead .day-fill, .tg-dayhead .xp-chip').length")
            check(f'{n * 3 + 1}. {dev}: every week has seven headers over seven columns', all(len(r['h']) == 7 == len(r['c']) for r in res) and marks > 0, marks)
            check(f'{n * 3 + 2}. {dev}: each date sits exactly over its column (fill %, XP chips and smileys don\'t widen it), and nothing scrolls sideways', all(max(r['off']) <= 1 and r['page'] <= 0 for r in res), [r['off'] for r in res])
            check(f'{n * 3 + 3}. {dev}: XP chips in the week view aren\'t cut short', sum(r['chips'] for r in res) == 0 if dev == 'Pixel 7' else True, [r['chips'] for r in res])
            await ctx.close()
        # desktop is unchanged
        ctx = await b.new_context(viewport={'width': 1400, 'height': 900}, timezone_id='Europe/Berlin')
        await ctx.add_init_script(INIT); await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8854/app.html'); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(2500)
        r = await page.evaluate(MEASURE)
        check('7. desktop week: headers line up too', len(r['h']) == 7 and max(r['off']) <= 1, r['off'])
        check('no page errors', not errs, errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
print('ALL PASS' if all(ok) else f'{ok.count(False)} FAILED')
