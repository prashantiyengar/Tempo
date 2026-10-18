import asyncio, sys, json, subprocess, time, os
from playwright.async_api import async_playwright
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8765','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.8)
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width':1440,'height':900}, timezone_id='Europe/Berlin', accept_downloads=True)
        # Freeze time at Monday 2026-10-19 08:00 Berlin
        await ctx.add_init_script("""
          const FIX = Date.parse('2026-10-19T06:00:00Z'); const _Date = Date; const off = FIX - _Date.now();
          class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+off);} else super(...a);} static now(){ return _Date.now()+off; } }
          globalThis.Date = D;
        """)
        page = await ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.on('console', lambda m: errs.append('console:'+m.text) if m.type=='error' else None)
        await page.goto('http://localhost:8765/app.html')
        await page.wait_for_selector('.tg-col')
        await page.screenshot(path=f'{OUT}/01-empty.png')

        # Drag to create an event Monday 10:00-11:30
        cols = await page.query_selector_all('.tg-col')
        box = await cols[0].bounding_box()
        hh = 48
        sc = await page.query_selector('.tg-scroll')
        top = await sc.evaluate('e=>e.scrollTop')
        y10 = box['y'] + 10*hh ; y1130 = box['y'] + 11.5*hh
        await page.mouse.move(box['x']+30, y10+2); await page.mouse.down()
        await page.mouse.move(box['x']+30, y10+30, steps=5); await page.mouse.move(box['x']+30, y1130-2, steps=5)
        await page.screenshot(path=f'{OUT}/02-dragging.png')
        await page.mouse.up()
        await page.wait_for_selector('.popover .qc')
        await page.fill('.qc input[name=title]', 'Team standup')
        await page.screenshot(path=f'{OUT}/03-quick-create.png')
        await page.click('.qc button[type=submit]')
        await page.wait_for_timeout(500)
        evs = await page.eval_on_selector_all('.ev:not(.chunk)', 'els=>els.map(e=>e.textContent.trim())')
        print('events after create:', evs)

        # Create recurring local event via full dialog: weekly lunch Tue/Thu 12:00
        await page.evaluate("document.querySelector('#btn-new-event').click()")
        await page.wait_for_selector('dialog .event-form')
        await page.fill('dialog [name=summary]', 'Gym')
        await page.fill('dialog [name=sDate]', '2026-10-20'); await page.fill('dialog [name=eDate]', '2026-10-20')
        await page.fill('dialog [name=sTime]', '17:30'); await page.fill('dialog [name=eTime]', '18:30')
        await page.select_option('dialog [name=freq]', 'WEEKLY')
        await page.click('dialog .wd:has(input[value="4"])')
        await page.screenshot(path=f'{OUT}/04-event-dialog.png')
        await page.click('dialog button[type=submit]')
        await page.wait_for_timeout(500)

        # Reading task: Pride and Prejudice 200 pages from p.47 at 20 pages/hour
        await page.click('#btn-new-reading')
        await page.wait_for_selector('dialog .task-form')
        await page.fill('dialog [name=title]', 'Pride and Prejudice')
        await page.fill('dialog [name=pages]', '200'); await page.fill('dialog [name=startPage]', '47'); await page.fill('dialog [name=speed]', '20')
        await page.fill('dialog [name=deadline]', '2026-10-23T17:00')
        await page.fill('dialog [name=rank]', '3')
        await page.wait_for_timeout(300)
        await page.screenshot(path=f'{OUT}/05-reading-dialog.png')
        await page.click('dialog button[type=submit]')
        await page.wait_for_timeout(800)
        await page.screenshot(path=f'{OUT}/06-week-with-reading.png')
        labels = await page.eval_on_selector_all('.ev.chunk .ev-t', 'els=>els.map(e=>e.textContent.trim())')
        print('chunks:', labels[:3], '... total', len(labels))

        # Rank-2 task that must push the reading
        await page.click('#btn-new-task')
        await page.wait_for_selector('dialog .task-form')
        await page.fill('dialog [name=title]', 'Grant report')
        await page.fill('dialog [name=hours]', '6')
        await page.fill('dialog [name=deadline]', '2026-10-20T17:00')
        await page.fill('dialog [name=rank]', '2')
        await page.click('dialog button[type=submit]')
        await page.wait_for_timeout(900)
        await page.screenshot(path=f'{OUT}/07-rank-push.png')
        st = await page.evaluate("(()=>{const a=window.__tempo; return a.app.state.tasks.map(t=>({title:t.title, s:a.S.sessions(t).map(x=>a.T.toDTInput(x.start,'Europe/Berlin')+' '+x.label)}))})()")
        for t in st: print(t['title'], t['s'][:4], len(t['s']))

        # Click a reading session -> delete one session
        chunk = await page.query_selector('.ev.chunk:has-text("Pride")')
        await chunk.click()
        await page.wait_for_selector('.popover .pop')
        await page.screenshot(path=f'{OUT}/08-chunk-popover.png')
        await page.click('.popover .del')
        await page.wait_for_selector('dialog .choice')
        await page.screenshot(path=f'{OUT}/09-delete-choice.png')
        await page.click('dialog .choice-btn >> nth=0')
        await page.wait_for_timeout(800)

        # Tight task -> not enough time prompt
        await page.click('#btn-new-task')
        await page.wait_for_selector('dialog .task-form')
        await page.fill('dialog [name=title]', 'Thesis chapter')
        await page.fill('dialog [name=hours]', '30')
        await page.fill('dialog [name=deadline]', '2026-10-22T17:00')
        await page.fill('dialog [name=rank]', '1')
        await page.wait_for_timeout(300)
        await page.screenshot(path=f'{OUT}/10-task-dialog-warning.png')
        await page.click('dialog button[type=submit]')
        await page.wait_for_selector('dialog .problem', timeout=5000)
        await page.screenshot(path=f'{OUT}/11-problem.png')
        await page.click('dialog .choice-btn[data-a=deadline]')
        await page.wait_for_timeout(1000)
        n=0
        while await page.query_selector('dialog .problem') and n<5:
            n+=1; await page.screenshot(path=f'{OUT}/11b-problem-{n}.png')
            t = await page.text_content('dialog .problem h2'); print('extra prompt:', t)
            await page.click('dialog .choice-btn[data-a=deadline]'); await page.wait_for_timeout(1000)
        await page.screenshot(path=f'{OUT}/12-after-deadline.png')

        # Month view
        await page.click('#view-seg button[data-view=month]')
        await page.wait_for_timeout(500)
        await page.screenshot(path=f'{OUT}/13-month.png')
        await page.click('#view-seg button[data-view=week]')
        await page.wait_for_timeout(300)

        # Exports
        for kind, fmt in [('week','pdf'),('week','png'),('month','pdf'),('month','png')]:
            await page.click('#btn-export')
            async with page.expect_download() as dl:
                await page.click(f'#export-menu button[data-kind={kind}][data-fmt={fmt}]')
            d = await dl.value
            path = f'{OUT}/export-{kind}.{fmt}'
            await d.save_as(path)
            print('exported', path, os.path.getsize(path))

        # Multi-page export: 4 weeks PDF, 3 weeks TIFF
        for fmt, n in [('pdf', 4), ('tiff', 3)]:
            await page.click('#btn-export'); await page.click('#export-multi')
            await page.wait_for_selector('dialog .export-form')
            await page.fill('dialog [name=count]', str(n))
            await page.click(f'dialog label:has(input[name=fmt][value={fmt}])')
            if fmt == 'pdf': await page.screenshot(path=f'{OUT}/16-export-dialog.png')
            async with page.expect_download(timeout=60000) as dl:
                await page.click('dialog button[type=submit]')
            d = await dl.value; path = f'{OUT}/multi.{"tif" if fmt=="tiff" else "pdf"}'
            await d.save_as(path); print('multi export', path, os.path.getsize(path))

        # Analysis
        await page.click('#view-seg button[data-view=analysis]')
        await page.wait_for_selector('.an-tiles'); await page.wait_for_timeout(300)
        await page.screenshot(path=f'{OUT}/17-analysis.png', full_page=False)
        tiles = await page.eval_on_selector_all('.tile', 'els=>els.map(e=>e.innerText.split(String.fromCharCode(10)).join(" | "))'); print('tiles:', tiles)
        await page.select_option('[data-o=scope]', 'outside'); await page.wait_for_timeout(400)
        print('outside tiles:', await page.eval_on_selector_all('.tile', 'els=>els.slice(0,3).map(e=>e.innerText.split(String.fromCharCode(10)).join(" | "))'))
        await page.select_option('[data-o=scope]', 'bounds'); await page.select_option('[data-o=period]', 'next30'); await page.select_option('[data-o=by]', 'source'); await page.wait_for_timeout(500)
        await page.hover('.an-cols rect >> nth=3'); await page.wait_for_timeout(100)
        await page.screenshot(path=f'{OUT}/18-analysis-30d.png')
        await page.select_option('[data-o=by]', 'color'); await page.select_option('[data-o=period]', 'next7'); await page.wait_for_timeout(400)
        await page.click('.lbl-edit >> nth=0'); await page.fill('dialog [name=v]', 'Deep work'); await page.click('dialog button.primary'); await page.wait_for_timeout(400)
        print('renamed:', await page.text_content('.lbl-edit >> nth=0'))
        await page.click('#view-seg button[data-view=week]'); await page.wait_for_timeout(300)

        # Banner (local mode with tasks) + wizard
        print('banner:', await page.eval_on_selector('#banner', 'b=>b.hidden ? "(hidden)" : b.innerText'))
        await page.click('#banner [data-b=connect]')
        await page.wait_for_selector('dialog .wizard-form')
        await page.screenshot(path=f'{OUT}/19-wizard-1.png')
        await page.click('dialog .wz-steps button[data-s="3"]'); await page.screenshot(path=f'{OUT}/20-wizard-4.png')
        await page.click('dialog .wz-steps button[data-s="4"]'); await page.fill('dialog [name=cid]', 'GOCSPX-abc'); await page.screenshot(path=f'{OUT}/21-wizard-5.png')
        await page.keyboard.press('Escape')
        await page.click('#sync-status'); await page.wait_for_selector('dialog .syncdlg'); await page.screenshot(path=f'{OUT}/22-syncpanel-local.png'); await page.keyboard.press('Escape')

        # Settings
        await page.click('#btn-settings')
        await page.wait_for_selector('dialog .settings-form')
        await page.click('dialog .tabs button[data-tab="1"]')
        await page.screenshot(path=f'{OUT}/14-settings.png')
        await page.click('dialog .tabs button[data-tab="2"]')
        await page.screenshot(path=f'{OUT}/14b-settings-google.png')
        await page.keyboard.press('Escape')

        # Dark mode
        await page.emulate_media(color_scheme='dark')
        await page.wait_for_timeout(200)
        await page.screenshot(path=f'{OUT}/15-dark.png')
        print('ERRORS:', errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
