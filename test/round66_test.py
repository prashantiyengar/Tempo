# Round 66: Tempo's own date picker with "Today" for every date field; project steps with a rank, and a note when a
# task moved, got a new deadline or is delayed against its original plan.
import sys, json
sys.path.insert(0, 'test')
from harness import App

TZ = 'Europe/Berlin'
NOW = '2026-11-12T09:00:00Z'   # Thu 10:00 Berlin

async def run_cmd(page, cmds):
    return json.loads(await page.evaluate(f'async () => JSON.stringify(await window.tempo.run({json.dumps(cmds)}))'))

async def main(app):
    # ——— 1. The date picker ———
    for dev, kw in [('desktop', {'viewport': {'width': 1400, 'height': 900}}), ('phone', {'device': 'Pixel 7'})]:
        p = await app.page(settings={'tz': TZ}, now=NOW, wait=2500, **kw)
        p.set_default_timeout(8000)
        tap = p.tap if dev == 'phone' else p.click
        await p.evaluate("document.getElementById('btn-new-event').click()"); await p.wait_for_selector('dialog [name=sDate]')
        await p.evaluate("document.querySelector('dialog [name=sDate]').value = '2026-12-03'")
        await tap('dialog [name=sDate]'); await p.wait_for_selector('dialog .dp-pop')
        app.check(f'1. {dev}: tapping a date opens the calendar on its month with the day selected', await p.text_content('dialog .dp-head b') == 'December 2026' and await p.text_content('dialog .dp-d.on') == '3')
        inside = await p.evaluate("(() => { const r = document.querySelector('.dp-pop').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })()")
        app.check(f'2. {dev}: it fits on the screen and has Today', inside and await p.is_visible('dialog .dp-today'))
        await tap('dialog .dp-nav[data-n="-1"]')
        app.check(f'3. {dev}: ‹ goes to the previous month', await p.text_content('dialog .dp-head b') == 'November 2026' and await p.text_content('dialog .dp-d.today') == '12')
        await tap('dialog .dp-today'); await p.wait_for_timeout(200)
        app.check(f'4. {dev}: Today sets today and closes', await p.input_value('dialog [name=sDate]') == '2026-11-12' and not await p.query_selector('.dp-pop'))
        await tap('dialog [name=eDate]'); await tap('dialog .dp-d[data-k="2026-11-20"]'); await p.wait_for_timeout(200)
        app.check(f'5. {dev}: picking a day sets the field', await p.input_value('dialog [name=eDate]') == '2026-11-20')
        await p.keyboard.press('Escape'); await p.wait_for_timeout(300)
        if await p.query_selector('dialog[open]'): await p.keyboard.press('Escape'); await p.wait_for_timeout(300)
        # date and time: Today keeps the time; the time can be set in the calendar
        await p.evaluate("document.getElementById('btn-new-task').click()"); await p.wait_for_selector('dialog [name=deadline]')
        await tap('dialog [name=deadline]'); await p.wait_for_selector('dialog .dp-pop')
        await tap('dialog .dp-today'); await p.wait_for_timeout(200)
        app.check(f'6. {dev}: date-and-time field: Today keeps its time (17:00)', await p.input_value('dialog [name=deadline]') == '2026-11-12T17:00')
        await p.fill('dialog .dp-time', '18:30'); await p.dispatch_event('dialog .dp-time', 'change')
        await tap('dialog .dp-done'); await p.wait_for_timeout(200)
        app.check(f'7. {dev}: its time set in the calendar, Done closes', await p.input_value('dialog [name=deadline]') == '2026-11-12T18:30' and not await p.query_selector('.dp-pop'))
        # Escape closes the calendar but not the dialog
        await tap('dialog [name=deadline]'); await p.wait_for_selector('dialog .dp-pop')
        await p.keyboard.press('Escape'); await p.wait_for_timeout(200)
        app.check(f'8. {dev}: Escape closes only the calendar', not await p.query_selector('.dp-pop') and bool(await p.query_selector('dialog[open] .task-form')))
        await p.keyboard.press('Escape'); await p.wait_for_timeout(300)
        # a date field outside dialogs (Later note's "by")
        if dev == 'phone': await p.tap('#btn-menu'); await p.wait_for_timeout(400)
        await tap('.side-tabs [data-st=later]'); await p.wait_for_timeout(300)
        await tap('#later-list input[name=d]'); await p.wait_for_selector('.dp-pop')
        await tap('.dp-today'); await p.wait_for_timeout(200)
        app.check(f'9. {dev}: a date field in the sidebar gets the calendar too', await p.input_value('#later-list input[name=d]') == '2026-11-12')
        await p.close()

    # ——— 2. Projects: rank, and notes about the original plan ———
    p = await app.page(settings={'tz': TZ, 'bounds': {'start': '09:00', 'end': '17:00', 'days': [1, 2, 3, 4, 5]}}, now=NOW, wait=2500)
    p.set_default_timeout(8000)
    await p.evaluate("import('./js/sidebar.js').then(m => { m.openProject(null); })"); await p.wait_for_selector('dialog .project-form')
    await p.fill('dialog [name=name]', 'Thesis')
    await p.click('dialog .pj-add[data-kind=task]'); await p.fill('dialog .pj-step:nth-child(1) .ps-title', 'Draft chapter'); await p.fill('dialog .pj-step:nth-child(1) .ps-rk', '1')
    await p.click('dialog .pj-add[data-kind=task]'); await p.fill('dialog .pj-step:nth-child(2) .ps-title', 'Revise')
    app.check('10. task steps have a Rank field (new ones start at 3)', await p.input_value('dialog .pj-step:nth-child(2) .ps-rk') == '3')
    await p.click('dialog .project-form button[type=submit]'); await p.wait_for_timeout(1500)
    ranks = json.loads(await p.evaluate("JSON.stringify(window.__tempo.app.state.tasks.map(t => [t.title, t.rank]))"))
    app.check('11. the ranks go onto the tasks', ['Thesis: Draft chapter', 1] in ranks and ['Thesis: Revise', 3] in ranks, ranks)
    # change rank in the project dialog later
    await p.evaluate("import('./js/sidebar.js').then(m => { m.openProject(window.__tempo.app.state.settings.projects[0]); })"); await p.wait_for_selector('dialog .project-form')
    await p.fill('dialog .pj-step:nth-child(2) .ps-rk', '2'); await p.click('dialog .project-form button[type=submit]'); await p.wait_for_timeout(1200)
    app.check('12. changing a rank in the project updates its task', await p.evaluate("window.__tempo.app.state.tasks.find(t => t.title === 'Thesis: Revise').rank") == 2)
    # the deadline is changed in the task itself
    await run_cmd(p, [{'cmd': 'updateTask', 'task': 'Draft chapter', 'deadline': '2026-11-23 17:00'}]); await p.wait_for_timeout(1200)
    card = await p.evaluate("document.querySelector('.pj-card')?.innerText || ''")
    app.check('13. the project card says a step moved from the plan', 'moved or delayed' in card, card)
    await p.evaluate("import('./js/sidebar.js').then(m => { m.openProject(window.__tempo.app.state.settings.projects[0]); })"); await p.wait_for_selector('dialog .project-form')
    app.check('14. the project shows the new deadline', await p.input_value('dialog .pj-step:nth-child(1) .ps-ed') == '2026-11-23')
    note = await p.evaluate("document.querySelector('dialog .pj-step:nth-child(1) .ps-note')?.innerText || ''")
    app.check('15. with a note about the original plan: planned by Thu 19 Nov, now Mon 23 Nov (+4 days)', 'Deadline moved' in note and 'Nov 19' in note and 'Nov 23' in note and '+4 days' in note, note)
    app.check('16. steps on plan have no note', not await p.query_selector('dialog .pj-step:nth-child(2) .ps-note'))
    # saving the project keeps the task's new deadline (it no longer writes the old one back)
    await p.click('dialog .project-form button[type=submit]'); await p.wait_for_timeout(1200)
    dl = await p.evaluate("new Date(window.__tempo.app.state.tasks.find(t => t.title === 'Thesis: Draft chapter').deadline).toISOString()")
    app.check("17. saving the project keeps the task's new deadline", dl.startswith('2026-11-23T16:00'), dl)
    # "Make the current dates the plan" clears the note
    await p.evaluate("import('./js/sidebar.js').then(m => { m.openProject(window.__tempo.app.state.settings.projects[0]); })"); await p.wait_for_selector('dialog .project-form')
    await p.click('dialog .pj-step:nth-child(1) .ps-accept'); await p.wait_for_timeout(200)
    app.check('18. accepting the new dates removes the note', not await p.query_selector('dialog .pj-step:nth-child(1) .ps-note'))
    await p.click('dialog .project-form button[type=submit]'); await p.wait_for_timeout(1200)
    # delayed: the week fills up, so Revise can't be done by its planned end
    await run_cmd(p, [{'cmd': 'addEvent', 'title': 'Conference', 'start': '2026-11-12 10:00', 'end': '2026-11-27 17:00', 'calendar': 'Local'}]); await p.wait_for_timeout(2000)
    await p.evaluate("() => { window.__tempo.cycle(); }"); await p.wait_for_timeout(2500)
    # (the re-plan asks what to do about the task that no longer fits — leave it for now)
    for _ in range(3):
        if await p.query_selector('dialog[open]'): await p.keyboard.press('Escape'); await p.wait_for_timeout(400)
    await p.evaluate("import('./js/sidebar.js').then(m => { m.openProject(window.__tempo.app.state.settings.projects[0]); })"); await p.wait_for_selector('dialog .project-form')
    note2 = await p.evaluate("document.querySelector('dialog .pj-step:nth-child(2) .ps-note')?.innerText || ''")
    app.check('19. a task that can no longer finish by its planned end says Delayed, with the planned date', 'Delayed' in note2 and 'planned to be done by' in note2, note2)
    await p.close()

App.run(main, port=8967)
