# Round 57: fix phone rescheduling — creating an event that overlaps with a task
# session should cause the task session to move, not sit alongside the new event.
import sys, json
sys.path.insert(0, 'test')
from harness import App

async def main(app):
    # The task has a planned session at 14:35–15:30 UTC.
    # We'll create an event at 14:30–15:00 that overlaps it.
    task = {
        'id': 't1', 'title': 'Study', 'kind': 'generic', 'totalMinutes': 55,
        'rank': 5, 'created': 1730100000000,
        'deadline': 1730160000000,
        'planned': [{
            'id': 'c1',
            'start': 1730126100000,   # 2024-10-28T14:35:00Z
            'end':   1730129400000,   # 2024-10-28T15:30:00Z
        }],
        'frozen': [],
    }
    # Start clock at 14:30 — the task session hasn't started yet
    NOW = '2024-10-28T14:30:00Z'

    page = await app.page(
        settings={
            'tz': 'UTC',
            'bounds': {'start': '06:00', 'end': '22:00', 'days': [0,1,2,3,4,5,6]},
            'assumePastDone': True,
            'defaultEventMinutes': 30,
            'syncTasksToGoogle': False,
        },
        now=NOW,
        extra=f"localStorage.setItem('tempo:tasks', JSON.stringify([{json.dumps(task)}]));",
        wait=3000,
    )

    # ——————————————————————————————————————————————
    # 1. Verify the task session is visible
    # ——————————————————————————————————————————————
    sessions = await page.evaluate(
        "window.tempo.run([{cmd:'listSessions', task:'Study', from:'2024-10-28', to:'2024-10-29'}])"
    )
    s1 = sessions[0]['result'] if sessions and sessions[0].get('result') else []
    app.check('1. task session exists before event', len(s1) >= 1)

    # ——————————————————————————————————————————————
    # 2. Advance clock to 14:36 (past the session start at 14:35), then
    #    create a local event at 14:30–15:00 that overlaps with the session
    # ——————————————————————————————————————————————
    await page.evaluate('() => { globalThis.__off += 6 * 60 * 1000; }')

    # Create the overlapping event via the API
    result = await page.evaluate('''() => {
        return window.tempo.run([{
            cmd: 'addEvent',
            title: 'Urgent meeting',
            start: '2024-10-28 14:30',
            end:   '2024-10-28 15:00',
            calendar: 'Local'
        }]);
    }''')
    await page.wait_for_timeout(3000)

    # ——————————————————————————————————————————————
    # 3. Check that the task session has moved
    # ——————————————————————————————————————————————
    sessions2 = await page.evaluate(
        "window.tempo.run([{cmd:'listSessions', task:'Study', from:'2024-10-28', to:'2024-10-29'}])"
    )
    s2 = sessions2[0]['result'] if sessions2 and sessions2[0].get('result') else []
    app.check('2. task session(s) still exist after event', len(s2) >= 1)

    # Find the planned session (not done/frozen)
    planned = [s for s in s2 if s.get('status') == 'planned']
    done = [s for s in s2 if s.get('status') == 'done']

    if planned:
        new_start = planned[0]['start']
        # The new session should start at or after 15:00 (after the event ends)
        app.check('3. planned session starts at or after event end',
                   '15:' in new_start or '16:' in new_start or '17:' in new_start or '18:' in new_start or '19:' in new_start or '20:' in new_start or '21:' in new_start,
                   f'session starts at {new_start}')

        # The old 14:35 session should NOT still be there as a planned session
        at_old = [s for s in planned if '14:35' in s.get('start', '')]
        app.check('4. no planned session at old overlapping time', len(at_old) == 0)
    else:
        # If no planned sessions, maybe the session was frozen as done (the old bug).
        at_old_done = [s for s in done if '14:35' in s.get('start', '')]
        if at_old_done:
            app.check('3. BUG: session frozen at old time instead of rescheduled', False,
                       f'frozen session at {at_old_done[0]["start"]}')
        else:
            app.check('3. planned session starts at or after event end', False, 'no planned session found')
        app.check('4. no planned session at old overlapping time', len(at_old_done) == 0)

    # ——————————————————————————————————————————————
    # 4. The event should be on the calendar
    # ——————————————————————————————————————————————
    evs = await page.evaluate(
        "window.tempo.run([{cmd:'listEvents', from:'2024-10-28', to:'2024-10-29'}])"
    )
    ev_list = evs[0]['result'] if evs and evs[0].get('result') else []
    meeting_found = any('Urgent meeting' in (e.get('title', '') or '') for e in ev_list)
    app.check('5. overlapping event is on the calendar', meeting_found)

    # ——————————————————————————————————————————————
    # 5. No overlap: task session should not overlap with the event
    # ——————————————————————————————————————————————
    planned_after = [s for s in s2 if s.get('status') == 'planned']
    if planned_after:
        # Check none of the planned sessions overlap with the 14:30–15:00 event
        ev_start_str = '14:30'
        ev_end_str = '15:00'
        overlapping = [s for s in planned_after
                       if s.get('start', '') < '2024-10-28T15:00' and s.get('end', '') > '2024-10-28T14:30']
        app.check('6. no planned session overlaps with the event', len(overlapping) == 0,
                   f'overlapping: {overlapping}' if overlapping else '')
    else:
        app.check('6. no planned session overlaps with the event', False, 'no planned sessions')

    # ——————————————————————————————————————————————
    # 6. The done-frozen session at 14:35 should NOT exist (since it overlaps with the event)
    # ——————————————————————————————————————————————
    frozen_at_old = [s for s in done if '14:35' in s.get('start', '')]
    app.check('7. no frozen session at 14:35 (it should have been rescheduled, not frozen)',
              len(frozen_at_old) == 0, f'found: {frozen_at_old}' if frozen_at_old else '')

App.run(main, port=8957)
