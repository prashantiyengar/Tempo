# Round 59: Graveyard of Time — move tasks/events to graveyard, list, reschedule, newsletter section.
import sys, json
sys.path.insert(0, 'test')
from harness import App

async def main(app):
    # ——————————————————————————————————————————————
    # Feature 1: Move a task to the Graveyard via API
    # ——————————————————————————————————————————————
    task = {
        'id': 't1', 'title': 'Learn Go', 'kind': 'generic', 'totalMinutes': 120,
        'rank': 5, 'created': 1730100000000,
        'deadline': 1730500000000,
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

    # Move task to graveyard
    res = await page.evaluate('''() =>
        window.tempo.run([{cmd: 'moveTaskToGraveyard', task: 'Learn Go'}])
    ''')
    app.check('1. moveTaskToGraveyard succeeded', res and not res[0].get('error'), res[0].get('error') if res else 'no result')
    await page.wait_for_timeout(2000)

    # Task should be gone
    info = await page.evaluate("window.tempo.run([{cmd:'listTasks'}])")
    tasks = info[0]['result'] if info and info[0].get('result') else []
    has_go = any(t.get('title') == 'Learn Go' for t in tasks)
    app.check('2. task removed from task list', not has_go)

    # Graveyard should have the item
    gy = await page.evaluate("window.tempo.run([{cmd:'listGraveyard'}])")
    gy_result = gy[0]['result'] if gy and gy[0].get('result') else {}
    active = gy_result.get('active', [])
    has_gy = any('Learn Go' in (x.get('text', '') or '') for x in active)
    app.check('3. task in graveyard', has_gy)

    # Check graveyard item has correct duration (120 min = 2h)
    gy_item = next((x for x in active if 'Learn Go' in (x.get('text', '') or '')), None)
    app.check('4. graveyard item has correct minutes', gy_item and gy_item.get('minutes') == 120, f"minutes={gy_item.get('minutes') if gy_item else 'none'}")
    app.check('5. graveyard item is kind=task', gy_item and gy_item.get('kind') == 'task')

    await page.close()

    # ——————————————————————————————————————————————
    # Feature 2: Move an event to the Graveyard via API
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

    # Create an event
    await page2.evaluate('''() =>
        window.tempo.run([{cmd: 'addEvent', title: 'Dentist appointment', start: '2024-10-28 15:00', end: '2024-10-28 16:00', calendar: 'Local'}])
    ''')
    await page2.wait_for_timeout(2000)

    # Move to graveyard
    move = await page2.evaluate('''() =>
        window.tempo.run([{cmd: 'moveEventToGraveyard', event: 'Dentist appointment', from: '2024-10-28', to: '2024-10-29'}])
    ''')
    app.check('6. moveEventToGraveyard succeeded', move and not move[0].get('error'), move[0].get('error') if move else 'no result')
    await page2.wait_for_timeout(2000)

    # Event should be gone
    evs = await page2.evaluate(
        "window.tempo.run([{cmd:'listEvents', from:'2024-10-28', to:'2024-10-29'}])"
    )
    ev_list = evs[0]['result'] if evs and evs[0].get('result') else []
    has_dentist = any('Dentist' in (e.get('title', '') or '') for e in ev_list)
    app.check('7. event removed from calendar', not has_dentist)

    # Check graveyard
    gy2 = await page2.evaluate("window.tempo.run([{cmd:'listGraveyard'}])")
    gy2_result = gy2[0]['result'] if gy2 and gy2[0].get('result') else {}
    active2 = gy2_result.get('active', [])
    has_dentist_gy = any('Dentist' in (x.get('text', '') or '') for x in active2)
    app.check('8. event in graveyard', has_dentist_gy)

    dentist_gy = next((x for x in active2 if 'Dentist' in (x.get('text', '') or '')), None)
    app.check('9. graveyard event has correct minutes (60)', dentist_gy and dentist_gy.get('minutes') == 60, f"minutes={dentist_gy.get('minutes') if dentist_gy else 'none'}")

    await page2.close()

    # ——————————————————————————————————————————————
    # Feature 3: Reschedule from Graveyard
    # ——————————————————————————————————————————————
    page3 = await app.page(
        settings={
            'tz': 'UTC',
            'bounds': {'start': '06:00', 'end': '22:00', 'days': [0,1,2,3,4,5,6]},
            'assumePastDone': True,
            'syncTasksToGoogle': False,
            'graveyard': [
                {'id': 'g1', 'text': 'Write blog post', 'kind': 'task', 'addedAt': 1730100000000, 'created': 1730000000000, 'minutes': 90},
                {'id': 'g2', 'text': 'Old abandoned thing', 'kind': 'event', 'addedAt': 1725000000000, 'created': 1724900000000, 'minutes': 45},
            ],
        },
        now='2024-10-28T10:00:00Z',
        wait=3000,
    )

    # Verify listing shows correct active/archived split
    gy3 = await page3.evaluate("window.tempo.run([{cmd:'listGraveyard'}])")
    gy3_result = gy3[0]['result'] if gy3 and gy3[0].get('result') else {}
    active3 = gy3_result.get('active', [])
    archived3 = gy3_result.get('archived', 0)
    # (the Graveyard syncs between devices since Round 63, and this run's pages share one fake Google account:
    # items from parts 1 and 2 are here too)
    texts3 = [x.get('text') for x in active3]
    app.check('10. graveyard active count correct', 'Write blog post' in texts3 and 'Old abandoned thing' not in texts3, f"active={texts3}")
    app.check('11. graveyard archived count correct', archived3 >= 1, f"archived={archived3}")

    # Reschedule as task
    resc = await page3.evaluate('''() =>
        window.tempo.run([{cmd: 'rescheduleFromGraveyard', item: 'Write blog post', as: 'task'}])
    ''')
    app.check('12. rescheduleFromGraveyard succeeded', resc and not resc[0].get('error'), resc[0].get('error') if resc else 'no result')
    await page3.wait_for_timeout(2000)

    # Verify it's now a task
    info3 = await page3.evaluate("window.tempo.run([{cmd:'listTasks'}])")
    tasks3 = info3[0]['result'] if info3 and info3[0].get('result') else []
    has_blog = any('Write blog post' in (t.get('title', '') or '') for t in tasks3)
    app.check('13. rescheduled item is now a task', has_blog)

    # Verify it's removed from graveyard
    gy4 = await page3.evaluate("window.tempo.run([{cmd:'listGraveyard'}])")
    gy4_result = gy4[0]['result'] if gy4 and gy4[0].get('result') else {}
    active4 = gy4_result.get('active', [])
    has_blog_gy = any('Write blog post' in (x.get('text', '') or '') for x in active4)
    app.check('14. rescheduled item removed from graveyard', not has_blog_gy)

    await page3.close()

App.run(main, port=8959)
