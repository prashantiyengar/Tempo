# Round 64: the Bookcase scrolls on phones (its body scrolls, not the dialog), number habits line up under their
# days in the sidebar (and Goals) and a figure can be entered for a day from the sidebar.
import sys, json
sys.path.insert(0, 'test')
from harness import App

TZ = 'Europe/Berlin'
NOW = '2026-11-03T09:00:00Z'
HABITS = [
    {'id': 'h1', 'name': 'Meditate', 'type': 'yesno', 'freq': {'times': 1, 'per': 'day'}, 'created': 1, 'color': '#0f9d76', 'log': {'2026-11-02': 1}},
    {'id': 'h2', 'name': 'Water', 'type': 'number', 'target': 8, 'unit': 'glasses', 'freq': {'times': 1, 'per': 'day'}, 'created': 1, 'color': '#4f6bed', 'log': {'2026-11-02': 6, '2026-11-01': 8}},
    {'id': 'h3', 'name': 'Running distance', 'type': 'number', 'target': 20, 'unit': 'km', 'freq': {'times': 1, 'per': 'week'}, 'created': 1, 'log': {'2026-11-01': 5.5}},
]

async def run_cmd(page, cmds):
    return json.loads(await page.evaluate(f'async () => JSON.stringify(await window.tempo.run({json.dumps(cmds)}))'))

async def main(app):
    # ——— 1. Bookcase on a phone ———
    p = await app.page(settings={'tz': TZ}, now=NOW, device='Pixel 7', wait=2500)
    p.set_default_timeout(8000)
    await run_cmd(p, [{'cmd': 'addTask', 'title': f'Book {i}', 'pages': 150 + i * 10, 'deadline': f'2026-12-{10 + i}'} for i in range(8)])
    await p.wait_for_timeout(1500)
    await p.tap('#btn-menu'); await p.wait_for_timeout(400)
    await p.tap('#task-list .lib-open'); await p.wait_for_selector('dialog .bookcase'); await p.wait_for_timeout(600)
    g = await p.evaluate("""(() => { const d = document.querySelector('dialog[open]'), b = d.querySelector('.dlg-body');
        return { dlgOver: d.scrollHeight - d.clientHeight, bodyOver: b.scrollHeight - b.clientHeight, fits: d.getBoundingClientRect().bottom <= innerHeight + 1, oy: getComputedStyle(b).overflowY }; })()""")
    app.check('1. the Bookcase fits the phone screen and its body scrolls (not the dialog)', g['dlgOver'] <= 1 and g['bodyOver'] > 50 and g['fits'] and g['oy'] == 'auto', g)
    box = await p.locator('dialog .dlg-body').bounding_box()
    await p.mouse.move(box['x'] + box['width'] / 2, box['y'] + box['height'] * 0.6); await p.mouse.wheel(0, 2000); await p.wait_for_timeout(500)
    last = await p.evaluate("(() => { const rows = document.querySelectorAll('dialog .lib-t tr'); const r = rows[rows.length - 1].getBoundingClientRect(); return r.bottom <= innerHeight + 1 && r.top >= 0; })()")
    app.check('2. scrolling reaches the last book in the tables', last)
    await p.close()

    # ——— 2. Number habits in the sidebar ———
    for dev, kw in [('desktop', {'viewport': {'width': 1400, 'height': 900}}), ('phone', {'device': 'Pixel 7'})]:
        p = await app.page(settings={'tz': TZ, 'habits': HABITS}, now=NOW, wait=2500, **kw)
        p.set_default_timeout(8000)
        tap = p.tap if dev == 'phone' else p.click
        if dev == 'phone': await p.tap('#btn-menu'); await p.wait_for_timeout(400)
        await tap('.side-tabs [data-st=habits]'); await p.wait_for_timeout(600)
        heads = await p.evaluate("[...document.querySelectorAll('#habit-list .hb-headrow .hb-day')].map(d => Math.round(d.getBoundingClientRect().left + d.getBoundingClientRect().width / 2))")
        rows = json.loads(await p.evaluate("JSON.stringify([...document.querySelectorAll('#habit-list .hb-row[data-id]')].map(r => ({ id: r.dataset.id, c: [...r.querySelectorAll('.hb-c')].map(c => ({ k: c.dataset.k, x: Math.round(c.getBoundingClientRect().left + c.getBoundingClientRect().width / 2), w: Math.round(c.getBoundingClientRect().width), t: c.textContent.trim() })) })))"))
        aligned = all(len(r['c']) == len(heads) and all(abs(c['x'] - h) <= 2 for c, h in zip(r['c'], heads)) for r in rows)
        widths = {c['w'] for r in rows for c in r['c']}
        app.check(f'3. {dev}: every habit cell sits under its day (number habits too), all the same width', aligned and len(widths) == 1, (heads, rows))
        water = next(r for r in rows if r['id'] == 'h2')['c']
        app.check(f'4. {dev}: Water shows 0 · 6 · 8 · 0 for Tue · Mon · Sun · Sat', [c['t'].replace('glasses', '') for c in water] == ['0', '6', '8', '0'], water)
        inside = await p.evaluate("(() => { const s = document.querySelector('#side').getBoundingClientRect(); return [...document.querySelectorAll('#habit-list .hb-c')].every(c => c.getBoundingClientRect().right <= s.right + 1); })()")
        app.check(f'5. {dev}: no cell spills out of the sidebar', inside)
        await tap('#habit-list .hb-row[data-id=h2] .hb-c[data-k="2026-11-03"]')
        await p.wait_for_selector('dialog .hb-amount')
        await p.fill('dialog .hb-amount [name=v]', '7'); await p.click('dialog .hb-amount .btn.primary'); await p.wait_for_timeout(800)
        v = await p.evaluate("window.__tempo.app.state.settings.habits.find(h => h.id === 'h2').log['2026-11-03']")
        t = await p.text_content('#habit-list .hb-row[data-id=h2] .hb-c[data-k="2026-11-03"]')
        app.check(f'6. {dev}: entering 7 for today from the sidebar saves it and shows it', v == 7 and t.strip().startswith('7'), (v, t))
        ring = await p.evaluate("document.querySelector('#habit-list .hb-row[data-id=h3] .hb-ring circle:last-child').getAttribute('stroke')")
        app.check(f'7. {dev}: a habit without a colour still gets a coloured ring', ring and ring != 'undefined', ring)
        await p.close()

    # ——— 3. Goals tab habits grid ———
    p = await app.page(settings={'tz': TZ, 'habits': HABITS}, now=NOW, wait=2500)
    await p.keyboard.press('g'); await p.wait_for_timeout(1200)
    w = await p.evaluate("[...new Set([...document.querySelectorAll('.g-habits .hb-c')].map(c => Math.round(c.getBoundingClientRect().width)))]")
    app.check('8. Goals tab: number and yes/no cells are the same width', len(w) == 1, w)
    await p.close()

App.run(main, port=8965)
