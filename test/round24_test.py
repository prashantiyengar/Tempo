# Phones: tapping an ongoing event or task session opens its sheet and every button works (the tap's "ghost"
# click must not hit the sheet's category chip or ✕). Uses the web build (./build.sh).
import asyncio, sys, subprocess, time, re
sys.path.insert(0, 'test')
OUT = sys.argv[1]
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
srv = subprocess.Popen(['python3','-m','http.server','8814','-d','dist/web'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
INIT = """
const FIX = Date.parse('2026-10-22T20:30:00Z'); const _Date = Date; globalThis.__off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false, goalNotice: false, overflowBounds: {start:'00:00', end:'24:00', days:[0,1,2,3,4,5,6]}}));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2099-01-01'));
}"""
async def run(p, name, kw):
    g = MockGoogle(); errs = []
    g.events['me@example.com']['x'] = {'id': 'x', 'summary': 'Evening call', 'status': 'confirmed', 'start': {'dateTime': '2026-10-22T21:30:00+02:00'}, 'end': {'dateTime': '2026-10-22T22:30:00+02:00'}}
    b = await p.chromium.launch(); ctx = await b.new_context(**kw, timezone_id='Europe/Berlin')
    await ctx.add_init_script(INIT); await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
    page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
    await page.goto('http://localhost:8814/'); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(2000)
    # an ongoing task session (22:00–23:00): add the task at 21:50
    await page.evaluate("globalThis.__off -= 100*60000")
    await page.evaluate("window.tempo.run([{cmd:'addTask', title:'Thesis', hours:1, deadline:'2026-10-23 12:00', ignoreBounds:true}])"); await page.wait_for_timeout(1500)
    await page.evaluate("globalThis.__off += 60*60000"); await page.evaluate("window.__tempo.render()"); await page.wait_for_timeout(800)
    pass  # print('  sessions:', await page.evaluate("window.tempo.run([{cmd:'listSessions', task:'Thesis'}])"))
    cel = '.ev.chunk:has-text("Thesis")'
    await (await page.query_selector(cel)).scroll_into_view_if_needed(); await page.wait_for_timeout(300)
    pass  # print('  hit test:', await page.evaluate("""(() => { const e = document.querySelector('.ev.chunk'); const r = e.getBoundingClientRect(); const h = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2); return { rect: [Math.round(r.top), Math.round(r.bottom), innerHeight], hit: h ? (h.id || h.className) : null, inside: e.contains(h) }; })()"""))
    await page.screenshot(path=f'{OUT}/g-{name}-before.png')
    await page.evaluate("""(() => { window.__log = []; new MutationObserver((ms) => { for (const m of ms) { for (const n of m.addedNodes) if (n.classList?.contains('popover')) window.__log.push('open ' + performance.now().toFixed(0)); for (const n of m.removedNodes) if (n.classList?.contains('popover')) window.__log.push('close ' + performance.now().toFixed(0) + ' ' + new Error().stack.split('\\n').slice(1,4).join('|')); } }).observe(document.body, { childList: true }); const oc = window.__tempo; })()""")
    if 'is_mobile' in kw: await page.tap(cel)
    else: await page.click(cel)
    await page.wait_for_timeout(1500); print('  popover opened and stayed:', await page.evaluate('window.__log.length === 1 && window.__log[0].startsWith("open")'), '| category dialog opened by itself:', bool(await page.query_selector('dialog[open]')))
    await page.wait_for_selector('.popover', timeout=3000); await page.wait_for_timeout(300)
    btns = await page.eval_on_selector_all('.popover button', 'bs => bs.map(b => b.className + ":" + b.textContent.trim().slice(0,20))')
    print('  session sheet has:', [b.split(':')[1] for b in btns if 'btn' in b])
    await page.screenshot(path=f'{OUT}/g-{name}-chunk.png')
    tap0 = page.tap if 'is_mobile' in kw else page.click
    await tap0('.popover .done' if await page.query_selector('.popover .done') else '.popover .undone'); await page.wait_for_timeout(1200)
    print('  chunk after done/undone: popover open', bool(await page.query_selector('.popover')), '| toast', await page.text_content('#toast'), '| errors', errs)
    await page.keyboard.press('Escape')
    el = await page.query_selector('.ev:has-text("Evening call")')
    await el.scroll_into_view_if_needed(); bb = await el.bounding_box()
    if 'is_mobile' in kw: await page.tap('.ev:has-text("Evening call")')
    else: await page.click('.ev:has-text("Evening call")')
    await page.wait_for_selector('.popover'); await page.wait_for_timeout(400)
    await page.screenshot(path=f'{OUT}/g-{name}.png')
    info = await page.evaluate("""(() => { const out = {}; for (const s of ['.popover .edit', '.popover .del', '.popover .ev-done', '.popover .fin-early', '.popover .pop-evcat']) { const e = document.querySelector(s); if (!e) { out[s] = 'missing'; continue; } const r = e.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); out[s] = e.contains(hit) || hit === e ? 'ok' : ('covered by ' + (hit ? hit.className || hit.tagName : 'nothing') + ' ' + Math.round(r.top) + '/' + innerHeight); } return out; })()""")
    print(name, 'buttons reachable:', all(v == 'ok' for v in info.values()), errs)
    tap = page.tap if 'is_mobile' in kw else page.click
    await tap('.popover .ev-done'); await page.wait_for_timeout(1500)
    print('  after Mark done: class done =', 'done' in (await page.get_attribute('.ev:has-text("Evening call")', 'class') or ''), '| toast:', await page.text_content('#toast'), '| popover open:', bool(await page.query_selector('.popover')))
    if 'is_mobile' in kw: await page.tap('.ev:has-text("Evening call")')
    else: await page.click('.ev:has-text("Evening call")')
    await page.wait_for_selector('.popover'); await page.wait_for_timeout(300)
    await tap('.popover .edit'); await page.wait_for_timeout(1000)
    print('  after Edit: dialog open =', bool(await page.query_selector('dialog[open] [name=summary]')), errs)
    await page.screenshot(path=f'{OUT}/g-{name}-2.png')
    await b.close()
async def main():
    async with async_playwright() as p:
        await run(p, 'desktop', {'viewport': {'width': 1366, 'height': 800}})
        await run(p, 'phone', dict(p.devices['iPhone 13']))
        await run(p, 'se', dict(p.devices['iPhone SE']))
        await run(p, 'pixel', dict(p.devices['Pixel 5']))
try: asyncio.run(main())
finally: srv.terminate()
