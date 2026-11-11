# Round 65: From and To never change each other (a setting brings "From moves To" back); two devices no longer plan
# the same task against each other — the newer plan is followed, so no stray "adjacent" sessions appear.
import sys, json
sys.path.insert(0, 'test')
from harness import App

TZ = 'Europe/Berlin'
NOW = '2026-11-11T08:00:00Z'   # Wed 09:00 Berlin

async def run_cmd(page, cmds):
    return json.loads(await page.evaluate(f'async () => JSON.stringify(await window.tempo.run({json.dumps(cmds)}))'))

def res(rv):
    r = rv[0].get('result') if rv else None
    return r.get('result', r) if isinstance(r, dict) and 'result' in r else r

async def type_time(page, sel, digits):
    box = await page.locator(sel).bounding_box()
    await page.mouse.click(box['x'] + 8, box['y'] + box['height'] / 2)
    await page.keyboard.type(digits); await page.keyboard.press('Tab'); await page.wait_for_timeout(200)

async def sessions(page, task):
    return [(x['start'], x['end'], x['status']) for x in (res(await run_cmd(page, [{'cmd': 'listSessions', 'task': task, 'from': '2026-11-10', 'to': '2026-11-20'}])) or [])]

async def cycle(page, pull=True):
    await page.evaluate(f'window.__tempo.cycle({{ pull: {"true" if pull else "false"} }})'); await page.wait_for_timeout(1500)

async def main(app):
    # ——— 1. From and To are independent (default) ———
    p = await app.page(settings={'tz': TZ}, now=NOW, wait=2500)
    p.set_default_timeout(8000)
    await p.click('#btn-new-event'); await p.wait_for_selector('dialog [name=sTime]')
    await type_time(p, 'dialog [name=sTime]', '1000'); await type_time(p, 'dialog [name=eTime]', '1130')
    await type_time(p, 'dialog [name=sTime]', '1400')
    app.check('1. changing From leaves To alone (11:30 stays)', await p.input_value('dialog [name=eTime]') == '11:30' and not await p.query_selector('dialog .revert-btn'), await p.input_value('dialog [name=eTime]'))
    app.check('2. the length line says the end is before the start', 'before' in (await p.text_content('dialog .t-len')))
    await p.fill('dialog [name=summary]', 'Lunch'); await p.click('dialog button[type=submit] >> nth=-1'); await p.wait_for_timeout(600)
    app.check('3. saving with To before From is refused with a message', bool(await p.query_selector('dialog[open] .event-form')) and 'end must be after' in (await p.evaluate("document.querySelector('.toast')?.textContent || ''")))
    await type_time(p, 'dialog [name=eTime]', '1500')
    await type_time(p, 'dialog [name=sTime]', '1430')
    app.check('4. changing From again: To still 15:00', await p.input_value('dialog [name=eTime]') == '15:00')
    await p.click('dialog .st-now'); await p.wait_for_timeout(200)
    app.check('5. "Now" moves only From', await p.input_value('dialog [name=sTime]') == '09:00' and await p.input_value('dialog [name=eTime]') == '15:00')
    await p.click('dialog button[type=submit] >> nth=-1')
    try: await p.click('dialog .ask-cat [data-close]', timeout=1500)
    except Exception: pass
    await p.wait_for_timeout(1200)
    ev = res(await run_cmd(p, [{'cmd': 'listEvents', 'from': '2026-11-11', 'to': '2026-11-12'}])) or []
    app.check('6. saved with the times as typed', any(e['title'] == 'Lunch' and e['end'].endswith('15:00') for e in ev), ev)
    # quick create: From typed, To stays; typing in From isn't interrupted
    await p.evaluate("document.querySelector('.tg-scroll').scrollTop = 9 * window.__tempo.app.state.settings.hourHeight")
    cols = await p.query_selector_all('.tg-col'); box = await cols[3].bounding_box(); hh = await p.evaluate('window.__tempo.app.state.settings.hourHeight')
    top = await p.evaluate("document.querySelectorAll('.tg-col')[3].getBoundingClientRect().top")
    await p.mouse.move(box['x'] + 20, top + 10 * hh + 2); await p.mouse.down(); await p.mouse.move(box['x'] + 20, top + 11 * hh - 2, steps=4); await p.mouse.up()
    await p.wait_for_selector('.popover [name=qs]')
    await type_time(p, '.popover [name=qs]', '1030')
    app.check('7. quick create: typing From 10:30 keeps To 11:00 and the typing lands in From', await p.input_value('.popover [name=qs]') == '10:30' and await p.input_value('.popover [name=qe]') == '11:00' and await p.input_value('.popover [name=title]') == '')
    await p.click('.popover .qc-cancel')
    # task dialog: From (don't start before) doesn't move the deadline
    await p.click('#btn-new-task'); await p.wait_for_selector('dialog .task-form')
    await p.fill('dialog [name=title]', 'Essay'); await p.fill('dialog [name=deadline]', '2026-11-13T17:00'); await p.dispatch_event('dialog [name=deadline]', 'change')
    await p.fill('dialog [name=earliest]', '2026-11-12T09:00'); await p.dispatch_event('dialog [name=earliest]', 'change', {'detail': 'user'})
    app.check('8. task dialog: From does not move the deadline', await p.input_value('dialog [name=deadline]') == '2026-11-13T17:00', await p.input_value('dialog [name=deadline]'))
    await p.fill('dialog [name=earliest]', '2026-11-14T09:00'); await p.dispatch_event('dialog [name=earliest]', 'change', {'detail': 'user'})
    await p.click('dialog .task-form button[type=submit]'); await p.wait_for_timeout(600)
    app.check('9. a deadline before From is refused', bool(await p.query_selector('dialog[open] .task-form')) and 'must be after' in (await p.evaluate("document.querySelector('.toast')?.textContent || ''")))
    await p.keyboard.press('Escape')
    await p.close()

    # the setting brings the old behaviour back
    p = await app.page(settings={'tz': TZ, 'linkTimes': True}, now=NOW, wait=2500)
    p.set_default_timeout(8000)
    await p.click('#btn-new-event'); await p.wait_for_selector('dialog [name=sTime]')
    await type_time(p, 'dialog [name=sTime]', '1000'); await type_time(p, 'dialog [name=eTime]', '1630')
    await type_time(p, 'dialog [name=sTime]', '1400')
    app.check('10. with "From moves To" on: To follows (20:30) and ↶ offers 16:30', await p.input_value('dialog [name=eTime]') == '20:30' and '16:30' in (await p.text_content('dialog .revert-btn') or ''))
    await p.keyboard.press('Escape')
    await p.evaluate("document.getElementById('btn-settings').click()"); await p.wait_for_selector('dialog [name=linkTimes]')
    app.check('11. the switch is in Settings → New events', await p.is_checked('dialog [name=linkTimes]'))
    await p.close()

    # ——— 2. Two devices, one plan ———
    A = await app.page(settings={'tz': TZ, 'syncTasksToGoogle': True, 'bounds': {'start': '09:00', 'end': '17:00', 'days': [1, 2, 3, 4, 5]}}, now=NOW, wait=2500)
    A.set_default_timeout(8000)
    await run_cmd(A, [{'cmd': 'addTask', 'title': 'Thesis', 'hours': 3, 'deadline': '2026-11-13 17:00'}])
    await A.wait_for_timeout(2500)
    sa = await sessions(A, 'Thesis')
    app.check('12. A plans 3 sessions and writes them to Google', len(sa) == 3 and len(app.google.task_events()) == 3, (sa, len(app.google.task_events())))
    ida = await A.evaluate("window.__tempo.app.state.installId")
    B = await app.page(settings={'tz': TZ, 'syncTasksToGoogle': True, 'bounds': {'start': '09:00', 'end': '17:00', 'days': [1, 2, 3, 4, 5]}}, now=NOW, wait=3000)
    B.set_default_timeout(8000)
    await cycle(B)
    sb = await sessions(B, 'Thesis')
    plan = await B.evaluate("JSON.stringify(window.__tempo.app.state.tasks.find(t => t.title === 'Thesis').plan)")
    app.check("13. B takes on A's plan and follows it (same sessions, plan stamped by A)", sb == sa and json.loads(plan)['by'] == ida, (sb, plan))
    app.check('14. still 3 events on Google (B wrote nothing of its own)', len(app.google.task_events()) == 3, len(app.google.task_events()))
    # B has a local-only event over the first session: B must re-plan, and A then follows B
    await run_cmd(B, [{'cmd': 'addEvent', 'title': 'Dentist', 'start': sa[0][0], 'minutes': 30, 'calendar': 'Local'}])
    await cycle(B, pull=False)
    sb2 = await sessions(B, 'Thesis')
    idb = await B.evaluate("window.__tempo.app.state.installId")
    app.check("15. B re-plans around its local event (the plan is now B's)", sb2 != sb and len(sb2) == 3 and (await B.evaluate("window.__tempo.app.state.tasks.find(t => t.title === 'Thesis').plan.by")) == idb, sb2)
    app.check('16. Google still holds exactly 3 sessions', len(app.google.task_events()) == 3, len(app.google.task_events()))
    await cycle(A)
    sa2 = await sessions(A, 'Thesis')
    app.check("17. A follows B's newer plan instead of planning against it", sa2 == sb2, (sa2, sb2))
    for _ in range(2): await cycle(A); await cycle(B)
    sa3, sb3 = await sessions(A, 'Thesis'), await sessions(B, 'Thesis')
    app.check('18. after more rounds on both: the same 3 sessions everywhere, 3 events on Google', sa3 == sb3 == sb2 and len(app.google.task_events()) == 3, (sa3, sb3, len(app.google.task_events())))
    # A moves a session by hand: an edit wins everywhere
    mv = await run_cmd(A, [{'cmd': 'moveSession', 'task': 'Thesis', 'index': 2, 'start': '2026-11-12 14:00'}])
    await A.wait_for_timeout(2500); await cycle(A, pull=False)
    await cycle(B); await cycle(A); await cycle(B)
    sa4, sb4 = await sessions(A, 'Thesis'), await sessions(B, 'Thesis')
    app.check("19. a session moved on A shows the same on B; no stray events", sa4 == sb4 and any(s[0] == '2026-11-12 14:00' and s[2] == 'pinned' for s in sb4) and len(app.google.task_events()) == len(sa4), (sa4, sb4, len(app.google.task_events())))
    await A.close(); await B.close()

App.run(main, port=8966)
