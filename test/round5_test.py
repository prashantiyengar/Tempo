# Deleting things must show up right away (no stale copies from Google's cached event list).
import asyncio, sys, subprocess, time, re
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8774','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
INIT = """
const FIX = Date.parse('2026-10-19T05:30:00Z'); const _Date = Date; const off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+off);} else super(...a);} static now(){ return _Date.now()+off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false}));
}"""
async def main():
    g = MockGoogle(); errs = []
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1440, 'height': 900}, timezone_id='Europe/Berlin')
        await ctx.add_init_script(INIT)
        await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8774/app.html'); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(1500)
        shown = lambda: page.eval_on_selector_all('.ev .ev-t, .task-row .tr-title', "e => e.map(x => x.textContent.trim()).filter(t => /Essay|Deck/.test(t)).length")
        async def mk(title):
            await page.click('#btn-new-task'); await page.wait_for_selector('dialog .task-form')
            await page.fill('dialog [name=title]', title); await page.fill('dialog [name=hours]', '4'); await page.fill('dialog [name=deadline]', '2026-10-23T17:00')
            await page.click('dialog .task-form button[type=submit]'); await page.wait_for_timeout(2500)
        await mk('Essay'); await mk('Deck')
        # visit another week and come back so Google's copies are in the cache
        await page.keyboard.press('ArrowRight'); await page.wait_for_timeout(800); await page.keyboard.press('t'); await page.wait_for_timeout(1500)
        print('before:', await shown(), '| on Google', len(g.task_events()))
        # delete the Essay series from a session popup
        await page.click('.ev.chunk:has-text("Essay") >> nth=0'); await page.click('.popover .del')
        await page.click('dialog .choice-btn:has-text("entire series")'); await page.wait_for_timeout(300)
        n_now = await page.eval_on_selector_all('.ev .ev-t', "e => e.filter(x => /Essay/.test(x.textContent)).length")
        await page.wait_for_timeout(3000)
        n_later = await page.eval_on_selector_all('.ev .ev-t', "e => e.filter(x => /Essay/.test(x.textContent)).length")
        print('1. Essay right after delete:', n_now, '| after sync:', n_later, '| sidebar:', await page.eval_on_selector_all('.task-row .tr-title', 'e => e.map(x => x.textContent.trim())'), '| Google Essay events:', len([e for e in g.task_events() if 'Essay' in e['summary']]))
        # delete via Edit task -> Delete
        await page.click('.task-row:has-text("Deck")'); await page.wait_for_selector('dialog .task-form')
        await page.click('dialog .task-form .del, dialog .task-form button:has-text("Delete")'); await page.click('dialog .choice-btn:has-text("entire series")'); await page.wait_for_timeout(300)
        print('2. Deck right after delete:', await page.eval_on_selector_all('.ev .ev-t', "e => e.filter(x => /Deck/.test(x.textContent)).length"))
        await page.wait_for_timeout(3000)
        print('   after sync:', await page.eval_on_selector_all('.ev .ev-t', "e => e.filter(x => /Deck/.test(x.textContent)).length"), '| Google Deck events:', len([e for e in g.task_events() if 'Deck' in e['summary']]))
        # event delete reflected immediately
        await page.click('#btn-new-event'); await page.wait_for_selector('dialog [name=summary]'); await page.fill('dialog [name=summary]', 'Dentist'); await page.click('dialog button[type=submit] >> nth=-1'); await page.wait_for_timeout(2000)
        await page.click('.ev:has-text("Dentist")'); await page.click('.popover .del, .popover button:has-text("Delete")'); await page.wait_for_timeout(300)
        if await page.query_selector('dialog .choice-btn'): await page.click('dialog .choice-btn >> nth=0')
        await page.wait_for_timeout(1500)
        print('3. Dentist after delete:', await page.eval_on_selector_all('.ev .ev-t', "e => e.filter(x => /Dentist/.test(x.textContent)).length"))
        await page.screenshot(path=f'{OUT}/d1.png')
        print('ERRORS:', errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
