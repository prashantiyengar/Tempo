# Round 68: moving events off a leave day never puts a second copy next to one that is already there (repeating
# events, Tempo's own daily blocks, events already on that day); "+ Add rule" works on a new time period when
# fill-in blocks exist.
import sys, json
sys.path.insert(0, 'test')
from harness import App

TZ = 'Europe/Berlin'
NOW = '2026-11-16T07:30:00Z'   # Mon 08:30 Berlin
ev = lambda id, title, day, a, b, **kw: {'id': id, 'summary': title, 'start': {'dateTime': f'2026-11-{day}T{a}:00+01:00', 'timeZone': TZ}, 'end': {'dateTime': f'2026-11-{day}T{b}:00+01:00', 'timeZone': TZ}, **kw}
LOCAL = [
    ev('s1', 'Standup', '09', '10:00', '10:15', recurrence=['RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR']),
    ev('w1', 'Team lunch', '09', '12:00', '13:00', recurrence=['RRULE:FREQ=WEEKLY;BYDAY=MO']),
    ev('d1', 'Dentist', '16', '14:00', '15:00'),
    ev('r1', 'Review', '16', '15:00', '15:30'), ev('r2', 'Review', '17', '15:00', '15:30'),
    ev('z1', '😴 Sleep', '16', '13:00', '13:30', extendedProperties={'private': {'tempoSleep': '2026-11-16'}}),
]

async def run_cmd(page, cmds):
    return json.loads(await page.evaluate(f'async () => JSON.stringify(await window.tempo.run({json.dumps(cmds)}))'))

async def day(p, k):
    r = await run_cmd(p, [{'cmd': 'listEvents', 'from': f'2026-11-{k}', 'to': f'2026-11-{k}'}])
    return sorted((e['title'], e['start'][11:]) for e in r[0]['result'])

async def main(app):
    extra = f"\nif (!localStorage.getItem('tempo:localEvents')) localStorage.setItem('tempo:localEvents', JSON.stringify({json.dumps(LOCAL)}));"
    p = await app.page(settings={'tz': TZ, 'bounds': {'start': '09:00', 'end': '17:00', 'days': [1, 2, 3, 4, 5]}}, now=NOW, wait=2500, extra=extra)
    p.set_default_timeout(8000)
    mon0, tue0 = await day(p, 16), await day(p, 17)
    app.check('1. before: Monday has 5 events, Tuesday has Standup and Review', len(mon0) == 5 and tue0 == [('Review', '15:00'), ('Standup', '10:00')], (mon0, tue0))
    await run_cmd(p, [{'cmd': 'setLeave', 'from': '2026-11-16', 'kind': 'sick'}]); await p.wait_for_timeout(4000)
    mon, tue = await day(p, 16), await day(p, 17)
    app.check('2. Tuesday has exactly one Standup (the repeating event is not copied onto it)', [t for t in tue if t[0] == 'Standup'] == [('Standup', '10:00')], tue)
    app.check('3. one-off events move to Tuesday at the same time (Dentist 14:00)', ('Dentist', '14:00') in tue and not any(t[0] == 'Dentist' for t in mon), (mon, tue))
    app.check('4. a weekly event that does not happen on Tuesday moves there once', [t for t in tue if t[0] == 'Team lunch'] == [('Team lunch', '12:00')] and not any(t[0] == 'Team lunch' for t in mon), (mon, tue))
    app.check('5. an event already on Tuesday with the same title and time is not doubled', [t for t in tue if t[0] == 'Review'] == [('Review', '15:00')], tue)
    app.check("6. Tempo's own daily blocks (sleep) are not moved", any('Sleep' in t[0] for t in mon) and not any('Sleep' in t[0] for t in tue), (mon, tue))
    app.check('7. Tuesday has no two events with the same title', len({t[0] for t in tue}) == len(tue), tue)
    # the following Monday still has its own Standup and Team lunch (only this occurrence moved)
    nxt = await day(p, 23)
    app.check('8. next Monday is untouched', nxt == [('Standup', '10:00'), ('Team lunch', '12:00')], nxt)
    await p.close()

    # two leave days: Monday's and Tuesday's occurrences of one series don't both land on Wednesday
    p = await app.page(settings={'tz': TZ, 'bounds': {'start': '09:00', 'end': '17:00', 'days': [1, 2, 3, 4, 5]}}, now=NOW, wait=2500,
                       extra=f"\nif (!localStorage.getItem('tempo:localEvents')) localStorage.setItem('tempo:localEvents', JSON.stringify({json.dumps([ev('m1', 'Class', '09', '11:00', '12:00', recurrence=['RRULE:FREQ=WEEKLY;BYDAY=MO,TU'])])}));")
    await run_cmd(p, [{'cmd': 'setLeave', 'from': '2026-11-16', 'to': '2026-11-17', 'kind': 'vacation'}]); await p.wait_for_timeout(4000)
    wed = await day(p, 18)
    app.check('9. two leave days: only one occurrence of the series lands on Wednesday', wed == [('Class', '11:00')], wed)
    await p.close()

    # ——— Settings: + Add rule on a new period, with a fill-in block set up ———
    for dev, kw in [('phone', {'device': 'Pixel 7'}), ('desktop', {})]:
        p = await app.page(settings={'tz': TZ, 'autoFills': [{'id': 'f1', 'on': True, 'from': '18:00', 'to': '20:00', 'catId': 'work', 'days': [1, 2, 3, 4, 5]}]}, now=NOW, wait=2500, **kw)
        p.set_default_timeout(8000)
        tap = p.tap if dev == 'phone' else p.click
        await p.evaluate("document.getElementById('btn-settings').click()"); await p.wait_for_selector('dialog .settings-form')
        tab = await p.evaluate("document.querySelector('dialog .periods-list').closest('[data-pane]').dataset.pane")
        await tap(f'dialog .tabs button[data-tab="{tab}"]'); await p.wait_for_timeout(300)
        await p.evaluate("(() => { const d = document.querySelector('dialog .periods-list').closest('details'); if (d) d.open = true; })()")
        n0 = await p.evaluate("document.querySelectorAll('dialog .periods-list > .period').length")
        await p.locator('dialog .add-period').scroll_into_view_if_needed(); await tap('dialog .add-period'); await p.wait_for_timeout(300)
        last = 'dialog .periods-list > .period:last-child'
        await p.locator(f'{last} .per-add-rule').scroll_into_view_if_needed(); await tap(f'{last} .per-add-rule'); await p.wait_for_timeout(300)
        app.check(f'10. {dev}: + Add rule works on a period just added (2 rules)', await p.evaluate("document.querySelectorAll('dialog .periods-list > .period').length") == n0 + 1 and await p.evaluate(f"document.querySelectorAll('{last} .per-rule').length") == 2)
        await tap(f'{last} .per-rule .r-del >> nth=-1'); await p.wait_for_timeout(300)
        app.check(f'11. {dev}: removing a rule works too, and the fill-in block is still there', await p.evaluate(f"document.querySelectorAll('{last} .per-rule').length") == 1 and await p.evaluate("document.querySelectorAll('dialog .fill-rule').length") == 1)
        await p.close()

App.run(main, port=8969)
