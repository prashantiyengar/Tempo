# Round 42: XP for rating the day (more with a reason); fireworks once per level; the phone's bottom bar stays put;
# notes for a future day (red post-it on the day until read); formatting in notes.
import asyncio, sys, subprocess, time, re, json
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8837','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
INIT = """
const FIX = Date.parse('2026-10-24T13:00:00Z'); const _Date = Date; globalThis.__off = (+(localStorage.getItem('test:off') || 0)) + FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
window.__fw = 0; new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.classList?.contains('fireworks')) window.__fw++; }).observe(document, { childList: true, subtree: true });
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false, goalNotice: false, game: {on: true, started: '2026-10-12', active: ['2026-10-24']}}));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2099-01-01'));
}"""
ok = []
def check(label, cond, extra=''):
    ok.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + label, extra)
def ev(i, title, d, h0, h1):
    return {'id': i, 'summary': title, 'status': 'confirmed', 'start': {'dateTime': f'{d}T{h0}:00+02:00'}, 'end': {'dateTime': f'{d}T{h1}:00+02:00'}}

async def main():
    g = MockGoogle(); errs = []
    E = g.events['me@example.com']
    import datetime
    for i in range(12):
        d = (datetime.date(2026, 10, 12) + datetime.timedelta(i)).isoformat()
        for h in [9, 10, 14, 15]: E[f'w{i}{h}'] = ev(f'w{i}{h}', 'Work', d, f'{h:02d}:00', f'{h + 1:02d}:00')
    E['late'] = {'id': 'late', 'summary': 'Late call', 'status': 'confirmed', 'start': {'dateTime': '2026-10-28T22:00:00+01:00'}, 'end': {'dateTime': '2026-10-28T23:00:00+01:00'}}
    async with async_playwright() as p:
        b = await p.chromium.launch(); ctx = await b.new_context(viewport={'width': 1400, 'height': 900}, timezone_id='Europe/Berlin', compact_ui=True)
        await ctx.add_init_script(INIT); await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        load = lambda: page.goto('http://localhost:8837/app.html')
        await load(); await page.wait_for_function('window.tempo'); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(3500)
        # ---- 3. fireworks once per level
        g0 = await page.evaluate("window.__tempo.app.state.settings.game")
        lv = g0.get('celebrated')
        fw0 = await page.evaluate("window.__fw")
        check('1. the first count remembers the level without fireworks', lv and lv >= 2 and fw0 == 0, (lv, fw0))
        await page.wait_for_timeout(800); await load(); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(3500)
        fw1 = await page.evaluate("window.__fw")
        check('2. reopening the app at the same level: no fireworks', fw1 == 0, fw1)
        await page.evaluate(f"window.__tempo.app.state.settings.game.celebrated = {lv - 1}")
        await page.evaluate("window.__tempo.gameRefresh()"); await page.wait_for_timeout(800)
        fw2 = await page.evaluate("[window.__fw, window.__tempo.app.state.settings.game.celebrated]")
        await page.wait_for_timeout(2500); await load(); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(3500)
        fw3 = await page.evaluate("window.__fw")
        check('3. a new level gets fireworks once — not again on the next open', fw2 == [1, lv] and fw3 == 0, (fw2, fw3))
        # ---- 1. rating XP
        await page.click('.tg-dayhead[data-day="2026-10-24"] .dm-rate'); await page.wait_for_selector('.popover .rate-pop')
        hint = await page.text_content('.popover .rate-pop')
        await page.click('.popover .rate-b[data-v="5"]'); await page.fill('.popover .rate-why', 'great day'); await page.click('.popover .rate-pop button.primary'); await page.wait_for_timeout(1500)
        lines = await page.evaluate("window.__tempo.app.gameToday.lines.filter(l => l[0].startsWith('rated')).map(l => [l[0], l[2]])")
        check('4. rating today earns a little XP, more with a reason (3 + 3)', 'XP for rating' in hint and lines == [['rated the day 5/5 with a reason', 6]], (hint[-80:], lines))
        a0 = await page.evaluate("window.__tempo.app.state.settings.game.ledger['2026-10-23'].a")
        await page.click('.tg-dayhead[data-day="2026-10-23"] .dm-rate'); await page.wait_for_selector('.popover .rate-pop')
        await page.click('.popover .rate-b[data-v="2"]'); await page.click('.popover .rate-pop button.primary'); await page.wait_for_timeout(2000)
        a1 = await page.evaluate("window.__tempo.app.state.settings.game.ledger['2026-10-23'].a")
        check('5. rating a past day without a reason: +3 on that day', a1 - a0 == 3, (a0, a1))
        # ---- 5. formatting
        await page.click('.side-tabs [data-st=notes]'); await page.wait_for_selector('#note-list .note-add')
        ta = '#note-list .note-add textarea'
        await page.fill(ta, 'hello world'); await page.evaluate(f"(() => {{ const t = document.querySelector('{ta}'); t.setSelectionRange(0, 5); }})()")
        await page.click('#note-list .note-tools [data-fmt=b]')
        v1 = await page.input_value(ta)
        await page.evaluate(f"(() => {{ const t = document.querySelector('{ta}'); t.setSelectionRange(t.value.length - 5, t.value.length); }})()")
        await page.keyboard.press('Control+i')
        v2 = await page.input_value(ta)
        await page.press(ta, 'End'); await page.keyboard.type('\n- one\n- two')
        await page.click('#note-list .note-add button[type=submit]'); await page.wait_for_timeout(600)
        html = await page.inner_html('#note-list .note .note-t')
        check('6. notes can be formatted: bold, italic and bullet lists', v1 == '**hello** world' and v2 == '**hello** *world*' and '<b>hello</b>' in html and '<i>world</i>' in html and html.count('<li>') == 2, (v1, v2, html))
        # ---- 4. a note for a future day
        await page.fill(ta, 'Call the bank'); await page.fill('#note-list .note-add [name=for]', '2026-10-25')
        await page.click('#note-list .note-add button[type=submit]'); await page.wait_for_timeout(800)
        n = await page.evaluate("window.__tempo.app.state.settings.notes.find(n => n.text === 'Call the bank')")
        pit = await page.evaluate("(() => { const b = document.querySelector('.tg-dayhead[data-day=\"2026-10-25\"] .dm-note'); return b && b.className; })()")
        check('7. a note for a future day sits on that day (not red yet)', n and n.get('for') == '2026-10-25' and pit and 'due' not in pit, (n, pit))
        await page.evaluate("localStorage.setItem('test:off', String(24 * 3600e3))")
        await load(); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(2500)
        red = await page.evaluate("(() => { const b = document.querySelector('.tg-dayhead[data-day=\"2026-10-25\"] .dm-note'); return b && b.className; })()")
        await page.screenshot(path=f'{OUT}/r42-red-note.png')
        check('8. on that day its post-it turns red', red and 'due' in red, red)
        await page.click('.tg-dayhead[data-day="2026-10-25"] .dm-note'); await page.wait_for_selector('dialog[open] .day-notes')
        txt = await page.text_content('dialog[open] .dn-list')
        await page.keyboard.press('Escape'); await page.wait_for_timeout(800)
        red2 = await page.evaluate("(() => { const b = document.querySelector('.tg-dayhead[data-day=\"2026-10-25\"] .dm-note'); return b && b.className; })()")
        rd = await page.evaluate("window.__tempo.app.state.settings.notes.find(n => n.text === 'Call the bank').read")
        check('9. reading it on the day turns it back to normal', 'Call the bank' in txt and 'due' not in red2 and rd, (red2, rd))
        await page.evaluate("localStorage.setItem('test:off', '0')")
        check('no page errors (desktop)', not errs, errs)
        await ctx.close()
        # ---- 2. phone: the page never scrolls, so the bottom bar stays
        ctx = await b.new_context(**p.devices['Pixel 7'], timezone_id='Europe/Berlin')
        await ctx.add_init_script(INIT); await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8837/app.html'); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(2500)
        await page.click('#bottombar button[data-view=week]'); await page.wait_for_timeout(600)
        await page.evaluate("document.querySelector('.tg-scroll').scrollTop = 99999")
        res = []
        for i in range(3):
            await page.evaluate("document.scrollingElement.scrollTo(0, 400); window.scrollTo(0, 400)")
            await page.evaluate("window.__tempo.app.swipeIn = 1"); await page.click('#btn-next') if await page.is_visible('#btn-next') else await page.evaluate("document.querySelector('#btn-next').click()")
            await page.wait_for_timeout(700)
            res.append(await page.evaluate("(() => { const r = document.querySelector('#bottombar').getBoundingClientRect(); return [document.querySelector('#range-title').textContent, Math.round(r.bottom), innerHeight, document.scrollingElement.scrollTop]; })()"))
        check('10. on the phone the bottom bar stays at the bottom after moving to later weeks (even past a 10 pm event)', all(r[1] == r[2] and r[3] == 0 for r in res), res)
        await page.screenshot(path=f'{OUT}/r42-phone.png')
        check('no page errors (phone)', not errs, errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
print('ALL PASS' if all(ok) else f'{ok.count(False)} FAILED')
