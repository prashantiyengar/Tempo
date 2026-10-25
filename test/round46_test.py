# Round 46: "extend until now" from the item's own popup, and only ever for the latest item; life-growth categories
# can count less (e.g. Study at 50%); finishing tasks/projects gives life XP once, on the day; event title suggestions
# from the last 7 days' events.
import asyncio, sys, subprocess, time, re, json
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8842','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
INIT = """
const FIX = Date.parse('2026-10-25T10:10:00Z'); const _Date = Date; globalThis.__off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false, goalNotice: false, game: {on: true, started: '2026-10-19', lifeCats: ['study'], active: ['2026-10-25']}}));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2099-01-01'));
}"""
ok = []
def check(label, cond, extra=''):
    ok.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + label, extra)
def ev(i, t, d, a, b, off='+01:00'): return {'id': i, 'summary': t, 'status': 'confirmed', 'start': {'dateTime': f'{d}T{a}:00{off}'}, 'end': {'dateTime': f'{d}T{b}:00{off}'}}
async def main():
    g = MockGoogle(); errs = []
    E = g.events['me@example.com']
    E['cf'] = ev('cf', 'Coffee', '2026-10-25', '07:00', '07:30')
    E['bf'] = ev('bf', 'Breakfast', '2026-10-25', '08:30', '10:40')
    E['yo'] = ev('yo', 'Yoga class', '2026-10-22', '18:00', '19:00', '+02:00')
    E['ol'] = ev('ol', 'Old thing', '2026-10-15', '18:00', '19:00', '+02:00')
    async with async_playwright() as p:
        b = await p.chromium.launch(); ctx = await b.new_context(viewport={'width': 1400, 'height': 900}, timezone_id='Europe/Berlin', compact_ui=True)
        await ctx.add_init_script(INIT); await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8842/app.html'); await page.wait_for_function('window.tempo'); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(2500)
        blk = lambda t: f'.tg-col .ev:has-text("{t}")'
        await page.click(blk('Breakfast')); await page.wait_for_selector('.popover')
        has = await page.is_visible('.popover .to-now')
        await page.click('.popover .to-now'); await page.wait_for_timeout(2000)
        check('1. the last event\'s popup offers "Extend until now", which makes it end now', has and E['bf']['end']['dateTime'].startswith('2026-10-25T10:10:00'), (has, E['bf']['end']))
        await page.click(blk('Coffee')); await page.wait_for_selector('.popover')
        c1 = await page.is_visible('.popover .to-now'); fl = await page.evaluate("!!document.querySelector('.tonow-btn')")
        await page.keyboard.press('Escape')
        check('2. right after extending, nothing earlier is offered instead (not Coffee)', not c1 and not fl, (c1, fl))
        await page.evaluate("globalThis.__off += 5 * 60000; window.__tempo.render()"); await page.wait_for_timeout(800)
        t2 = await page.evaluate("document.querySelector('.tonow-btn')?.textContent || ''")
        check('3. a few minutes later it\'s the extended event again (Breakfast), never the one before', 'Breakfast' in t2, t2)
        # 4. title suggestions
        await page.evaluate("document.querySelector('.tg-scroll').scrollTop = 500")
        col = await page.eval_on_selector('.tg-col[data-day="2026-10-25"]', 'e => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top }; }')
        hh = await page.evaluate("window.__tempo.app.state.settings.hourHeight")
        await page.mouse.click(col['x'], col['y'] + 16 * hh); await page.wait_for_selector('.popover .qc'); await page.wait_for_timeout(500)
        lst = [None, await page.eval_on_selector_all('.popover .ts-chip', 'cs => cs.map(c => c.textContent)')]
        await page.fill('.popover input[name=title]', 'o'); await page.wait_for_timeout(100)
        lst2 = await page.eval_on_selector_all('.popover .ts-chip', 'cs => cs.map(c => c.textContent)')
        check('4. typing an event title suggests the last 7 days\' event titles (most recent first)', lst[1][:1] == ['Breakfast'] and 'Yoga class' in lst[1] and 'Coffee' in lst[1] and 'Old thing' not in lst[1] + lst2, (lst, lst2))
        await page.click('.popover .qc-cancel')
        # 5. life weights
        await page.evaluate("document.querySelector('#btn-settings').click()"); await page.wait_for_selector('dialog[open] .settings-form')
        await page.click('dialog[open] details[data-sect=s-game] > summary')
        await page.fill('dialog[open] .glw[data-id=study]', '50')
        await page.screenshot(path=f'{OUT}/r46-weights.png')
        await page.click('dialog[open] button[type=submit]'); await page.wait_for_timeout(2500)
        w = await page.evaluate("""(async () => { const GM = await import('./js/game.js'); const s = window.__tempo.app.state.settings;
          const it = { kind: 'event', title: 'Spanish', catId: 'study', start: Date.parse('2026-10-24T17:00:00Z'), end: Date.parse('2026-10-24T18:00:00Z') };
          return [s.game.lifeWeights, GM.itemXP(it, s, Date.now()).life, GM.itemXP(it, s, Date.now()).why]; })()""")
        check('5. a life-growth category can count less: Study at 50% → 25 life XP for an hour (not 50)', w[0] == {'study': 50} and w[1] == 25 and 'life growth ×0.5' in w[2], w)
        # 6. finishing: life XP once, on the day it was first finished
        f = await page.evaluate("""(async () => { const GM = await import('./js/game.js'); const s = { ...window.__tempo.app.state.settings, game: { ...window.__tempo.app.state.settings.game, doneOn: { 't:x': '2026-10-20' } } };
          const ctx = { items: [], tasks: [{ id: 'x', title: 'Essay', created: 0, _finishedAt: Date.parse('2026-10-23T10:00:00Z'), _sessions: 4 }], projects: [], projectsDone: [], habits: [], goalsAll: [], history: [] };
          const l = (k) => GM.dayXP(k, s, ctx, Date.parse('2026-10-25T10:00:00Z')).lines.filter(x => x[0].includes('Essay')).map(x => [x[1], x[2]]);
          return [l('2026-10-20'), l('2026-10-23')]; })()""")
        check('6. finishing a task gives busy and life XP on the day it was first finished — and never again', len(f[0]) == 2 and f[0][1] == ['life', 18] and f[1] == [], f)
        check('no page errors', not errs, errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
print('ALL PASS' if all(ok) else f'{ok.count(False)} FAILED')
