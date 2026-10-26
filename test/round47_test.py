# Round 47: categories in alphabetical order; drain strength (% of the costs); road-to-300 knobs; title suggestion
# chips (also on phones); audiobook length in hours and minutes; "extend until now" on the current-time line;
# minimising the month and the game panel.
import asyncio, sys, subprocess, time, re, json
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8843','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
CATS = [{'id': 'work', 'name': 'Work', 'color': '#039be5'}, {'id': 'zumba', 'name': 'Zumba', 'color': '#e67c73'}, {'id': 'art', 'name': 'Art', 'color': '#8e24aa'}, {'id': 'study', 'name': 'Study', 'color': '#0b8043'}, {'id': 'mtg', 'name': 'Meetings', 'color': '#039be5', 'parent': 'work'}, {'id': 'adm', 'name': 'Admin', 'color': '#039be5', 'parent': 'work'}]
INIT = """
const FIX = Date.parse('2026-10-25T10:10:00Z'); const _Date = Date; globalThis.__off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false, goalNotice: false, categories: CATS, game: {on: true, started: '2026-10-12', lifeCats: ['study'], active: ['2026-10-25']}}));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2099-01-01'));
}""".replace('CATS', json.dumps(CATS))
ok = []
def check(label, cond, extra=''):
    ok.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + label, extra)
def ev(i, t, d, a, b, off='+01:00'): return {'id': i, 'summary': t, 'status': 'confirmed', 'start': {'dateTime': f'{d}T{a}:00{off}'}, 'end': {'dateTime': f'{d}T{b}:00{off}'}}
async def main():
    g = MockGoogle(); errs = []
    E = g.events['me@example.com']
    E['bf'] = ev('bf', 'Breakfast', '2026-10-25', '08:30', '10:40')
    E['yo'] = ev('yo', 'Yoga class', '2026-10-22', '18:00', '19:00', '+02:00')
    for i, d in enumerate(['2026-10-13', '2026-10-14', '2026-10-20', '2026-10-21']):
        E[f'w{i}'] = ev(f'w{i}', 'Work block', d, '09:00', '12:00', '+02:00')
    async with async_playwright() as p:
        b = await p.chromium.launch(); ctx = await b.new_context(viewport={'width': 1400, 'height': 900}, timezone_id='Europe/Berlin', compact_ui=True)
        await ctx.add_init_script(INIT); await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8843/app.html'); await page.wait_for_function('window.tempo'); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(3000)
        # 1. alphabetical
        order = await page.evaluate("(async () => { const C = await import('./js/categories.js'); return C.ordered(window.__tempo.app.state.settings).map(c => c.name); })()")
        check('1. categories are listed alphabetically, sub-categories under their main one', order == ['Art', 'Study', 'Work', 'Admin', 'Meetings', 'Zumba'], order)
        # 6. extend on the now line
        btn = await page.evaluate("(() => { const b = document.querySelector('.tonow-btn'); return b && [b.textContent, !!b.closest('.now')]; })()")
        check('2. on a computer "extend until now" sits on the current-time line', btn and 'Breakfast' in btn[0] and btn[1], btn)
        await page.screenshot(path=f'{OUT}/r47-nowline.png')
        # 4. title suggestions
        await page.evaluate("document.querySelector('.tg-scroll').scrollTop = 500")
        col = await page.eval_on_selector('.tg-col[data-day="2026-10-25"]', 'e => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top }; }')
        hh = await page.evaluate("window.__tempo.app.state.settings.hourHeight")
        await page.mouse.click(col['x'], col['y'] + 16 * hh); await page.wait_for_selector('.popover .qc'); await page.wait_for_timeout(600)
        all0 = await page.eval_on_selector_all('.popover .ts-item', 'cs => cs.filter(c => c.offsetParent).map(c => c.textContent)')
        await page.type('.popover input[name=title]', 'yo'); await page.wait_for_timeout(100)
        yo = await page.eval_on_selector_all('.popover .ts-item', 'cs => cs.map(c => c.textContent)')
        await page.click('.popover .ts-item'); v = await page.input_value('.popover input[name=title]')
        check('3. title suggestions show in a small list once you type; tapping one fills it in', all0 == [] and yo == ['Yoga class'] and v == 'Yoga class', (all0, yo, v))
        await page.click('.popover .qc-cancel')
        # 2. drain strength
        await page.evaluate("document.querySelector('#btn-settings').click()"); await page.wait_for_selector('dialog[open] .settings-form')
        await page.click('dialog[open] details[data-sect=s-game] > summary')
        await page.click('dialog[open] .add-drain'); await page.wait_for_timeout(200)
        await page.fill('dialog[open] .dr-str', '25'); await page.dispatch_event('dialog[open] .dr-str', 'input')
        say = await page.text_content('dialog[open] .dr-say')
        await page.click('dialog[open] button[type=submit]'); await page.wait_for_timeout(2500)
        d = await page.evaluate("(async () => { const GM = await import('./js/game.js'); const d = window.__tempo.app.state.settings.game.drains[0]; return [d.strength, GM.drainPct(d, 1), GM.drainPct({ ...d, strength: undefined }, 1)]; })()")
        check('4. a drain can apply only part of its costs (strength 25% → 2.5% instead of 10%)', d == [25, 2.5, 10] and '25% strength' in say, (d, say))
        # 3. road knobs
        await page.click('#game-panel .gp-more'); await page.wait_for_selector('dialog[open] .road-knobs')
        h0 = await page.text_content('dialog[open] .road-out')
        await page.select_option('dialog[open] [data-road=weeks]', '1'); await page.fill('dialog[open] [data-road=extra]', '5'); await page.dispatch_event('dialog[open] [data-road=extra]', 'input'); await page.wait_for_timeout(500)
        h1 = await page.text_content('dialog[open] .road-out')
        check('5. the road to 300 has knobs (weeks of data, extra life growth…) and redraws as you change them', 'last 4 weeks' in h0 and 'last 1 week' in h1 and '+5 h life growth' in h1 and await page.query_selector('dialog[open] .road-out svg'), (h0[:80], h1[:120]))
        await page.screenshot(path=f'{OUT}/r47-road.png')
        await page.keyboard.press('Escape'); await page.wait_for_timeout(300)
        # 5. audiobook h + m
        await page.click('#btn-new-task'); await page.wait_for_selector('dialog[open] .task-form')
        await page.click('dialog[open] label:has(input[name=kind][value=reading])'); await page.click('dialog[open] label:has(input[name=rformat][value=audio])')
        await page.fill('dialog[open] [name=title]', 'Educated'); await page.fill('dialog[open] [name=ah]', '7'); await page.fill('dialog[open] [name=am]', '45')
        await page.click('dialog[open] button[type=submit]'); await page.wait_for_timeout(2000)
        r = await page.evaluate("window.__tempo.app.state.tasks.find(t => t.title === 'Educated')?.reading")
        check('6. an audiobook\'s length can be given in hours and minutes (7 h 45 min)', r and r['pages'] == 465, r)
        # 7. minimise
        await page.click('#mini .mini-toggle'); await page.wait_for_timeout(200)
        mh = await page.evaluate("document.querySelector('#mini .mini-grid').hidden")
        await page.click('#game-panel .gp-head'); await page.wait_for_timeout(200)
        gm = await page.evaluate("document.querySelector('#game-panel').classList.contains('min')")
        await page.reload(); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(2500)
        keep = await page.evaluate("[document.querySelector('#mini .mini-grid').hidden, document.querySelector('#game-panel').classList.contains('min') && getComputedStyle(document.querySelector('#game-panel .gp-body')).display === 'none']")
        check('7. the month calendar and the game panel can be minimised (and stay so)', mh and gm and keep == [True, True], (mh, gm, keep))
        await page.screenshot(path=f'{OUT}/r47-min.png')
        await ctx.close()
        # phone: suggestions in the event dialog; no extend button on the line
        ctx = await b.new_context(**p.devices['Pixel 7'], timezone_id='Europe/Berlin')
        await ctx.add_init_script(INIT); await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8843/app.html'); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(2500)
        vis = await page.evaluate("(() => { const b = document.querySelector('.tonow-btn'); return b ? getComputedStyle(b).display : 'none'; })()")
        await page.click('#fab'); await page.wait_for_timeout(300)
        await page.click('dialog[open] .sheet-menu button:has-text("New event")'); await page.wait_for_selector('dialog[open] [name=summary]'); await page.wait_for_timeout(600)
        await page.fill('dialog[open] [name=summary]', ''); await page.type('dialog[open] [name=summary]', 'b'); await page.wait_for_timeout(300)
        chips = await page.eval_on_selector_all('dialog[open] .ts-item', 'cs => cs.filter(c => c.offsetParent).map(c => c.textContent)')
        check('8. on the phone the suggestions show in the event dialog too; the extend button stays in the + menu', vis == 'none' and 'Breakfast' in chips, (vis, chips))
        await page.screenshot(path=f'{OUT}/r47-phone.png')
        check('no page errors', not errs, errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
print('ALL PASS' if all(ok) else f'{ok.count(False)} FAILED')
