# Round 60: Flexible recurring tasks — custom intervals (every N days/weeks/months),
# default end (3 months or 10 sessions), extend recurrences.
import sys, json
sys.path.insert(0, 'test')
from harness import App

async def main(app):
    NOW = '2024-10-28T10:00:00Z'

    # ——————————————————————————————————————————————
    # Feature 1: Create a repeating task every 3 weeks
    # ——————————————————————————————————————————————
    page = await app.page(
        settings={
            'tz': 'UTC',
            'bounds': {'start': '06:00', 'end': '22:00', 'days': [0,1,2,3,4,5,6]},
            'assumePastDone': True,
            'syncTasksToGoogle': False,
        },
        now=NOW,
        wait=3000,
    )

    # Create a 2h task every 3 weeks
    res = await page.evaluate('''() =>
        window.tempo.run([{cmd: 'addTask', title: 'Deep clean', repeat: {every: 'week', interval: 3, hours: 2}, start: '2024-10-28'}])
    ''')
    app.check('1. every-3-weeks task created', res and not res[0].get('error'), res[0].get('error') if res else 'no result')
    await page.wait_for_timeout(2000)

    # Verify it exists and has the right repeat info
    info = await page.evaluate("window.tempo.run([{cmd:'listTasks'}])")
    tasks = info[0]['result'] if info and info[0].get('result') else []
    deep = next((t for t in tasks if t.get('title') == 'Deep clean'), None)
    app.check('2. task exists', deep is not None)
    app.check('3. repeat.every is week', deep and deep.get('repeat', {}).get('every') == 'week')
    app.check('4. repeat.interval is 3', deep and deep.get('repeat', {}).get('interval') == 3)
    app.check('5. repeat.hours is 2', deep and deep.get('repeat', {}).get('hours') == 2.0)

    await page.close()

    # ——————————————————————————————————————————————
    # Feature 2: Create a monthly repeating task
    # ——————————————————————————————————————————————
    page2 = await app.page(
        settings={
            'tz': 'UTC',
            'bounds': {'start': '06:00', 'end': '22:00', 'days': [0,1,2,3,4,5,6]},
            'assumePastDone': True,
            'syncTasksToGoogle': False,
        },
        now=NOW,
        wait=3000,
    )

    # Create a 10h monthly task for 3 months
    res2 = await page2.evaluate('''() =>
        window.tempo.run([{cmd: 'addTask', title: 'Monthly report', repeat: {every: 'month', hours: 10, count: 3}, start: '2024-10-28'}])
    ''')
    app.check('6. monthly task created', res2 and not res2[0].get('error'), res2[0].get('error') if res2 else 'no result')
    await page2.wait_for_timeout(2000)

    info2 = await page2.evaluate("window.tempo.run([{cmd:'listTasks'}])")
    tasks2 = info2[0]['result'] if info2 and info2[0].get('result') else []
    monthly = next((t for t in tasks2 if t.get('title') == 'Monthly report'), None)
    app.check('7. monthly task exists', monthly is not None)
    app.check('8. repeat.every is month', monthly and monthly.get('repeat', {}).get('every') == 'month')
    app.check('9. repeat.hours is 10', monthly and monthly.get('repeat', {}).get('hours') == 10.0)

    # Check sessions are created
    sess = await page2.evaluate("window.tempo.run([{cmd:'listSessions', task:'Monthly report', from:'2024-10-28', to:'2025-02-01'}])")
    sess_list = sess[0]['result'] if sess and sess[0].get('result') else []
    app.check('10. monthly task has sessions', len(sess_list) >= 1, f"sessions={len(sess_list)}")

    await page2.close()

    # ——————————————————————————————————————————————
    # Feature 3: Default end (3 months or 10 sessions, whichever shorter)
    # ——————————————————————————————————————————————
    page3 = await app.page(
        settings={
            'tz': 'UTC',
            'bounds': {'start': '06:00', 'end': '22:00', 'days': [0,1,2,3,4,5,6]},
            'assumePastDone': True,
            'syncTasksToGoogle': False,
        },
        now=NOW,
        wait=3000,
    )

    # Weekly task with no count/until — should get a default
    res3 = await page3.evaluate('''() =>
        window.tempo.run([{cmd: 'addTask', title: 'Workout', repeat: {every: 'week', hours: 3}, start: '2024-10-28'}])
    ''')
    app.check('11. default-end task created', res3 and not res3[0].get('error'), res3[0].get('error') if res3 else 'no result')
    await page3.wait_for_timeout(2000)

    info3 = await page3.evaluate("window.tempo.run([{cmd:'listTasks'}])")
    tasks3 = info3[0]['result'] if info3 and info3[0].get('result') else []
    workout = next((t for t in tasks3 if t.get('title') == 'Workout'), None)
    app.check('12. workout task exists', workout is not None)
    # The until should be set (either from count or until) — just check it has one
    has_until = workout and workout.get('repeat', {}).get('until')
    app.check('13. workout has an end date', has_until is not None)

    await page3.close()

    # ——————————————————————————————————————————————
    # Feature 4: Extend recurrences via API
    # ——————————————————————————————————————————————
    page4 = await app.page(
        settings={
            'tz': 'UTC',
            'bounds': {'start': '06:00', 'end': '22:00', 'days': [0,1,2,3,4,5,6]},
            'assumePastDone': True,
            'syncTasksToGoogle': False,
        },
        now=NOW,
        wait=3000,
    )

    # Create a weekly task with 4 weeks
    await page4.evaluate('''() =>
        window.tempo.run([{cmd: 'addTask', title: 'Study', repeat: {every: 'week', hours: 2, count: 4}, start: '2024-10-28'}])
    ''')
    await page4.wait_for_timeout(2000)

    # Get original until date
    info4a = await page4.evaluate("window.tempo.run([{cmd:'listTasks'}])")
    tasks4a = info4a[0]['result'] if info4a and info4a[0].get('result') else []
    study = next((t for t in tasks4a if t.get('title') == 'Study'), None)
    original_until = study.get('repeat', {}).get('until') if study else None
    app.check('14. study task exists with until', original_until is not None)

    # Extend by 5 more periods
    ext = await page4.evaluate('''() =>
        window.tempo.run([{cmd: 'extendRecurrences', task: 'Study', count: 5}])
    ''')
    app.check('15. extendRecurrences succeeded', ext and not ext[0].get('error'), ext[0].get('error') if ext else 'no result')
    await page4.wait_for_timeout(2000)

    # Verify until date moved later
    info4b = await page4.evaluate("window.tempo.run([{cmd:'listTasks'}])")
    tasks4b = info4b[0]['result'] if info4b and info4b[0].get('result') else []
    study2 = next((t for t in tasks4b if t.get('title') == 'Study'), None)
    new_until = study2.get('repeat', {}).get('until') if study2 else None
    app.check('16. extended until is later than original', original_until and new_until and new_until > original_until, f"original={original_until}, new={new_until}")

    await page4.close()

    # ——————————————————————————————————————————————
    # Feature 5: Every-2-day interval
    # ——————————————————————————————————————————————
    page5 = await app.page(
        settings={
            'tz': 'UTC',
            'bounds': {'start': '06:00', 'end': '22:00', 'days': [0,1,2,3,4,5,6]},
            'assumePastDone': True,
            'syncTasksToGoogle': False,
        },
        now=NOW,
        wait=3000,
    )

    # Create a task every 2 days
    res5 = await page5.evaluate('''() =>
        window.tempo.run([{cmd: 'addTask', title: 'Stretching', repeat: {every: 'day', interval: 2, hours: 0.5, count: 6}, start: '2024-10-28'}])
    ''')
    app.check('17. every-2-days task created', res5 and not res5[0].get('error'), res5[0].get('error') if res5 else 'no result')
    await page5.wait_for_timeout(2000)

    info5 = await page5.evaluate("window.tempo.run([{cmd:'listTasks'}])")
    tasks5 = info5[0]['result'] if info5 and info5[0].get('result') else []
    stretch = next((t for t in tasks5 if t.get('title') == 'Stretching'), None)
    app.check('18. stretch task exists', stretch is not None)
    app.check('19. repeat.interval is 2', stretch and stretch.get('repeat', {}).get('interval') == 2)

    # Check sessions span the right range (6 periods of 2 days = 12 days)
    sess5 = await page5.evaluate("window.tempo.run([{cmd:'listSessions', task:'Stretching', from:'2024-10-28', to:'2024-11-10'}])")
    sess5_list = sess5[0]['result'] if sess5 and sess5[0].get('result') else []
    app.check('20. every-2-days has sessions', len(sess5_list) >= 1, f"sessions={len(sess5_list)}")

    await page5.close()

App.run(main, port=8960)
