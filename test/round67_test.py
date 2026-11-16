# Round 67: a leave day (sick leave / vacation) set on one device moves the task sessions on every device — also on
# a device that is following a plan made by the other one, and also when the leave arrives before the moved sessions.
import sys, json
sys.path.insert(0, 'test')
from harness import App

TZ = 'Europe/Berlin'
NOW = '2026-11-16T07:30:00Z'   # Mon 08:30 Berlin
S = {'tz': TZ, 'syncTasksToGoogle': True, 'bounds': {'start': '09:00', 'end': '17:00', 'days': [1, 2, 3, 4, 5]}}

async def run_cmd(page, cmds):
    return json.loads(await page.evaluate(f'async () => JSON.stringify(await window.tempo.run({json.dumps(cmds)}))'))

async def sess(p):
    r = await run_cmd(p, [{'cmd': 'listSessions', 'from': '2026-11-15', 'to': '2026-11-28'}])
    return sorted((x['task'], x['start']) for x in r[0]['result'])

async def pull(p):
    await p.evaluate('() => { window.__tempo.cycle({ pull: true }); }'); await p.wait_for_timeout(3500)

async def main(app):
    A = await app.page(settings=S, now=NOW, wait=2500)                    # desktop
    await run_cmd(A, [{'cmd': 'addTask', 'title': 'Report', 'hours': 3, 'deadline': '2026-11-18 17:00'}, {'cmd': 'addTask', 'title': 'Slides', 'hours': 2, 'deadline': '2026-11-19 17:00'}])
    await A.wait_for_timeout(3000)
    B = await app.page(settings=S, now=NOW, wait=3000, device='Pixel 7')  # phone
    await pull(B)
    s0 = await sess(B)
    app.check("1. the phone follows the desktop's plan (5 sessions today)", s0 == await sess(A) and len(s0) == 5 and all(x[1].startswith('2026-11-16') for x in s0), s0)

    # sick leave set on the phone, which is only following the plan
    await run_cmd(B, [{'cmd': 'setLeave', 'from': '2026-11-16', 'kind': 'sick'}]); await B.wait_for_timeout(6000)
    sb = await sess(B)
    app.check('2. sick leave on the phone moves its sessions off today, although the plan came from the desktop', len(sb) == 5 and not any(x[1].startswith('2026-11-16') for x in sb), sb)
    g = sorted(e['start']['dateTime'][:10] for e in app.google.task_events())
    app.check('3. Google has the 5 moved sessions, none on the leave day', len(g) == 5 and '2026-11-16' not in g, g)
    await pull(A)
    app.check('4. the desktop shows the leave day and the same moved sessions', await A.evaluate("window.__tempo.app.state.settings.leave?.['2026-11-16']") == 'sick' and await sess(A) == sb, await sess(A))
    app.check('5. the leave day is marked in the desktop week', bool(await A.query_selector('.tg-col[data-day="2026-11-16"].on-leave')))

    # leave reaches a device before the moved sessions do (the other device was closed before it finished writing):
    # the desktop, following the phone's plan, must move the sessions itself
    await A.evaluate("""(async () => { const st = window.__tempo.app.state; st.settings.leave = { ...(st.settings.leave || {}), '2026-11-17': 'vacation' }; await window.__tempo.E.persist(st, ['settings']); })()""")
    await A.evaluate('() => { window.__tempo.cycle({ sync: false }); }'); await A.wait_for_timeout(2500)
    sa = await sess(A)
    app.check("6. a leave day that arrives on its own: the device re-plans the other's plan around it", len(sa) == 5 and not any(x[1][:10] in ('2026-11-16', '2026-11-17') for x in sa), sa)
    await A.evaluate('() => { window.__tempo.cycle(); }'); await A.wait_for_timeout(3000)
    await pull(B)
    app.check('7. …and the phone ends up with the same sessions; 5 events on Google', await sess(B) == sa and len(app.google.task_events()) == 5, (await sess(B), len(app.google.task_events())))

    # removing the leave on one device brings the days back on both
    await run_cmd(A, [{'cmd': 'setLeave', 'from': '2026-11-16', 'to': '2026-11-17', 'kind': 'none'}]); await A.wait_for_timeout(5000)
    await pull(B)
    app.check('8. clearing the leave on the desktop clears it on the phone', not await B.evaluate("Object.keys(window.__tempo.app.state.settings.leave || {}).length"))
    await A.close(); await B.close()

App.run(main, port=8968)
