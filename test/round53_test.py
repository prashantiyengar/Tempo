# Round 53: life-growth step bonuses every 5 h, one reschedule penalty a day per task, less busy XP, fill-in blocks
# (with "skip if anything is planned" and a delay), a delay for sleep blocks, events done at another time, finished
# early after the end, and the web app renewing its Google sign-in by itself.
import asyncio, sys, subprocess, time, re, json, urllib.parse
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
PORT = 8855
srv = subprocess.Popen(['python3','-m','http.server',str(PORT),'-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
CATS = [{'id': 'care', 'name': 'Childcare', 'color': '#e67c73', 'icon': '🧸'}, {'id': 'study', 'name': 'Study', 'color': '#33b679', 'icon': '📚'}, {'id': 'work', 'name': 'Work', 'color': '#039be5', 'icon': ''}]
FILLS = [
    {'id': 'fa', 'name': '', 'from': '18:00', 'to': '20:00', 'catId': 'care', 'days': [0, 1, 2, 3, 4, 5, 6], 'skipIfAny': False, 'delayMin': 0, 'cal': 'default', 'since': '2026-10-27', 'on': True},
    {'id': 'fb', 'name': 'Quiet time', 'from': '14:00', 'to': '16:00', 'catId': 'care', 'days': [0, 1, 2, 3, 4, 5, 6], 'skipIfAny': True, 'delayMin': 0, 'cal': 'default', 'since': '2026-10-27', 'on': True},
    {'id': 'fc', 'name': 'Play', 'from': '16:00', 'to': '17:00', 'catId': 'care', 'days': [0, 1, 2, 3, 4, 5, 6], 'skipIfAny': False, 'delayMin': 300, 'cal': 'default', 'since': '2026-10-27', 'on': True},
]
SETTINGS = {'tz': 'Europe/Berlin', 'askCategory': False, 'goalNotice': False, 'categories': CATS, 'autoFills': FILLS,
            'sleepEvents': True, 'sleepEventsFrom': '2026-10-26', 'sleepStart': '23:00', 'sleepEnd': '07:00', 'sleepDelayMin': 900,
            'game': {'on': True, 'started': '2026-10-20', 'lifeCats': ['study']}}
def init(expires='9e15'):
    return """
const FIX = Date.parse('2026-10-27T20:00:00Z'); const _Date = Date; globalThis.__off = (+(sessionStorage.getItem('test:off') || 0)) + FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: EXP, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify(SETTINGS));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2099-01-01'));
}""".replace('SETTINGS', json.dumps(SETTINGS)).replace('EXP', expires)
ok = []
def check(label, cond, extra=''):
    ok.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + label, extra)
def ev(i, title, d, h0, h1, **kw):
    return {'id': i, 'summary': title, 'status': 'confirmed', 'start': {'dateTime': f'{d}T{h0}:00+01:00'}, 'end': {'dateTime': f'{d}T{h1}:00+01:00'}, **kw}
def hm(e, k):
    import datetime
    t = datetime.datetime.fromisoformat(e[k]['dateTime'].replace('Z', '+00:00')).astimezone(datetime.timezone(datetime.timedelta(hours=1)))
    return t.strftime('%H:%M')

async def main():
    g = MockGoogle(); errs = []
    E = g.events['me@example.com']
    E['shop'] = ev('shop', 'Shopping', '2026-10-27', '19:00', '19:30')
    E['call'] = ev('call', 'Call', '2026-10-27', '14:30', '14:40')
    E['gym'] = ev('gym', 'Gym', '2026-10-27', '10:00', '11:00')
    E['meet'] = ev('meet', 'Meeting', '2026-10-27', '11:30', '13:30')
    E['run'] = ev('run', 'Workshop', '2026-10-27', '20:30', '22:00')
    fills = lambda: sorted((hm(e, 'start'), hm(e, 'end'), e['summary']) for e in E.values() if e.get('extendedProperties', {}).get('private', {}).get('tempoFill'))
    sleeps = lambda: [e for e in E.values() if e.get('extendedProperties', {}).get('private', {}).get('tempoSleep')]
    async with async_playwright() as p:
        b = await p.chromium.launch(); ctx = await b.new_context(viewport={'width': 1400, 'height': 900}, timezone_id='Europe/Berlin')
        await ctx.add_init_script(init()); await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(f'http://localhost:{PORT}/app.html'); await page.wait_for_function('window.tempo'); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(4000)
        # ---- 1. life steps, 2. penalties, 3. busy XP (pure rules)
        r = await page.evaluate("""(async () => { const GM = await import('./js/game.js'); const s = window.__tempo.app.state.settings;
          const k = '2026-10-26', at = (h) => Date.parse(`2026-10-26T${h}:00+01:00`);
          const it = { kind: 'event', title: 'Study', catId: 'study', start: at('08'), end: at('14') };
          const ctx = { items: [it], tasks: [], projects: [], habits: [], history: [], goalsAll: [], habitDone: () => false, lifeBefore: () => 4 * 60 };
          const d = GM.dayXP(k, s, ctx, Date.parse('2026-10-27T20:00:00Z'));
          const steps = d.lines.filter((l) => /h of life growth this week/.test(l[0])).map((l) => [l[0], l[2]]);
          const H = (h, kind, extra = {}) => ({ id: Math.random(), kind, at: at(h), ...extra });
          const hist = [H('09', 'resched', { taskId: 'a', title: 'Essay' }), H('10', 'resched', { taskId: 'a', title: 'Essay' }), H('11', 'moved', { taskId: 'a', title: 'Essay' }), H('12', 'resched', { evId: 'e1', title: 'Dentist' }),
            { id: 1, kind: 'resched', taskId: 'b', title: 'Report', at: Date.parse('2026-10-24T10:00:00+02:00') }, H('13', 'resched', { taskId: 'b', title: 'Report' })];
          const d2 = GM.dayXP(k, s, { ...ctx, items: [], history: hist }, Date.parse('2026-10-27T20:00:00Z'));
          const pens = d2.lines.filter((l) => l[1] === 'pen').map((l) => [l[0], l[2]]);
          const ev1 = GM.itemXP({ kind: 'event', title: 'Work', catId: 'work', start: at('09'), end: at('10') }, s, Date.parse('2026-10-27T20:00:00Z'));
          const se1 = GM.itemXP({ kind: 'chunk', title: 'T', task: { categoryId: 'work' }, sess: { index: 1, count: 1 }, status: 'done', start: at('09'), end: at('10') }, s, Date.parse('2026-10-27T20:00:00Z'));
          return { steps, growWeek: d.growWeek, pens, penN: d2.penN, ev: ev1.busy, se: se1.busy, rulesV: GM.RULES_V }; })()""")
        check('1. life growth: passing 5 h and 10 h in a week earns step bonuses that grow (+25, +50)', r['steps'] == [['5 h of life growth this week — step 1 (×1)', 25], ['10 h of life growth this week — step 2 (×2)', 50]] and r['growWeek'] == 600, r['steps'])
        check('2. rescheduling: once a day per task or event, however often it moves (3 moves of “Essay” → one −8)', r['penN'] == 3 and r['pens'][0] == ['rescheduled: Essay — moved 3× today, counted once', -8] and ['rescheduled: Dentist', -8] in r['pens'], r['pens'])
        check('3. … and a task that slipped on an earlier day this week costs more (−16)', ['rescheduled again (2 days this week): Report', -16] in r['pens'], r['pens'])
        check('4. busy XP is lower: an hour of an event 14 (was 28), an hour of a task session 18 (was 36)', r['ev'] == 14 and r['se'] == 18 and r['rulesV'] == 7, (r['ev'], r['se']))
        # ---- 5. fill-in blocks
        f0 = fills()
        check('5. the 18:00–20:00 window is filled with Childcare around the shopping trip', ('18:00', '19:00', '🧸 Childcare') in f0 and ('19:30', '20:00', '🧸 Childcare') in f0, f0)
        check('6. “skip if anything is planned”: a 10-minute call keeps 14:00–16:00 empty', not any(x[2].endswith('Quiet time') for x in f0) and 'fb:2026-10-27' in await page.evaluate("window.__tempo.app.state.settings.autoFillDone"), f0)
        check('7. a block with a 5-hour wait isn\'t added yet (its window ended 4 h ago)', not any(x[2].endswith('Play') for x in f0), f0)
        check('8. sleep with a 15-hour wait: last night\'s block isn\'t added yet (night ended 14 h ago)', not sleeps(), len(sleeps()))
        cat = next(e for e in E.values() if e.get('extendedProperties', {}).get('private', {}).get('tempoFill'))['extendedProperties']['private']
        check('9. fill-in blocks carry their category', cat.get('tempoCategory') == 'care', cat)
        await page.screenshot(path=f'{OUT}/r53-fills.png')
        # ---- 10. event done at another time
        await page.click('.ev:has-text("Gym")'); await page.wait_for_selector('.popover .ev-done-at')
        await page.click('.popover .ev-done-at'); await page.wait_for_selector('dialog[open] .done-at-f')
        await page.fill('dialog[open] [name=a]', '07:00'); await page.fill('dialog[open] [name=b]', '08:00')
        await page.click('dialog[open] button.primary'); await page.wait_for_timeout(2500)
        gy = E['gym']
        check('10. an event can be marked done at another time: it moves there and is ticked off', Date_eq(gy['start']['dateTime'], '2026-10-27T06:00:00Z') and Date_eq(gy['end']['dateTime'], '2026-10-27T07:00:00Z') and gy['extendedProperties']['private'].get('tempoDone') == '1', (gy['start'], gy.get('extendedProperties')))
        # ---- 11. finished early after the end
        await page.click('.ev:has-text("Meeting")'); await page.wait_for_selector('.popover .fin-early')
        await page.click('.popover .fin-early'); await page.wait_for_selector('dialog[open] .fin-at-f')
        await page.fill('dialog[open] [name=t]', '12:30'); await page.click('dialog[open] button.primary'); await page.wait_for_timeout(2500)
        me = E['meet']
        check('11. “Finished early” works after an event ended: pick when (12:30); the rest is left unallocated', Date_eq(me['end']['dateTime'], '2026-10-27T11:30:00Z') and Date_eq(me['start']['dateTime'], '2026-10-27T10:30:00Z'), me['end'])
        # ---- 12. finished early while it runs: end now, keep the rest free
        await page.click('.ev:has-text("Workshop")'); await page.wait_for_selector('.popover .fin-early')
        await page.click('.popover .fin-early'); await page.wait_for_selector('dialog[open] .choice-btn')
        await page.click('dialog[open] .choice-btn:has-text("Leave it free")'); await page.wait_for_timeout(2000)
        wk = E['run']; holds = await page.evaluate("window.__tempo.app.state.settings.holds || []")
        check('12. while it runs: it ends now and the rest can stay unallocated', wk['end']['dateTime'].startswith('2026-10-27T20:0') and any(h['end'] == 1793134800000 for h in holds), (wk['end'], holds))
        # ---- 13. later: the delayed blocks arrive
        await page.evaluate("sessionStorage.setItem('test:off', String(2 * 3600e3)); globalThis.__off += 2 * 3600e3")
        await page.evaluate("window.__tempo.cycle()"); await page.wait_for_timeout(5000)
        f1 = fills()
        check('13. once its wait is over, the delayed block is added (Play 16:00–17:00)', ('16:00', '17:00', '🧸 Play') in f1, f1)
        check('14. … and the sleep block too, once its 15-hour wait is over', len(sleeps()) == 1, [(x['start'], x['end']) for x in sleeps()])
        await page.evaluate("window.__tempo.cycle()"); await page.wait_for_timeout(3000)
        check('15. nothing is added twice', fills() == f1 and len(sleeps()) == 1, len(fills()))
        # settings UI
        await page.evaluate("window.__tempo.app.state.settings.x = 0")
        await page.click('#btn-settings') if await page.is_visible('#btn-settings') else None
        has = await page.evaluate("!!document.querySelector('dialog[open] .fills-list')")
        if has:
            rows = await page.eval_on_selector_all('dialog[open] .fill-rule', 'xs => xs.length')
            dl = await page.input_value('dialog[open] [name=sleepDelayMin]')
            check('16. Settings list the fill-in blocks and the sleep wait', rows == 3 and dl == '900', (rows, dl))
            await page.keyboard.press('Escape')
        else:
            check('16. Settings list the fill-in blocks and the sleep wait', False, 'settings dialog not found')
        check('no page errors', not errs, errs)
        await ctx.close()
        # ---- 17. web app: the Google sign-in renews by itself before it runs out (no Reconnect)
        g2 = MockGoogle(); calls = []
        async def oauth(route):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(route.request.url).query); calls.append(q.get('prompt', [''])[0])
            if len(calls) >= 2: frag = urllib.parse.urlencode({'error': 'login_required', 'state': q['state'][0]})
            else: frag = urllib.parse.urlencode({'access_token': 'tok2', 'token_type': 'Bearer', 'expires_in': '3600', 'scope': 'https://www.googleapis.com/auth/calendar openid email', 'state': q['state'][0]})
            await route.fulfill(status=302, headers={'location': f'http://localhost:{PORT}/app.html#{frag}'})
        ctx = await b.new_context(viewport={'width': 1400, 'height': 900}, timezone_id='Europe/Berlin')
        await ctx.add_init_script(init('Date.now() + 2 * 60000'))
        await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g2.handle)
        await ctx.route(re.compile(r'https://accounts\.google\.com/.*'), oauth)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(f'http://localhost:{PORT}/app.html'); await page.wait_for_selector('.tg-col')
        await page.click('#btn-next') if await page.is_visible('#btn-next') else None
        title0 = await page.text_content('#range-title')
        await page.mouse.move(5, 5)
        for _ in range(40):
            await page.wait_for_timeout(1000)
            if calls: break
        await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(2000)
        a = await page.evaluate("({ ...JSON.parse(localStorage.getItem('tempo:auth')), left: JSON.parse(localStorage.getItem('tempo:auth')).expires - Date.now() })")
        title1 = await page.text_content('#range-title')
        banner = await page.evaluate("(() => { const b = document.querySelector('#banner'); return b && !b.hidden ? b.textContent : ''; })()")
        check('17. web app: a few minutes before the sign-in runs out it is renewed silently (prompt=none), back on the same week', calls[:1] == ['none'] and a['token'] == 'tok2' and a['left'] > 50 * 60000 and title1 == title0 and not banner, (calls, a.get('token'), title0, title1, banner))
        # if Google refuses, then (and only then) it asks to reconnect
        await page.evaluate("(() => { const a = JSON.parse(localStorage.getItem('tempo:auth')); a.expires = Date.now() + 60000; localStorage.setItem('tempo:auth', JSON.stringify(a)); sessionStorage.removeItem('tempo:silentAt'); })()")
        await page.reload(); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(3000)
        await page.mouse.move(9, 9)
        for _ in range(40):
            await page.wait_for_timeout(1000)
            if len(calls) >= 2: break
        await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(2500)
        banner = await page.evaluate("(() => { const b = document.querySelector('#banner'); return b && !b.hidden ? b.textContent : ''; })()")
        check('18. … and only when Google refuses the silent renewal does it ask you to reconnect', len(calls) >= 2 and 'Reconnect' in banner, (calls, banner))
        check('no page errors (web sign-in)', not errs, errs)
        await b.close()

def Date_eq(s, iso):
    import datetime
    f = lambda x: datetime.datetime.fromisoformat(x.replace('Z', '+00:00')).timestamp()
    return abs(f(s) - f(iso)) < 1
try: asyncio.run(main())
finally: srv.terminate()
print('ALL PASS' if all(ok) else f'{ok.count(False)} FAILED')
