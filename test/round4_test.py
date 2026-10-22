# Tests for: categories/icons shared across devices, more icons + custom colors, partly done sessions (reading and
# generic, with the block split for an interruption), and parallel sync with read-back verification + fault recovery.
import asyncio, sys, subprocess, time, re, json
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8773','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
INIT = """
const FIX = Date.parse('2026-10-19T05:30:00Z'); const _Date = Date; const off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+off);} else super(...a);} static now(){ return _Date.now()+off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false, goalNotice: false}));
}"""
APP = 'http://localhost:8773/app.html'

def dt(e, k='start'): return e[k]['dateTime']
def local_hm(iso):
    import datetime
    d = datetime.datetime.fromisoformat(iso.replace('Z', '+00:00')).astimezone(datetime.timezone(datetime.timedelta(hours=2)))
    return d.strftime('%a %H:%M')

async def main():
    g = MockGoogle(); errs = []
    async with async_playwright() as p:
        b = await p.chromium.launch()
        async def device(name):
            ctx = await b.new_context(viewport={'width': 1440, 'height': 900}, timezone_id='Europe/Berlin')
            await ctx.add_init_script(INIT)
            await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
            page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(f'{name}: {e}'))
            await page.goto(APP); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(1500)
            return page
        A = await device('A')
        cats = lambda pg: pg.evaluate("window.__tempo.app.state.settings.categories.map(c => (c.icon || '') + ' ' + c.name + ' ' + c.color).join(' | ')")

        # 1. Device A: change Study's icon, add a category with a new icon and a custom color
        await A.click('#btn-settings'); await A.click('dialog .tabs button[data-tab="5"]')
        row = 'dialog .cat-row:has(.cat-nm[value="Study"])'
        await A.click(f'{row} .cat-icbtn'); await A.click(f'{row} .ic-btn:has-text("🎓")')
        await A.click('dialog .add-cat'); await A.fill('dialog .cat-row >> nth=-1 >> .cat-nm', 'Music')
        last = 'dialog .cat-row >> nth=-1'
        await A.click(f'{last} >> .cat-icbtn'); await A.click(f'{last} >> .ic-btn:has-text("🎸")')
        await A.eval_on_selector(f'.cat-row:last-child .sw-color', "e => { e.value = '#123456'; e.dispatchEvent(new Event('input', {bubbles: true})); }")
        await A.click(f'{last} >> .cat-icbtn'); await A.screenshot(path=f'{OUT}/s1-more-icons.png'); await A.click(f'{last} >> .cat-icbtn')
        print('1. icon choices:', await A.eval_on_selector_all(f'{row} .ic-btn', 'e => e.length'), '| color swatches:', await A.eval_on_selector_all(f'{row} .sw', 'e => e.length'))
        await A.click('dialog button[type=submit] >> nth=-1'); await A.wait_for_timeout(2500)
        print('   A:', await cats(A))
        se = [e for evs in g.events.values() for e in evs.values() if e.get('extendedProperties', {}).get('private', {}).get('tempoSettings')]
        print('   settings record on Google:', len(se), '| date', se[0]['start'] if se else None)

        # 2. Device B (fresh) gets them
        B = await device('B')
        print('2. B:', await cats(B))
        # B changes Work's icon -> A picks it up on its next refresh
        await B.click('#btn-settings'); await B.click('dialog .tabs button[data-tab="5"]')
        row = 'dialog .cat-row:has(.cat-nm[value="Work"])'
        await B.click(f'{row} .cat-icbtn'); await B.fill(f'{row} .cat-icin', '🧑‍💻'); await B.click(f'{row} .cat-icbtn')
        await B.click('dialog button[type=submit] >> nth=-1'); await B.wait_for_timeout(2500)
        await A.evaluate("window.__tempo.cycle({ pull: true })"); await A.wait_for_timeout(1500)
        print('   A after B edit:', await cats(A))

        # 3. Reading task on A, first session partly done: 7 of 15 pages, 20-min call at the start, squeeze
        await A.click('#btn-new-reading'); await A.wait_for_selector('dialog .task-form')
        await A.fill('dialog [name=title]', 'Pride and Prejudice'); await A.fill('dialog [name=pages]', '90'); await A.fill('dialog [name=startPage]', '47')
        await A.fill('dialog [name=deadline]', '2026-10-30T17:00'); await A.click('dialog .cat-host .cat-cur'); await A.click('dialog .cat-chip:has-text("Study")')
        await A.click('dialog .task-form button[type=submit]'); await A.wait_for_timeout(3000)
        evs = lambda: sorted([e for e in g.task_events() if 'Pride' in e['summary']], key=dt)
        before = evs()
        print('3. sessions:', len(before), '|', before[0]['summary'], local_hm(dt(before[0])), '-', local_hm(dt(before[0], 'end')))
        await A.click('.ev.chunk:has-text("Pride") >> nth=0'); await A.click('.popover .partial'); await A.wait_for_selector('dialog .partial')
        await A.fill('dialog [name=pages]', '7'); await A.check('dialog [name=fit][value=squeeze]')
        await A.check('dialog [name=split]'); await A.fill('dialog [name=otherMin]', '20'); await A.fill('dialog [name=evTitle]', 'Phone call')
        print('   preview:', await A.text_content('dialog .split-preview'), '|', await A.text_content('dialog .pg-to'))
        await A.screenshot(path=f'{OUT}/s2-partial-reading.png')
        await A.click('dialog .partial button[type=submit]'); await A.wait_for_timeout(3500)
        after = evs()
        call = [e for evs_ in g.events.values() for e in evs_.values() if e.get('summary') == 'Phone call']
        print('   call:', [(local_hm(dt(e)), local_hm(dt(e, 'end'))) for e in call])
        print('   session 1:', after[0]['summary'], local_hm(dt(after[0])), '-', local_hm(dt(after[0], 'end')), '| credit', after[0]['extendedProperties']['private'].get('tCredit'))
        print('   count', len(before), '->', len(after), '| same later times:', [dt(e) for e in before[1:]] == [dt(e) for e in after[1:]], '| last:', after[-1]['summary'])
        await A.screenshot(path=f'{OUT}/s3-after-partial.png')
        # B sees the same
        await B.evaluate("window.__tempo.cycle({ pull: true })"); await B.wait_for_timeout(2000)
        print('   B labels:', await B.evaluate("window.__tempo.S.sessions(window.__tempo.app.state.tasks.find(t => t.title === 'Pride and Prejudice')).slice(0, 3).map(s => s.label + ' ' + s.minutes + 'm')"))

        # 4. Generic task: second session 50% done, add time for the rest (no split)
        await A.click('#btn-new-task'); await A.wait_for_selector('dialog .task-form')
        await A.fill('dialog [name=title]', 'Grant report'); await A.fill('dialog [name=hours]', '3'); await A.fill('dialog [name=deadline]', '2026-10-30T17:00')
        await A.click('dialog .task-form button[type=submit]'); await A.wait_for_timeout(3000)
        await A.click('.ev.chunk:has-text("Grant") >> nth=0'); await A.click('.popover .partial'); await A.wait_for_selector('dialog .partial')
        await A.fill('dialog [name=pct]', '50'); await A.click('dialog .partial button[type=submit]'); await A.wait_for_timeout(3000)
        gr = sorted([e for e in g.task_events() if 'Grant' in e['summary']], key=dt)
        tot = sum((__import__('datetime').datetime.fromisoformat(dt(e, 'end').replace('Z', '+00:00')) - __import__('datetime').datetime.fromisoformat(dt(e).replace('Z', '+00:00'))).seconds // 60 for e in gr)
        print('4. grant:', [e['summary'] for e in gr], '| minutes on calendar', tot, '| progress', await A.evaluate("JSON.stringify(window.__tempo.S.progress(window.__tempo.app.state.tasks.find(t => t.title === 'Grant report')))"))

        # 5. Parallel sync under faults: slow API, temporary errors, rate limits, and lost inserts
        g.delay = 0.12; g.flaky_every = 7; g.rate_every = 11; g.lose_inserts = 3; g.max_inflight = 0
        t0 = time.time()
        await A.click('#btn-new-task'); await A.wait_for_selector('dialog .task-form')
        await A.fill('dialog [name=title]', 'Big project'); await A.fill('dialog [name=hours]', '18'); await A.fill('dialog [name=deadline]', '2026-11-13T17:00')
        await A.click('dialog .task-form button[type=submit]')
        await A.wait_for_function("window.__tempo.app.state.syncInfo && window.__tempo.app.state.tasks.some(t => t.title === 'Big project') && window.__tempo.app.state.syncInfo.at > Date.now() - 60000 && window.__tempo.app.state.syncInfo.total >= 18", timeout=60000)
        await A.wait_for_timeout(4000)
        info = await A.evaluate("window.__tempo.app.state.syncInfo")
        bp = [e for e in g.task_events() if 'Big project' in e['summary']]
        want = await A.evaluate("window.__tempo.S.sessions(window.__tempo.app.state.tasks.find(t => t.title === 'Big project')).map(s => s.label)")
        print('5. max parallel requests:', g.max_inflight, '| took %.1fs' % (time.time() - t0), '| lost inserts left', g.lose_inserts)
        print('   on Google:', len(bp), 'of', len(want), '| all labels match:', sorted(e['summary'] for e in bp) == sorted(want), '| duplicates:', len(bp) - len({e['extendedProperties']['private']['chunkId'] for e in bp}))
        print('   syncInfo:', {k: info.get(k) for k in ('ok', 'total', 'verified', 'repaired', 'changed', 'error')})
        # Something deleted on Google directly gets restored on the next sync
        g.delay = 0; g.flaky_every = 0; g.rate_every = 0
        victim = bp[0]; cal = next(c for c, evs_ in g.events.items() if victim['id'] in evs_); del g.events[cal][victim['id']]
        await A.evaluate("window.__tempo.cycle({ pull: true })"); await A.wait_for_timeout(3000)
        bp2 = [e for e in g.task_events() if 'Big project' in e['summary']]
        print('   after deleting one on Google:', len(bp2), '| syncInfo repaired', (await A.evaluate("window.__tempo.app.state.syncInfo")).get('repaired'))
        await A.click('#sync-status')
        await A.wait_for_timeout(500); await A.screenshot(path=f'{OUT}/s4-sync-panel.png')
        print('ERRORS:', errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
