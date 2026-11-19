# Round 71: tasks scheduled back from the deadline (spread out / all together, with a buffer); repeating events and
# tasks that extend themselves by the same length, with a question on their last day.
import sys, json
sys.path.insert(0, 'test')
from harness import App

TZ = 'Europe/Berlin'
NOW = '2026-11-19T07:00:00Z'   # Thu 08:00 Berlin
BASE = {'tz': TZ, 'bounds': {'start': '09:00', 'end': '17:00', 'days': [1, 2, 3, 4, 5]}}

async def run_cmd(page, cmds):
    return json.loads(await page.evaluate(f'async () => JSON.stringify(await window.tempo.run({json.dumps(cmds)}))'))

def res(rv):
    r = rv[0].get('result') if rv else None
    return r.get('result', r) if isinstance(r, dict) and 'result' in r else r

async def sess(p, task):
    return [(x['start'], x['end']) for x in (res(await run_cmd(p, [{'cmd': 'listSessions', 'task': task, 'from': '2026-11-01', 'to': '2027-02-01'}])) or [])]

async def setv(p, n, val):
    await p.evaluate(f"(() => {{ const d = document.querySelector('dialog [name={n}]'); d.value = '{val}'; d.dispatchEvent(new CustomEvent('change', {{ bubbles: true, detail: 'user' }})); }})()")

async def new_task(p, title, hours, deadline):
    await p.click('#btn-new-task'); await p.wait_for_selector('dialog .task-form')
    await p.fill('dialog [name=title]', title); await p.fill('dialog [name=hours]', str(hours))
    await setv(p, 'deadline', deadline); await p.wait_for_timeout(500)

async def save_task(p):
    await p.click('dialog .task-form button[type=submit]'); await p.wait_for_timeout(1500)

async def main(app):
    # ——— 1. Back from the deadline ———
    p = await app.page(settings={**BASE, 'backwardDefault': True, 'autoExtendDefault': True}, now=NOW, wait=2500)
    p.set_default_timeout(8000)
    await new_task(p, 'Essay', 6, '2026-12-04T17:00')
    app.check('1. new tasks: "Schedule back from the deadline" is on by default, spread out, 1 day buffer, 2 near the end',
              await p.is_checked('dialog [name=bwOn]') and await p.is_checked('dialog [name=bwMode][value=spread]') and await p.input_value('dialog [name=bwBuf]') == '1' and await p.input_value('dialog [name=bwUnit]') == 'd' and await p.input_value('dialog [name=bwNear]') == '2')
    app.check('2. the safety-margin field gives way to the buffer', not await p.is_visible('dialog [name=margin]'))
    await save_task(p)
    s = await sess(p, 'Essay')
    days = [x[0][:10] for x in s]
    app.check('3. spread: 2 sessions right before the buffer (Thu 3 Dec, ending 17:00), the other 4 spread from today', len(s) == 6 and days[-2:] == ['2026-12-03', '2026-12-03'] and s[-1][1] == '2026-12-03 17:00' and days[:4] == ['2026-11-19', '2026-11-23', '2026-11-26', '2026-11-30'], s)
    app.check('4. nothing inside the buffer (all before Thu 3 Dec 17:00)', all(x[1] <= '2026-12-03 17:00' for x in s))

    await new_task(p, 'Report', 4, '2026-12-04T17:00')
    await p.click('dialog [name=bwMode][value=cluster] + span'); await p.fill('dialog [name=bwBuf]', '3'); await p.select_option('dialog [name=bwUnit]', 'h'); await p.wait_for_timeout(400)
    app.check('5. all together: the near-end count hides; the line explains it', not await p.is_visible('dialog [name=bwNear]') and 'All sessions together' in (await p.text_content('dialog .bw-say')))
    await save_task(p)
    s = await sess(p, 'Report')
    app.check('6. all together, 3 h buffer: 4 sessions packed back from Fri 4 Dec 14:00', len(s) == 4 and all(x[0].startswith('2026-12-04') for x in s) and s[-1][1] == '2026-12-04 14:00', s)

    await new_task(p, 'Errands', 2, '2026-12-04T17:00')
    await p.click('dialog [name=bwOn]'); await p.wait_for_timeout(300)
    app.check('7. switched off: its options hide and the safety margin is back', not await p.is_visible('dialog [name=bwBuf]') and await p.is_visible('dialog [name=margin]'))
    await save_task(p)
    s = await sess(p, 'Errands')
    app.check('8. off: as soon as possible (today)', len(s) == 2 and all(x[0].startswith('2026-11-19') for x in s), s)
    r = await run_cmd(p, [{'cmd': 'addTask', 'title': 'Taxes', 'hours': 2, 'deadline': '2026-12-11 17:00', 'backward': 'cluster'}])
    await p.wait_for_timeout(1200)
    s = await sess(p, 'Taxes')
    app.check('9. API: backward "cluster" with the default buffer (ends Thu 10 Dec 17:00)', len(s) == 2 and s[-1][1] == '2026-12-10 17:00', s)
    app.check('10. it is stored on the task (and so synced to other devices)', await p.evaluate("JSON.stringify(window.__tempo.app.state.tasks.find(t => t.title === 'Taxes').backward)") == json.dumps({'mode': 'cluster', 'bufferMin': 1440, 'nearEnd': 2}).replace(' ', ''))
    await p.evaluate("document.getElementById('btn-settings').click()"); await p.wait_for_selector('dialog [name=backwardDefault]', state='attached')
    vals = await p.evaluate("(() => { const f = (n) => document.querySelector(`dialog [name=${n}]`); return [f('backwardDefault').checked, f('backwardBufferHours').value, f('autoExtendDefault').checked, f('backwardDefault').closest('[data-sect]')?.dataset.sect]; })()")
    app.check('11. the defaults are in Settings → Scheduling → Planning', vals == [True, '24', True, 's-planning'], vals)
    await p.keyboard.press('Escape')
    await p.close()
    p = await app.page(settings={**BASE, 'backwardDefault': False}, now=NOW, wait=2500)
    await new_task(p, 'Plain', 2, '2026-12-04T17:00')
    app.check('12. with the default off in Settings, new tasks start unticked', not await p.is_checked('dialog [name=bwOn]'))
    await p.close()

    # ——— 2. A repeating event that extends itself ———
    p = await app.page(settings={**BASE, 'autoExtendDefault': True}, auth={}, now=NOW, wait=2500)
    p.set_default_timeout(8000)
    await p.click('#btn-new-event'); await p.wait_for_selector('dialog [name=freq]')
    await p.fill('dialog [name=summary]', 'Standup')
    await setv(p, 'sDate', '2026-11-24'); await setv(p, 'eDate', '2026-11-24'); await setv(p, 'sTime', '11:30'); await setv(p, 'eTime', '12:00')
    await p.evaluate("document.querySelector('details[data-sect=ev-notify]').open = true")
    await p.select_option('dialog [name=freq]', 'WEEKLY')
    await p.evaluate("(() => { for (const c of document.querySelectorAll('dialog [name=byday]')) { c.checked = ['2', '3'].includes(c.value); c.dispatchEvent(new Event('change', { bubbles: true })); } })()")
    await p.select_option('dialog [name=ends]', 'on'); await setv(p, 'until', '2026-12-03')
    app.check('13. the event dialog offers "Extend it automatically", ticked by default', await p.is_visible('dialog [name=recAuto]') and await p.is_checked('dialog [name=recAuto]'))
    await p.select_option('dialog [name=calId]', 'local')
    await p.click('dialog button[type=submit] >> nth=-1')
    try: await p.click('dialog .ask-cat [data-close]', timeout=1500)
    except Exception: pass
    await p.wait_for_timeout(1500)
    master = json.loads(await p.evaluate("JSON.stringify(window.__tempo.app.state.localEvents.find(e => e.summary === 'Standup'))"))
    pr = master['extendedProperties']['private']
    app.check('14. the series remembers its length (2 weeks from today), its last day and auto-extend', pr.get('tempoExt') == 'D14' and pr.get('tempoLast') == '2026-12-02' and pr.get('tempoAutoExt') == '1', pr)
    ev = res(await run_cmd(p, [{'cmd': 'listEvents', 'from': '2026-11-19', 'to': '2026-12-31'}])) or []
    app.check('15. it happens on Tue/Wed 24, 25 Nov and 1, 2 Dec', [e['start'][:10] for e in ev if e['title'] == 'Standup'] == ['2026-11-24', '2026-11-25', '2026-12-01', '2026-12-02'], [e['start'] for e in ev if e['title'] == 'Standup'])
    await p.close()

    # its last day: the question
    p = await app.page(settings={**BASE, 'autoExtendDefault': True}, auth={}, now='2026-12-02T07:00:00Z', wait=2500,
                       extra=f"\nif (!localStorage.getItem('tempo:localEvents')) localStorage.setItem('tempo:localEvents', JSON.stringify([{json.dumps(master)}]));")
    p.set_default_timeout(8000)
    await p.evaluate("() => { window.__tempo.cycle(); }")
    await p.wait_for_selector('dialog .recur-ext', timeout=10000)
    h2 = await p.text_content('dialog .recur-ext h2')
    app.check('16. on its last day: “Standup” ends today — extend it? (by 2 weeks, or a length you choose)', 'Standup' in h2 and 'ends today' in h2 and 'Extend by 2 weeks' in (await p.text_content('dialog .re-same')) and await p.is_visible('dialog .re-custom input'), h2)
    await p.click('dialog .re-same'); await p.wait_for_timeout(2000)
    ev = res(await run_cmd(p, [{'cmd': 'listEvents', 'from': '2026-11-19', 'to': '2026-12-31'}])) or []
    days = [e['start'][:10] for e in ev if e['title'] == 'Standup']
    app.check('17. extended by 2 weeks: now until 17 Dec (8, 9, 15, 16 Dec added), still one series', days == ['2026-11-24', '2026-11-25', '2026-12-01', '2026-12-02', '2026-12-08', '2026-12-09', '2026-12-15', '2026-12-16'], days)
    app.check('18. its last day moves on, so it will ask again then', await p.evaluate("window.__tempo.app.state.localEvents.find(e => e.summary === 'Standup').extendedProperties.private.tempoLast") == '2026-12-16')
    master2 = json.loads(await p.evaluate("JSON.stringify(window.__tempo.app.state.localEvents.find(e => e.summary === 'Standup'))"))
    await p.close()

    # no answer on the last day: extended automatically the day after
    p = await app.page(settings={**BASE, 'autoExtendDefault': True}, auth={}, now='2026-12-17T07:00:00Z', wait=2500,
                       extra=f"\nif (!localStorage.getItem('tempo:localEvents')) localStorage.setItem('tempo:localEvents', JSON.stringify([{json.dumps(master2)}]));")
    p.set_default_timeout(8000)
    await p.evaluate("() => { window.__tempo.cycle(); }"); await p.wait_for_timeout(3000)
    app.check('19. not answered: the day after it ended, it extends itself by the same 2 weeks (to 30 Dec)', await p.evaluate("window.__tempo.app.state.localEvents.find(e => e.summary === 'Standup').extendedProperties.private.tempoLast") == '2026-12-30' and not await p.query_selector('dialog .recur-ext'))
    app.check('20. …and says so', 'extended by 2 weeks' in (await p.evaluate("document.querySelector('.toast')?.textContent || ''")))
    await p.close()

    # "Let it end", and a custom length
    p = await app.page(settings={**BASE, 'autoExtendDefault': True}, auth={}, now='2026-12-16T07:00:00Z', wait=2500,
                       extra=f"\nif (!localStorage.getItem('tempo:localEvents')) localStorage.setItem('tempo:localEvents', JSON.stringify([{json.dumps(master2)}]));")
    p.set_default_timeout(8000)
    await p.evaluate("() => { window.__tempo.cycle(); }"); await p.wait_for_selector('dialog .recur-ext', timeout=10000)
    await p.fill('dialog .re-custom [name=n]', '1'); await p.select_option('dialog .re-custom [name=u]', 'm'); await p.click('dialog .re-go'); await p.wait_for_timeout(2000)
    app.check('21. a length you choose: 1 month (until 17 Jan → last Tue/Wed 13 Jan)', await p.evaluate("window.__tempo.app.state.localEvents.find(e => e.summary === 'Standup').extendedProperties.private.tempoLast") == '2027-01-13')
    await p.close()
    p = await app.page(settings={**BASE, 'autoExtendDefault': True}, auth={}, now='2026-12-16T07:00:00Z', wait=2500,
                       extra=f"\nif (!localStorage.getItem('tempo:localEvents')) localStorage.setItem('tempo:localEvents', JSON.stringify([{json.dumps(master2)}]));")
    p.set_default_timeout(8000)
    await p.evaluate("() => { window.__tempo.cycle(); }"); await p.wait_for_selector('dialog .recur-ext', timeout=10000)
    await p.click('dialog .re-end'); await p.wait_for_timeout(1200)
    await p.evaluate("sessionStorage.setItem('test:off', String(2 * 86400000))"); await p.reload(); await p.wait_for_selector('.tg-col'); await p.wait_for_timeout(1500)
    await p.evaluate("() => { window.__tempo.cycle(); }"); await p.wait_for_timeout(3000)
    app.check('22. "Let it end": it ends, and is not extended later', await p.evaluate("window.__tempo.app.state.localEvents.find(e => e.summary === 'Standup').extendedProperties.private.tempoLast") == '2026-12-16' and not await p.query_selector('dialog .recur-ext'))
    await p.close()

    # the same on Google: the series itself is extended (one series, no copies)
    g = app.google
    p = await app.page(settings={**BASE, 'autoExtendDefault': True}, now=NOW, wait=2500)
    p.set_default_timeout(8000)
    await p.click('#btn-new-event'); await p.wait_for_selector('dialog [name=freq]')
    await p.fill('dialog [name=summary]', 'Seminar')
    await setv(p, 'sDate', '2026-11-24'); await setv(p, 'eDate', '2026-11-24'); await setv(p, 'sTime', '14:00'); await setv(p, 'eTime', '15:00')
    await p.evaluate("document.querySelector('details[data-sect=ev-notify]').open = true")
    await p.select_option('dialog [name=freq]', 'WEEKLY')
    await p.evaluate("(() => { for (const c of document.querySelectorAll('dialog [name=byday]')) { c.checked = c.value === '2'; c.dispatchEvent(new Event('change', { bubbles: true })); } })()")
    await p.select_option('dialog [name=ends]', 'after'); await p.fill('dialog [name=count]', '2'); await p.dispatch_event('dialog [name=count]', 'change')
    await p.click('dialog button[type=submit] >> nth=-1')
    try: await p.click('dialog .ask-cat [data-close]', timeout=1500)
    except Exception: pass
    await p.wait_for_timeout(2000)
    ms = [e for evs in g.events.values() for e in evs.values() if e.get('summary') == 'Seminar']
    app.check('22a. on Google: one series, 2 times, remembering "2 more times" and its last day (1 Dec)', len(ms) == 1 and ms[0]['extendedProperties']['private'].get('tempoExt') == 'C2' and ms[0]['extendedProperties']['private'].get('tempoLast') == '2026-12-01', [m.get('extendedProperties') for m in ms])
    await p.evaluate("sessionStorage.setItem('test:off', String(12 * 86400000))"); await p.reload(); await p.wait_for_selector('.tg-col')
    await p.evaluate("() => { window.__tempo.cycle({ pull: true }); }"); await p.wait_for_selector('dialog .recur-ext', timeout=10000)
    await p.click('dialog .re-same'); await p.wait_for_timeout(2500)
    ms = [e for evs in g.events.values() for e in evs.values() if e.get('summary') == 'Seminar']
    rule = next((l for l in ms[0].get('recurrence', []) if l.startswith('RRULE:')), '') if ms else ''
    app.check('22b. extended on Google: still one series, now COUNT=4 (to 15 Dec)', len(ms) == 1 and 'COUNT=4' in rule and ms[0]['extendedProperties']['private'].get('tempoLast') == '2026-12-15', (len(ms), rule))
    await p.close()

    # ——— 3. A repeating task that extends itself ———
    p = await app.page(settings={**BASE, 'autoExtendDefault': True}, auth={}, now=NOW, wait=2500)
    p.set_default_timeout(8000)
    await p.click('#btn-new-task'); await p.wait_for_selector('dialog .task-form')
    await p.fill('dialog [name=title]', 'Gym'); await p.check('dialog [name=repOn]')
    await p.fill('dialog [name=repStart]', '2026-11-20'); await p.fill('dialog [name=repInterval]', '1'); await p.select_option('dialog [name=repEvery]', 'week'); await p.fill('dialog [name=repHours]', '1')
    await p.select_option('dialog [name=repEnd]', 'count'); await p.fill('dialog [name=repCount]', '3'); await p.wait_for_timeout(300)
    app.check('23. the repeating-task panel has "Extend it automatically", ticked by default', await p.is_checked('dialog [name=repAuto]'))
    await save_task(p)
    rep = json.loads(await p.evaluate("JSON.stringify(window.__tempo.app.state.tasks.find(t => t.title === 'Gym').repeat)"))
    app.check('24. the task remembers its length (3 times)', rep.get('auto') is True and rep.get('extend') == {'count': 3}, rep)
    task = await p.evaluate("JSON.stringify(window.__tempo.app.state.tasks.find(t => t.title === 'Gym'))")
    await p.close()
    p = await app.page(settings={**BASE, 'autoExtendDefault': True}, auth={}, now='2026-12-04T07:00:00Z', wait=2500,
                       extra=f"\nif (!localStorage.getItem('tempo:tasks')) localStorage.setItem('tempo:tasks', JSON.stringify([{task}]));")
    p.set_default_timeout(8000)
    await p.evaluate("() => { window.__tempo.cycle(); }"); await p.wait_for_selector('dialog .recur-ext', timeout=10000)
    app.check('25. a repeating task: on its last time (Fri 4 Dec) it asks, offering 3 more times', 'repeats for the last time today' in (await p.text_content('dialog .recur-ext h2')) and '3 more times' in (await p.text_content('dialog .re-same')))
    await p.click('dialog .re-same'); await p.wait_for_timeout(2500)
    s = await sess(p, 'Gym')
    app.check('26. extended: 3 more Fridays planned (11, 18, 25 Dec)', [x[0][:10] for x in s if x[0][:10] > '2026-12-04'] == ['2026-12-11', '2026-12-18', '2026-12-25'], s)
    await p.close()

App.run(main, port=8972)
