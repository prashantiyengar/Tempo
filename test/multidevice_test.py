# Device A creates tasks and syncs; device B (fresh storage, same Google account) must see them.
import asyncio, sys, subprocess, time, re
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8767','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
INIT = """
  const FIX = Date.parse('2026-10-19T06:00:00Z'); const _Date = Date; const off = FIX - _Date.now();
  class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+off);} else super(...a);} static now(){ return _Date.now()+off; } }
  globalThis.Date = D;
  if (!localStorage.getItem('tempo:auth')) localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, token:'tok', expires: 9e15, email:'me@example.com'}));
"""
async def device(b, g, errs):
    ctx = await b.new_context(viewport={'width':1440,'height':900}, timezone_id='Europe/Berlin', accept_downloads=True)
    await ctx.add_init_script(INIT)
    await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
    page = await ctx.new_page()
    page.on('pageerror', lambda e: errs.append(str(e)))
    await page.goto('http://localhost:8767/app.html'); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(1500)
    return page
async def chunks(page): return await page.eval_on_selector_all('.ev.chunk .ev-t', 'els=>els.map(e=>e.textContent.trim())')
async def main():
    g = MockGoogle(); errs = []
    async with async_playwright() as p:
        b = await p.chromium.launch()
        A = await device(b, g, errs)
        await A.click('#btn-new-reading'); await A.wait_for_selector('dialog .task-form')
        await A.fill('dialog [name=title]', 'Pride and Prejudice'); await A.fill('dialog [name=pages]', '200'); await A.fill('dialog [name=startPage]', '47'); await A.fill('dialog [name=speed]', '20')
        await A.fill('dialog [name=deadline]', '2026-10-30T17:00'); await A.fill('dialog [name=notes]', 'Penguin edition, ' + 'x'*1500)
        await A.click('dialog button[type=submit]'); await A.wait_for_timeout(2000)
        await A.click('#btn-new-task'); await A.wait_for_selector('dialog .task-form')
        await A.fill('dialog [name=title]', 'Grant report'); await A.fill('dialog [name=hours]', '3'); await A.fill('dialog [name=deadline]', '2026-10-21T17:00'); await A.fill('dialog [name=rank]', '2')
        await A.click('dialog button[type=submit]'); await A.wait_for_timeout(2000)
        # mark first grant session done on A
        await A.click('.ev.chunk:has-text("Grant") >> nth=0'); await A.click('.popover .done'); await A.wait_for_timeout(2000)
        print('A chunks:', len(await chunks(A)), '| google task events:', len(g.task_events()))

        B = await device(b, g, errs)   # fresh install / other browser
        cb = await chunks(B)
        print('B chunks on open:', len(cb), cb[:2])
        print('B sidebar tasks:', await B.eval_on_selector_all('.task-row .tr-title', 'els=>els.map(e=>e.textContent.trim())'))
        print('B done sessions:', await B.eval_on_selector_all('.ev.chunk.done .ev-t', 'els=>els.map(e=>e.textContent.trim())'))
        print('google after B opened:', len(g.task_events()))
        await B.screenshot(path=f'{OUT}/md-B.png')
        # B edits rank of book -> A refreshes and sees it; A deletes grant series -> B refresh removes it
        await A.click('.task-row:has-text("Grant")'); await A.click('dialog .del'); await A.click('dialog .choice-btn'); await A.wait_for_timeout(2000)
        print('google after A deleted Grant:', len(g.task_events()))
        if await B.query_selector('#btn-refresh'):
            await B.click('#btn-refresh'); await B.wait_for_timeout(2500)
        print('B tasks after refresh:', await B.eval_on_selector_all('.task-row .tr-title', 'els=>els.map(e=>e.textContent.trim())'))
        print('B chunks after refresh:', len(await chunks(B)), '| google:', len(g.task_events()))
        # Legacy events (older version, no task definition) must also show up
        g.events['me@example.com']['legacy1'] = {'id':'legacy1','summary':'Old book page 1-20, task 1/2','status':'confirmed','start':{'dateTime':'2026-10-22T18:00:00+02:00'},'end':{'dateTime':'2026-10-22T19:00:00+02:00'},'extendedProperties':{'private':{'tempoTask':'1','taskId':'tOLD','chunkId':'c1'}}}
        g.events['me@example.com']['legacy2'] = {'id':'legacy2','summary':'Old book page 21-40, task 2/2','status':'confirmed','start':{'dateTime':'2026-10-23T18:00:00+02:00'},'end':{'dateTime':'2026-10-23T19:00:00+02:00'},'extendedProperties':{'private':{'tempoTask':'1','taskId':'tOLD','chunkId':'c2'}}}
        if await B.query_selector('#btn-refresh'):
            await B.click('#btn-refresh'); await B.wait_for_timeout(2500)
        print('B tasks after legacy:', await B.eval_on_selector_all('.task-row .tr-title', 'els=>els.map(e=>e.textContent.trim())'), '| google:', len(g.task_events()))
        await B.screenshot(path=f'{OUT}/md-B2.png')
        print('ERRORS:', errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
