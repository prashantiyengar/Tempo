# Round 45: "until now" in the phone's + menu; audiobooks by hours; compact colour pickers; −/+ buttons that show
# the same steps both ways for a moment; tapping a gap fills it from the event before to the event after.
import asyncio, sys, subprocess, time, re, json
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8840','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
INIT = """
const FIX = Date.parse('2026-10-25T10:10:00Z'); const _Date = Date; globalThis.__off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false, goalNotice: false, sinceLastBuffer: 0, tillNextBuffer: 0, hourHeight: 40}));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2099-01-01'));
}"""
ok = []
def check(label, cond, extra=''):
    ok.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + label, extra)
def ev(i, t, d, a, b): return {'id': i, 'summary': t, 'status': 'confirmed', 'start': {'dateTime': f'{d}T{a}:00+01:00'}, 'end': {'dateTime': f'{d}T{b}:00+01:00'}}
async def main():
    g = MockGoogle(); errs = []
    E = g.events['me@example.com']
    E['bf'] = ev('bf', 'Breakfast', '2026-10-25', '08:30', '10:40')          # ended 30 min before "now" (11:10)
    E['a'] = ev('a', 'Swim', '2026-10-25', '13:00', '14:00'); E['b'] = ev('b', 'Lunch', '2026-10-25', '16:00', '17:00')   # 2 h gap
    E['c'] = ev('c', 'Read', '2026-10-25', '17:30', '18:00'); E['d'] = ev('d', 'Dinner', '2026-10-25', '23:00', '23:30')  # 5 h gap
    async with async_playwright() as p:
        b = await p.chromium.launch(); ctx = await b.new_context(viewport={'width': 1400, 'height': 900}, timezone_id='Europe/Berlin', compact_ui=True)
        await ctx.add_init_script(INIT); await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8840/app.html'); await page.wait_for_function('window.tempo'); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(2000)
        hh = 40
        col = await page.eval_on_selector('.tg-col[data-day="2026-10-25"]', 'e => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top }; }')
        async def tap_at(h):
            await page.evaluate(f"document.querySelector('.tg-scroll').scrollTop = {max(0, (h - 3) * hh)}")
            c = await page.eval_on_selector('.tg-col[data-day="2026-10-25"]', 'e => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top }; }')
            await page.mouse.click(c['x'], c['y'] + h * hh); await page.wait_for_selector('.popover .qc')
            r = await asyncio.gather(page.input_value('.popover [name=qs]'), page.input_value('.popover [name=qe]'))
            note = await page.text_content('.popover .qc-note') if await page.query_selector('.popover .qc-note') else ''
            return r, note
        r1, n1 = await tap_at(15)
        check('1. a tap in a gap of up to 4 h fills it: since the last event till the next', r1 == ['14:00', '16:00'] and 'Swim' in n1 and 'Lunch' in n1, (r1, n1))
        # nudges: just − and +, the steps show for a moment
        ts = await page.eval_on_selector_all('.popover .qc-t', 'rs => rs.map(r => [...r.querySelectorAll(".ndg-t, .ndg-set button")].filter(b => b.offsetParent).map(b => b.textContent))')
        await page.click('.popover .qc-t:first-child .ndg-t[data-sign="1"]'); await page.wait_for_timeout(200)
        plus = await page.eval_on_selector_all('.popover .qc-t:first-child .ndg-set button', 'bs => bs.filter(b => b.offsetParent).map(b => b.textContent)')
        await page.click('.popover .qc-t:first-child .ndg-t[data-sign="-1"]'); await page.wait_for_timeout(200)
        minus = await page.eval_on_selector_all('.popover .qc-t:first-child .ndg-set button', 'bs => bs.filter(b => b.offsetParent).map(b => b.textContent)')
        await page.click('.popover .qc-t:first-child .ndg-set button[data-add="-10"]')
        st = await page.input_value('.popover [name=qs]')
        await page.screenshot(path=f'{OUT}/r45-nudges.png')
        await page.wait_for_timeout(4000)
        gone = await page.eval_on_selector_all('.popover .ndg-set button', 'bs => bs.filter(b => b.offsetParent).length')
        check('2. the −/+ buttons: only − and + show; tapping one shows the same steps both ways (5, 10, 15, 30 min, 1 h)', ts == [['−', '+'], ['−', '+']] and plus == ['+5m', '+10m', '+15m', '+30m', '+1h'] and minus == ['−5m', '−10m', '−15m', '−30m', '−1h'] and st == '13:50', (ts, plus, minus, st))
        check('3. they fold away a few seconds after the last use', gone == 0, gone)
        await page.click('.popover .qc-cancel')
        r2, n2 = await tap_at(19)
        check('4. a longer gap: a tap near the earlier event starts when it ended', r2 == ['18:00', '19:00'] and 'Read' in n2, (r2, n2))
        await page.click('.popover .qc-cancel')
        r3, n3 = await tap_at(22.5)
        check('5. …and a tap near the later event ends when it starts', r3 == ['22:00', '23:00'] and 'Dinner' in n3, (r3, n3))
        await page.click('.popover .qc-cancel')
        # colour pickers
        await page.click('#btn-new-task'); await page.wait_for_selector('dialog[open] .task-form')
        cp = await page.evaluate("(() => { const w = document.querySelector('dialog[open] .color-field .sw-pick'); return w && [!!w.querySelector('.sw-cur'), w.querySelector('.swatches').hidden]; })()")
        await page.click('dialog[open] .color-field .sw-cur')
        vis = await page.evaluate("!document.querySelector('dialog[open] .color-field .swatches').hidden")
        await page.click('dialog[open] .color-field .sw:nth-child(3)')
        after = await page.evaluate("(() => { const w = document.querySelector('dialog[open] .color-field'); return [w.querySelector('.swatches').hidden, getComputedStyle(w.querySelector('.sw-cur .sw-dot')).backgroundColor, w.querySelector('input[name=color]:checked').value]; })()")
        check('6. colour pickers show just the chosen colour; tap to pick, and they fold away', cp == [True, True] and vis and after[0] is True and after[2] == '#e2683c' and after[1] == 'rgb(226, 104, 60)', (cp, vis, after))
        await page.screenshot(path=f'{OUT}/r45-colour.png')
        # audiobook
        await page.click('dialog[open] label:has(input[name=kind][value=reading])')
        await page.click('dialog[open] label:has(input[name=rformat][value=audio])')
        vis2 = await page.evaluate("[getComputedStyle(document.querySelector('dialog[open] [name=ahours]').closest('.only-audio')).display, getComputedStyle(document.querySelector('dialog[open] [name=pages]').closest('.only-book')).display]")
        await page.fill('dialog[open] [name=title]', 'Sapiens'); await page.fill('dialog[open] [name=ahours]', '10'); await page.fill('dialog[open] [name=adone]', '1'); await page.select_option('dialog[open] [name=aspeed]', '1.5')
        calc = await page.text_content('dialog[open] .calc')
        await page.click('dialog[open] button[type=submit]'); await page.wait_for_timeout(2500)
        t = await page.evaluate("(async () => { const S = await import('./js/scheduler.js'); const t = window.__tempo.app.state.tasks.find(t => t.title === 'Sapiens'); return t && [t.reading, S.totalMinutes(t), S.sessions(t)[0]?.label]; })()")
        check('7. a reading plan can be an audiobook: its length in hours (and playback speed), not pages', vis2[0] != 'none' and vis2[1] == 'none' and t and t[0]['format'] == 'audio' and t[0]['pages'] == 540 and t[1] == 360 and '🎧 1:00–' in t[2] and '6h' in calc, (vis2, t, calc))
        # phone: "until now" in the + menu
        await ctx.close()
        ctx = await b.new_context(**p.devices['Pixel 7'], timezone_id='Europe/Berlin')
        await ctx.add_init_script(INIT); await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8840/app.html'); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(2000)
        fl = await page.evaluate("(() => { const b = document.querySelector('.tonow-btn'); return b ? getComputedStyle(b).display : 'none'; })()")
        dot = await page.evaluate("document.querySelector('#fab').classList.contains('has-tonow')")
        await page.click('#fab'); await page.wait_for_timeout(400)
        labels = await page.eval_on_selector_all('dialog[open] .sheet-menu button', 'bs => bs.map(b => b.textContent.trim())')
        check('8. on the phone "until now" is in the + menu (no floating button), and the + shows a dot', fl == 'none' and dot and labels and 'Breakfast' in labels[0] and 'until now' in labels[0], (fl, dot, labels[:2]))
        await page.screenshot(path=f'{OUT}/r45-fab.png')
        await page.click('dialog[open] .sheet-menu button >> nth=0'); await page.wait_for_timeout(2000)
        check('9. choosing it makes Breakfast end now', E['bf']['end'].get('dateTime', '').startswith('2026-10-25T10:10:00'), E['bf']['end'])
        check('no page errors', not errs, errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
print('ALL PASS' if all(ok) else f'{ok.count(False)} FAILED')
