# Compact dialogs: the event, task and settings dialogs show only the essentials; the rest sits in sections that are
# collapsed by default (with a one-line summary) and open with the ▾ arrow. Category and color share one row.
import asyncio, sys, subprocess, time, re
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8815','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
INIT = """
const FIX = Date.parse('2026-10-20T06:00:00Z'); const _Date = Date; globalThis.__off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false, goalNotice: false}));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2026-10-19'));
}"""
ok = []
def check(label, cond, extra=''):
    ok.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + label, extra)

async def sects(page):
    return await page.eval_on_selector_all('dialog[open] details.sect', 'ds => ds.map(d => [d.dataset.sect, d.open, d.querySelector(".sect-s").textContent])')

async def run(p, name, kw):
    g = MockGoogle(); errs = []
    b = await p.chromium.launch()
    ctx = await b.new_context(**kw, timezone_id='Europe/Berlin', compact_ui=True)
    await ctx.add_init_script(INIT)
    await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
    page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
    await page.goto('http://localhost:8815/app.html'); await page.wait_for_selector('.tg-col'); await page.wait_for_function('window.tempo'); await page.wait_for_timeout(1500)
    tap = page.tap if kw.get('has_touch') else page.click

    # ---------- event dialog
    await page.evaluate("document.querySelector('#btn-new-event, #btn-new') && 0")
    cols = await page.query_selector_all('.tg-col'); col = cols[min(2, len(cols) - 1)]
    await col.scroll_into_view_if_needed(); box = await col.bounding_box(); hh = await page.evaluate('window.__tempo.app.state.settings.hourHeight')
    top = await page.evaluate("document.querySelector('.tg-col').getBoundingClientRect().top")
    await page.evaluate(f"document.querySelector('.tg-scroll, .tg-body, .grid-scroll')?.scrollTo?.(0, {int(9 * hh)})"); await page.wait_for_timeout(200)
    box = await col.bounding_box()
    await page.mouse.move(box['x'] + 15, box['y'] + 10 * hh + 2); await page.mouse.down(); await page.mouse.move(box['x'] + 15, box['y'] + 11 * hh - 2, steps=5); await page.mouse.up()
    await page.wait_for_selector('.popover .qc'); await page.fill('.popover [name=title]', 'Dentist')
    await page.click('.popover .more'); await page.wait_for_selector('dialog[open] .event-form')
    await page.wait_for_timeout(300)
    ss = await sects(page)
    print(name, 'event sections:', ss)
    check(f'{name}: event sections collapsed by default', ss and all(not o for _, o, _ in ss) and [x[0] for x in ss] == ['ev-notify', 'ev-more'])
    check(f'{name}: notify summary', '🔔' in ss[0][2] and 'Does not repeat' in ss[0][2], ss[0][2])
    check(f'{name}: more summary names the calendar and Busy', 'Busy' in ss[1][2], ss[1][2])
    for fld in ['tz', 'freq', 'calId', 'transparency', 'visibility', 'location', 'attendees']:
        check(f'{name}: event field {fld} hidden', not await page.is_visible(f'dialog[open] [name={fld}]'))
    same_row = await page.evaluate("(() => { const c = document.querySelector('dialog[open] .ev-cat-host'), s = document.querySelector('dialog[open] input[name=colorId]'); return c.closest('.row') === s.closest('.row'); })()")
    check(f'{name}: category and color in one row', same_row)
    h = await page.evaluate("document.querySelector('dialog[open] .event-form').scrollHeight")
    print(f'  event form height: {h}px')
    await page.screenshot(path=f'{OUT}/z-{name}-event.png')
    # expand "More", set a location; expand notifications & repeat, pick weekly
    await tap('dialog[open] details[data-sect=ev-more] > summary'); await page.wait_for_timeout(200)
    check(f'{name}: More opens on click', await page.is_visible('dialog[open] [name=location]'))
    await page.fill('dialog[open] [name=location]', 'Main St 1')
    await tap('dialog[open] details[data-sect=ev-notify] > summary'); await page.wait_for_timeout(200)
    await page.select_option('dialog[open] [name=freq]', 'WEEKLY')
    await page.screenshot(path=f'{OUT}/z-{name}-event-open.png', full_page=False)
    await tap('dialog[open] details[data-sect=ev-more] > summary'); await page.wait_for_timeout(150)
    s2 = await page.text_content('dialog[open] details[data-sect=ev-more] .sect-s')
    check(f'{name}: summary shows the location after closing', 'Main St 1' in s2, s2)
    await tap('dialog[open] details[data-sect=ev-notify] > summary'); await page.wait_for_timeout(150)
    s3 = await page.text_content('dialog[open] details[data-sect=ev-notify] .sect-s')
    check(f'{name}: summary shows the repeat', 'eekly' in s3, s3)
    await tap('dialog[open] button[type=submit]'); await page.wait_for_timeout(1500)
    if await page.query_selector('dialog[open] :text("End it on")'):
        await tap('dialog[open] :text("End it on")'); await page.wait_for_timeout(1500)
    evs = [e for e in g.events['me@example.com'].values() if e.get('summary') == 'Dentist']
    check(f'{name}: event saved with location and weekly repeat', evs and evs[0].get('location') == 'Main St 1' and 'WEEKLY' in ''.join(evs[0].get('recurrence', [])), evs[:1])

    # ---------- task dialog
    await page.evaluate("document.querySelector('#btn-new-task').click()")
    await page.wait_for_selector('dialog[open] .task-form'); await page.wait_for_timeout(300)
    ss = await sects(page)
    print(name, 'task sections:', ss)
    check(f'{name}: task sections collapsed', [x[0] for x in ss] == ['t-notify', 't-project', 't-sessions', 't-when'] and not any(o for _, o, _ in ss))
    check(f'{name}: sessions summary', 'min sessions' in ss[2][2], ss[2][2])
    check(f'{name}: when summary', 'Work hours' in ss[3][2], ss[3][2])
    for fld in ['chunk', 'projectId', 'repEvery', 'notify', 'ignoreBounds']:
        check(f'{name}: task field {fld} hidden', not await page.is_visible(f'dialog[open] [name={fld}]'))
    for fld in ['title', 'hours', 'deadline', 'rank']:
        check(f'{name}: task field {fld} visible', await page.is_visible(f'dialog[open] [name={fld}]'))
    same_row = await page.evaluate("(() => { const c = document.querySelector('dialog[open] .cat-host'), s = document.querySelector('dialog[open] input[name=color]'); return c.closest('.row') === s.closest('.row'); })()")
    check(f'{name}: task category and color in one row', same_row)
    await page.screenshot(path=f'{OUT}/z-{name}-task.png')
    await page.fill('dialog[open] [name=title]', 'Essay')
    await tap('dialog[open] details[data-sect=t-sessions] > summary'); await page.wait_for_timeout(150)
    check(f'{name}: sessions opens', await page.is_visible('dialog[open] [name=chunk]'))
    await page.fill('dialog[open] [name=chunk]', '45')
    await tap('dialog[open] details[data-sect=t-sessions] > summary'); await page.wait_for_timeout(200)
    s4 = await page.text_content('dialog[open] details[data-sect=t-sessions] .sect-s')
    check(f'{name}: sessions summary updates', '45 min sessions' in s4, s4)
    await tap('dialog[open] details[data-sect=t-notify] > summary'); await page.wait_for_timeout(150)
    await page.select_option('dialog[open] [name=repEvery]', 'week'); await page.wait_for_timeout(200)
    check(f'{name}: repeating hides deadline', not await page.is_visible('dialog[open] [name=deadline]'))
    await page.select_option('dialog[open] [name=repEvery]', ''); await page.wait_for_timeout(200)
    await page.screenshot(path=f'{OUT}/z-{name}-task-open.png')
    await tap('dialog[open] button[type=submit]'); await page.wait_for_timeout(1500)
    t = await page.evaluate("window.__tempo.app.state.tasks.find(t => t.title === 'Essay')")
    check(f'{name}: task saved with 45-min sessions', t and t.get('chunkMinutes') == 45, t and t.get('chunkMinutes'))
    # reading kind hides total hours
    await page.evaluate("document.querySelector('#btn-new-task').click()"); await page.wait_for_selector('dialog[open] .task-form')
    await tap('dialog[open] .kind-seg label:has(input[value=reading])'); await page.wait_for_timeout(200)
    check(f'{name}: reading hides total hours, shows pages', not await page.is_visible('dialog[open] [name=hours]') and await page.is_visible('dialog[open] [name=pages]'))
    await page.keyboard.press('Escape'); await page.wait_for_timeout(300)
    if await page.query_selector('dialog[open]'): await page.click('dialog[open] [data-close] >> nth=-1'); await page.wait_for_timeout(300)

    # ---------- settings
    await page.evaluate("document.querySelector('#btn-settings').click()"); await page.wait_for_selector('dialog[open] .settings-form'); await page.wait_for_timeout(300)
    gen = await page.eval_on_selector_all('dialog[open] section[data-pane="0"] details.sect', 'ds => ds.map(d => [d.dataset.sect, d.open, d.querySelector(".sect-s").textContent])')
    print(name, 'settings/general:', gen)
    check(f'{name}: general settings grouped and collapsed', len(gen) == 5 and not any(o for _, o, _ in gen))
    check(f'{name}: time zone stays visible', await page.is_visible('dialog[open] [name=tz]'))
    await page.screenshot(path=f'{OUT}/z-{name}-settings.png')
    await tap('dialog[open] .tabs button[data-tab="1"]'); await page.wait_for_timeout(200)
    sch = await page.eval_on_selector_all('dialog[open] section[data-pane="1"] details.sect', 'ds => ds.map(d => [d.dataset.sect, d.open, d.querySelector(".sect-s").textContent])')
    print(name, 'settings/scheduling:', sch)
    check(f'{name}: scheduling grouped', len(sch) == 8 and not any(o for _, o, _ in sch) and '–' in sch[0][2])
    await page.screenshot(path=f'{OUT}/z-{name}-settings-sched.png')
    await tap('dialog[open] details[data-sect=s-sessions] > summary'); await page.wait_for_timeout(150)
    await page.fill('dialog[open] [name=chunkMinutes]', '50')
    await tap('dialog[open] .tabs button[data-tab="3"]'); await page.wait_for_timeout(150)
    nt = await page.eval_on_selector_all('dialog[open] section[data-pane="3"] details.sect', 'ds => ds.map(d => d.dataset.sect + ": " + d.querySelector(".sect-s").textContent)')
    print(name, 'settings/notifications:', nt)
    check(f'{name}: profiles summary names Default', 'Default' in nt[0], nt)
    await tap('dialog[open] .tabs button[data-tab="7"]'); await page.wait_for_timeout(150)
    rv = await page.eval_on_selector_all('dialog[open] section[data-pane="7"] details.sect', 'ds => ds.map(d => d.dataset.sect + ": " + d.querySelector(".sect-s").textContent)')
    print(name, 'settings/review:', rv)
    check(f'{name}: review grouped', len(rv) == 4)
    await tap('dialog[open] button[type=submit]'); await page.wait_for_timeout(1200)
    check(f'{name}: settings saved from a section', await page.evaluate('window.__tempo.app.state.settings.chunkMinutes') == 50)
    check(f'{name}: no page errors', not errs, errs)
    await b.close()

async def main():
    async with async_playwright() as p:
        await run(p, 'desktop', {'viewport': {'width': 1366, 'height': 860}})
        await run(p, 'phone', dict(p.devices['iPhone 13']))
try: asyncio.run(main())
finally: srv.terminate()
print('ALL PASS' if all(ok) else f'{ok.count(False)} FAILED')
