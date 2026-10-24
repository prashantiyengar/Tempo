# Round 40: winning back XP lost to drains (5 clean days → 75%, 10 → all + 5%, in trust day by day, one more day
# each time); the hours a drain watches; the hours automatic habits and goal rules look at (advanced); the time
# periods editor moves "to" with "from"; a Google Keep shortcut in the sidebar.
import asyncio, sys, subprocess, time, re, json
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8835','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
DRAIN = {'id': 'd1', 'name': 'Gameplay', 'cats': [], 'words': ['gaming'], 'per': 'week', 'free': 0, 'tol': 2, 'basePct': 10, 'growPct': 15, 'maxPct': 75, 'types': ['app', 'busy', 'life']}
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
    import datetime
    d0 = datetime.date(2026, 10, 5)
    for i in range(19):
        d = (d0 + datetime.timedelta(i)).isoformat()
        for h in [9, 10, 14]: E[f'w{i}{h}'] = ev(f'w{i}{h}', 'Work block', d, f'{h:02d}:00', f'{h + 1:02d}:00', 'work')
    E['g1'] = ev('g1', 'Gaming', '2026-10-07', '19:00', '22:00')          # 3 h: a drain day
    E['g2'] = ev('g2', 'Gaming', '2026-10-20', '20:00', '21:00')          # a second drain day
    async with async_playwright() as p:
        b = await p.chromium.launch(); ctx = await b.new_context(viewport={'width': 1400, 'height': 900}, timezone_id='Europe/Berlin', compact_ui=True)
        await ctx.add_init_script(INIT); await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        await ctx.route(re.compile(r'https://(keep\.new|keep\.google\.com)/.*'), lambda r: r.fulfill(body='<title>Keep</title>keep', content_type='text/html'))
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8835/app.html'); await page.wait_for_function('window.tempo'); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(4500)
        GM = "const GM = await import('./js/game.js'); const s = window.__tempo.app.state.settings;"
        rec = await page.evaluate("window.__tempo.app.gameRecover")
        by = rec['byDay']
        L = await page.evaluate("window.__tempo.app.state.settings.game.weeks['2026-10-05'].drain")
        d12 = sum(x[1] for x in by.get('2026-10-12', [])); paid5 = sum(x[1] for k in sorted(by) if k <= '2026-10-12' for x in by[k])
        check('1. after a drain, 5 clean days in a row win back 75% (a share each day)', L > 0 and abs(paid5 - round(L * 0.75)) <= 1 and len([k for k in by if '2026-10-08' <= k <= '2026-10-12']) == 5, (L, paid5, {k: by[k] for k in sorted(by)[:6]}))
        tot1 = sum(x[1] for k in sorted(by) if k <= '2026-10-17' for x in by[k])
        check('2. 10 clean days win back all of it plus a 5% bonus', abs(tot1 - round(L * 1.05)) <= 1 and any('bonus' in x[0] for x in by.get('2026-10-17', [])), (tot1, by.get('2026-10-17')))
        a = rec['active']
        check('3. the next drain needs one more day: 6 for 75%, 11 for all — 3 clean days so far', a and a['N1'] == 6 and a['N2'] == 11 and a['n'] == 3 and a['inTrust'] > 0, a)
        panel = await page.text_content('#game-panel')
        check('4. the panel says what can be won back and how many days are left', 'Win back' in panel and '3 of 6 clean days' in panel and '3 days left' in panel and 'in trust' in panel and 'won back' in panel, panel[:500])
        await page.screenshot(path=f'{OUT}/r40-panel.png')
        brk = await page.evaluate("(async () => { " + GM + """ const days = [{k:'a', drain:true, loss:100}, {k:'b', loss:0}, {k:'c', loss:0}, {k:'d', loss:0}, {k:'e', drain:true, loss:40}];
          const r1 = GM.recovery(s, days);
          const days2 = [{k:'a', drain:true, loss:100}, ...'bcdefgh'.split('').map(k => ({k, loss:0})), {k:'i', drain:true, loss:0}];
          const r2 = GM.recovery(s, days2); return [r1.total, r1.byDay.e, r2.total, r2.byDay.i]; })()""")
        check('5. a drain before day 5 takes back everything in trust; after day 5 the 75% is kept', brk[0] == 0 and brk[1][0][1] == -45 and brk[2] == 75 and brk[3][0][1] == -10, brk)
        # ---- drain scope
        sc = await page.evaluate("(async () => { " + GM + """ const it = (d, h0, h1) => ({ kind: 'event', title: 'Gaming', start: Date.parse(`${d}T${h0}:00+02:00`), end: Date.parse(`${d}T${h1}:00+02:00`) });
          const d = { ...s.game.drains[0], scope: 'bounds' }, items = [it('2026-10-22', '20:00', '22:00'), it('2026-10-23', '12:00', '13:00')];
          const hrs = GM.drainHours(d, s, items, '2026-10-22', '2026-10-24', Date.now()); return hrs; })()""")
        check('6. a drain watching only the work hours ignores evening gaming', sc.get('2026-10-22') == 0 and sc.get('2026-10-23') == 1, sc)
        # ---- habit / goal scope
        hs = await page.evaluate("""(async () => { const HB = await import('./js/habits.js'), GL = await import('./js/goals.js'); const s = window.__tempo.app.state.settings;
          const it = (d, h0, h1) => ({ kind: 'event', title: 'Reading', catId: 'study', start: Date.parse(`${d}T${h0}:00+02:00`), end: Date.parse(`${d}T${h1}:00+02:00`) });
          const items = [it('2026-10-22', '10:00', '11:00'), it('2026-10-23', '20:00', '21:00')];
          const h = { id: 'hx', name: 'Read at night', type: 'yesno', freq: { times: 1, per: 'day' }, created: 0, log: {}, auto: { mode: 'hours', cats: ['study'], op: 'atLeast', hours: 1, per: 'day', from: '2026-10-20', scope: 'outside' } };
          const r = HB.applyAuto(h, items, ['2026-10-22', '2026-10-23'], s, Date.now());
          const g = { text: 'Read 1 h after hours', rule: { op: 'atLeast', hours: 1.5, per: 'period', cats: ['study'], scope: 'outside' } };
          const st = GL.ruleStatus(g, s, items, '2026-10-19', '2026-10-26', Date.now());
          const st2 = GL.ruleStatus({ ...g, rule: { ...g.rule, scope: undefined } }, s, items, '2026-10-19', '2026-10-26', Date.now());
          return [r.autoLog, st.text, st2.text]; })()""")
        check('7. a habit counting only “after hours” ticks the evening reading, not the morning one', hs[0] == {'2026-10-22': 0, '2026-10-23': 1}, hs[0])
        check('8. a goal rule counting only “after hours” counts 1 h of the 2 h', hs[1].startswith('1 h of') and hs[2].startswith('2 h of'), hs[1:])
        # ---- UI: drain advanced, habit advanced, goal rule advanced
        await page.evaluate("document.querySelector('#btn-settings').click()"); await page.wait_for_selector('dialog[open] .settings-form')
        await page.click('dialog[open] details[data-sect=s-game] > summary')
        closed = await page.evaluate("!document.querySelector('dialog[open] .drain details.dr-adv').open")
        await page.click('dialog[open] .drain details.dr-adv > summary')
        opts = await page.eval_on_selector_all('dialog[open] .dr-scope option', 'os => os.map(o => o.value)')
        await page.select_option('dialog[open] .dr-scope', 'bounds')
        # periods editor: a new rule 10:00–18:00, start at 18:00 → ends 19:00
        await page.click('dialog[open] .settings-tabs button:nth-child(2), dialog[open] [data-tab="1"]') if await page.query_selector('dialog[open] [data-tab="1"]') else None
        await page.evaluate("document.querySelectorAll('dialog[open] [data-pane]').forEach(p => p.hidden = false)")
        await page.click('dialog[open] details[data-sect=s-periods] > summary')
        await page.click('dialog[open] .add-period'); await page.wait_for_timeout(100)
        await page.locator('dialog[open] .period').last.locator('.per-add-rule').click(); await page.wait_for_timeout(100)
        per = page.locator('dialog[open] .period').last
        rl = per.locator('.per-rule').last
        await rl.locator('.r-start').fill('18:00'); await rl.locator('.r-start').dispatch_event('change')
        end = await rl.locator('.r-end').input_value()
        r0 = per.locator('.per-rule').first
        s0 = await r0.locator('.r-start').input_value(); e0 = await r0.locator('.r-end').input_value()
        await r0.locator('.r-start').fill('18:00'); await r0.locator('.r-start').dispatch_event('change')
        e0b = await r0.locator('.r-end').input_value()
        check('9. time periods: setting “from” to 18:00 sets “to” to 19:00 (or keeps a close end)', end == '19:00' and (e0b == e0 if e0 > '18:00' and e0 <= '21:00' else e0b == '19:00'), (end, s0, e0, e0b))
        await page.click('dialog[open] details[data-sect=s-display] > summary'); await page.check('dialog[open] [name=keepOn]')
        await page.click('dialog[open] button[type=submit]'); await page.wait_for_timeout(3500)
        d1 = await page.evaluate("window.__tempo.app.state.settings.game.drains[0].scope")
        check('10. the drain\'s hours sit in a closed “Advanced” block and are saved', closed and opts[:4] == ['', 'bounds', 'outside', 'waking'] and any(o.startswith('period:') for o in opts) and d1 == 'bounds', (closed, opts, d1))
        await page.click('#view-seg button[data-view=goals]'); await page.wait_for_timeout(800)
        await page.click('.g-habits .hb-add'); await page.wait_for_selector('dialog[open] .habit-form')
        inadv = await page.evaluate("!!document.querySelector('dialog[open] details[data-sect=hb-adv] [name=ascope]')")
        await page.keyboard.press('Escape'); await page.wait_for_timeout(300)
        await page.click('#view-seg button[data-view=week]'); await page.wait_for_timeout(500)
        check('11. habits: the hours to look at are in the advanced block', inadv)
        # ---- Keep
        vis = await page.is_visible('#keep-box')
        async with ctx.expect_page() as pi:
            await page.click('#keep-new')
        pop = await pi.value; await pop.wait_for_load_state()
        check('12. Google Keep in the sidebar: “+ Note” opens a new note beside Tempo', vis and 'keep.new' in pop.url, pop.url)
        await page.screenshot(path=f'{OUT}/r40-keep.png')
        check('no page errors', not errs, errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
print('ALL PASS' if all(ok) else f'{ok.count(False)} FAILED')
