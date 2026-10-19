from noask import NOASK
import asyncio, sys, subprocess, time, re
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8768','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
def init(iso): return """
  const FIX = Date.parse('%s'); const _Date = Date; const off = FIX - _Date.now();
  class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+off);} else super(...a);} static now(){ return _Date.now()+off; } }
  globalThis.Date = D;
  if (!localStorage.getItem('tempo:auth')) localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, token:'tok', expires: 9e15, email:'me@example.com'}));
""" % iso
async def device(b, g, errs, iso):
    ctx = await b.new_context(viewport={'width':1440,'height':900}, timezone_id='Europe/Berlin')
    await ctx.add_init_script(init(iso)); await ctx.add_init_script(NOASK)
    await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
    page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
    await page.goto('http://localhost:8768/app.html'); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(1500)
    return page
async def counts(p):
    wk = await p.eval_on_selector_all('.ev.chunk', 'e=>e.length'); t = await p.text_content('#range-title')
    await p.click('#view-seg button[data-view=month]'); await p.wait_for_timeout(500)
    mo = await p.eval_on_selector_all('.chip', 'e=>e.map(x=>x.textContent.trim())')
    await p.click('#view-seg button[data-view=week]'); await p.wait_for_timeout(400)
    return f'week "{t}": {wk} sessions | month chips: {len(mo)}'
async def main():
    g = MockGoogle(); errs = []
    async with async_playwright() as p:
        b = await p.chromium.launch()
        A = await device(b, g, errs, '2026-10-18T10:27:00Z')   # Sunday 12:27 Berlin
        # use a dedicated "Tempo Tasks" calendar like Settings offers
        await A.click('#btn-settings'); await A.click('dialog .tabs button[data-tab="2"]'); await A.click('dialog .create-cal'); await A.wait_for_timeout(1500)
        await A.click('#btn-new-reading'); await A.wait_for_selector('dialog .task-form')
        await A.fill('dialog [name=title]', 'Pride and Prejudice'); await A.fill('dialog [name=pages]', '200'); await A.fill('dialog [name=startPage]', '47'); await A.fill('dialog [name=speed]', '20')
        await A.fill('dialog [name=deadline]', '2026-10-30T17:00'); await A.click('dialog button[type=submit]'); await A.wait_for_timeout(2500)
        print('A (Sunday):', await counts(A), '| on Google:', len(g.task_events()), 'in', {c for c,evs in g.events.items() for e in evs.values() if e.get('extendedProperties')})
        await A.screenshot(path=f'{OUT}/r-A.png')
        B = await device(b, g, errs, '2026-10-18T10:27:00Z')
        print('B fresh:', await counts(B))
        print('B tasks:', await B.eval_on_selector_all('.task-row .tr-title', 'e=>e.map(x=>x.textContent.trim())'))
        await B.screenshot(path=f'{OUT}/r-B.png')
        print('B hint (removed, should be None):', await B.query_selector('.next-hint'))
        await B.click('#btn-next'); await B.wait_for_timeout(1000)
        print('B after "Show it":', await B.text_content('#range-title'), await B.eval_on_selector_all('.ev.chunk', 'e=>e.length'), 'sessions')
        await B.screenshot(path=f'{OUT}/r-B-week.png')
        # --- Edit the series on B (other browser): change deadline + rank, mark a session done, delete a session
        await B.click('.task-row'); await B.wait_for_selector('dialog .task-form')
        await B.fill('dialog [name=rank]', '1'); await B.fill('dialog [name=deadline]', '2026-11-06T17:00')
        await B.screenshot(path=f'{OUT}/r-B-edit.png')
        await B.click('dialog button[type=submit]'); await B.wait_for_timeout(2500)
        await B.click('.ev.chunk >> nth=0'); await B.click('.popover .done'); await B.wait_for_timeout(2000)
        await B.click('.ev.chunk:not(.done) >> nth=0'); await B.click('.popover .del'); await B.click('dialog .choice-btn >> nth=0'); await B.wait_for_timeout(2500)
        ev = g.task_events()
        print('Google after B edits:', len(ev), 'events; done:', sum(1 for e in ev if e['summary'].startswith('✓')), '; calendars:', {c for c,evs in g.events.items() for e in evs.values() if e.get('extendedProperties')})
        # --- A refreshes and must see B's edits
        await A.click('#btn-refresh'); await A.wait_for_timeout(2500)
        info = await A.evaluate("(()=>{const t=window.__tempo.app.state.tasks[0]; const ss=window.__tempo.S.sessions(t); return {rank:t.rank, deadline:new Date(t.deadline).toISOString(), done:ss.filter(x=>x.kind==='done').length, n:ss.length, skipped:(t.skipped||[]).length}})()")
        print('A after refresh:', info)
        # --- B deletes the whole series; A refresh removes it
        await B.click('.task-row'); await B.click('dialog .del'); await B.click('dialog .choice-btn'); await B.wait_for_timeout(2500)
        await A.click('#btn-refresh'); await A.wait_for_timeout(2500)
        print('After B deleted series -> A tasks:', await A.eval_on_selector_all('.task-row', 'e=>e.length'), '| Google:', len(g.task_events()))
        # --- rolling week option
        await A.evaluate("window.__tempo.app.state.settings.weekView='rolling'; window.__tempo.render()"); await A.wait_for_timeout(400)
        print('Rolling week title:', await A.text_content('#range-title'))
        print('ERRORS', errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
