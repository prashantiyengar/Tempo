# Round 73: "Abandon the rest" on a session under way (it stays; the later ones go), and ☢ Clear the day's schedule
# offered on every event / task session of today or later and in the day's menu (with on leave / sick leave).
import sys, json
sys.path.insert(0, 'test')
from harness import App

TZ = 'Europe/Berlin'
NOW = '2026-11-16T07:00:00Z'   # Mon 08:00 Berlin
BASE = {'tz': TZ, 'bounds': {'start': '09:00', 'end': '17:00', 'days': [1, 2, 3, 4, 5]}}

async def run_cmd(page, cmds):
    return json.loads(await page.evaluate(f'async () => JSON.stringify(await window.tempo.run({json.dumps(cmds)}))'))

def res(rv):
    r = rv[0].get('result') if rv else None
    return r.get('result', r) if isinstance(r, dict) and 'result' in r else r

async def sess(p, task):
    return res(await run_cmd(p, [{'cmd': 'listSessions', 'task': task, 'from': '2026-11-01', 'to': '2027-03-01'}])) or []

async def show_day(p, day, view='week'):
    await p.evaluate(f"(() => {{ const a = window.__tempo.app; a.view = '{view}'; a.cursor = '{day}'; return window.__tempo.render(); }})()")
    await p.wait_for_timeout(700)

async def main(app):
    for dev, kw in [('desktop', {'viewport': {'width': 1400, 'height': 900}}), ('phone', {'device': 'Pixel 7'})]:
        p = await app.page(settings=BASE, now=NOW, wait=2500, auth={}, **kw)
        p.set_default_timeout(8000)
        tap = p.tap if dev == 'phone' else p.click
        view = 'day' if dev == 'phone' else 'week'
        await run_cmd(p, [{'cmd': 'addTask', 'title': 'Dune', 'pages': 200, 'pagesPerHour': 40, 'deadline': '2026-11-27 17:00', 'sessionMinutes': 60},
                          {'cmd': 'addEvent', 'title': 'Standup', 'start': '2026-11-16 15:00', 'end': '2026-11-16 15:30', 'calendar': 'Local'},
                          {'cmd': 'addEvent', 'title': 'Wed call', 'start': '2026-11-18 11:00', 'end': '2026-11-18 11:30', 'calendar': 'Local'}])
        await p.wait_for_timeout(1500)
        # the first session is under way: it started 20 minutes ago and runs another 40
        await p.evaluate("""(() => { const s = window.__tempo.app.state, t = s.tasks.find(x => x.title === 'Dune'), now = Date.now();
            const pl = [...t.planned].sort((a, b) => a.start - b.start); pl[0].start = now - 20 * 60000; pl[0].end = now + 40 * 60000; pl[0].syncHash = null; })()""")
        await p.evaluate("window.__tempo.cycle()"); await p.wait_for_timeout(2500)
        ss = await sess(p, 'Dune'); first = ss[0]; later = len(ss) - 1
        await show_day(p, '2026-11-16', view)
        el = p.locator(f'.ev[data-key="c|{first["id"]}"]').first
        await el.scroll_into_view_if_needed(); await tap(f'.ev[data-key="c|{first["id"]}"]'); await p.wait_for_selector('.popover .pop-actions')
        app.check(f'1. {dev}: the session under way has "Abandon the rest"', await p.is_visible('.popover .abandon'), first)
        app.check(f"2. {dev}: … and ☢ Clear today's schedule", 'Clear today’s schedule' in (await p.text_content('.popover .clear-day') or ''))
        await tap('.popover .abandon'); await p.wait_for_selector('dialog[open] .choice')
        txt = await p.text_content('dialog[open] .choice')
        app.check(f'3. {dev}: it says this session stays and the {later} after it go; 40 of 200 pages read', 'This session stays' in txt and f'{later} sessions after it' in txt and '40 of 200 pages' in txt, txt.strip()[:220])
        await tap('dialog[open] .choice-btn.primary'); await p.wait_for_timeout(2500)
        ss2 = await sess(p, 'Dune')
        t = json.loads(await p.evaluate("JSON.stringify(window.__tempo.app.state.tasks.find(t => t.title === 'Dune'))"))
        app.check(f'4. {dev}: the session under way stays; the later ones are gone; set aside at 20% (40 pages)', len(ss2) == 1 and ss2[0]['id'] == first['id'] and t['abandoned']['pct'] == 20 and t['abandoned']['read'] == 40, (ss2, t.get('abandoned')))
        # ☢ on an event of another day opens the dialog for that day
        await show_day(p, '2026-11-18', view)
        ev = p.locator('.ev:has-text("Wed call")').first
        await ev.scroll_into_view_if_needed(); await tap('.ev:has-text("Wed call")'); await p.wait_for_selector('.popover .pop-actions')
        lab = await p.text_content('.popover .clear-day')
        await tap('.popover .clear-day'); await p.wait_for_selector('dialog .clear-day'); await p.wait_for_timeout(700)
        app.check(f"5. {dev}: an event on Wednesday offers ☢ Clear this day's schedule, for Wednesday, the whole day",
                  'Clear this day’s schedule' in lab and await p.input_value('dialog .clear-day [name=day]') == '2026-11-18' and 'The whole day' in await p.text_content('dialog .cd-day-l') and '1 event' in await p.text_content('dialog .cd-preview'), lab)
        await p.keyboard.press('Escape'); await p.wait_for_timeout(400)
        # the day's own menu: on leave, sick leave and ☢
        await show_day(p, '2026-11-16', view)
        await tap('.tg-dayhead[data-day="2026-11-16"] .leave-menu'); await p.wait_for_selector('.popover .leave-pop')
        pop = await p.text_content('.popover .leave-pop')
        app.check(f"6. {dev}: clicking the day: on leave, sick leave and ☢ Clear today's schedule", 'Sick' in pop and 'leave' in pop.lower() and 'Clear today’s schedule' in pop, pop)
        await tap('.popover .lv-nuke'); await p.wait_for_selector('dialog .clear-day'); await p.wait_for_timeout(700)
        app.check(f'7. {dev}: … which opens the dialog for the rest of today', await p.input_value('dialog .clear-day [name=day]') == '2026-11-16' and 'rest of today' in await p.text_content('dialog .cd-day-l'))
        await p.screenshot(path=f'{app.out}/r73-{dev}-clear.png')
        await p.keyboard.press('Escape'); await p.wait_for_timeout(400)
        # a past day has no ☢
        await show_day(p, '2026-11-13', view)
        await tap('.tg-dayhead[data-day="2026-11-13"] .leave-menu'); await p.wait_for_selector('.popover .leave-pop')
        app.check(f'8. {dev}: a past day has no ☢', not await p.query_selector('.popover .lv-nuke'))
        await p.close()

App.run(main, port=8975)
