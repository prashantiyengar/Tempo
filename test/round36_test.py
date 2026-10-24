# Round 36: clean-day / clean-week bonus (no XP drain), streaks, drain cost graphs that scale with rank,
# goal-style category pickers in the game settings, 🚩 level-up flags on the calendar, game news in the paper.
import asyncio, sys, subprocess, time, re, json
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8830','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
DRAIN = {'id': 'd1', 'name': 'Gameplay', 'cats': [], 'words': ['game', 'gaming'], 'per': 'week', 'free': 0, 'tol': 2, 'basePct': 10, 'growPct': 15, 'maxPct': 75, 'types': ['app', 'busy', 'life']}
INIT = """
const FIX = Date.parse('2026-10-24T13:00:00Z'); const _Date = Date; globalThis.__off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false, goalNotice: false,
    game: {on: true, started: '2026-10-05', lifeCats: ['study'], active: ['2026-10-24'], drains: [DRAIN]}}));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2099-01-01'));
}""".replace('DRAIN', json.dumps(DRAIN))
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
    days = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']
    for i, d in enumerate(days):
        for h in [9, 10, 11, 14, 15, 16]: E[f'w{i}{h}'] = ev(f'w{i}{h}', 'Work block', d, f'{h:02d}:00', f'{h + 1:02d}:00', 'work')
    E['g1'] = ev('g1', 'Gaming', '2026-10-14', '20:00', '21:00')                       # the only drain: Wed 14 Oct
    async with async_playwright() as p:
        b = await p.chromium.launch(); ctx = await b.new_context(viewport={'width': 1400, 'height': 900}, timezone_id='Europe/Berlin', compact_ui=True)
        await ctx.add_init_script(INIT); await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8830/app.html'); await page.wait_for_function('window.tempo'); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(4500)
        gm = await page.evaluate("window.__tempo.app.state.settings.game")
        L = gm['ledger']
        check('1. clean days before the drain: 9 in a row by 13 Oct, with a bonus', L['2026-10-13'].get('cs') == 9 and L['2026-10-13'].get('cb', 0) > 0, {k: (v.get('cs'), v.get('cb')) for k, v in sorted(L.items())})
        check('2. the drain day breaks the streak; it starts again after', not L['2026-10-14'].get('cb') and L['2026-10-15'].get('cs') == 1 and L['2026-10-23'].get('cs') == 9)
        c1, c9 = L['2026-10-05'], L['2026-10-13']
        pct = lambda e: e['cb'] / (e['a'] + e['b'] + e['l'])
        check('3. the bonus grows slowly with the streak (4% → 5.6% of the day)', abs(pct(c1) - 0.04) < 0.006 and abs(pct(c9) - 0.056) < 0.006, (round(pct(c1), 3), round(pct(c9), 3)))
        W = gm['weeks']
        check('4. a week without drains earns a clean-week bonus; the week with the drain does not', W['2026-10-05'].get('cb', 0) > 0 and W['2026-10-05'].get('cs') == 1 and not W['2026-10-12'].get('cb') and W.get('2026-10-12', {}).get('cs') is None, (W['2026-10-05'].get('cb'), W['2026-10-12']))
        panel = await page.text_content('#game-panel')
        check('5. the panel shows the clean streak and what keeping today clean earns', 'Clean streak: 9 days' in panel and 'Keep today clean' in panel and 'clean' in panel, panel[:400])
        await page.screenshot(path=f'{OUT}/r36-panel.png')
        await page.click('.tg-dayhead[data-day="2026-10-23"] .xp-chip'); await page.wait_for_selector('.popover .xb')
        bd = await page.text_content('.popover .xb')
        check('6. the day breakdown shows the clean bonus', 'Clean bonus' in bd and '9 in a row' in bd, bd[-300:])
        await page.keyboard.press('Escape')
        # level flags
        ups = await page.evaluate("window.__tempo.app.gameLevelUps")
        flags = await page.evaluate("[...document.querySelectorAll('.lv-flag')].map(x => x.closest('[data-day]')?.dataset.day + ':' + x.dataset.lvflag)")
        inweek = {k: v for k, v in ups.items() if '2026-10-19' <= k <= '2026-10-25'}
        check('7. level-ups are recorded by day and flagged 🚩 on the calendar', len(ups) >= 3 and all(any(f.endswith(':' + str(v)) for f in flags) for v in inweek.values()) and (flags or not inweek), (ups, flags))
        await page.click('#view-seg button[data-view=month]'); await page.wait_for_timeout(1500)
        mflags = await page.evaluate("[...document.querySelectorAll('.lv-flag')].map(x => x.dataset.lvflag)")
        check('7b. the month view shows a 🚩 for each level reached', sorted(int(x) for x in mflags) == sorted(ups.values()), mflags)
        await page.screenshot(path=f'{OUT}/r36-flags.png')
        await page.click('#view-seg button[data-view=week]'); await page.wait_for_timeout(1000)
        # settings: graph + category pickers
        await page.evaluate("document.querySelector('#btn-settings').click()"); await page.wait_for_selector('dialog[open] .settings-form')
        await page.click('dialog[open] details[data-sect=s-game] > summary')
        svg = await page.evaluate("(() => { const s = document.querySelector('dialog[open] .dr-graph svg'); return s ? { bars: s.querySelectorAll('rect').length, text: s.textContent } : null; })()")
        gtxt = await page.text_content('dialog[open] .dr-graph')
        check('8. each drain shows a graph: what each hour costs and the clean bonus for none', svg and svg['bars'] >= 5 and 'none' in svg['text'] and '1 h' in svg['text'] and 'clean bonus' in gtxt and 'level' in gtxt, (svg, gtxt[-200:]))
        hidden0 = await page.evaluate("getComputedStyle(document.querySelector('dialog[open] .game-life .cp-grid')).display === 'none'")
        await page.click('dialog[open] .game-life .cp-open')
        vis = await page.evaluate("!document.querySelector('dialog[open] .game-life .cp-grid').hidden")
        await page.click('dialog[open] .game-life .cp-grid label.cat-chip:has(input[value=work])')
        chips = await page.text_content('dialog[open] .game-life .cp-chips')
        await page.click('dialog[open] .game-life .cp-done')
        hidden1 = await page.evaluate("getComputedStyle(document.querySelector('dialog[open] .game-life .cp-grid')).display === 'none'")
        check('9. categories are picked like for goals: a button opens chips, Done folds them away', hidden0 and vis and hidden1 and 'Work' in chips, chips)
        await page.screenshot(path=f'{OUT}/r36-settings.png')
        await page.click('dialog[open] .game-life .cp-open')
        await page.click('dialog[open] .game-life .cp-grid label.cat-chip:has(input[value=work])')  # undo
        # rank scaling: at level >= 5 a drain costs more than its base %
        lv = await page.evaluate("window.__tempo.app.gameLevelUps")
        await page.click('dialog[open] details.game-adv > summary')
        await page.fill('dialog[open] .gc-v[data-k=cleanDayPct]', '6')
        await page.click('dialog[open] button[type=submit]'); await page.wait_for_timeout(4500)
        L2 = await page.evaluate("window.__tempo.app.state.settings.game.ledger")
        check('10. changing the clean bonus counts again (6% on the first clean day)', abs(L2['2026-10-05']['cb'] / (L2['2026-10-05']['a'] + L2['2026-10-05']['b'] + L2['2026-10-05']['l']) - 0.06) < 0.006)
        sc = await page.evaluate("(async () => { const GM = await import('./js/game.js'); const s = window.__tempo.app.state.settings; return [GM.drainScale(s, 1), GM.drainScale(s, 12), GM.drainScale(s, 60), GM.drainPct(s.game.drains[0], 1, GM.drainScale(s, 60))]; })()")
        check('11. drains cost more the higher the rank (×1, ×1.06 at level 12, ×1.36 at level 60)', abs(sc[0] - 1) < 1e-9 and abs(sc[1] - 1.06) < 1e-9 and abs(sc[2] - 1.36) < 1e-6 and abs(sc[3] - 13.6) < 1e-6, sc)
        # newspaper
        await page.click('#view-seg button[data-view=review]'); await page.wait_for_timeout(2500)
        np = await page.text_content('.np-game') if await page.query_selector('.np-game') else ''
        check('12. the paper has a game news section: level, rank, XP, clean streak', 'Level' in np and 'XP' in np and 'clean' in np and await page.query_selector('.np-game svg') is not None, np[:300])
        await page.screenshot(path=f'{OUT}/r36-paper.png', full_page=True)
        check('no page errors', not errs, errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
print('ALL PASS' if all(ok) else f'{ok.count(False)} FAILED')
