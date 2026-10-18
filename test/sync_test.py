import asyncio, sys, json, subprocess, time
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8766','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
async def main():
    g = MockGoogle(fail_insert=("--fail" in sys.argv))
    g.events['work']['m1'] = {'id':'m1','summary':'Client meeting','status':'confirmed','start':{'dateTime':'2026-10-19T09:00:00+02:00'},'end':{'dateTime':'2026-10-19T11:00:00+02:00'}}
    g.events['work']['m2'] = {'id':'m2','summary':'Offsite','status':'confirmed','colorId':'11','start':{'dateTime':'2026-10-21T13:00:00+02:00'},'end':{'dateTime':'2026-10-21T17:00:00+02:00'}}
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width':1440,'height':900}, timezone_id='Europe/Berlin')
        await ctx.add_init_script("""
          const FIX = Date.parse('2026-10-19T06:00:00Z'); const _Date = Date; const off = FIX - _Date.now();
          class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+off);} else super(...a);} static now(){ return _Date.now()+off; } }
          globalThis.Date = D;
          if (!localStorage.getItem('tempo:auth')) localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, token:'tok', expires: 9e15, email:'me@example.com'}));
        """)
        await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        page = await ctx.new_page(); errs=[]
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.on('console', lambda m: errs.append('console:'+m.text) if m.type in ('error','warning') else None)
        await page.goto('http://localhost:8766/app.html'); await page.wait_for_selector('.tg-col')
        await page.wait_for_timeout(1500)
        await page.click('#btn-new-reading'); await page.wait_for_selector('dialog .task-form')
        await page.fill('dialog [name=title]', 'Pride and Prejudice')
        await page.fill('dialog [name=pages]', '200'); await page.fill('dialog [name=startPage]', '47'); await page.fill('dialog [name=speed]', '20')
        await page.fill('dialog [name=deadline]', '2026-10-30T17:00')
        await page.click('dialog button[type=submit]')
        await page.wait_for_timeout(2500)
        tev = g.task_events()
        print('google task events after create:', len(tev), sorted(e['summary'] for e in tev)[:2])
        print('status:', await page.text_content('#sync-status'))
        print('banner:', await page.eval_on_selector('#banner', 'b=>b.hidden ? "(hidden)" : b.textContent.trim()'))
        await page.screenshot(path=f'{OUT}/s1.png')
        # Delete one session -> google should still have 10, shifted
        await page.click('.ev.chunk >> nth=0'); await page.click('.popover .del'); await page.click('dialog .choice-btn >> nth=0')
        await page.wait_for_timeout(2500)
        print('after delete one:', len(g.task_events()))
        # User deletes 3 session events directly in Google Calendar -> Tempo must re-create them
        for e in g.task_events()[:3]:
            for evs in g.events.values(): evs.pop(e['id'], None)
        print('google after manual delete:', len(g.task_events()))
        await page.click('#btn-resched'); await page.wait_for_timeout(2500)
        print('after resync (recreated):', len(g.task_events()))
        await page.click('#sync-status'); await page.wait_for_selector('dialog .syncdlg')
        await page.screenshot(path=f'{OUT}/s2-sync-panel.png'); await page.keyboard.press('Escape')
        await page.click('#view-seg button[data-view=analysis]'); await page.wait_for_selector('.an-legend'); await page.wait_for_timeout(400)
        print('analysis legend (color):', await page.inner_text('.an-legend'))
        await page.select_option('[data-o=by]', 'source'); await page.wait_for_timeout(500)
        print('analysis legend (source):', await page.inner_text('.an-legend'))
        await page.screenshot(path=f'{OUT}/s3-analysis-google.png')
        await page.click('#view-seg button[data-view=week]'); await page.wait_for_timeout(300)
        # reload page (fresh state from storage) -> no duplicates
        await page.reload(); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(2500)
        print('after reload:', len(g.task_events()))
        # Delete series
        await page.click('.task-row'); await page.click('dialog .del'); await page.click('dialog .choice-btn')
        await page.wait_for_timeout(2500)
        print('after delete series:', len(g.task_events()))
        print('requests:', len(g.log)); print('ERRORS:', errs)
        await b.close()
import re
try: asyncio.run(main())
finally: srv.terminate()
