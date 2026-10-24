# Round 39: deadline shortcuts count from "From" when set; "Starts only after…" leaves out finished tasks;
# the newspaper arranges its lower sections by height (pairs of similar height, long ones across the page in columns).
import asyncio, sys, subprocess, time, re, json
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8833','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
HABITS = [{'id': f'h{i}', 'name': f'Habit {i}', 'type': 'yesno', 'freq': {'times': 1, 'per': 'day'}, 'target': 1, 'color': '#388e3c', 'created': 0, 'log': {'2026-10-20': 1, '2026-10-21': 1}} for i in range(12)]
INIT = """
const FIX = Date.parse('2026-10-24T13:00:00Z'); const _Date = Date; globalThis.__off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false, goalNotice: false, habits: HABITS, game: {on: true, started: '2026-10-19', active: ['2026-10-24']}}));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2099-01-01'));
}""".replace('HABITS', json.dumps(HABITS))
ok = []
def check(label, cond, extra=''):
    ok.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + label, extra)

async def main():
    g = MockGoogle(); errs = []
    async with async_playwright() as p:
        b = await p.chromium.launch(); ctx = await b.new_context(viewport={'width': 1400, 'height': 900}, timezone_id='Europe/Berlin', compact_ui=False)
        await ctx.add_init_script(INIT); await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8833/app.html'); await page.wait_for_function('window.tempo'); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(2500)
        run = lambda c: page.evaluate(f"window.tempo.run({json.dumps(c)})")
        await run([{'cmd': 'addTask', 'title': 'Finished essay', 'hours': 1, 'deadline': '2026-10-30 17:00'}, {'cmd': 'addTask', 'title': 'Open report', 'hours': 2, 'deadline': '2026-10-30 17:00'}])
        await page.wait_for_timeout(1500)
        await page.evaluate("""(async () => { const S = await import('./js/scheduler.js'); const a = window.__tempo.app.state;
          a.tasks = a.tasks.map(t => { if (t.title !== 'Finished essay') return t; let x = t; for (const c of S.sessions(t).filter(c => c.kind === 'planned')) x = S.markDone(x, c.id); return x; }); })()""")
        pct = await page.evaluate("(async () => { const S = await import('./js/scheduler.js'); return S.progress(window.__tempo.app.state.tasks.find(t => t.title === 'Finished essay')).pct; })()")
        # ---- new task: "Starts only after" and deadline shortcuts
        await page.click('#btn-new-task'); await page.wait_for_selector('dialog[open] [name=title]')
        opts = await page.eval_on_selector_all('dialog[open] .after-list label', 'ls => ls.map(l => l.textContent.trim())')
        check('1. "Starts only after…" leaves out finished tasks', pct >= 100 and 'Open report' in opts and 'Finished essay' not in opts, (pct, opts))
        await page.fill('dialog[open] [name=earliest]', '2026-11-04T09:00'); await page.dispatch_event('dialog[open] [name=earliest]', 'change')
        bend = await page.evaluate("window.__tempo.app.state.settings.bounds.end")
        await page.click('dialog[open] [data-dl=week]')
        wk = await page.input_value('dialog[open] [name=deadline]')
        await page.click('dialog[open] [data-dl=day]')
        dy = await page.input_value('dialog[open] [name=deadline]')
        await page.click('dialog[open] [data-dl="2w"]')
        tw = await page.input_value('dialog[open] [name=deadline]')
        check('2. "End of work week" counts from the start date (Wed 4 Nov → Fri 6 Nov)', wk == f'2026-11-06T{bend}', wk)
        check('3. "End of work day" and "Within two weeks" too', dy == f'2026-11-04T{bend}' and tw == f'2026-11-18T{bend}', (dy, tw))
        await page.fill('dialog[open] [name=earliest]', ''); await page.dispatch_event('dialog[open] [name=earliest]', 'change')
        await page.click('dialog[open] [data-dl=week]')
        wk2 = await page.input_value('dialog[open] [name=deadline]')
        check('4. without a start date it is this work week (Sat 24 Oct → Fri 30 Oct)', wk2 == f'2026-10-30T{bend}', wk2)
        await page.keyboard.press('Escape'); await page.wait_for_timeout(300)
        # ---- newspaper layout
        await page.click('#view-seg button[data-view=review]'); await page.wait_for_timeout(3000)
        lay = await page.evaluate("""(() => { const g = document.querySelector('.np-grid'), gr = g.getBoundingClientRect();
          return [...g.querySelectorAll(':scope > section.np-flowed')].map(s => { const r = s.getBoundingClientRect(); return { c: s.className.split(' ')[0], col: s.style.gridColumn, cols: s.style.columnCount, w: Math.round(r.width / gr.width * 100), top: Math.round(r.top), h: Math.round(r.height) }; }); })()""")
        game = next((x for x in lay if x['c'] == 'np-game'), None)
        check('5. the game section is no longer squeezed into a sliver (at least half the page wide)', game and game['w'] >= 45, lay)
        rows = {}
        for x in lay: rows.setdefault(x['top'], []).append(x)
        full = all(abs(sum(x['w'] for x in r) - (100 if len(r) > 1 else r[0]['w'])) < 6 for r in rows.values())
        check('6. every row of lower sections fills the page (pairs side by side, or one across)', full and all(len(r) <= 2 for r in rows.values()), rows)
        hab = next((x for x in lay if x['c'] == 'np-habits'), None)
        check('7. the long habits section stretches across the page in columns', hab and hab['w'] > 90 and hab['cols'] in ('2', '3'), hab)
        pairs = [r for r in rows.values() if len(r) == 2]
        check('8. side-by-side sections end at about the same height', all(max(a['h'], b['h']) / max(1, min(a['h'], b['h'])) < 2.2 for a, b in pairs), [(a['c'], a['h'], b['c'], b['h']) for a, b in pairs])
        await page.screenshot(path=f'{OUT}/r39-paper.png', full_page=True)
        await page.set_viewport_size({'width': 700, 'height': 900}); await page.wait_for_timeout(600)
        one = await page.evaluate("[...document.querySelectorAll('.np-grid > section')].every(s => !s.style.gridColumn)")
        check('9. on a narrow screen it goes back to one column', one)
        check('no page errors', not errs, errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
print('ALL PASS' if all(ok) else f'{ok.count(False)} FAILED')
