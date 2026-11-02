# Round 63: "since last event" starts 1 minute after it, back-to-back events stay full width, settings (habits,
# graveyard …) merge between devices instead of overwriting each other, fill-in blocks start 2 minutes after events.
import sys, json
sys.path.insert(0, 'test')
from harness import App

TZ = 'Europe/Berlin'

async def run_cmd(page, cmds):
    return json.loads(await page.evaluate(f'async () => JSON.stringify(await window.tempo.run({json.dumps(cmds)}))'))

def res(rv):
    r = rv[0].get('result') if rv else None
    return r.get('result', r) if isinstance(r, dict) and 'result' in r else r

async def main(app):
    # ——— 1. Fill time since last event: 1 minute after it ———
    page = await app.page(settings={'tz': TZ, 'sinceLastBuffer': 0}, now='2026-11-02T13:40:00Z', wait=2500)  # 14:40 Berlin
    page.set_default_timeout(8000)
    app.check('1. saved "0" becomes 1 minute (one-time upgrade)', await page.evaluate('window.__tempo.app.state.settings.sinceLastBuffer') == 1)
    await run_cmd(page, [{'cmd': 'addEvent', 'title': 'Planning', 'start': '2026-11-02 14:06', 'end': '2026-11-02 14:21'}])
    await page.wait_for_timeout(1200)
    await page.evaluate("import('./js/commands.js').then(m => { m.runCommand('since'); })")
    await page.wait_for_selector('dialog [name=sTime]')
    app.check('2. fill since last event starts at 14:22', await page.input_value('dialog [name=sTime]') == '14:22', await page.input_value('dialog [name=sTime]'))
    await page.fill('dialog [name=summary]', 'Deep work')
    await page.click('dialog button[type=submit] >> nth=-1')
    try: await page.click('dialog .ask-cat [data-close]', timeout=1500)
    except Exception: pass
    await page.wait_for_timeout(1500)

    # ——— 2. Back-to-back events are drawn full width ———
    await run_cmd(page, [{'cmd': 'addEvent', 'title': 'Admin', 'start': '2026-11-02 15:30', 'end': '2026-11-02 15:36'}, {'cmd': 'addEvent', 'title': 'Call', 'start': '2026-11-02 15:40', 'end': '2026-11-02 16:00'}])
    await page.wait_for_timeout(1500)
    geo = json.loads(await page.evaluate("""JSON.stringify([...document.querySelectorAll('.tg-col[data-day="2026-11-02"] .ev')].map(e => { const r = e.getBoundingClientRect(), c = e.closest('.tg-col').getBoundingClientRect(); return { t: e.querySelector('.ev-t')?.textContent.trim(), w: r.width / c.width, top: r.top, bottom: r.bottom }; }))"""))
    by = {g['t'].split(' ')[-1] if g['t'] else '': g for g in geo}
    pl, dw, ad, ca = (next((g for g in geo if n in (g['t'] or '')), None) for n in ('Planning', 'Deep work', 'Admin', 'Call'))
    app.check('3. 14:06–14:21 and 14:22–… both (nearly) full width', pl and dw and pl['w'] > 0.8 and dw['w'] > 0.8, geo)
    app.check('4. 6-minute event followed 4 min later: both full width', ad and ca and ad['w'] > 0.8 and ca['w'] > 0.8, (ad, ca))
    app.check('5. the short event does not reach into the next one', ad and ca and ad['bottom'] <= ca['top'] + 1, (ad, ca))
    await page.close()

    # ——— 3. Settings merge between two devices ———
    habit = {'id': 'h1', 'name': 'Run', 'type': 'yesno', 'freq': {'times': 3, 'per': 'week'}, 'created': 1, 'log': {}}
    A = await app.page(settings={'tz': TZ, 'habits': [habit]}, now='2026-11-02T08:00:00Z', wait=2500)
    await A.evaluate('window.__tempo.cycle({ pull: true })'); await A.wait_for_timeout(1500)
    B = await app.page(settings={'tz': TZ}, now='2026-11-02T08:00:00Z', wait=2500)
    await B.evaluate('window.__tempo.cycle({ pull: true })'); await B.wait_for_timeout(1500)
    app.check('6. B gets the habit from A', await B.evaluate("(window.__tempo.app.state.settings.habits || []).map(h => h.name).join()") == 'Run')
    # A changes the habit's settings; B ticks today (both before syncing again)
    await A.evaluate("""(async () => { const s = window.__tempo.app.state.settings; s.habits = s.habits.map(h => ({ ...h, name: 'Morning run', freq: { times: 5, per: 'week' } })); await window.__tempo.E.persist(window.__tempo.app.state, ['settings']); })()""")
    await B.evaluate("""(async () => { const s = window.__tempo.app.state.settings; s.habits = s.habits.map(h => ({ ...h, log: { ...h.log, '2026-11-02': 1 } })); s.graveyard = [{ id: 'g1', text: 'Old report', kind: 'task', addedAt: Date.now(), created: Date.now() }]; await window.__tempo.E.persist(window.__tempo.app.state, ['settings']); })()""")
    await A.evaluate('window.__tempo.cycle({ pull: true })'); await A.wait_for_timeout(1500)
    await B.evaluate('window.__tempo.cycle({ pull: true })'); await B.wait_for_timeout(1500)
    await A.evaluate('window.__tempo.cycle({ pull: true })'); await A.wait_for_timeout(1500)
    ha = await A.evaluate("JSON.stringify(window.__tempo.app.state.settings.habits[0])")
    hb = await B.evaluate("JSON.stringify(window.__tempo.app.state.settings.habits[0])")
    ha, hb = json.loads(ha), json.loads(hb)
    ok = lambda h: h['name'] == 'Morning run' and h['freq']['times'] == 5 and h['log'].get('2026-11-02') == 1
    app.check("7. A has its own habit change and B's tick", ok(ha), ha)
    app.check("8. B has A's habit change and its own tick", ok(hb), hb)
    app.check('9. the Graveyard syncs too', await A.evaluate("(window.__tempo.app.state.settings.graveyard || []).map(x => x.text).join()") == 'Old report')
    await A.close(); await B.close()

    # ——— 4. Fill-in blocks start 2 minutes after events, still need 15 free minutes ———
    page = await app.page(settings={
        'tz': 'UTC', 'bounds': {'start': '06:00', 'end': '22:00', 'days': [0, 1, 2, 3, 4, 5, 6]},
        'autoFills': [{'id': 'f1', 'on': True, 'from': '12:00', 'to': '15:00', 'catId': 'cat1', 'delayMin': 0, 'cal': 'local'}],
        'categories': [{'id': 'cat1', 'name': 'Admin block', 'color': '#3b82f6', 'icon': '🗂'}],
    }, now='2026-11-02T11:00:00Z', wait=2500)
    await run_cmd(page, [{'cmd': 'addEvent', 'title': 'Lunch', 'start': '2026-11-02 12:30', 'end': '2026-11-02 13:00', 'calendar': 'Local'},
                         {'cmd': 'addEvent', 'title': 'Review', 'start': '2026-11-02 13:10', 'end': '2026-11-02 13:40', 'calendar': 'Local'}])
    await page.evaluate("sessionStorage.setItem('test:off', String(4 * 3600000))"); await page.reload(); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(5000)
    evs = res(await run_cmd(page, [{'cmd': 'listEvents', 'from': '2026-11-02', 'to': '2026-11-03'}])) or []
    fills = sorted((e['start'][11:], e['end'][11:]) for e in evs if 'Admin block' in (e.get('title') or '') or '🗂' in (e.get('title') or ''))
    # (part 1's events share this fake Google calendar: Admin 14:30–14:36 and Call 14:40–15:00 UTC are in the window too)
    app.check('10. fill-ins: 12:00–12:30, none in the 10-min gap, 13:42–14:30 (2 min after Review; none in 4-min gap)', fills == [('12:00', '12:30'), ('13:42', '14:30')], (fills, [(e['title'], e['start'], e['end']) for e in evs]))
    await page.close()

App.run(main, port=8964)
