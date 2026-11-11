# Round 62: repeating tasks anchored to the start day (every 3 weeks after hours), the "Create repeating task"
# panel with its preview, ↶ to put the end back after changing From, sidebar tabs show one section each.
import sys, json
sys.path.insert(0, 'test')
from harness import App

NOW = '2026-11-01T13:00:00Z'   # Sun 1 Nov 2026, 14:00 in Berlin
TZ = 'Europe/Berlin'
WEDS = ['2026-11-04', '2026-11-25', '2026-12-16', '2027-01-06', '2027-01-27']

async def run_cmd(page, cmds):
    raw = await page.evaluate(f'async () => JSON.stringify(await window.tempo.run({json.dumps(cmds)}))')
    return json.loads(raw)

def res(rv):
    r = rv[0].get('result') if rv else None
    return r.get('result', r) if isinstance(r, dict) and 'result' in r else r

async def sessions(page, task):
    return res(await run_cmd(page, [{'cmd': 'listSessions', 'task': task, 'from': '2026-11-01', 'to': '2027-04-01'}])) or []

async def type_time(page, sel, digits):
    box = await page.locator(sel).bounding_box()
    await page.mouse.click(box['x'] + 8, box['y'] + box['height'] / 2)
    await page.keyboard.type(digits); await page.keyboard.press('Tab'); await page.wait_for_timeout(200)

async def main(app):
    # ——— 1. API: every 3 weeks from Wed 4 Nov, after hours, one block, on the start day ———
    page = await app.page(settings={'tz': TZ}, now=NOW, wait=2500)
    page.set_default_timeout(8000)
    r = await run_cmd(page, [{'cmd': 'addTask', 'title': 'Deep clean', 'repeat': {'every': 'week', 'interval': 3, 'hours': 2, 'on': 'day'}, 'start': '2026-11-04', 'period': 'After hours', 'single': True}])
    app.check('1. anchored repeat created', r and not r[0].get('error'), r)
    await page.wait_for_timeout(1500)
    ss = await sessions(page, 'Deep clean')
    days = [x['start'][:10] for x in ss]
    app.check('2. five sessions, every 3 weeks on Wednesdays (not all on the first day)', days == WEDS, days)
    app.check('3. each in the after-hours window, one 2h block', all(x['start'][11:] == '17:30' and x['minutes'] == 120 for x in ss), [(x['start'], x['minutes']) for x in ss])
    app.check('4. labelled by their day', ss and ss[0]['label'].endswith('Wed 4 Nov'), ss[0]['label'] if ss else None)
    # any day within each 3-week period
    r = await run_cmd(page, [{'cmd': 'addTask', 'title': 'Windows', 'repeat': {'every': 'week', 'interval': 3, 'hours': 1, 'on': 'period', 'count': 3}, 'start': '2026-11-04', 'period': 'After hours', 'single': True}])
    await page.wait_for_timeout(1500)
    ss = await sessions(page, 'Windows')
    app.check('5. "period" mode: one session in each 3-week period from the start day', len(ss) == 3 and all(a <= x['start'][:10] < b for x, a, b in zip(ss, ['2026-11-04', '2026-11-25', '2026-12-16'], ['2026-11-25', '2026-12-16', '2027-01-06'])), [x['start'] for x in ss])
    # monthly on the 31st keeps the day (last day of shorter months)
    r = await run_cmd(page, [{'cmd': 'addTask', 'title': 'Invoices', 'repeat': {'every': 'month', 'hours': 1, 'on': 'day', 'count': 4}, 'start': '2026-12-31', 'ignoreBounds': True, 'single': True}])
    await page.wait_for_timeout(1500)
    ss = await sessions(page, 'Invoices')
    app.check('6. monthly on the 31st: 31 Dec, 31 Jan, 28 Feb, 31 Mar', [x['start'][:10] for x in ss] == ['2026-12-31', '2027-01-31', '2027-02-28', '2027-03-31'], [x['start'] for x in ss])
    await page.close()

    # ——— 2. The task dialog: "Create repeating task" panel and preview ———
    # (the fake Google account is shared between pages: part 1's tasks are on this calendar too, so use a new day)
    page = await app.page(settings={'tz': TZ}, now=NOW, wait=2500)
    page.set_default_timeout(8000)
    await run_cmd(page, [{'cmd': 'deleteTask', 'task': 'Deep clean'}, {'cmd': 'deleteTask', 'task': 'Windows'}, {'cmd': 'deleteTask', 'task': 'Invoices'}])
    await page.wait_for_timeout(1500)
    await page.click('#btn-new-task'); await page.wait_for_selector('dialog .task-form')
    app.check('7. repeat toggle right after the title', await page.evaluate("(() => { const t = document.querySelector('dialog [name=title]'); return t.nextElementSibling?.querySelector('[name=repOn]') ? true : false; })()"))
    app.check('8. panel hidden until ticked', not await page.is_visible('dialog .rep-panel'))
    await page.fill('dialog [name=title]', 'Gutters')
    await page.check('dialog [name=repOn]')
    await page.fill('dialog [name=repStart]', '2026-11-04')
    await page.fill('dialog [name=repInterval]', '3')
    await page.fill('dialog [name=repHours]', '2')
    await page.select_option('dialog [name=repWin]', 'period:after-hours')
    await page.wait_for_timeout(800)
    app.check('9. From and To are hidden', not await page.is_visible('dialog [name=earliest]') and not await page.is_visible('dialog [name=deadline]'))
    app.check('10. one block by default for repeats', await page.evaluate("document.querySelector('dialog [name=blockmode]:checked').value") == 'single')
    app.check('11. "During" sets When to schedule', await page.evaluate("document.querySelector('dialog [name=bmode]:checked').value") == 'period:after-hours')
    summ = await page.text_content('dialog .rep-sum')
    app.check('12. summary: every 3 weeks on Wednesday, 5 times', 'every 3 weeks on Wednesday' in summ and '5 times' in summ and 'After hours' in summ, summ)
    pv = await page.inner_text('dialog .preview')
    app.check('13. preview lists all 5 sessions it will add', 'Will add 5 sessions' in pv and pv.count('17:30–19:30') == 5 and 'Jan 27' in pv, pv)
    # the default end follows the start and frequency until changed
    await page.fill('dialog [name=repInterval]', '1'); await page.wait_for_timeout(500)
    app.check('14. default end follows the frequency (weekly: 10 times)', await page.input_value('dialog [name=repCount]') == '10')
    await page.fill('dialog [name=repInterval]', '3'); await page.wait_for_timeout(500)
    await page.click('dialog .task-form button[type=submit]'); await page.wait_for_timeout(2500)
    ss = await sessions(page, 'Gutters')
    app.check('15. saving adds what the preview showed', [x['start'][:10] for x in ss] == WEDS and all(x['start'][11:] == '17:30' for x in ss), [x['start'] for x in ss])
    # editing it shows the panel with its values
    await page.evaluate("import('./js/undo.js').then(m => { m.editTask(window.__tempo.app.state.tasks.find(t => t.title === 'Gutters')); })")
    await page.wait_for_selector('dialog .task-form')
    await page.wait_for_timeout(500)
    app.check('16. editing: panel open with start, every 3 weeks, 5 times', await page.is_checked('dialog [name=repOn]') and await page.input_value('dialog [name=repStart]') == '2026-11-04' and await page.input_value('dialog [name=repInterval]') == '3' and await page.input_value('dialog [name=repCount]') == '5')
    await page.keyboard.press('Escape')
    await page.close()

    # ——— 3. ↶ puts the end back after changing From ———
    # (since Round 65 From and To are independent by default; this is the optional 'From moves To' behaviour)
    page = await app.page(settings={'tz': TZ, 'linkTimes': True}, now='2026-11-02T08:00:00Z', wait=2500)
    page.set_default_timeout(8000)
    await page.click('#btn-new-event'); await page.wait_for_selector('dialog [name=sTime]')
    await type_time(page, 'dialog [name=sTime]', '1000'); await type_time(page, 'dialog [name=eTime]', '1630')
    app.check('17. no ↶ before From changes', not await page.query_selector('dialog .revert-btn'))
    await type_time(page, 'dialog [name=sTime]', '1400')
    app.check('18. changing From keeps the length (To 20:30)', await page.input_value('dialog [name=eTime]') == '20:30')
    btn = await page.query_selector('dialog .revert-btn')
    app.check('19. a tiny ↶ offers the earlier end', btn and '16:30' in (await btn.text_content()), await btn.text_content() if btn else None)
    await type_time(page, 'dialog [name=sTime]', '1500')
    app.check('20. after moving From again it still offers the original end', '16:30' in (await page.text_content('dialog .revert-btn')))
    await page.click('dialog .revert-btn')
    app.check('21. ↶ puts back 16:30 and keeps the new start', await page.input_value('dialog [name=sTime]') == '15:00' and await page.input_value('dialog [name=eTime]') == '16:30' and not await page.query_selector('dialog .revert-btn'))
    await type_time(page, 'dialog [name=sTime]', '1700')
    app.check('22. no ↶ when the old end would be before the new start', not await page.is_visible('dialog .revert-btn') if await page.query_selector('dialog .revert-btn') else True)
    await page.keyboard.press('Escape'); await page.wait_for_timeout(300)
    # quick create
    await page.evaluate("document.querySelector('.tg-scroll').scrollTop = 9 * window.__tempo.app.state.settings.hourHeight")
    cols = await page.query_selector_all('.tg-col'); box = await cols[1].bounding_box(); hh = await page.evaluate('window.__tempo.app.state.settings.hourHeight')
    top = await page.evaluate("document.querySelectorAll('.tg-col')[1].getBoundingClientRect().top")
    await page.mouse.move(box['x'] + 20, top + 10 * hh + 2); await page.mouse.down(); await page.mouse.move(box['x'] + 20, top + 11 * hh - 2, steps=4); await page.mouse.up()
    await page.wait_for_selector('.popover [name=qs]')
    before = await page.input_value('.popover [name=qe]')
    await type_time(page, '.popover [name=qs]', '1030')
    qb = await page.query_selector('.popover .revert-btn')
    app.check('23. quick create: ↶ next to To after changing From', qb and before in (await qb.text_content()), (before, await qb.text_content() if qb else None))
    await page.close()

    # ——— 4. Sidebar tabs show only their own section ———
    page = await app.page(settings={'tz': TZ, 'later': [{'id': 'l1', 'text': 'Buy paint', 'created': 1}], 'notes': [{'id': 'n1', 'text': 'Idea', 'at': 1}]}, now=NOW, wait=2500)
    secs = {'tasks': '#task-list', 'later': '#later-list', 'projects': '#proj-list', 'habits': '#habit-list', 'notes': '#note-list', 'graveyard': '#grave-list'}
    bad = {}
    for t, sel in secs.items():
        await page.click(f'.side-tabs [data-st={t}]'); await page.wait_for_timeout(300)
        vis = await page.evaluate(f"{json.dumps(list(secs.values()))}.filter(s => {{ const e = document.querySelector(s); return e && getComputedStyle(e).display !== 'none'; }})")
        if vis != [sel]: bad[t] = vis
    app.check('24. each sidebar tab shows only its section', not bad, bad)
    await page.close()

App.run(main, port=8963)
