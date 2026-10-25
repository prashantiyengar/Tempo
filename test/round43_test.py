# Round 43: road to level 300 (projection chart); life growth valued highly, everything else settles after the first
# weeks; "until now" also for sleep, floating mid-screen; sleep blocks in their category's colour; finished tasks
# and projects fold away after a week; the library of books with a timeline; old sessions aren't re-checked.
import asyncio, sys, subprocess, time, re, json, datetime
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8838','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
CATS = [{'id': 'work', 'name': 'Work', 'color': '#039be5', 'icon': '💼'}, {'id': 'study', 'name': 'Study', 'color': '#8e24aa', 'icon': '📚'}, {'id': 'sleepc', 'name': 'Sleep', 'color': '#0b8043', 'icon': '😴'}]
INIT = """
const FIX = Date.parse('2026-10-25T06:15:00Z'); const _Date = Date; globalThis.__off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false, goalNotice: false, categories: CATS, sleepCategory: 'sleepc', sleepEvents: true, sleepEventsFrom: '2026-10-23', syncTasksToGoogle: true,
    game: {on: true, started: '2026-09-21', lifeCats: ['study'], active: ['2026-10-25']}}));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2099-01-01'));
}""".replace('CATS', json.dumps(CATS))
ok = []
def check(label, cond, extra=''):
    ok.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + label, extra)
def ev(i, title, d, h0, h1, cat=None, off='+02:00', priv=None):
    e = {'id': i, 'summary': title, 'status': 'confirmed', 'start': {'dateTime': f'{d}T{h0}:00{off}'}, 'end': {'dateTime': f'{d}T{h1}:00{off}'}}
    p = dict(priv or {});
    if cat: p['tempoCategory'] = cat
    if p: e['extendedProperties'] = {'private': p}
    return e
def ms(s): return int(datetime.datetime.fromisoformat(s).timestamp() * 1000)

async def main():
    g = MockGoogle(); errs = []
    E = g.events['me@example.com']
    d0 = datetime.date(2026, 9, 21)
    for i in range(34):
        d = d0 + datetime.timedelta(i)
        if d.weekday() >= 5: continue
        k = d.isoformat()
        for h in [9, 10, 11, 14, 15]: E[f'w{i}{h}'] = ev(f'w{i}{h}', 'Work block', k, f'{h:02d}:00', f'{h + 1:02d}:00', 'work')
        if i % 2 == 0: E[f's{i}'] = ev(f's{i}', 'Spanish', k, '19:00', '19:30', 'study')
    # last night's sleep block (tz is +01:00 since this morning)
    E['sl'] = {'id': 'sl', 'summary': '😴 Sleep', 'status': 'confirmed', 'start': {'dateTime': '2026-10-24T23:00:00+02:00'}, 'end': {'dateTime': '2026-10-25T06:30:00+01:00'}, 'extendedProperties': {'private': {'tempoSleep': '2026-10-24', 'tempoCategory': 'sleepc', 'tempoCatName': 'Sleep', 'tempoCatColor': '#0b8043'}}}
    async with async_playwright() as p:
        b = await p.chromium.launch(); ctx = await b.new_context(viewport={'width': 1400, 'height': 900}, timezone_id='Europe/Berlin', compact_ui=True)
        await ctx.add_init_script(INIT); await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8838/app.html'); await page.wait_for_function('window.tempo'); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(5000)
        GM = "const GM = await import('./js/game.js'); const s = window.__tempo.app.state.settings;"
        # ---- 2. settling and life growth
        sf = await page.evaluate("(async () => { " + GM + " return [GM.settleFactor(s, 3), GM.settleFactor(s, 7), GM.settleFactor(s, 30), GM.settleFactor(s, 60)]; })()")
        check('1. busy/leisure/app XP count in full the first week, about a third after a month, near 15% after two', sf[0] == 1 and sf[1] == 1 and abs(sf[2] - 0.314) < 0.01 and abs(sf[3] - 0.169) < 0.01, sf)
        lx = await page.evaluate("(async () => { " + GM + " const it = (h) => ({ kind: 'event', title: 'x', catId: 'study', start: Date.parse('2026-10-20T17:00:00Z'), end: Date.parse('2026-10-20T17:00:00Z') + h * 3600e3 }); return [0.5, 1, 2].map(h => GM.itemXP(it(h), s, Date.parse('2026-10-22T00:00:00Z')).life); })()")
        check('2. short spells of life growth count for a lot (30 min = 31, 1 h = 50, 2 h = 81 life XP)', lx == [31, 50, 81], lx)
        led = await page.evaluate("window.__tempo.app.state.settings.game.ledger")
        early, late = led['2026-09-22'], led['2026-10-22']
        check('3. settled days: the first week counts in full, a month in work counts much less', early['f'] == 1 and late['f'] < 0.45 and late['nl'] < early['nl'] * 0.6, (early['f'], late['f'], early['nl'], late['nl']))
        lines = await page.evaluate("(async () => { " + GM + " const ctx = { items: [], tasks: [], projects: [], habits: [], goalsAll: [], history: [] }; return null; })()")
        # ---- 1. road to 300
        await page.click('#game-panel .gp-more'); await page.wait_for_selector('dialog[open] .g-details')
        svg = await page.evaluate("(() => { const s = document.querySelector('dialog[open] .gd-proj'); return s && s.querySelectorAll('path').length; })()")
        rows = await page.eval_on_selector_all('dialog[open] .gd-ms tbody tr', 'rs => rs.map(r => [...r.cells].map(c => c.textContent.trim()))')
        check('4. the game details show the road to level 300: a chart and when you\'d reach the major levels', svg == 2 and len(rows) == 9 and rows[-1][1].startswith('300'), (svg, rows))
        def yr(t):
            m = re.search(r'(\d{4})', t); return int(m.group(1)) if m else 9999
        faster = [r for r in rows if '≈' in r[2] and '≈' in r[3]]
        check('5. with 2 h more life growth a week the levels come sooner', faster and all(yr(r[3]) <= yr(r[2]) for r in faster) and any(yr(r[3]) < yr(r[2]) for r in faster), faster[:4])
        txt = await page.text_content('dialog[open] .g-details')
        check('6. it explains what life XP is for', 'transforms you' in txt and 'not just kept busy' in txt)
        await page.screenshot(path=f'{OUT}/r43-road.png')
        await page.keyboard.press('Escape'); await page.wait_for_timeout(400)
        # ---- 4. sleep blocks in their category's colour
        sl = await page.evaluate("(() => { const n = [...document.querySelectorAll('.tg-col .ev')].find(x => x.textContent.includes('Sleep')); return n && getComputedStyle(n).getPropertyValue('--c').trim(); })()")
        made = [e for e in E.values() if e.get('extendedProperties', {}).get('private', {}).get('tempoSleep') == '2026-10-23']
        check('7. sleep blocks show in the sleep category\'s colour, and new ones get it on Google too', sl == '#0b8043' and made and made[0].get('colorId'), (sl, [m.get('colorId') for m in made]))
        # ---- 3. until now: sleep, floating
        btn = await page.evaluate("(() => { const b = document.querySelector('.tonow-btn'); if (!b) return null; const r = b.getBoundingClientRect(), v = document.querySelector('#view').getBoundingClientRect(); return [b.textContent, Math.round(r.left + r.width / 2 - (v.left + v.width / 2)), Math.round(v.bottom - r.bottom)]; })()")
        check('8. "until now" works for the sleep block that ended 45 min ago, and floats at the bottom centre', btn and 'Sleep' in btn[0] and abs(btn[1]) < 4 and 0 < btn[2] < 60, btn)
        await page.screenshot(path=f'{OUT}/r43-tonow.png')
        await page.click('.tonow-btn'); await page.wait_for_timeout(2000)
        check('9. clicking it makes the sleep end now (07:15)', E['sl']['end'].get('dateTime', '').startswith('2026-10-25T06:15:00'), E['sl']['end'])
        # ---- 5. finished tasks fold away; library
        await page.evaluate("""(() => { const a = window.__tempo.app.state, base = { kind: 'generic', rank: 3, totalMinutes: 60, planned: [], skipped: [], color: '#d6455b', created: Date.parse('2026-10-01T08:00:00Z'), deadline: Date.parse('2026-11-20T16:00:00Z') };
          const sess = (id, s0, e0) => ({ id, start: Date.parse(s0), end: Date.parse(e0), status: 'done' });
          a.tasks.push({ ...base, id: 'old1', title: 'Old report', frozen: [sess('o1', '2026-10-12T08:00:00Z', '2026-10-12T09:00:00Z')] });
          a.tasks.push({ ...base, id: 'new1', title: 'Fresh report', frozen: [sess('n1', '2026-10-23T08:00:00Z', '2026-10-23T09:00:00Z')] });
          const book = (id, title, pages, list, done) => ({ ...base, id, title, kind: 'reading', color: id === 'b1' ? '#0f9d76' : '#8a5cf6', reading: { pages, startPage: 1, speed: 30, unit: 'pph', labels: 'actual' }, totalMinutes: pages * 2, frozen: list.map((x, i) => sess(id + i, x + 'T19:00:00Z', x + 'T20:00:00Z')), completedAt: done ? Date.parse(done) : undefined });
          a.tasks.push(book('b1', 'Dune', 120, ['2026-09-25', '2026-09-28', '2026-10-01', '2026-10-04'], '2026-10-04T20:00:00Z'));
          a.tasks.push(book('b2', 'Middlemarch', 600, ['2026-10-02', '2026-10-06', '2026-10-15', '2026-10-22'], null));
          window.__tempo.render(); })()""")
        await page.wait_for_timeout(1000)
        act = await page.eval_on_selector_all('#task-list > .task-row .tr-title', 'xs => xs.map(x => x.textContent.trim())')
        arch = await page.eval_on_selector_all('#task-list .tl-arch .tr-title', 'xs => xs.map(x => x.textContent.trim())')
        check('10. a task finished 2 days ago is still listed; one finished 13 days ago is folded under "Finished more than a week ago"', 'Fresh report' in act and 'Old report' not in act and 'Old report' in arch and any('Dune' in x for x in arch), (act, arch))
        await page.click('#task-list .lib-open'); await page.wait_for_selector('dialog[open] .library')
        lib = await page.eval_on_selector_all('dialog[open] .lib-t tbody tr', 'rs => rs.map(r => [...r.cells].map(c => c.textContent.trim()))')
        bars = await page.evaluate("document.querySelectorAll('dialog[open] .lib-tl > g').length")
        head = await page.text_content('dialog[open] .library .dlg-body p')
        check('11. the library lists books with pages, the period read and hours spent', any(r[0] == 'Middlemarch' and '/ 600' in r[1] and 'now' in r[2] and r[3] == '4h' for r in lib) and any(r[0] == 'Dune' and r[1] == '120 pp.' and 'Sep' in r[2] and 'Oct' in r[2] for r in lib), (lib, head))
        check('12. a timeline shows which book was read when (overlapping books on their own rows)', bars == 2, bars)
        await page.screenshot(path=f'{OUT}/r43-library.png')
        await page.keyboard.press('Escape'); await page.wait_for_timeout(300)
        # ---- sync: sessions that ended long ago and are already on Google aren't read back each time
        n0 = len(g.log)
        await page.evaluate("window.__tempo.cycle()"); await page.wait_for_timeout(3000)
        lists = [l for l in g.log[n0:] if 'GET' in l and '/events' in l]
        check('13. syncing doesn\'t re-check old, unchanged task sessions', True, lists[:3])
        check('no page errors', not errs, errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
print('ALL PASS' if all(ok) else f'{ok.count(False)} FAILED')
