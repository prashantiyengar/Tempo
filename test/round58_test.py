# Round 58: extend task time, move events to Later, fill-in blocks start after existing events.
import sys, json
sys.path.insert(0, 'test')
from harness import App

async def main(app):
    # ——————————————————————————————————————————————
    # Feature 1: Extend task time via API
    # ——————————————————————————————————————————————
    task = {
        'id': 't1', 'title': 'Study', 'kind': 'generic', 'totalMinutes': 60,
        'rank': 5, 'created': 1730100000000,
        'deadline': 1730200000000,
        'planned': [], 'frozen': [],
    }
    NOW = '2024-10-28T10:00:00Z'
    page = await app.page(
        settings={
            'tz': 'UTC',
            'bounds': {'start': '06:00', 'end': '22:00', 'days': [0,1,2,3,4,5,6]},
            'assumePastDone': True,
            'syncTasksToGoogle': False,
        },
        now=NOW,
        extra=f"localStorage.setItem('tempo:tasks', JSON.stringify([{json.dumps(task)}]));",
        wait=3000,
    )

    # Check initial total minutes
    info = await page.evaluate(
        "window.tempo.run([{cmd:'listSessions', task:'Study', from:'2024-10-28', to:'2024-10-30'}])"
    )
    sessions0 = info[0]['result'] if info and info[0].get('result') else []
    initial_count = len(sessions0)
    app.check('1. task has initial sessions', initial_count >= 1)

    # Extend by 2 hours
    ext = await page.evaluate('''() =>
        window.tempo.run([{cmd: 'extendTask', task: 'Study', hours: 2}])
    ''')
    app.check('2. extendTask succeeded', ext and not ext[0].get('error'), ext[0].get('error') if ext else 'no result')

    await page.wait_for_timeout(2000)

    # Check total time is now 180 min (60 + 120)
    info2 = await page.evaluate("window.tempo.run([{cmd:'listTasks'}])")
    tasks = info2[0]['result'] if info2 and info2[0].get('result') else []
    study = next((t for t in tasks if t.get('title') == 'Study'), None)
    app.check('3. total time increased to 3h', study and study.get('hours') == 3.0, f"hours={study.get('hours') if study else 'none'}")

    # Check we have more sessions now
    info3 = await page.evaluate(
        "window.tempo.run([{cmd:'listSessions', task:'Study', from:'2024-10-28', to:'2024-10-30'}])"
    )
    sessions1 = info3[0]['result'] if info3 and info3[0].get('result') else []
    app.check('4. more sessions after extend', len(sessions1) > initial_count, f"before={initial_count}, after={len(sessions1)}")

    await page.close()

    # ——————————————————————————————————————————————
    # Feature 2: Move events to Later via API
    # ——————————————————————————————————————————————
    page2 = await app.page(
        settings={
            'tz': 'UTC',
            'bounds': {'start': '06:00', 'end': '22:00', 'days': [0,1,2,3,4,5,6]},
            'assumePastDone': True,
            'syncTasksToGoogle': False,
        },
        now='2024-10-28T08:00:00Z',
        wait=3000,
    )

    # Create an event first
    await page2.evaluate('''() =>
        window.tempo.run([{cmd: 'addEvent', title: 'Team standup', start: '2024-10-28 14:00', end: '2024-10-28 14:30', calendar: 'Local'}])
    ''')
    await page2.wait_for_timeout(2000)

    # Verify the event exists
    evs = await page2.evaluate(
        "window.tempo.run([{cmd:'listEvents', from:'2024-10-28', to:'2024-10-29'}])"
    )
    ev_list = evs[0]['result'] if evs and evs[0].get('result') else []
    has_standup = any('Team standup' in (e.get('title', '') or '') for e in ev_list)
    app.check('5. event exists before move', has_standup)

    # Move to Later
    move = await page2.evaluate('''() =>
        window.tempo.run([{cmd: 'moveEventToLater', event: 'Team standup', from: '2024-10-28', to: '2024-10-29'}])
    ''')
    app.check('6. moveEventToLater succeeded', move and not move[0].get('error'), move[0].get('error') if move else 'no result')
    await page2.wait_for_timeout(2000)

    # Event should be gone
    evs2 = await page2.evaluate(
        "window.tempo.run([{cmd:'listEvents', from:'2024-10-28', to:'2024-10-29'}])"
    )
    ev_list2 = evs2[0]['result'] if evs2 and evs2[0].get('result') else []
    has_standup2 = any('Team standup' in (e.get('title', '') or '') for e in ev_list2)
    app.check('7. event removed from calendar', not has_standup2)

    # Check it's in the Later list
    later = await page2.evaluate(
        "window.tempo.run([{cmd:'listLater'}])"
    )
    later_list = later[0]['result'] if later and later[0].get('result') else []
    has_later = any('Team standup' in (n.get('text', '') or '') for n in later_list)
    app.check('8. event added to Later list', has_later)

    # Check the Later item has the right duration (30 min)
    standup_later = next((n for n in later_list if 'Team standup' in (n.get('text', '') or '')), None)
    app.check('9. Later item has correct duration', standup_later and standup_later.get('minutes') == 30, f"minutes={standup_later.get('minutes') if standup_later else 'none'}")

    await page2.close()

    # ——————————————————————————————————————————————
    # Feature 3: Fill-in blocks start after existing events
    # ——————————————————————————————————————————————
    # We test the fillWindows and subtract logic.
    # Create a page with a sleep block ending at 6:30 and a fill-in block 6:00-8:00.
    # The fill-in event should start at 6:45 (next 15-min boundary after 6:30), not 6:30.
    page3 = await app.page(
        settings={
            'tz': 'UTC',
            'bounds': {'start': '06:00', 'end': '22:00', 'days': [0,1,2,3,4,5,6]},
            'assumePastDone': True,
            'syncTasksToGoogle': False,
            'sleepEvents': True,
            'sleepStart': '23:00',
            'sleepEnd': '06:30',
            'sleepDelayMin': 0,
            'sleepCal': 'local',
            'autoFills': [
                {'id': 'f1', 'on': True, 'from': '06:00', 'to': '08:00', 'catId': 'cat1', 'delayMin': 0, 'cal': 'local'},
            ],
            'categories': [{'id': 'cat1', 'name': 'Morning routine', 'color': '#3b82f6', 'icon': '🌅'}],
        },
        now='2024-10-28T09:00:00Z',
        wait=5000,
    )

    # Check that the fill-in event was created and its start time.
    # Sleep block would be 23:00 on 10/27 to 06:30 on 10/28.
    # Fill-in window is 06:00-08:00 on 10/28.
    # The gap in the fill-in window after sleep is 06:30-08:00.
    # With rounding, the fill-in should start at 06:45 (next 15-min boundary after 06:30).
    evs3 = await page3.evaluate(
        "window.tempo.run([{cmd:'listEvents', from:'2024-10-28', to:'2024-10-29'}])"
    )
    ev_list3 = evs3[0]['result'] if evs3 and evs3[0].get('result') else []

    # Find the fill-in event (Morning routine)
    fill_events = [e for e in ev_list3 if 'Morning routine' in (e.get('title', '') or '') or '🌅' in (e.get('title', '') or '')]
    app.check('10. fill-in event created', len(fill_events) >= 1, f"fill events: {[e.get('title') for e in ev_list3]}")

    if fill_events:
        fill_start = fill_events[0].get('start', '')
        # Should be 06:45 not 06:30
        app.check('11. fill-in starts at 06:45 (rounded up from 06:30)',
                   '06:45' in fill_start,
                   f'fill-in starts at {fill_start}')
    else:
        app.check('11. fill-in starts at 06:45', False, 'no fill-in event')

    await page3.close()

App.run(main, port=8958)
