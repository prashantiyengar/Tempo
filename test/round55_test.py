# Round 55: settings sync over several hidden events (game log kept on each device), shared item helpers, events can
# start late, faster time-zone maths, the command bar (search + every action), "share my free time", and backups to
# Google Drive (Tempo's hidden app folder).
import re, json, urllib.parse, datetime, sys
sys.path.insert(0, 'test')
from harness import App
PORT = 8864
CATS = [{'id': 'work', 'name': 'Work', 'color': '#039be5', 'icon': '💼'}, {'id': 'meet', 'name': 'Meetings', 'color': '#3f51b5', 'icon': '', 'parent': 'work'}, {'id': 'fit', 'name': 'Fitness', 'color': '#33b679', 'icon': '🏃'}]
SETTINGS = {'tz': 'Europe/Berlin', 'askCategory': False, 'goalNotice': False, 'categories': CATS, 'bounds': {'start': '09:00', 'end': '17:00', 'days': [1, 2, 3, 4, 5]},
            'later': [{'id': 'l1', 'text': 'Book the dentist again', 'created': 1792000000000}], 'notes': [{'id': 'n1', 'text': 'Dentist said floss more', 'at': 1793000000000}],
            'game': {'on': True, 'started': '2026-08-01', 'lifeCats': ['fit']}}
def ev(i, title, d, h0, h1, **kw):
    off = '+02:00' if d < '2026-10-25' else '+01:00'
    return {'id': i, 'summary': title, 'status': 'confirmed', 'start': {'dateTime': f'{d}T{h0}:00{off}'}, 'end': {'dateTime': f'{d}T{h1}:00{off}'}, **kw}

async def main(app):
    g, check = app.google, app.check
    E = g.events['me@example.com']
    d0 = datetime.date(2026, 8, 1)
    for i in range(88):   # three months of ordinary days (the game log grows)
        d = (d0 + datetime.timedelta(i)).isoformat()
        for h, t in [(9, 'Team standup'), (11, 'Project work block'), (14, 'Client call with Acme'), (18, 'Evening run')]:
            E[f'w{i}{h}'] = ev(f'w{i}{h}', t, d, f'{h:02d}:00', f'{h + 1:02d}:00')
    E['dent'] = ev('dent', 'Dentist appointment', '2026-11-03', '15:00', '16:00')
    E['tom'] = ev('tom', 'Planning meeting', '2026-10-29', '10:00', '11:00')
    E['now'] = ev('now', 'Workshop', '2026-10-28', '10:00', '12:00')
    # an older version of Tempo saved settings in the single-event format, more recently than anything else
    legacy = {'categories': CATS + [{'id': 'old', 'name': 'From old device', 'color': '#616161', 'icon': ''}]}
    js = json.dumps(legacy); priv = {'tempoSettings': '1', 'sRev': str(9 * 10**12), 'sN': str((len(js) + 449) // 450), **{f's_{i}': js[i * 450:(i + 1) * 450] for i in range((len(js) + 449) // 450)}}
    E['legacy'] = {'id': 'legacy', 'summary': 'Tempo settings — please keep', 'status': 'confirmed', 'start': {'date': '2000-01-01'}, 'end': {'date': '2000-01-02'}, 'extendedProperties': {'private': priv}}
    calls = []
    async def oauth(route):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(route.request.url).query); calls.append(q.get('scope', [''])[0])
        frag = urllib.parse.urlencode({'access_token': 'tok3', 'token_type': 'Bearer', 'expires_in': '3600', 'scope': q['scope'][0], 'state': q['state'][0]})
        await route.fulfill(status=302, headers={'location': f'http://localhost:{PORT}/app.html#{frag}'})
    page = await app.page(SETTINGS, now='2026-10-28T09:30:00Z', routes=[(re.compile(r'https://accounts\.google\.com/.*'), oauth)], wait=6000)
    # ---- 1. settings sync
    await page.evaluate("(async () => { const E = await import('./js/engine.js'); window.__tempo.app.state.settings.sharedHash = 'x'; await E.syncShared(window.__tempo.app.state, { force: true }); })()")
    parts = [e for e in E.values() if e.get('extendedProperties', {}).get('private', {}).get('tempoSettingsV2')]
    sizes = [sum(len(k) + len(v) for k, v in e['extendedProperties']['private'].items()) for e in parts]
    content = ''.join(v for e in sorted(parts, key=lambda e: int(e['extendedProperties']['private']['sPart'])) for k, v in sorted(e['extendedProperties']['private'].items(), key=lambda kv: (len(kv[0]), kv[0])) if k.startswith('s_'))
    data = json.loads(content) if parts else {}
    led = await page.evaluate("Object.keys(window.__tempo.app.state.settings.game.ledger || {}).length")
    check('1. shared settings are stored within Google\'s 32 KB per event, and the game log isn\'t shared (each device keeps its own)', parts and all(x <= 32000 for x in sizes) and 'ledger' not in data.get('game', {}) and led > 60, (sizes, led))
    cats = [c['name'] for c in await page.evaluate("window.__tempo.app.state.settings.categories")]
    check('2. a newer save from an older version of Tempo (single event) is merged in, then moved to the new format', 'From old device' in cats and 'legacy' not in E and any(c['name'] == 'From old device' for c in data.get('categories', [])), cats)
    u = await page.evaluate("""(async () => { const E = await import('./js/engine.js');
      const big = { notes: Array.from({ length: 300 }, (_, i) => ({ id: 'n' + i, text: 'x'.repeat(200) })) };
      const ps = E.encodeParts(big, 100), evs = (rev, parts) => parts.map((p) => ({ extendedProperties: { private: p } }));
      const a = E.decodeParts(evs(100, ps));
      const half = evs(200, E.encodeParts({ notes: [] }, 200)).concat(evs(200, E.encodeParts(big, 200)).slice(1, 2));
      const b2 = E.decodeParts([...evs(100, ps), ...evs(300, E.encodeParts(big, 300)).slice(0, 1)]);
      return [ps.length, Math.max(...ps.map((p) => Object.entries(p).reduce((t, [k, v]) => t + k.length + v.length, 0))), a?.obj.notes.length, b2?.rev]; })()""")
    check('3. big settings are split over several events; a version still being written is skipped for the last complete one', u[0] >= 3 and u[1] <= 32000 and u[2] == 300 and u[3] == 100, u)
    # ---- 4. shared helpers and time zones
    h = await page.evaluate("""(async () => { const I = await import('./js/items.js'), T = await import('./js/tz.js'); const s = window.__tempo.app.state.settings;
      const m = I.itemMatcher({ cats: ['work'], words: ['run'] }, s);
      const it = (title, catId, x = {}) => ({ kind: 'event', title, catId, start: 0, end: 1, ...x });
      const r = [m(it('Brunch', null)), m(it('Morning run', null)), m(it('x', 'meet')), m(it('x', 'fit')), m(it('Run', null, { declined: true })),
        I.takesTime(it('a', null, { ev: { transparency: 'transparent' } })), I.unionLength([[0, 10], [5, 15], [20, 25]])];
      const p = T.partsOf(Date.parse('2026-10-25T00:59:00Z'), 'Europe/Berlin'), q = T.partsOf(Date.parse('2026-10-25T01:00:00Z'), 'Europe/Berlin');
      return [r, [p.h, p.mi, q.h, q.mi], T.dayKey(Date.parse('2026-03-29T00:30:00Z'), 'Australia/Lord_Howe')]; })()""")
    check('4. one matcher for categories (with sub-categories) and words (start of a word); one "takes time" rule; overlaps counted once', h[0] == [False, True, True, False, False, False, 20], h[0])
    check('5. cached time-zone offsets stay right across a DST change (02:59 CEST → 02:00 CET)', h[1] == [2, 59, 2, 0], h[1])
    # ---- 6. an event can start late
    await page.click('.ev:has-text("Workshop")'); await page.wait_for_selector('.popover .late')
    acts = await page.eval_on_selector_all('.popover [data-ia]', 'bs => bs.map(b => b.textContent.trim())')
    await page.click('.popover .late'); await page.wait_for_selector('dialog[open] .start-at-f')
    await page.fill('dialog[open] [name=t]', '10:25'); await page.click('dialog[open] button.primary'); await page.wait_for_timeout(2000)
    st0 = E['now']['start']['dateTime']
    check('6. events and sessions share one list of actions; an event can be marked started late (10:25)', '⏰ Started late…' in acts and '⏹ Finished early' in acts and st0.startswith('2026-10-28T09:25:00'), (acts, st0))
    # ---- 7. command bar
    await page.keyboard.press('Control+k'); await page.wait_for_selector('dialog[open] .cmd-bar')
    await page.keyboard.type('dentist'); await page.wait_for_timeout(1500)
    rows = await page.eval_on_selector_all('dialog[open] .cmd-row', 'rs => rs.map(r => [r.querySelector(".cmd-k").textContent, r.querySelector(".cmd-l").textContent])')
    kinds = {k for k, _ in rows}
    check('7. Ctrl/⌘ K opens the command bar; it finds events, Later notes and notes', {'Event', 'Later', 'Note'} <= kinds and rows[0][1] in ('Dentist appointment', 'Book the dentist again'), rows[:5])
    await page.screenshot(path=f'{app.out}/r55-cmdbar.png')
    i = next(n for n, r in enumerate(rows) if r[0] == 'Event')
    for _ in range(i): await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter'); await page.wait_for_selector('.popover'); await page.wait_for_timeout(300)
    pt = await page.text_content('.popover h3'); rt = await page.text_content('#range-title')
    check('8. choosing an event goes to its week and opens it', 'Dentist' in pt and 'Nov' in rt, (pt, rt))
    await page.keyboard.press('Escape'); await page.wait_for_timeout(200)
    await page.keyboard.press('/'); await page.wait_for_selector('dialog[open] .cmd-bar')
    await page.keyboard.type('share free'); await page.wait_for_timeout(300)
    first = await page.text_content('dialog[open] .cmd-row.on .cmd-l')
    await page.keyboard.press('Enter'); await page.wait_for_selector('dialog[open] .share-free'); await page.wait_for_timeout(1500)
    await page.select_option('dialog[open] [name=span]', '3'); await page.wait_for_timeout(1500)
    txt = await page.input_value('dialog[open] .share-text')
    check('9. “/” opens it too; actions are found by name (share my free time)', 'Share my free time' in first, first)
    check('10. sharing free time lists the free slots by day (work hours; tomorrow around the 10–11 meeting)', txt.startswith("I'm free:") and re.search(r'(29 Oct|Oct 29): 09:00–10:00, 11:00–17:00', txt) and 'Europe/Berlin' in txt, txt)
    await page.screenshot(path=f'{app.out}/r55-share.png')
    await page.keyboard.press('Escape'); await page.wait_for_timeout(300)
    # ---- 11. Drive backup
    await page.click('#btn-settings'); await page.wait_for_selector('dialog[open] .settings-form')
    await page.evaluate("document.querySelector('dialog[open] [name=driveBackup]').click()")
    await page.click('dialog[open] .settings-form button[type=submit], dialog[open] .settings-form .primary >> nth=-1')
    await page.wait_for_url(re.compile(r'.*app\.html.*'), timeout=15000); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(5000)
    a = await page.evaluate("JSON.parse(localStorage.getItem('tempo:auth'))")
    files = list((g.drive_files or {}).values())
    check('11. turning on Drive backups asks Google for the app-folder permission once, then backs up', calls and 'drive.appdata' in calls[-1] and a.get('drive') and files and files[0]['parents'] == ['appDataFolder'], (calls[-1:] , len(files)))
    bk = json.loads(files[0]['content']) if files else {}
    check('12. a backup holds tasks, settings and local events', bk.get('app') == 'tempo' and 'settings' in bk and 'tasks' in bk, list(bk)[:6])
    await page.evaluate("(async () => { const B = await import('./js/backup.js'); for (let i = 0; i < 16; i++) await B.backupNow({ quiet: true }); })()"); await page.wait_for_timeout(500)
    check('13. only the last 14 backups are kept', len(g.drive_files) == 14, len(g.drive_files))
    await page.evaluate("(() => { const s = window.__tempo.app.state.settings; s.later = []; })()")
    await page.evaluate("window.tempo.run([{ cmd: 'addTask', title: 'Temp task', hours: 1, deadline: '2026-11-06 17:00' }])"); await page.wait_for_timeout(1500)
    await page.keyboard.press('Control+k'); await page.wait_for_selector('dialog[open] .cmd-bar'); await page.keyboard.type('restore from'); await page.wait_for_timeout(300); await page.keyboard.press('Enter')
    await page.wait_for_selector('dialog[open] .choice-btn'); await page.click('dialog[open] .choice-btn >> nth=0'); await page.wait_for_timeout(2500)
    later = await page.evaluate("(window.__tempo.app.state.settings.later || []).map(x => x.text)")
    tasks = await page.evaluate("window.__tempo.app.state.tasks.map(t => t.title)")
    check('14. restoring from Drive brings back that day\'s tasks and settings', 'Book the dentist again' in later and 'Temp task' not in tasks, (later, tasks))
    # menus from the command list
    await page.set_viewport_size({'width': 400, 'height': 860}); await page.wait_for_timeout(600)
    await page.evaluate("document.querySelector('#btn-more').click()"); await page.wait_for_selector('dialog[open] .sheet-menu')
    more = await page.eval_on_selector_all('dialog[open] .sheet-menu button', 'bs => bs.map(b => b.textContent)')
    check('15. the phone menus come from the same list of actions (search, share, back up, export…)', any('Search' in x for x in more) and any('Share my free time' in x for x in more) and any('Back up to Google Drive' in x for x in more) and any('Export this week as PDF' in x for x in more), more)
    await page.keyboard.press('Escape')

App.run(main, port=PORT)
