# Round 51: stretching one occurrence of a repeating event (or the whole series) moves the split task's sessions
# off the new time — even while Google's event list still shows the old occurrence for a few seconds.
import asyncio, sys, subprocess, time, re, json, datetime
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8852','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
INIT = """
const FIX = Date.parse('2026-10-26T07:00:00Z'); const _Date = Date; globalThis.__off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false, goalNotice: false, syncTasksToGoogle: true, hourHeight: 40}));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2099-01-01'));
}"""
ok = []
def check(label, cond, extra=''):
    ok.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + label, extra)
P = lambda s: datetime.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp() * 1000
SESS = """(async () => { const S = await import('./js/scheduler.js'); const t = window.__tempo.app.state.tasks.find(t => t.title === 'Report');
  return S.sessions(t).filter(c => c.end > Date.now()).map(c => [c.start, c.end]); })()"""
def clash(sess, blocks):
    return [(s, e) for s, e in sess for b0, b1 in blocks if s < b1 and e > b0]

async def main():
    g = MockGoogle(); errs = []
    g.lag_instances = 5   # Google's list keeps showing the old occurrence for 5 s
    E = g.events['me@example.com']
    E['rec'] = {'id': 'rec', 'summary': 'Lunch', 'status': 'confirmed', 'recurrence': ['RRULE:FREQ=DAILY'], 'start': {'dateTime': '2026-10-19T11:00:00Z', 'timeZone': 'Europe/Berlin'}, 'end': {'dateTime': '2026-10-19T11:30:00Z', 'timeZone': 'Europe/Berlin'}}
    lunches = lambda d0=26, n=6, h1=11.5: [(P(f'2026-10-{d0 + i}T11:00:00Z'), P(f'2026-10-{d0 + i}T11:00:00Z') + (h1 - 11) * 3600e3) for i in range(n)]
    async with async_playwright() as p:
        b = await p.chromium.launch(); ctx = await b.new_context(viewport={'width': 1400, 'height': 900}, timezone_id='Europe/Berlin')
        await ctx.add_init_script(INIT); await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8852/app.html'); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(2000)
        await page.evaluate("window.tempo.run([{ cmd: 'addTask', title: 'Report', hours: 30, deadline: '2026-10-31 17:00' }])"); await page.wait_for_timeout(3000)
        s0 = await page.evaluate(SESS)
        wed = [x for x in s0 if x[0] >= P('2026-10-28T11:30:00Z') and x[0] < P('2026-10-28T13:00:00Z')]
        check('1. the split task is planned around the daily lunch, with a session right after Wednesday\'s', s0 and not clash(s0, lunches()) and wed, len(s0))
        # stretch Wednesday's lunch by 1.5 h (to 14:00 Berlin) — "This event"
        await page.evaluate("document.querySelector('.tg-scroll').scrollTop = 300")
        h = page.locator('.tg-col[data-day="2026-10-28"] .ev:has-text("Lunch") .ev-resize'); hb = await h.bounding_box()
        await page.mouse.move(hb['x'] + hb['width'] / 2, hb['y'] + hb['height'] / 2); await page.mouse.down()
        await page.mouse.move(hb['x'] + hb['width'] / 2, hb['y'] + 60, steps=8); await page.mouse.up(); await page.wait_for_timeout(500)
        if await page.query_selector('dialog[open]'): await page.click('dialog[open] .choice-btn >> nth=0')
        await page.wait_for_timeout(2500)
        ex = [x for x in g.exceptions['me@example.com'].values()]
        newend = ex and P(ex[0]['end']['dateTime'])
        check('2. only that occurrence was stretched (by more than an hour)', len(ex) == 1 and newend >= P('2026-10-28T12:30:00Z'), [(x['start'], x['end']) for x in ex])
        stale = g._stale > time.time()
        s1 = await page.evaluate(SESS)
        big = [(P('2026-10-28T11:00:00Z'), newend)]
        check('3. the sessions move off the stretched lunch right away, although Google\'s list still shows the old one', stale and s1 and not clash(s1, big), (stale, clash(s1, big)))
        check('4. … and still avoid the other days\' lunches; the task keeps all its hours', not clash(s1, lunches()) and sum(e - s for s, e in s1) == sum(e - s for s, e in s0))
        await page.screenshot(path=f'{OUT}/r51-stretched.png')
        # Google catches up: nothing jumps back onto the lunch
        await page.wait_for_timeout(7000)
        s2 = await page.evaluate(SESS)
        check('5. once Google catches up, the sessions stay off it', g._stale < time.time() and not clash(s2, big + lunches()), g._stale)
        # stretch the whole series to an hour
        await page.evaluate("document.querySelector('.tg-scroll').scrollTop = 300")
        h = page.locator('.tg-col[data-day="2026-10-29"] .ev:has-text("Lunch") .ev-resize'); hb = await h.bounding_box()
        await page.mouse.move(hb['x'] + hb['width'] / 2, hb['y'] + hb['height'] / 2); await page.mouse.down()
        await page.mouse.move(hb['x'] + hb['width'] / 2, hb['y'] + 40, steps=6); await page.mouse.up(); await page.wait_for_timeout(500)
        labels = await page.eval_on_selector_all('dialog[open] .choice-btn', 'xs => xs.map(x => x.textContent)')
        idx = next((i for i, l in enumerate(labels) if 'All' in l), 2)
        await page.click(f'dialog[open] .choice-btn >> nth={idx}'); await page.wait_for_timeout(3500)
        m = E['rec']
        dur = (P(m['end']['dateTime']) - P(m['start']['dateTime'])) / 60000
        s3 = await page.evaluate(SESS)
        hour = [x for x in lunches(h1=11 + dur / 60) if x[0] != P('2026-10-28T11:00:00Z')]
        check('6. stretching the whole series moves every session off the longer lunches', dur >= 45 and s3 and not clash(s3, hour + big), (dur, labels, len(clash(s3, hour))))
        # a repeating event of your own (Tempo calendar) does the same
        r = await page.evaluate("""(async () => { const E = await import('./js/engine.js'); const st = window.__tempo.app.state;
          st.localEvents.push({ id: 'lr', summary: 'Gym', recurrence: ['RRULE:FREQ=DAILY'], start: { dateTime: '2026-10-26T14:00:00Z', timeZone: 'Europe/Berlin' }, end: { dateTime: '2026-10-26T14:30:00Z', timeZone: 'Europe/Berlin' } });
          E.invalidate(); window.__tempo.cycle(); return true; })()""")
        if not await page.evaluate("!!window.__tempo.cycle"): await page.evaluate("window.__tempo.app.state.settings.x = 1");
        await page.wait_for_timeout(3000)
        s4 = await page.evaluate(SESS)
        gym = [(P(f'2026-10-{d}T14:00:00Z'), P(f'2026-10-{d}T14:30:00Z')) for d in range(26, 32)]
        check('7. a repeating event in the Tempo calendar is kept free too', not clash(s4, gym), len(clash(s4, gym)))
        # unit: a later copy in Google's list wins over our remembered edit
        u = await page.evaluate("""(async () => { const E = await import('./js/engine.js'); const st = window.__tempo.app.state;
          E.forgetEdits(); E.invalidate();
          const live = await E.googleEvents(st, Date.parse('2026-10-30T00:00:00Z'), Date.parse('2026-10-31T00:00:00Z'));
          const one = live.find(e => e.summary === 'Lunch');
          E.noteEdit(one._calId, { ...one, end: { dateTime: '2026-10-30T15:00:00Z' }, updated: '2000-01-01T00:00:00Z' });
          E.invalidate();
          const a = (await E.googleEvents(st, Date.parse('2026-10-30T00:00:00Z'), Date.parse('2026-10-31T00:00:00Z'))).find(e => e.id === one.id);
          E.noteEdit(one._calId, { ...one, end: { dateTime: '2026-10-30T15:00:00Z' }, updated: '2999-01-01T00:00:00Z' });
          E.invalidate();
          const b2 = (await E.googleEvents(st, Date.parse('2026-10-30T00:00:00Z'), Date.parse('2026-10-31T00:00:00Z'))).find(e => e.id === one.id);
          E.forgetEdits(); E.invalidate(); return [a.end.dateTime, b2.end.dateTime, !!one.updated]; })()""")
        check('8. our remembered copy wins only over an older one in Google\'s list', u[1] == '2026-10-30T15:00:00Z' and (u[0] != u[1] or not u[2]), u)
        check('no page errors', not errs, errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
print('ALL PASS' if all(ok) else f'{ok.count(False)} FAILED')
