# Round 61: Category selection near title, category prompt, goal-setting auto-slot,
# analysis period presets, graveyard improvements, custom calendar flags.
import sys, json
sys.path.insert(0, 'test')
from harness import App

async def run_cmd(page, cmds_json):
    """Run tempo commands and return parsed JSON result."""
    raw = await page.evaluate(f'async () => JSON.stringify(await window.tempo.run({cmds_json}))')
    return json.loads(raw) if raw else []

def res(rv, key='result'):
    """Extract from run() result: rv is [{"cmd":...,"result":...},...]. Returns first cmd's result."""
    if not rv: return None
    r = rv[0] if isinstance(rv, list) else rv
    inner = r.get('result') if isinstance(r, dict) else None
    # Commands like listFlags return {result:[...]}, so run() wraps as {result:{result:[...]}}
    if isinstance(inner, dict) and key in inner:
        return inner[key]
    return inner

async def main(app):
    NOW = '2024-10-28T10:00:00Z'

    # ——————————————————————————————————————————————
    # Feature 6: Custom calendar flags (add, list, delete via API)
    # ——————————————————————————————————————————————
    page = await app.page(
        settings={
            'tz': 'UTC',
            'bounds': {'start': '09:00', 'end': '17:00', 'days': [1,2,3,4,5]},
        },
        now=NOW,
        wait=3000,
    )

    # Add a flag via API
    rf = await run_cmd(page, '[{"cmd":"addFlag","text":"Project deadline","date":"2024-10-30","time":"14:00","color":"#e74c3c"}]')
    r0 = rf[0] if rf else {}
    app.check('1. addFlag succeeds', r0 and not r0.get('error'), r0.get('error') if r0 else 'no result')

    # List flags
    lf = await run_cmd(page, '[{"cmd":"listFlags"}]')
    flags = res(lf) or []
    app.check('2. listFlags returns 1 flag', len(flags) == 1, f'count={len(flags)}')
    f0 = flags[0] if flags else {}
    app.check('3. flag text correct', f0.get('text') == 'Project deadline')
    app.check('4. flag date correct', f0.get('date') == '2024-10-30')
    app.check('5. flag time correct', f0.get('time') == '14:00')
    app.check('6. flag color correct', f0.get('color') == '#e74c3c')

    # Add a second flag
    await run_cmd(page, '[{"cmd":"addFlag","text":"Sprint ends","date":"2024-11-01"}]')
    lf2 = await run_cmd(page, '[{"cmd":"listFlags"}]')
    flags2 = res(lf2) or []
    app.check('7. now 2 flags', len(flags2) == 2)

    # Delete a flag by text
    df = await run_cmd(page, '[{"cmd":"deleteFlag","flag":"Sprint ends"}]')
    d0 = df[0] if df else {}
    app.check('8. deleteFlag succeeds', d0 and not d0.get('error'), d0.get('error') if d0 else 'no result')

    lf3 = await run_cmd(page, '[{"cmd":"listFlags"}]')
    flags3 = res(lf3) or []
    app.check('9. back to 1 flag after delete', len(flags3) == 1)
    f3 = flags3[0] if flags3 else {}
    app.check('10. remaining flag is Project deadline', f3.get('text') == 'Project deadline')

    await page.close()

    # ——————————————————————————————————————————————
    # Feature 5: Graveyard improvements
    # ——————————————————————————————————————————————
    page2 = await app.page(
        settings={
            'tz': 'UTC',
            'bounds': {'start': '09:00', 'end': '17:00', 'days': [1,2,3,4,5]},
        },
        now=NOW,
        wait=3000,
    )

    tab_text = await page2.evaluate('''() => {
        const btn = document.querySelector('[data-st="graveyard"]');
        return btn ? btn.textContent : null;
    }''')
    app.check('11. graveyard tab shows name', tab_text and 'Graveyard' in tab_text, tab_text)

    # Add a task then bury it
    await run_cmd(page2, '[{"cmd":"addTask","title":"Old report","hours":1,"start":"2024-10-20"}]')
    await page2.wait_for_timeout(1000)
    await run_cmd(page2, '[{"cmd":"moveTaskToGraveyard","task":"Old report"}]')
    await page2.wait_for_timeout(500)

    # Open graveyard tab
    await page2.evaluate('''() => {
        const btn = document.querySelector('[data-st="graveyard"]');
        if (btn) btn.click();
    }''')
    await page2.wait_for_timeout(500)

    gy_html = await page2.evaluate('''() => {
        const el = document.querySelector('#grave-list');
        return el ? el.innerHTML : '';
    }''')
    app.check('12. graveyard has content', bool(gy_html))
    has_gravestone = '🪦' in gy_html if gy_html else False
    app.check('13. graveyard shows gravestone icon', has_gravestone, 'looking for 🪦')
    app.check('13a. graveyard explains itself', "couldn't complete" in gy_html)
    app.check('13b. lifespan shows created and buried dates', 'Oct' in gy_html and '–' in gy_html or '→' in gy_html, gy_html[:400])
    app.check('13c. reschedule count shown', 'rescheduled 0×' in gy_html, gy_html[:600])
    gl = await run_cmd(page2, '[{"cmd":"listGraveyard"}]')
    g = (gl[0].get('result') or {}).get('active', [])
    app.check('13d. API lists lifespan (created + buried) and count', g and g[0].get('created') and g[0].get('added') and g[0].get('rescheduled') == 0, g)
    # rescue it, then bury it again: counted once
    await run_cmd(page2, '[{"cmd":"rescheduleFromGraveyard","item":"Old report","as":"task"}]')
    await page2.wait_for_timeout(800)
    await run_cmd(page2, '[{"cmd":"moveTaskToGraveyard","task":"Old report"}]')
    await page2.wait_for_timeout(800)
    gl = await run_cmd(page2, '[{"cmd":"listGraveyard"}]')
    g = (gl[0].get('result') or {}).get('active', [])
    app.check('13e. rescued then buried again: rescheduled 1×', len(g) == 1 and g[0].get('rescheduled') == 1, g)
    html2 = await page2.evaluate("document.querySelector('#grave-list').innerHTML")
    app.check('13f. gravestone shows rescheduled 1×', 'rescheduled 1×' in html2)

    await page2.close()

    # ——————————————————————————————————————————————
    # Feature 3: Goal auto-slot (Tue 29 Oct: next month starts in 3 days, no goals set)
    # ——————————————————————————————————————————————
    page3 = await app.page(
        settings={
            'tz': 'UTC',
            'bounds': {'start': '09:00', 'end': '17:00', 'days': [1,2,3,4,5]},
            'goalSlot': True,
        },
        now='2024-10-29T10:00:00Z',
        wait=4000,
    )
    ev = await run_cmd(page3, '[{"cmd":"listEvents","from":"2024-10-29","to":"2024-10-30"}]')
    evs = res(ev, 'events') or []
    if isinstance(evs, dict): evs = evs.get('events', [])
    slot = [e for e in evs if 'Set goals' in (e.get('title') or e.get('summary') or '')]
    app.check('14. goal-setting slot auto-created', len(slot) == 1, [e.get('title') for e in evs])
    app.check('14b. slot mentions next month', slot and 'next month' in (slot[0].get('title') or ''), slot)
    # Settings dialog has the toggle
    await page3.evaluate("document.getElementById('btn-settings').click()")
    await page3.wait_for_timeout(600)
    chk = await page3.evaluate("(() => { const c = document.querySelector('dialog[open] [name=goalSlot]'); return c ? c.checked : null; })()")
    app.check('14c. settings has goal-slot toggle (on)', chk is True, chk)
    await page3.close()

    # Off: no slot
    page3b = await app.page(
        settings={'tz': 'UTC', 'bounds': {'start': '09:00', 'end': '17:00', 'days': [1,2,3,4,5]}},
        now='2024-10-29T10:00:00Z', wait=4000,
    )
    ev = await run_cmd(page3b, '[{"cmd":"listEvents","from":"2024-10-29","to":"2024-10-30"}]')
    evs = res(ev, 'events') or []
    if isinstance(evs, dict): evs = evs.get('events', [])
    app.check('14d. no slot when setting is off', not [e for e in evs if 'Set goals' in (e.get('title') or '')])
    await page3b.close()

    # ——————————————————————————————————————————————
    # Feature 4: Analysis period presets (Mon 28 Oct 2024)
    # ——————————————————————————————————————————————
    page4 = await app.page(
        settings={
            'tz': 'UTC',
            'bounds': {'start': '09:00', 'end': '17:00', 'days': [1,2,3,4,5]},
            'weekStart': 1,
        },
        now=NOW,
        wait=3000,
    )
    await page4.keyboard.press('y')
    await page4.wait_for_timeout(1500)
    opts = json.loads(await page4.evaluate("JSON.stringify([...(document.querySelector('[data-o=period]')?.options || [])].map(o => o.value))"))
    app.check('15. analysis has last7 option', 'last7' in opts, opts)
    app.check('16. analysis has last30 option', 'last30' in opts, opts)
    app.check('17. analysis has lastworkweek option', 'lastworkweek' in opts, opts)
    async def pick(v):
        await page4.select_option('[data-o=period]', v)
        await page4.wait_for_timeout(1200)
        return await page4.evaluate("document.querySelector('.an-head .an-sub')?.textContent || ''")
    t = await pick('last7')
    app.check('17a. last7 range 22 Oct – 28 Oct', 'Last 7 days' in t and '22' in t and '28' in t, t)
    t = await pick('lastworkweek')
    app.check('17b. last work week 21 – 25 Oct', 'Last work week' in t and '21' in t and '25' in t, t)
    t = await pick('last30')
    app.check('17c. last30 range 29 Sep – 28 Oct', 'Last 30 days' in t and '29' in t and '28' in t, t)
    await page4.close()

    # ——————————————————————————————————————————————
    # Features 1 & 2: Category near title + placeholder
    # ——————————————————————————————————————————————
    page5 = await app.page(
        settings={
            'tz': 'UTC',
            'bounds': {'start': '09:00', 'end': '17:00', 'days': [1,2,3,4,5]},
            'categories': [{'id': 'cat1', 'name': 'Work', 'color': '#3498db'}],
            'askCategory': True,
        },
        now=NOW,
        wait=3000,
    )

    await page5.evaluate("document.getElementById('btn-new-event')?.click()")
    await page5.wait_for_timeout(800)

    placeholder = await page5.evaluate('''() => {
        const inp = document.querySelector('dialog[open] [name="summary"]');
        return inp ? inp.placeholder : null;
    }''')
    app.check('18. title placeholder mentions defaults', placeholder and 'default' in placeholder.lower() if placeholder else False, placeholder)

    cat_pos = await page5.evaluate("""() => {
        const body = document.querySelector('dialog[open] .dlg-body');
        const first = body && body.firstElementChild;
        return first ? first.className + '|' + !!first.querySelector('.ev-cat-host') + '|' + !!first.querySelector('[name=colorId]') : null;
    }""")
    app.check('19. category + color are first, right under title', cat_pos and cat_pos.endswith('|true|true'), cat_pos)

    # Titled but uncategorised: Save asks about picking a category first
    page5.set_default_timeout(8000)
    # settings sync through the shared fake Google account brings askCategory: false from earlier pages - switch it on here
    await page5.evaluate("import('./js/core.js').then(m => { m.set().askCategory = true; })")
    await page5.fill('dialog[open] [name=summary]', 'Lunch')
    await page5.click('dialog[open] button[type=submit]')
    try: await page5.wait_for_selector('dialog[open] .ask-cat', timeout=5000)
    except Exception: pass
    q = await page5.evaluate("[...document.querySelectorAll('dialog[open] h2')].map(h => h.textContent)")
    app.check('20. prompt to pick a category before scheduling', any('No category' in x for x in q), q)
    await page5.click('dialog[open] .ask-cat [data-close]')   # Skip
    await page5.wait_for_timeout(1200)
    ev = await run_cmd(page5, '[{"cmd":"listEvents","from":"2024-10-28","to":"2024-11-04"}]')
    app.check('20a. Skip still schedules it, uncategorised', any(e.get('title') == 'Lunch' for e in (res(ev) or [])), res(ev))
    # Picking a category in the prompt applies it
    await page5.evaluate("document.getElementById('btn-new-event')?.click()")
    await page5.wait_for_timeout(800)
    await page5.fill('dialog[open] [name=summary]', 'Standup')
    await page5.click('dialog[open] button[type=submit]')
    await page5.wait_for_selector('dialog[open] .ask-cat', timeout=5000)
    await page5.click('dialog[open] .ask-cat .cat-host button:has-text("Work")')
    await page5.wait_for_timeout(1200)
    ev = await run_cmd(page5, '[{"cmd":"listEvents","from":"2024-10-28","to":"2024-11-04"}]')
    su = [e for e in (res(ev) or []) if (e.get('title') or '').endswith('Standup')]  # titles get the category icon
    app.check('20b. picking a category in the prompt applies it', su and (su[0].get('category') == 'Work'), su)
    await page5.close()

    # ——————————————————————————————————————————————
    # Feature 6 UI: create a flag from the dialog, see it on the grid, delete it by clicking
    # ——————————————————————————————————————————————
    page6 = await app.page(settings={'tz': 'UTC', 'bounds': {'start': '09:00', 'end': '17:00', 'days': [1,2,3,4,5]}}, now=NOW, wait=3000)
    page6.set_default_timeout(5000)
    await page6.evaluate("import('./js/commands.js').then(m => { m.runCommand('new-flag'); })")
    await page6.wait_for_timeout(600)
    await page6.fill('dialog[open] [name=text]', 'Launch day')
    await page6.fill('dialog[open] [name=date]', '2024-10-30')
    await page6.fill('dialog[open] [name=time]', '11:00')
    await page6.click('dialog[open] button[type=submit]')
    await page6.wait_for_timeout(1200)
    fl = await page6.evaluate("(() => { const f = document.querySelector('.custom-flag'); return f ? f.textContent + '|' + f.closest('[data-day]')?.dataset.day : null; })()")
    app.check('21. flag drawn on the calendar', fl and 'Launch day' in fl, fl)
    await page6.click('.custom-flag')
    await page6.wait_for_timeout(500)
    await page6.click('dialog[open] .del-flag')
    await page6.wait_for_timeout(1000)
    n = await page6.evaluate("document.querySelectorAll('.custom-flag').length")
    app.check('22. flag deleted by clicking it', n == 0, n)
    await page6.close()

App.run(main, port=8961)
