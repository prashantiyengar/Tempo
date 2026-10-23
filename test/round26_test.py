# Round 26: sync never fights over one Google event (two sessions sharing an event id, millisecond times);
# "Task finished here"; leave days (label, scheduling avoids them, periods that include them, reschedule prompt);
# goals that track text in titles; From / To on their own lines with ± under each; newspaper phrases and spin.
import asyncio, sys, subprocess, time, re, json
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8819','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
INIT = """
const FIX = Date.parse('2026-10-23T09:30:00Z'); const _Date = Date; globalThis.__off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false, goalNotice: false, syncTasksToGoogle: true}));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2099-01-01'));
}"""
ok = []
def check(label, cond, extra=''):
    ok.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + label, extra)

async def main():
    g = MockGoogle(); errs = []
    g.events['me@example.com']['m'] = {'id': 'm', 'summary': 'Team meeting', 'status': 'confirmed', 'start': {'dateTime': '2026-10-27T10:00:00+01:00'}, 'end': {'dateTime': '2026-10-27T11:00:00+01:00'}}
    g.events['me@example.com']['md'] = {'id': 'md', 'summary': 'Moby Dick book club', 'status': 'confirmed', 'start': {'dateTime': '2026-10-21T18:00:00+02:00'}, 'end': {'dateTime': '2026-10-21T20:00:00+02:00'}}
    async with async_playwright() as p:
        b = await p.chromium.launch(); ctx = await b.new_context(viewport={'width': 1400, 'height': 900}, timezone_id='Europe/Berlin', compact_ui=True)
        await ctx.add_init_script(INIT); await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8819/app.html'); await page.wait_for_function('window.tempo'); await page.wait_for_timeout(1500)
        run = lambda c: page.evaluate(f"window.tempo.run({json.dumps(c)})")
        info = lambda: page.evaluate("window.__tempo.app.state.syncInfo")
        live = lambda: [e for e in g.events['me@example.com'].values() if e.get('status') != 'cancelled' and e.get('extendedProperties', {}).get('private', {}).get('tempoTask')]

        # ---------- 1. sync: early "done" + a corrupted state where two sessions share one Google event
        await run([{'cmd': 'addTask', 'title': 'Moby Dick', 'pages': 220, 'pagesPerHour': 20, 'deadline': '2026-10-30 17:00', 'rank': 1}]); await page.wait_for_timeout(2000)
        await run([{'cmd': 'markDone', 'task': 'Moby Dick', 'index': 11}, {'cmd': 'markDone', 'task': 'Moby Dick', 'index': 10}]); await page.wait_for_timeout(2000)
        i = await info(); check('1a. early done sessions sync cleanly', i['ok'] and i['verified'] == 11, i)
        await page.evaluate("""(() => { const t = window.__tempo.app.state.tasks.find((x) => x.title === 'Moby Dick');
          const pl = t.planned; pl[1].gid = pl[0].gid; pl[1].syncHash = null; pl[2].start += 123; pl[2].end += 456; pl[2].syncHash = null; })()""")
        await page.evaluate("window.__tempo.cycle()"); await page.wait_for_timeout(3000)
        i = await info(); gids = await page.evaluate("window.__tempo.app.state.tasks.find((x) => x.title === 'Moby Dick').planned.map((c) => c.gid)")
        check('1b. two sessions sharing one Google event get separate events, and sync verifies', i['ok'] and len(set(gids)) == len(gids) and len(live()) == 11, (i, len(live())))
        snap = lambda: {e['id']: json.dumps([e['summary'], e['start'], e['end'], {k: v for k, v in e['extendedProperties']['private'].items() if not k.startswith('tdef')}], sort_keys=True) for e in live()}
        # (the corrupted plan settles on the next re-plan; after that nothing changes any more)
        await page.evaluate("window.__tempo.cycle()"); await page.wait_for_timeout(2500)
        await page.evaluate("window.__tempo.cycle()"); await page.wait_for_timeout(2500)
        i = await info(); check('1c. it settles: a later sync has nothing left to repair', i['ok'] and i['repaired'] == 0 and i['changed'] == 0, i)

        # ---------- 2. Task finished here (session 4): pages up to 220, remaining sessions removed
        await page.evaluate("window.__tempo.render()"); await page.wait_for_timeout(500)
        ss = (await run([{'cmd': 'listSessions', 'task': 'Moby Dick', 'from': '2026-10-23', 'to': '2026-11-06'}]))[0]['result']
        s4 = ss[3]
        el = page.locator(f'.ev.chunk:has-text("task 4/11")').first
        await el.scroll_into_view_if_needed(); await el.click(); await page.wait_for_selector('.popover .fin-task')
        await page.screenshot(path=f'{OUT}/r26-session-pop.png')
        await page.click('.popover .fin-task'); await page.wait_for_selector('dialog[open] .choice')
        txt = await page.text_content('dialog[open] .choice'); check('2a. confirm mentions page 220 and removed sessions', 'page 220' in txt and '8 sessions' in txt, txt.strip()[:160])
        await page.click('dialog[open] .choice-btn'); await page.wait_for_timeout(2500)
        ss = (await run([{'cmd': 'listSessions', 'task': 'Moby Dick', 'from': '2026-10-23', 'to': '2026-11-06'}]))[0]['result']
        labels = [x['label'] for x in ss]
        check('2b. only done sessions remain; session 4 reads to the end before the early-done pages', all(x['status'] == 'done' for x in ss) and any('page 1-180' in l for l in labels) and len(labels) == 3, labels)
        t = (await run([{'cmd': 'listTasks'}]))[0]['result']; md = [x for x in t if x['title'] == 'Moby Dick'][0]
        check('2c. task shows 100%', '100%' in md['progress'], md['progress'])
        i = await info(); check('2d. Google has just the done sessions', i['ok'] and len(live()) == 3, (i, len(live())))

        # ---------- 3. leave days
        await run([{'cmd': 'addTask', 'title': 'Essay', 'hours': 14, 'deadline': '2026-11-03 17:00'}]); await page.wait_for_timeout(1500)
        await page.click('#btn-next'); await page.wait_for_timeout(1200)
        await page.click('.tg-dayhead[data-day="2026-10-27"] .leave-menu'); await page.wait_for_selector('.leave-pop')
        await page.click('.leave-pop .lv-set[data-kind=vacation]'); await page.wait_for_selector('dialog[open] .choice')
        q = await page.text_content('dialog[open] .choice h2')
        prim = await page.evaluate("document.activeElement?.classList.contains('primary')")
        check('3a. asked whether to reschedule, default Yes is focused', 'Reschedule' in q and '1 event' in q and prim, q)
        await page.screenshot(path=f'{OUT}/r26-leave-ask.png')
        await page.wait_for_timeout(300); await page.keyboard.press('Enter'); await page.wait_for_timeout(3000)
        ss = (await run([{'cmd': 'listSessions', 'task': 'Essay', 'from': '2026-10-23', 'to': '2026-11-06'}]))[0]['result']
        check('3b. no task sessions on the leave day', not [x for x in ss if x['start'].startswith('2026-10-27')], [x['start'] for x in ss])
        check('3c. the meeting moved to the next working day, same time', g.events['me@example.com']['m']['start'].get('dateTime', '').startswith('2026-10-28T09:00'), g.events['me@example.com']['m']['start'])
        tag = await page.text_content('.tg-dayhead[data-day="2026-10-27"] .leave-tag')
        check('3d. "On leave" label under the date', 'On leave' in (tag or ''), tag)
        await page.screenshot(path=f'{OUT}/r26-leave-week.png')
        # sick leave via API, and a task in a period that includes leave days
        await run([{'cmd': 'setLeave', 'from': '2026-10-29', 'kind': 'sick'}]); await page.wait_for_timeout(1500)
        tag = await page.text_content('.tg-dayhead[data-day="2026-10-29"] .leave-tag')
        check('3e. sick leave label', 'Sick leave' in (tag or ''), tag)
        await page.evaluate("""(async () => { const s = window.__tempo.app.state.settings; s.periods = [...(s.periods || []), { id: 'any', name: 'Any day', rules: [{ days: [0,1,2,3,4,5,6], start: '09:00', end: '17:00' }], onLeave: true }]; })()""")
        await run([{'cmd': 'addTask', 'title': 'Inbox', 'hours': 30, 'deadline': '2026-10-31 17:00', 'period': 'Any day', 'rank': 9}]); await page.wait_for_timeout(1500)
        ss = (await run([{'cmd': 'listSessions', 'task': 'Inbox', 'from': '2026-10-23', 'to': '2026-11-06'}]))[0]['result']
        check('3f. a period that includes leave days uses them', any(x['start'].startswith('2026-10-27') or x['start'].startswith('2026-10-29') for x in ss), sorted(set(x['start'][:10] for x in ss)))
        await run([{'cmd': 'deleteTask', 'task': 'Inbox'}]); await page.wait_for_timeout(800)
        # settings section lists them
        await page.evaluate("document.querySelector('#btn-settings').click()"); await page.wait_for_selector('dialog[open] .settings-form')
        await page.click('dialog[open] .tabs button[data-tab="1"]')
        sm = await page.text_content('dialog[open] details[data-sect=s-leave] .sect-s'); check('3g. settings summary counts the leave days', '2 upcoming' in sm, sm)
        await page.click('dialog[open] details[data-sect=s-leave] > summary'); await page.wait_for_timeout(200)
        rows = await page.eval_on_selector_all('dialog[open] .lv-row', 'rs => rs.map(r => r.textContent.trim())'); check('3h. leave list', len(rows) == 2, rows)
        await page.screenshot(path=f'{OUT}/r26-leave-settings.png')
        await page.click('dialog[open] [data-close] >> nth=-1'); await page.wait_for_timeout(300)

        # ---------- 4. goals by text
        await page.click('#btn-today'); await page.wait_for_timeout(500)
        await run([{'cmd': 'addGoal', 'period': 'this week', 'text': 'Read Moby Dick', 'head': 'personal', 'track': 'moby dick'}])
        await page.click('#view-seg button[data-view=goals]'); await page.wait_for_timeout(1500)
        row = page.locator('.g-row:has-text("Read Moby Dick")').first
        bud = await row.locator('.g-bud').text_content() if await row.locator('.g-bud').count() else ''
        check('4a. goal counts the "Moby Dick" event and sessions by title', '⏱' in bud and bud.strip() != '⏱', bud)
        await row.locator('.g-text').click(); await page.wait_for_selector('dialog[open] [name=w]')
        check('4b. edit dialog shows the tracked text', (await page.input_value('dialog[open] [name=w]')) == 'moby dick')
        await page.screenshot(path=f'{OUT}/r26-goal-edit.png')
        await page.click('dialog[open] [data-close]'); await page.wait_for_timeout(300)
        await page.click('#view-seg button[data-view=goals] ~ button, #view-seg button[data-view=week]') if False else None

        # ---------- 5. From / To lines with ± under each
        await page.click('#view-seg button[data-view=week]'); await page.wait_for_timeout(800)
        await page.evaluate("document.querySelector('#btn-new-event')?.click()")
        if not await page.query_selector('dialog[open] .event-form'):
            await page.keyboard.press('c')
        await page.wait_for_selector('dialog[open] .event-form')
        lines = await page.eval_on_selector_all('dialog[open] .tline .t-l', 'ls => ls.map(l => l.textContent)')
        check('5a. From and To on separate lines', lines == ['From', 'To'], lines)
        below = await page.evaluate("""(() => { const f = [...document.querySelectorAll('dialog[open] .tline')]; const a = [...document.querySelectorAll('dialog[open] .t-adj')];
          return f.length === 2 && a.length === 2 && f[0].getBoundingClientRect().bottom <= a[0].getBoundingClientRect().top + 2 && a[0].getBoundingClientRect().bottom <= f[1].getBoundingClientRect().top + 2 && f[1].getBoundingClientRect().bottom <= a[1].getBoundingClientRect().top + 2; })()""")
        check('5b. ± buttons sit below From and below To', below)
        st0, en0 = await page.input_value('dialog[open] [name=sTime]'), await page.input_value('dialog[open] [name=eTime]')
        await page.click('dialog[open] .st-add[data-add="-30"]'); await page.wait_for_timeout(100)
        st1, en1 = await page.input_value('dialog[open] [name=sTime]'), await page.input_value('dialog[open] [name=eTime]')
        check('5c. −30 under From moves only the start', st1 != st0 and en1 == en0, (st0, en0, st1, en1))
        await page.screenshot(path=f'{OUT}/r26-event-times.png')
        await page.click('dialog[open] [data-close] >> nth=-1'); await page.wait_for_timeout(300)
        await page.evaluate("document.querySelector('#btn-new-task').click()"); await page.wait_for_selector('dialog[open] .task-form')
        lines = await page.eval_on_selector_all('dialog[open] .tline .t-l', 'ls => ls.map(l => l.textContent)')
        check('5d. task dialog: From (don\'t start before) and To (deadline) lines', lines == ['From', 'To'], lines)
        dl0 = await page.input_value('dialog[open] [name=deadline]')
        await page.click('dialog[open] .dl-add[data-add="1440"]'); await page.wait_for_timeout(150)
        dl1 = await page.input_value('dialog[open] [name=deadline]')
        check('5e. +1d under the deadline', dl1 > dl0 and dl1[:10] != dl0[:10], (dl0, dl1))
        await page.click('dialog[open] .es-add[data-add="60"]'); await page.wait_for_timeout(150)
        check('5f. +1h under From sets "don\'t start before"', bool(await page.input_value('dialog[open] [name=earliest]')))
        await page.screenshot(path=f'{OUT}/r26-task-times.png')
        await page.click('dialog[open] [data-close] >> nth=-1'); await page.wait_for_timeout(300)

        # ---------- 6. newspaper: spins in, uses the phrase bank
        await page.evaluate("""(() => { const seen = []; window.__spin = seen; new MutationObserver(() => { const n = document.querySelector('.np.np-spin'); if (n) seen.push(1); }).observe(document.body, { subtree: true, attributes: true, childList: true }); })()""")
        await page.click('#view-seg button[data-view=review]'); await page.wait_for_selector('.np'); await page.wait_for_timeout(400)
        check('6a. the newspaper spins into view', await page.evaluate('window.__spin.length > 0'))
        await page.screenshot(path=f'{OUT}/r26-paper-spin.png')
        await page.wait_for_timeout(1500)
        check('6b. animation class removed afterwards', not await page.query_selector('.np.np-spin'))
        com = await page.text_content('.np-comment') if await page.query_selector('.np-comment') else ''
        check('6c. commentary paragraph analyses the numbers', len(com) > 40, com[:200])
        var = await page.evaluate("import('./js/phrases.js').then((PH) => { let n = 0; for (const v of Object.values(PH)) { if (Array.isArray(v)) n += PH.variety(v); else if (v && typeof v === 'object') for (const w of Object.values(v)) n += PH.variety(w); } return n; })")
        check('6d. hundreds of phrase variants', var >= 500, var)
        heads = set()
        for per in ['week', 'fortnight', 'month', 'quarter', 'year']:
            await page.evaluate(f"window.__tempo.app.state.settings.paperPeriod = '{per}'"); await page.evaluate("window.__tempo.render()"); await page.wait_for_timeout(900)
            heads.add(await page.text_content('.np-h1'))
        check('6e. headlines vary between issues', len(heads) >= 2, heads)
        await page.screenshot(path=f'{OUT}/r26-paper.png', full_page=True)
        check('no page errors', not errs, errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
print('ALL PASS' if all(ok) else f'{ok.count(False)} FAILED')
