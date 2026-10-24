# Round 37: a project's category for its tasks and events; XP-drain categories never score; habits in or out of
# the game, with streak rewards that grow with rank; slower clean bonus with a cap by rank; bonus activities and
# drains for a period (next week / two weeks / month / 3 months / custom).
import asyncio, sys, subprocess, time, re, json
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8831','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
DRAIN = {'id': 'd1', 'name': 'Gameplay', 'cats': ['leisure'], 'words': ['gaming'], 'per': 'week', 'free': 0, 'tol': 2, 'basePct': 10, 'growPct': 15, 'maxPct': 75, 'types': ['app', 'busy', 'life']}
LOG = {f'2026-10-{d:02d}': 1 for d in range(15, 25)}
HABITS = [{'id': 'h1', 'name': 'Read', 'type': 'yesno', 'freq': {'times': 1, 'per': 'day'}, 'target': 1, 'color': '#388e3c', 'created': 0, 'log': LOG},
          {'id': 'h2', 'name': 'Water', 'type': 'yesno', 'freq': {'times': 1, 'per': 'day'}, 'target': 1, 'color': '#039be5', 'created': 0, 'log': LOG, 'game': False}]
INIT = """
const FIX = Date.parse('2026-10-24T13:00:00Z'); const _Date = Date; globalThis.__off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false, goalNotice: false, habits: HABITS,
    game: {on: true, started: '2026-10-12', lifeCats: ['study'], active: ['2026-10-24'], drains: [DRAIN]}}));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2099-01-01'));
}""".replace('DRAIN', json.dumps(DRAIN)).replace('HABITS', json.dumps(HABITS))
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
    for i, d in enumerate(['2026-10-13', '2026-10-14', '2026-10-20', '2026-10-21', '2026-10-22']):
        for h in [9, 10, 14]: E[f'w{i}{h}'] = ev(f'w{i}{h}', 'Work block', d, f'{h:02d}:00', f'{h + 1:02d}:00', 'work')
    E['l1'] = ev('l1', 'Movie night', '2026-10-21', '20:00', '22:00', 'leisure')      # a drain category
    E['t1'] = ev('t1', 'Thesis writing', '2026-10-24', '09:00', '11:00')               # today, a bonus activity (later)
    async with async_playwright() as p:
        b = await p.chromium.launch(); ctx = await b.new_context(viewport={'width': 1400, 'height': 900}, timezone_id='Europe/Berlin', compact_ui=True)
        await ctx.add_init_script(INIT); await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8831/app.html'); await page.wait_for_function('window.tempo'); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(4000)
        GM = "const GM = await import('./js/game.js'); const s = window.__tempo.app.state.settings;"
        # ---- 1. project category
        await page.click('#btn-new-project'); await page.wait_for_selector('dialog[open] .project-form')
        await page.fill('dialog[open] [name=name]', 'Thesis')
        await page.select_option('dialog[open] [name=catId]', 'study')
        await page.click('dialog[open] .pj-add[data-kind=task]'); await page.fill('dialog[open] .pj-step[data-i="0"] .ps-title', 'Literature review')
        await page.fill('dialog[open] .pj-step[data-i="0"] .ps-sd', '2026-10-26'); await page.fill('dialog[open] .pj-step[data-i="0"] .ps-ed', '2026-10-30')
        await page.click('dialog[open] .pj-add[data-kind=event]'); await page.fill('dialog[open] .pj-step[data-i="1"] .ps-title', 'Meet supervisor')
        await page.fill('dialog[open] .pj-step[data-i="1"] .ps-sd', '2026-10-31'); await page.fill('dialog[open] .pj-step[data-i="1"] .ps-ed', '2026-10-31')
        await page.screenshot(path=f'{OUT}/r37-project.png')
        await page.click('dialog[open] button[type=submit]'); await page.wait_for_timeout(2500)
        t = await page.evaluate("window.__tempo.app.state.tasks.find(t => t.projectId)")
        meet = [e for e in E.values() if e.get('summary') == 'Thesis: Meet supervisor']
        check('1. the project\'s category goes on its tasks and events', t and t['categoryId'] == 'study' and meet and meet[0]['extendedProperties']['private'].get('tempoCategory') == 'study' and meet[0]['extendedProperties']['private'].get('tempoProject'), (t and t.get('categoryId'), meet[:1]))
        pj = await page.evaluate("window.__tempo.app.state.settings.projects[0].catId")
        check('1b. the project remembers its category', pj == 'study', pj)
        # ---- 2. drain categories never score
        x = await page.evaluate("(async () => { " + GM + " return GM.itemXP({ kind: 'event', title: 'Movie night', start: Date.parse('2026-10-21T18:00:00Z'), end: Date.parse('2026-10-21T20:00:00Z'), catId: 'leisure' }, s); })()")
        check('2. an event in a drain category earns nothing', x['busy'] == 0 and x['life'] == 0 and x.get('drain') and 'never scores' in x['why'][0], x)
        # ---- 3. habits: in / out of the game, streak rewards
        lines = await page.evaluate("window.__tempo.app.gameToday.lines.map(l => l[0])")
        check('3. a habit in the game earns XP and a streak reward; one left out earns nothing', 'habit: Read' in lines and any(l.startswith('habit streak: Read (10 days') for l in lines) and not any('Water' in l for l in lines), lines)
        hr = await page.evaluate("(async () => { " + GM + " return [GM.habitReward(s, 7, 0), GM.habitReward(s, 7, 10), GM.habitReward(s, 30, 10), GM.habitReward(s, 20, 0)]; })()")
        check('3b. streak rewards are small and grow with rank (milestone 20 → 28 at rank 10; 1 XP a day, up to 6 at the first rank)', hr[0]['milestone'] == 20 and hr[1]['milestone'] == 28 and hr[2]['milestone'] == 56 and hr[3]['xp'] == 6 and hr[0]['xp'] == 6 and hr[1]['xp'] == 8, hr)
        await page.click('#view-seg button[data-view=goals]'); await page.wait_for_timeout(1000)
        await page.click('.g-habits .hb-add'); await page.wait_for_selector('dialog[open] .habit-form')
        has = await page.is_checked('dialog[open] [name=hgame]')
        await page.fill('dialog[open] [name=name]', 'Stretch'); await page.uncheck('dialog[open] [name=hgame]')
        await page.click('dialog[open] button[type=submit]'); await page.wait_for_timeout(800)
        hs = await page.evaluate("window.__tempo.app.state.settings.habits.find(h => h.name === 'Stretch')")
        check('3c. the habit dialog has a game-mode switch (on by default)', has and hs and hs.get('game') is False, hs)
        await page.click('#view-seg button[data-view=week]'); await page.wait_for_timeout(800)
        # ---- 4. clean bonus caps
        cap = await page.evaluate("(async () => { " + GM + " return [GM.cleanCap(s, 1), GM.cleanCap(s, 50), GM.cleanCap(s, 300), GM.cleanPct(4, 0.2, 30, GM.cleanCap(s, 1))]; })()")
        check('4. the clean bonus grows slowly and its cap rises with rank (6% → 8.5% at level 50, never above 15%)', cap == [6, 8.5, 15, 6], cap)
        # ---- 5. bonus activity for the next two weeks; the drain only for the next week
        await page.evaluate("document.querySelector('#btn-settings').click()"); await page.wait_for_selector('dialog[open] .settings-form')
        await page.click('dialog[open] details[data-sect=s-game] > summary')
        auto = await page.text_content('dialog[open] .gn-auto')
        check('5. the settings say drain categories never score', 'Leisure' in auto, auto)
        await page.click('dialog[open] .add-boost'); await page.wait_for_timeout(200)
        await page.fill('dialog[open] .bo-name', 'Thesis sprint'); await page.fill('dialog[open] .bo-words', 'thesis')
        say = await page.text_content('dialog[open] .boost .pr-say')
        await page.select_option('dialog[open] .drain .pr-kind', '1w'); await page.wait_for_timeout(100)
        dsay = await page.text_content('dialog[open] .drain .pr-say')
        check('5b. a new bonus counts for the next two weeks; the drain can be set for the next week', 'until Fri, Nov 6' in say and '14 days left' in say and 'until Fri, Oct 30' in dsay, (say, dsay))
        opts = await page.eval_on_selector_all('dialog[open] .boost .pr-kind option', 'os => os.map(o => o.textContent)')
        check('5c. periods offered: always, next week, two weeks, month, 3 months, custom', opts == ['Always', 'Next week', 'Next two weeks', 'Next month', 'Next 3 months', 'Custom period'], opts)
        await page.screenshot(path=f'{OUT}/r37-periods.png')
        await page.click('dialog[open] button[type=submit]'); await page.wait_for_timeout(4500)
        gm = await page.evaluate("window.__tempo.app.state.settings.game")
        check('5d. stored with their dates', gm['boosts'][0]['from'] == '2026-10-24' and gm['boosts'][0]['to'] == '2026-11-07' and gm['drains'][0]['from'] == '2026-10-24' and gm['drains'][0]['to'] == '2026-10-31', (gm['boosts'], gm['drains'][0].get('from'), gm['drains'][0].get('to')))
        x2 = await page.evaluate("(async () => { " + GM + " const it = (d) => ({ kind: 'event', title: 'Thesis writing', start: Date.parse(d + 'T07:00:00Z'), end: Date.parse(d + 'T09:00:00Z') }); return [GM.itemXP(it('2026-10-24'), s, Date.parse('2026-12-01')), GM.itemXP(it('2026-11-10'), s, Date.parse('2026-12-01'))]; })()")
        check('5e. the bonus activity earns 50% more while it lasts, and not after', x2[0]['busy'] == round(x2[1]['busy'] * 1.5) and any('bonus: Thesis sprint +50%' in w for w in x2[0]['why']), x2)
        dr = await page.evaluate("window.__tempo.app.gameDrain")
        mv = await page.evaluate("(async () => { " + GM + " return GM.itemXP({ kind: 'event', title: 'Movie night', start: Date.parse('2026-10-21T18:00:00Z'), end: Date.parse('2026-10-21T20:00:00Z'), catId: 'leisure' }, s); })()")
        check('5f. before the drain\'s period, the movie neither costs nor is blocked', dr['total'] == 0 and mv['busy'] > 0, (dr, mv))
        # custom period
        await page.evaluate("document.querySelector('#btn-settings').click()"); await page.wait_for_selector('dialog[open] .settings-form')
        await page.click('dialog[open] details[data-sect=s-game] > summary')
        await page.select_option('dialog[open] .boost .pr-kind', 'custom')
        await page.fill('dialog[open] .boost input.pr-from', '2026-11-01'); await page.fill('dialog[open] .boost input.pr-to', '2026-11-30'); await page.dispatch_event('dialog[open] .boost input.pr-to', 'change')
        csay = await page.text_content('dialog[open] .boost .pr-say')
        await page.click('dialog[open] button[type=submit]'); await page.wait_for_timeout(3000)
        b0 = await page.evaluate("window.__tempo.app.state.settings.game.boosts[0]")
        check('5g. a custom period: 1–30 Nov', b0['from'] == '2026-11-01' and b0['to'] == '2026-12-01' and b0['period'] == 'custom' and 'From Sun, Nov 1 until Mon, Nov 30' in csay, (b0, csay))
        check('no page errors', not errs, errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
print('ALL PASS' if all(ok) else f'{ok.count(False)} FAILED')
