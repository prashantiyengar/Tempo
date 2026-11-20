# Round 72: abandon the rest of a task (books set aside in the Bookcase and planned again later; other tasks' rest
# to the Graveyard; a repeating task ends), ☢ clear a day's schedule (some hours, tasks / events / everything), and
# enveloping: a new event over existing ones becomes blocks around them.
import sys, json
sys.path.insert(0, 'test')
from harness import App

TZ = 'Europe/Berlin'
NOW = '2026-11-16T07:00:00Z'   # Mon 08:00 Berlin
BASE = {'tz': TZ, 'bounds': {'start': '09:00', 'end': '17:00', 'days': [1, 2, 3, 4, 5]}}

async def run_cmd(page, cmds):
    return json.loads(await page.evaluate(f'async () => JSON.stringify(await window.tempo.run({json.dumps(cmds)}))'))

def res(rv):
    r = rv[0].get('result') if rv else None
    return r.get('result', r) if isinstance(r, dict) and 'result' in r else r

async def sess(p, task, frm='2026-11-01', to='2027-03-01'):
    return res(await run_cmd(p, [{'cmd': 'listSessions', 'task': task, 'from': frm, 'to': to}])) or []

async def events(p, frm, to):
    return [(e['title'], e['start'][11:16], e['end'][11:16]) for e in (res(await run_cmd(p, [{'cmd': 'listEvents', 'from': frm, 'to': to}])) or [])]

async def open_session(p, sid, day):
    await p.evaluate(f"(() => {{ const a = window.__tempo.app; a.view = 'week'; a.cursor = '{day}'; return window.__tempo.render(); }})()")
    await p.wait_for_timeout(700)
    el = p.locator(f'.ev[data-key="c|{sid}"]').first
    await el.scroll_into_view_if_needed(); await el.click(); await p.wait_for_selector('.popover .pop-actions')

async def setv(p, n, val):
    await p.evaluate(f"(() => {{ const d = document.querySelector('dialog [name={n}]'); d.value = '{val}'; d.dispatchEvent(new Event('input', {{ bubbles: true }})); d.dispatchEvent(new CustomEvent('change', {{ bubbles: true, detail: 'user' }})); }})()")

async def radio(p, n, v):
    await p.evaluate(f"(() => {{ const r = document.querySelector('dialog [name={n}][value={v}]'); r.checked = true; r.dispatchEvent(new Event('change', {{ bubbles: true }})); }})()")

async def main(app):
    # ——— 1. A book set aside, and planned again ———
    p = await app.page(settings=BASE, now=NOW, wait=2500)
    p.set_default_timeout(8000)
    await run_cmd(p, [{'cmd': 'addTask', 'title': 'Dune', 'pages': 200, 'pagesPerHour': 40, 'deadline': '2026-11-27 17:00', 'sessionMinutes': 60}])
    await p.wait_for_timeout(1500)
    ss = await sess(p, 'Dune')
    for c in ss[:2]: await run_cmd(p, [{'cmd': 'markDone', 'session': c['id']}])
    await p.wait_for_timeout(1200)
    ss = await sess(p, 'Dune')
    nxt = next(c for c in ss if c['status'] != 'done')
    await open_session(p, nxt['id'], nxt['start'][:10])
    app.check('1. a session not done yet has "Abandon the rest"', await p.is_visible('.popover .abandon'))
    await p.click('.popover .abandon'); await p.wait_for_selector('dialog[open] .choice')
    txt = await p.text_content('dialog[open] .choice')
    app.check('2. the question says the Bookcase keeps how far you got (80 of 200 pages)', 'Stop reading' in txt and 'Bookcase' in txt and '80 of 200 pages' in txt, txt.strip()[:220])
    await p.click('dialog[open] .choice-btn.primary'); await p.wait_for_timeout(2500)
    ss2 = await sess(p, 'Dune')
    t = json.loads(await p.evaluate("JSON.stringify(window.__tempo.app.state.tasks.find(t => t.title === 'Dune'))"))
    app.check('3. only the 2 done sessions are left; the book is set aside at 40% (80 pages)', len(ss2) == 2 and all(c['status'] == 'done' for c in ss2) and t['abandoned']['pct'] == 40 and t['abandoned']['read'] == 80, (len(ss2), t.get('abandoned')))
    await p.evaluate("window.__tempo.cycle()"); await p.wait_for_timeout(2500)
    app.check('4. a re-plan does not bring the sessions back', len(await sess(p, 'Dune')) == 2)
    meta = await p.evaluate("[...document.querySelectorAll('#task-list .task-row')].find(r => r.innerText.includes('Dune'))?.innerText || ''")
    app.check('5. the task list says "Set aside at 40%"', 'Set aside at 40%' in meta, meta)
    await p.click('#task-list .lib-open'); await p.wait_for_selector('dialog .bookcase')
    body = await p.evaluate("document.querySelector('dialog .bookcase').innerText")
    app.check('6. the Bookcase has a "Set aside" shelf with the pages read and "Reschedule the rest"', 'Set aside' in body and '80 / 200 pp.' in body and await p.is_visible('dialog .lib-resume'), body[:300])
    await p.screenshot(path=f'{app.out}/r72-bookcase.png')
    await p.click('dialog .lib-resume'); await p.wait_for_selector('dialog .resume-book')
    app.check('7. rescheduling asks by when to read the rest', 'You read about 80 of 200 pages' in await p.text_content('dialog .resume-book'))
    await p.fill('dialog .resume-book [name=d]', '2026-12-11'); await p.click('dialog .resume-book button[type=submit]'); await p.wait_for_timeout(3000)
    t = json.loads(await p.evaluate("JSON.stringify(window.__tempo.app.state.tasks.find(t => t.title === 'Dune'))"))
    ss3 = await sess(p, 'Dune')
    planned = [c for c in ss3 if c['status'] != 'done']
    app.check('8. the rest of the book is planned again by Dec 11 (not set aside any more)', 'abandoned' not in t and len(planned) >= 3 and max(c['end'] for c in planned) <= '2026-12-11 17:00' and min(c['start'] for c in planned) >= '2026-11-16', (t.get('abandoned'), [c['start'] for c in planned]))
    pages = [c.get('pages') for c in planned]
    app.check('9. … starting at page 81', str(pages[0]).startswith('81') or (planned and '81' in json.dumps(planned[0])), planned[:1])

    # ——— 2. Other tasks: the rest goes to the Graveyard; a repeating task ends ———
    await run_cmd(p, [{'cmd': 'addTask', 'title': 'Report', 'hours': 4, 'deadline': '2026-11-27 17:00', 'sessionMinutes': 60}])
    await p.wait_for_timeout(1500)
    rs = await sess(p, 'Report')
    await run_cmd(p, [{'cmd': 'markDone', 'session': rs[0]['id']}]); await p.wait_for_timeout(1200)
    rs = await sess(p, 'Report'); nxt = next(c for c in rs if c['status'] != 'done')
    await open_session(p, nxt['id'], nxt['start'][:10])
    await p.click('.popover .abandon'); await p.wait_for_selector('dialog[open] .choice')
    txt = await p.text_content('dialog[open] .choice')
    app.check('10. a task: the remaining 3h go to the Graveyard', 'Graveyard' in txt and '3h' in txt.replace(' ', ''), txt.strip()[:200])
    await p.click('dialog[open] .choice-btn.primary'); await p.wait_for_timeout(2500)
    g = json.loads(await p.evaluate("JSON.stringify(window.__tempo.app.state.settings.graveyard || [])"))
    rs = await sess(p, 'Report')
    app.check('11. its done session stays; a Graveyard entry with 3h is there', len(rs) == 1 and rs[0]['status'] == 'done' and any(x['text'] == 'Report' and x.get('minutes') == 180 for x in g), (rs, g))
    await run_cmd(p, [{'cmd': 'addTask', 'title': 'Untouched', 'hours': 2, 'deadline': '2026-11-27 17:00'}]); await p.wait_for_timeout(1200)
    r = res(await run_cmd(p, [{'cmd': 'abandonTask', 'task': 'Untouched'}])); await p.wait_for_timeout(1500)
    gone = await p.evaluate("!window.__tempo.app.state.tasks.some(t => t.title === 'Untouched')")
    g = json.loads(await p.evaluate("JSON.stringify(window.__tempo.app.state.settings.graveyard || [])"))
    app.check('12. nothing done yet: the whole task goes to the Graveyard', r and r['as'] == 'graveyard' and gone and any(x['text'] == 'Untouched' for x in g), r)
    await run_cmd(p, [{'cmd': 'addTask', 'title': 'Stretch', 'repeat': {'every': 'day', 'hours': 0.5, 'until': '2026-11-30'}}]); await p.wait_for_timeout(1800)
    st = await sess(p, 'Stretch')
    third = [c for c in st if c['status'] != 'done'][2]
    r = res(await run_cmd(p, [{'cmd': 'abandonTask', 'task': 'Stretch', 'session': third['id']}])); await p.wait_for_timeout(2500)
    st2 = await sess(p, 'Stretch')
    app.check('13. a repeating task ends before that session (2 left)', r and r['as'] == 'series ended' and len(st2) == 2 and all(c['start'] < third['start'] for c in st2), (r, [c['start'] for c in st2]))
    await p.close()

    # ——— 3. ☢ Clear the schedule ———
    p = await app.page(settings=BASE, now=NOW, wait=2500)
    p.set_default_timeout(8000)
    await run_cmd(p, [
        {'cmd': 'addEvent', 'title': 'Standup', 'start': '2026-11-16 10:00', 'end': '2026-11-16 10:30', 'calendar': 'Local'},
        {'cmd': 'addEvent', 'title': 'Lunch', 'start': '2026-11-16 12:00', 'end': '2026-11-16 13:00', 'calendar': 'Local'},
        {'cmd': 'addEvent', 'title': 'Evening', 'start': '2026-11-16 19:00', 'end': '2026-11-16 20:00', 'calendar': 'Local'},
        {'cmd': 'addEvent', 'title': 'Tue call', 'start': '2026-11-17 09:00', 'end': '2026-11-17 09:30', 'calendar': 'Local'},
        {'cmd': 'addTask', 'title': 'Write', 'hours': 6, 'deadline': '2026-11-20 17:00', 'sessionMinutes': 90}])
    await p.wait_for_timeout(2500)
    menu = await p.evaluate("import('./js/commands.js').then(m => m.menuItems('fab').filter(c => c.id).map(c => c.ic + ' ' + c.label))")
    app.check("14. the + menu (and Now / More) has ☢ Clear today's schedule", any(x.startswith('☢') and 'Clear today' in x for x in menu), menu)
    await p.evaluate("import('./js/commands.js').then(m => { m.runCommand('clear-day'); })"); await p.wait_for_selector('dialog .clear-day'); await p.wait_for_timeout(800)
    today_write = [c for c in (res(await run_cmd(p, [{'cmd': 'listSessions', 'from': '2026-11-16', 'to': '2026-11-16'}])) or []) if c['start'].startswith('2026-11-16') and c['status'] != 'done']
    lbl = await p.text_content('dialog .cd-day-l'); pv = await p.text_content('dialog .cd-preview')
    app.check('15. by default it clears the rest of today, everything (3 events + all task sessions today)', 'rest of today' in lbl and pv.startswith('08:00') and '3 events' in pv and f'{len(today_write)} task session' in pv, (lbl, pv, today_write))
    await p.screenshot(path=f'{app.out}/r72-clear.png')
    await radio(p, 'span', 'hours'); await setv(p, 'from', '11:00'); await setv(p, 'to', '14:00')
    await radio(p, 'only', 'events'); await p.wait_for_timeout(600)
    pv = await p.text_content('dialog .cd-preview')
    app.check('16. only events between 11:00 and 14:00: Lunch', '1 event' in pv and 'task session' not in pv, pv)
    await p.click('dialog .cd-go'); await p.wait_for_timeout(2500)
    ev = await events(p, '2026-11-16', '2026-11-18')
    app.check('17. Lunch is gone, the rest stays; no time kept free', [e[0] for e in ev] == ['Standup', 'Evening', 'Tue call'] and not await p.evaluate("(window.__tempo.app.state.settings.holds || []).length"), ev)
    await p.evaluate("import('./js/commands.js').then(m => { m.runCommand('clear-day'); })"); await p.wait_for_selector('dialog .clear-day'); await p.wait_for_timeout(600)
    await p.click('dialog .cd-go'); await p.wait_for_timeout(3500)
    ev = await events(p, '2026-11-16', '2026-11-18')
    w = await sess(p, 'Write')
    left_today = [c for c in w if c['start'].startswith('2026-11-16') and c['status'] != 'done']
    app.check('18. everything for the rest of today: its events are deleted, task sessions move to other days', [e[0] for e in ev] == ['Tue call'] and not left_today and len(w) >= 4, (ev, [c['start'] for c in w]))
    holds = json.loads(await p.evaluate("JSON.stringify(window.__tempo.app.state.settings.holds || [])"))
    app.check('19. the time stays free ("Cleared" on the calendar)', len(holds) == 1 and holds[0].get('label') == 'Cleared' and await p.evaluate("[...document.querySelectorAll('.hold')].some(h => h.innerText.includes('Cleared'))"), holds)
    await run_cmd(p, [{'cmd': 'undo'}]); await p.wait_for_timeout(3000)
    ev = await events(p, '2026-11-16', '2026-11-18')
    app.check('20. undo puts the events back and lets tasks in again', [e[0] for e in ev] == ['Standup', 'Evening', 'Tue call'] and not await p.evaluate("(window.__tempo.app.state.settings.holds || []).length"), ev)
    tue_before = [c for c in await sess(p, 'Write') if c['start'].startswith('2026-11-17')]
    r = res(await run_cmd(p, [{'cmd': 'clearSchedule', 'date': '2026-11-17', 'only': 'tasks'}])); await p.wait_for_timeout(3000)
    tue_after = [c for c in await sess(p, 'Write') if c['start'].startswith('2026-11-17')]
    ev = await events(p, '2026-11-17', '2026-11-18')
    app.check('21. only tasks, tomorrow (whole day): sessions move, the event stays', r and r['sessionsMoved'] > 0 and tue_before and not tue_after and ev == [('Tue call', '09:00', '09:30')] and r['from'].endswith('00:00'), (r, ev))
    await p.evaluate("import('./js/commands.js').then(m => { m.runCommand('clear-day'); })"); await p.wait_for_selector('dialog .clear-day'); await setv(p, 'day', '2026-11-17'); await p.wait_for_timeout(600)
    app.check('22. time kept free can be given back to tasks from the dialog', await p.is_visible('dialog .cd-free') and 'The whole day' in await p.text_content('dialog .cd-day-l'))
    await p.click('dialog .cd-free'); await p.wait_for_timeout(2500)
    app.check('23. … and tasks are planned there again', not await p.evaluate("(window.__tempo.app.state.settings.holds || []).length") and any(c['start'].startswith('2026-11-17') for c in await sess(p, 'Write')))
    await p.keyboard.press('Escape'); await p.close()
    # on a phone the dialog fits
    p = await app.page(settings=BASE, now=NOW, device='Pixel 7', wait=2500)
    await p.evaluate("import('./js/commands.js').then(m => { m.runCommand('clear-day'); })"); await p.wait_for_selector('dialog .clear-day'); await p.wait_for_timeout(500)
    fits = await p.evaluate("(() => { const r = document.querySelector('dialog[open]').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 && document.documentElement.scrollWidth <= innerWidth; })()")
    app.check('24. phone: the clear dialog fits the screen', fits)
    await p.screenshot(path=f'{app.out}/r72-clear-phone.png')
    await p.close()

    # ——— 4. Envelop ———
    p = await app.page(settings=BASE, now=NOW, wait=2500)
    p.set_default_timeout(8000)
    await run_cmd(p, [{'cmd': 'addEvent', 'title': 'Meeting', 'start': '2026-11-17 11:00', 'end': '2026-11-17 12:00', 'calendar': 'Local'},
                      {'cmd': 'addEvent', 'title': 'Call', 'start': '2026-11-18 10:00', 'end': '2026-11-18 10:30', 'calendar': 'Local'},
                      {'cmd': 'addEvent', 'title': 'Review', 'start': '2026-11-18 14:00', 'end': '2026-11-18 15:00', 'calendar': 'Local'}])
    await p.wait_for_timeout(1500)

    async def new_event(title, day, a, b):
        await p.evaluate("document.getElementById('btn-new-event').click()"); await p.wait_for_selector('dialog [name=sDate]')
        await p.fill('dialog [name=summary]', title)
        await setv(p, 'sDate', day); await setv(p, 'eDate', day); await setv(p, 'sTime', a); await setv(p, 'eTime', b)
        await p.wait_for_timeout(200)
        await p.click('dialog form button[type=submit]'); await p.wait_for_timeout(1000)

    await new_event('Deep work', '2026-11-17', '09:00', '17:00')
    txt = await p.text_content('dialog[open] .choice') if await p.query_selector('dialog[open] .choice') else ''
    app.check('25. a new event over a meeting asks: envelop it in 2 blocks (09:00–11:00, 12:00–17:00)', 'overlaps 1 event' in txt and 'Envelop it: 2 blocks' in txt and '09:00–11:00' in txt and '12:00–17:00' in txt, txt[:260])
    await p.screenshot(path=f'{app.out}/r72-envelop.png')
    await p.click('dialog[open] .choice-btn.primary'); await p.wait_for_timeout(2000)
    ev = await events(p, '2026-11-17', '2026-11-17')
    app.check('26. two "Deep work" blocks around the meeting, which stays', ev == [('Deep work', '09:00', '11:00'), ('Meeting', '11:00', '12:00'), ('Deep work', '12:00', '17:00')], ev)
    await run_cmd(p, [{'cmd': 'undo'}]); await p.wait_for_timeout(2000)
    app.check('27. one undo takes both blocks away', await events(p, '2026-11-17', '2026-11-17') == [('Meeting', '11:00', '12:00')])
    await new_event('Focus', '2026-11-18', '09:00', '17:00')
    txt = await p.text_content('dialog[open] .choice')
    app.check('28. around two events: 3 blocks', 'overlaps 2 events' in txt and 'Envelop them: 3 blocks' in txt, txt[:200])
    await p.click('dialog[open] .choice-btn.primary'); await p.wait_for_timeout(2000)
    ev = await events(p, '2026-11-18', '2026-11-19')
    app.check('29. … 09:00–10:00, 10:30–14:00, 15:00–17:00', [e for e in ev if e[0] == 'Focus'] == [('Focus', '09:00', '10:00'), ('Focus', '10:30', '14:00'), ('Focus', '15:00', '17:00')], ev)
    await new_event('Workshop', '2026-11-17', '10:00', '13:00')
    await p.click('dialog[open] .choice-btn:not(.primary)'); await p.wait_for_timeout(2000)
    ev = await events(p, '2026-11-17', '2026-11-18')
    app.check('30. "One event over it all" makes a single event', ('Workshop', '10:00', '13:00') in ev and len([e for e in ev if e[0] == 'Workshop']) == 1, ev)
    await new_event('Free slot', '2026-11-19', '09:00', '10:00')
    app.check('31. no overlap: no question, one event', not await p.query_selector('dialog[open] .choice') and ('Free slot', '09:00', '10:00') in await events(p, '2026-11-19', '2026-11-20'))
    await p.close()

if __name__ == "__main__": App.run(main, port=8973)
