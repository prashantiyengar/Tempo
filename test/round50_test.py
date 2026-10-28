# Round 50: bigger day marks on phones with how full the day is (% of the day, and % of work hours); covers can be
# changed from the Bookcase without re-planning; syncing a large backlog goes in prioritised, throttled batches.
import asyncio, sys, subprocess, time, re, json
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8846','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
INIT = """
const FIX = Date.parse('2026-10-26T05:00:00Z'); const _Date = Date; globalThis.__off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false, goalNotice: false, syncTasksToGoogle: true, game: {on: true, started: '2026-10-20', active: ['2026-10-26']}}));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2099-01-01'));
}"""
ok = []
def check(label, cond, extra=''):
    ok.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + label, extra)
def ev(i, t, d, a, b): return {'id': i, 'summary': t, 'status': 'confirmed', 'start': {'dateTime': f'{d}T{a}:00+01:00'}, 'end': {'dateTime': f'{d}T{b}:00+01:00'}}
async def main():
    g = MockGoogle(); errs = []
    E = g.events['me@example.com']
    E['m'] = ev('m', 'Meeting block', '2026-10-27', '09:00', '13:00')
    E['e'] = ev('e', 'Dinner', '2026-10-27', '19:00', '21:00')
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1400, 'height': 900}, timezone_id='Europe/Berlin', compact_ui=True)
        await ctx.add_init_script(INIT); await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8846/app.html'); await page.wait_for_function('window.tempo'); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(2000)
        fill = await page.evaluate("(() => { const f = document.querySelector('.tg-dayhead[data-day=\"2026-10-27\"] .day-fill'); return f && [f.textContent, f.title]; })()")
        check('1. each day shows how full it is: % of the 24 hours (and of the work hours)', fill and fill[0] == '25% (50%)', fill)
        # ---- sync in batches
        await page.evaluate("window.tempo.run([{ cmd: 'addTask', title: 'Big project', hours: 40, deadline: '2026-11-20 17:00' }])")
        st1 = None
        for _ in range(300):  # (up to a minute: the first batch is slow when the machine is busy)
            await page.wait_for_timeout(200)
            cur = await page.evaluate("(async () => { const S = await import('./js/scheduler.js'); const t = window.__tempo.app.state.tasks.find(t => t.title === 'Big project'); if (!t) return null; const ss = S.sessions(t); return [ss.length, ss.filter(c => c.gid).length, ss.filter(c => c.gid).every(c => ss.filter(x => !x.gid).every(x => x.start >= c.start)), document.querySelector('#sync-status').textContent]; })()")
            if cur and 'more soon' in cur[3]: st1 = cur; break
        check('2. a big backlog is synced in batches, soonest first (25 now, the rest a moment later)', st1 and st1[0] >= 35 and st1[1] == 25 and st1[2] and 'more soon' in st1[3], st1)
        await page.wait_for_timeout(16000)
        st2 = await page.evaluate("(async () => { const S = await import('./js/scheduler.js'); const t = window.__tempo.app.state.tasks.find(t => t.title === 'Big project'); const ss = S.sessions(t); return [ss.length, ss.filter(c => c.gid).length, document.querySelector('#sync-status').textContent]; })()")
        n_on_google = len([e for e in E.values() if e.get('extendedProperties', {}).get('private', {}).get('taskId')])
        check('3. …and the next batch follows by itself until everything is on Google', st2[1] == st2[0] and n_on_google == st2[0] and 'more soon' not in st2[2], (st2, n_on_google))
        # ---- cover from the bookcase
        await page.evaluate("window.tempo.run([{ cmd: 'addTask', title: 'Dune', pages: 120, deadline: '2026-11-05 17:00' }])"); await page.wait_for_timeout(2500)
        before = await page.evaluate("(async () => { const S = await import('./js/scheduler.js'); const t = window.__tempo.app.state.tasks.find(t => t.title === 'Dune'); return S.sessions(t).map(c => [c.id, c.start]); })()")
        await page.click('#task-list .lib-open'); await page.wait_for_selector('dialog[open] .bookcase')
        await page.click('dialog[open] .bc-book:has-text("Dune")'); await page.wait_for_selector('dialog[open] .cover-f')
        await page.fill('dialog[open] .cover-f [name=isbn]', '9780441172719')
        await page.screenshot(path=f'{OUT}/r50-cover.png')
        await page.click('dialog[open] .cover-f button.primary'); await page.wait_for_timeout(1500)
        after = await page.evaluate("(async () => { const S = await import('./js/scheduler.js'); const t = window.__tempo.app.state.tasks.find(t => t.title === 'Dune'); return [t.reading.isbn, S.sessions(t).map(c => [c.id, c.start])]; })()")
        check('4. a book\'s cover (ISBN or image) can be changed from the Bookcase — the reading plan stays as it was', after[0] == '9780441172719' and after[1] == before, (after[0], len(before)))
        await ctx.close()
        # ---- phone: bigger marks
        ctx = await b.new_context(**p.devices['Pixel 7'], timezone_id='Europe/Berlin')
        await ctx.add_init_script(INIT); await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8846/app.html'); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(2500)
        sz = await page.evaluate("""(() => { const q = (s) => document.querySelector(s); const fs = (e) => e ? parseFloat(getComputedStyle(e).fontSize) : 0;
          return [fs(q('.xp-chip')), fs(q('.dm-rate')), fs(q('.day-fill')), q('.day-fill')?.textContent]; })()""")
        check('5. on the phone the XP chip, the rating smiley and the fill are bigger', sz[0] >= 12 and sz[1] >= 18 and sz[2] >= 11, sz)
        await page.screenshot(path=f'{OUT}/r50-phone.png')
        check('no page errors', not errs, errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
print('ALL PASS' if all(ok) else f'{ok.count(False)} FAILED')
