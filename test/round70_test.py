# Round 70: fewer requests to Google — a device following another's plan writes nothing when sessions start (it used
# to delete and re-create the other device's sessions), and one routine refresh stays within a known request budget.
import sys, json, collections
sys.path.insert(0, 'test')
from harness import App

S = {'tz': 'Europe/Berlin', 'syncTasksToGoogle': True, 'bounds': {'start': '09:00', 'end': '17:00', 'days': [1, 2, 3, 4, 5]}}
NOW = '2026-11-17T07:30:00Z'

async def run_cmd(page, cmds):
    return json.loads(await page.evaluate(f'async () => JSON.stringify(await window.tempo.run({json.dumps(cmds)}))'))

def writes(log): return dict(collections.Counter(l.split(' ')[0] for l in log if not l.startswith('GET')))
def lists(log): return sum(1 for l in log if l.startswith('GET') and l.endswith('/events'))

async def sess(p):
    r = await run_cmd(p, [{'cmd': 'listSessions', 'from': '2026-11-16', 'to': '2026-11-27'}])
    return sorted((x['task'], x['start'], x['status']) for x in r[0]['result'])

async def pull(p):
    await p.evaluate('() => { window.__tempo.cycle({ pull: true }); }'); await p.wait_for_timeout(4000)

async def main(app):
    g = app.google
    A = await app.page(settings=S, now=NOW, wait=2500)
    await run_cmd(A, [{'cmd': 'addTask', 'title': 'Report', 'hours': 8, 'deadline': '2026-11-20 17:00'}, {'cmd': 'addTask', 'title': 'Slides', 'hours': 6, 'deadline': '2026-11-23 17:00'}])
    await A.wait_for_timeout(4000)
    B = await app.page(settings=S, now=NOW, wait=3000, device='Pixel 7')
    await pull(B)
    ids0 = sorted(e['id'] for e in g.task_events())
    app.check('1. 14 sessions on Google, both devices agree', len(ids0) == 14 and await sess(A) == await sess(B))

    g.log.clear(); await pull(A)
    app.check('2. a routine refresh writes nothing and lists events at most 8 times (2 calendars)', not writes(g.log) and lists(g.log) <= 8, (writes(g.log), lists(g.log)))
    g.log.clear(); await pull(B)
    app.check('3. …also on the device following the plan', not writes(g.log) and lists(g.log) <= 8, (writes(g.log), lists(g.log)))

    # two hours later two sessions have started: the planning device marks them, the other writes nothing
    for p in (A, B): await p.evaluate("sessionStorage.setItem('test:off', String(2 * 3600000))")
    g.log.clear(); await A.reload(); await A.wait_for_selector('.tg-col'); await A.wait_for_timeout(6000)
    wa = writes(g.log)
    app.check('4. sessions that started: the planning device patches just those (2 writes)', wa == {'PATCH': 2}, wa)
    g.log.clear(); await B.reload(); await B.wait_for_selector('.tg-col'); await B.wait_for_timeout(7000)
    wb = writes(g.log)
    app.check('5. the following device writes nothing (no delete / re-create of the other plan)', not wb, wb)
    g.log.clear(); await pull(A); await pull(B)
    app.check('6. and nothing more on the next refreshes', not writes(g.log), writes(g.log))
    ids1 = sorted(e['id'] for e in g.task_events())
    app.check('7. the same 14 events are still on Google, and both devices show the same sessions', ids1 == ids0 and await sess(A) == await sess(B), (len(ids1), ids1 == ids0))

    # a real change on the follower still wins and reaches the other device with few writes
    g.log.clear()
    await run_cmd(B, [{'cmd': 'moveSession', 'task': 'Slides', 'index': 2, 'start': '2026-11-19 15:00'}]); await B.wait_for_timeout(5000)
    await pull(A)
    app.check('8. a session moved on the follower shows on the other device', await sess(A) == await sess(B) and any(s[0] == 'Slides' and s[1] == '2026-11-19 15:00' for s in await sess(A)), await sess(A))
    app.check('9. still no duplicates: one event per session', len(g.task_events()) == len(await sess(A)), (len(g.task_events()), len(await sess(A))))
    await A.close(); await B.close()

App.run(main, port=8971)
