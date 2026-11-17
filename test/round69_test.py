# Round 69: From and To stay independent — but a From moved to or past the To takes the To along, keeping the length.
import sys, json
sys.path.insert(0, 'test')
from harness import App

TZ = 'Europe/Berlin'
NOW = '2026-11-17T08:00:00Z'   # Tue 09:00 Berlin

async def type_time(page, sel, digits):
    box = await page.locator(sel).bounding_box()
    await page.mouse.click(box['x'] + 8, box['y'] + box['height'] / 2)
    await page.keyboard.type(digits); await page.keyboard.press('Tab'); await page.wait_for_timeout(200)

async def main(app):
    p = await app.page(settings={'tz': TZ}, now=NOW, wait=2500)
    p.set_default_timeout(8000)
    v = lambda n: p.input_value(f'dialog [name={n}]')
    await p.click('#btn-new-event'); await p.wait_for_selector('dialog [name=sTime]')
    await type_time(p, 'dialog [name=sTime]', '1000'); await type_time(p, 'dialog [name=eTime]', '1130')
    await type_time(p, 'dialog [name=sTime]', '1045')
    app.check('1. From moved but still before To: To stays (11:30)', await v('eTime') == '11:30')
    await type_time(p, 'dialog [name=sTime]', '1400')
    app.check('2. From typed past To: To follows with the length it had (14:00 → 14:45)', await v('eTime') == '14:45' and await v('eDate') == '2026-11-17', await v('eTime'))
    await type_time(p, 'dialog [name=sTime]', '1430')
    app.check('3. From 14:30, still before the new To 14:45: To stays', await v('eTime') == '14:45', await v('eTime'))
    await type_time(p, 'dialog [name=sTime]', '1600')
    app.check('3a. From 16:00 past it: To 16:15 (the 15 minutes it had)', await v('eTime') == '16:15', await v('eTime'))
    # −/+ under From
    setf = lambda n, val: p.evaluate(f"(() => {{ const d = document.querySelector('dialog [name={n}]'); d.dispatchEvent(new PointerEvent('pointerdown', {{ bubbles: true }})); d.value = '{val}'; d.dispatchEvent(new CustomEvent('change', {{ bubbles: true, detail: 'user' }})); }})()")
    await setf('eTime', '10:30'); await setf('sTime', '10:00'); await p.click('dialog [name=summary]')
    await p.click('dialog .t-adj .ndg-t[data-sign="1"] >> nth=0'); await p.click('dialog .st-add[data-add="15"]')
    app.check('4. From +15 min (10:15, before To 10:30): To stays', await v('sTime') == '10:15' and await v('eTime') == '10:30', (await v('sTime'), await v('eTime')))
    await p.click('dialog .st-add[data-add="15"]')
    app.check('5. From +15 again reaches To: To moves on, same length (10:30–11:00)', await v('sTime') == '10:30' and await v('eTime') == '11:00', (await v('sTime'), await v('eTime')))
    # a later From date takes the To date along
    await setf('sDate', '2026-11-20')
    app.check('6. From date after the To date: the To date follows, times kept', await v('eDate') == '2026-11-20' and await v('eTime') == '11:00', (await v('eDate'), await v('eTime')))
    # all-day: keeps its number of days
    await p.check('dialog [name=allDay]')
    await setf('eDate', '2026-11-22'); await setf('sDate', '2026-11-21')
    app.check('7. all-day: a From still within the range leaves To alone', await v('eDate') == '2026-11-22')
    await setf('sDate', '2026-11-25')
    app.check('8. all-day: a From past To keeps the number of days (25th–26th)', await v('eDate') == '2026-11-26', await v('eDate'))
    await p.keyboard.press('Escape'); await p.wait_for_timeout(300)
    if await p.query_selector('dialog[open]'): await p.keyboard.press('Escape'); await p.wait_for_timeout(300)

    # quick create
    await p.evaluate("document.querySelector('.tg-scroll').scrollTop = 9 * window.__tempo.app.state.settings.hourHeight")
    cols = await p.query_selector_all('.tg-col'); box = await cols[3].bounding_box(); hh = await p.evaluate('window.__tempo.app.state.settings.hourHeight')
    top = await p.evaluate("document.querySelectorAll('.tg-col')[3].getBoundingClientRect().top")
    await p.mouse.move(box['x'] + 20, top + 10 * hh + 2); await p.mouse.down(); await p.mouse.move(box['x'] + 20, top + 11 * hh - 2, steps=4); await p.mouse.up()
    await p.wait_for_selector('.popover [name=qs]')
    await type_time(p, '.popover [name=qs]', '1030')
    app.check('9. quick create: From 10:30 (before To 11:00) leaves To', await p.input_value('.popover [name=qe]') == '11:00')
    await type_time(p, '.popover [name=qs]', '1300')
    when = await p.text_content('.popover .qc-when')
    app.check('10. quick create: From 13:00 past To: 13:00–13:30 the same day (not into tomorrow)', await p.input_value('.popover [name=qe]') == '13:30' and '(30m)' in when, when)
    await p.click('.popover .qc-cancel')

    # task dialog: From (don't start before) past the deadline keeps the distance
    await p.click('#btn-new-task'); await p.wait_for_selector('dialog .task-form')
    setv = lambda n, val: p.evaluate(f"(() => {{ const d = document.querySelector('dialog [name={n}]'); d.dispatchEvent(new PointerEvent('pointerdown', {{ bubbles: true }})); d.focus(); d.value = '{val}'; d.dispatchEvent(new CustomEvent('change', {{ bubbles: true, detail: 'user' }})); }})()")
    await setv('deadline', '2026-11-20T17:00'); await setv('earliest', '2026-11-18T09:00')
    app.check('11. task: From before the deadline leaves it', await v('deadline') == '2026-11-20T17:00')
    await setv('earliest', '2026-11-24T09:00')
    app.check('12. task: From past the deadline moves it on by the same distance (26 Nov 17:00)', await v('deadline') == '2026-11-26T17:00', await v('deadline'))
    await p.keyboard.press('Escape')
    await p.close()

App.run(main, port=8970)
