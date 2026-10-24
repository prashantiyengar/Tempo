# Round 38: weather — the day's icon from the waking hours (not the worst hour of the night), current temperature,
# morning/afternoon/evening, forecast model; Later → task/event earns life XP (more the longer it waited, more when done).
import asyncio, sys, subprocess, time, re, json, datetime
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8832','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
C1 = int(datetime.datetime(2026, 10, 3, 10, tzinfo=datetime.timezone.utc).timestamp() * 1000)   # 21 days before
C2 = int(datetime.datetime(2026, 10, 17, 10, tzinfo=datetime.timezone.utc).timestamp() * 1000)  # 7 days before
LATER = [{'id': 'l1', 'text': 'Fix bike', 'created': C1}, {'id': 'l2', 'text': 'Read paper', 'created': C2, 'minutes': 60}]
INIT = """
const FIX = Date.parse('2026-10-24T13:00:00Z'); const _Date = Date; globalThis.__off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false, goalNotice: false, later: LATER,
    weather: {on: true, name: 'Berlin, Germany', lat: 52.52, lon: 13.4, unit: 'C'},
    game: {on: true, started: '2026-10-20', active: ['2026-10-24']}}));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2099-01-01'));
}""".replace('LATER', json.dumps(LATER))
ok = []
def check(label, cond, extra=''):
    ok.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + label, extra)
def wx():
    d0 = datetime.date(2026, 9, 23); n = 47
    days = [(d0 + datetime.timedelta(i)).isoformat() for i in range(n)]
    daily = {'time': days, 'weather_code': [95 if d == '2026-10-24' else 63 if d == '2026-10-25' else 2 for d in days], 'temperature_2m_max': [15.0] * n, 'temperature_2m_min': [7.0] * n, 'precipitation_probability_max': [80] * n, 'precipitation_sum': [6.0 if d in ('2026-10-24', '2026-10-25') else 0.0 for d in days]}
    hourly = {k: [] for k in ['time', 'weather_code', 'temperature_2m', 'precipitation', 'precipitation_probability', 'cloud_cover']}
    for d in days:
        for h in range(24):
            hourly['time'].append(f'{d}T{h:02d}:00')
            storm = d == '2026-10-24' and h == 3              # a thunderstorm at 3 am — dry and sunny all day
            rain = d == '2026-10-25' and 9 <= h < 17          # steady rain through the day
            hourly['weather_code'].append(95 if storm else 63 if rain else 1)
            hourly['temperature_2m'].append(8.0 + (6 if 11 <= h <= 16 else 0))
            hourly['precipitation'].append(6.0 if storm else 0.5 if rain else 0.0)
            hourly['precipitation_probability'].append(90 if storm or rain else 5)
            hourly['cloud_cover'].append(95 if rain else 10)
    return {'daily': daily, 'hourly': hourly, 'current': {'temperature_2m': 12.3, 'weather_code': 1}}

async def main():
    g = MockGoogle(); errs = []; calls = []
    async with async_playwright() as p:
        b = await p.chromium.launch(); ctx = await b.new_context(viewport={'width': 1400, 'height': 900}, timezone_id='Europe/Berlin', compact_ui=True)
        await ctx.add_init_script(INIT); await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        async def meteo(route):
            calls.append(route.request.url); await route.fulfill(json=wx(), headers={'Access-Control-Allow-Origin': '*'})
        await ctx.route(re.compile(r'https://(api|geocoding-api)\.open-meteo\.com/.*'), meteo)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8832/app.html'); await page.wait_for_function('window.tempo'); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(3500)
        # ---- weather
        check('1. asks for the hourly forecast and the current temperature, in your time zone', calls and 'hourly=' in calls[-1] and 'current=' in calls[-1] and 'timezone=Europe%2FBerlin' in calls[-1], calls[-1:] )
        w24 = await page.evaluate("(() => { const x = document.querySelector('.tg-dayhead[data-day=\"2026-10-24\"] .wx'); return x && { t: x.textContent, tip: x.title }; })()")
        w25 = await page.evaluate("(() => { const x = document.querySelector('.tg-dayhead[data-day=\"2026-10-25\"] .wx'); return x && { t: x.textContent, tip: x.title }; })()")
        check('2. a storm at 3 am no longer makes a sunny day look stormy', w24 and '☀' in w24['t'] and '⛈' not in w24['t'] and 'dry 7–22 h' in w24['tip'] and 'At some point: thunderstorm' in w24['tip'], w24)
        check('3. a rainy day still shows rain, with mm while you are awake and a part-of-day breakdown', w25 and '🌧' in w25['t'] and '4.0 mm rain 7–22 h' in w25['tip'] and 'Morning' in w25['tip'] and 'Afternoon' in w25['tip'], w25)
        check('4. today shows the temperature now', w24 and '12°' in w24['t'] and 'Now 12°' in w24['tip'], w24)
        await page.screenshot(path=f'{OUT}/r38-weather.png', clip={'x': 260, 'y': 50, 'width': 1140, 'height': 120})
        await page.evaluate("document.querySelector('#btn-settings').click()"); await page.wait_for_selector('dialog[open] .settings-form')
        await page.click('dialog[open] details[data-sect=s-weather] > summary')
        await page.select_option('dialog[open] [name=wxModel]', 'icon_seamless')
        await page.click('dialog[open] button[type=submit]'); await page.wait_for_timeout(2500)
        check('5. a forecast model can be chosen (e.g. DWD ICON) and is fetched again', 'models=icon_seamless' in calls[-1], calls[-1])
        # ---- Later
        await page.click('.side-tabs [data-st=later]'); await page.wait_for_timeout(300)
        chips = await page.eval_on_selector_all('.later-row .later-xp', 'xs => xs.map(x => x.textContent.trim())')
        check('6. each Later item shows what scheduling it earns now, and doing it', chips == ['🎮 +10 · +30 when done', '🎮 +6 · +18 when done'], chips)
        await page.screenshot(path=f'{OUT}/r38-later.png')
        await page.click('.later-row:has-text("Fix bike") .l-event'); await page.wait_for_selector('dialog [name=summary]')
        await page.click('dialog button[type=submit] >> nth=-1'); await page.wait_for_timeout(2500)
        ev = [e for e in g.events['me@example.com'].values() if e.get('summary') == 'Fix bike']
        check('7. the event remembers it came from Later', ev and ev[0]['extendedProperties']['private'].get('tempoLaterCreated') == str(C1), ev[:1])
        await page.click('.side-tabs [data-st=later]'); await page.wait_for_timeout(300)
        await page.click('.later-row:has-text("Read paper") .l-task'); await page.wait_for_selector('dialog [name=title]')
        await page.click('dialog button[type=submit] >> nth=-1'); await page.wait_for_timeout(3000)
        t = await page.evaluate("window.__tempo.app.state.tasks.find(t => t.title === 'Read paper')")
        check('8. the task remembers it came from Later', t and t.get('fromLater', {}).get('created') == C2, t and t.get('fromLater'))
        await page.wait_for_timeout(1500)
        lines = await page.evaluate("window.__tempo.app.gameToday.lines.filter(l => l[0].includes('Later')).map(l => [l[0], l[1], l[2]])")
        check('9. scheduling them earned life XP today: +10 (waited 3 weeks) and +6 (7 days)', ['scheduled from Later: “Fix bike” (waited 3 weeks)', 'life', 10] in lines and ['scheduled from Later: “Read paper” (waited 7 days)', 'life', 6] in lines, lines)
        done = await page.evaluate("""(async () => { const GM = await import('./js/game.js'); const s = window.__tempo.app.state.settings; const now = Date.now();
          const d = GM.dayXP('2026-10-24', s, { items: [], tasks: [{ title: 'Read paper', created: 0, fromLater: { created: now - 7 * 864e5, at: now - 864e5 }, _finishedAt: now - 3600e3 }], projects: [], habits: [], goalsAll: [], history: [] }, now);
          return d.lines.filter(l => l[0].includes('Later')); })()""")
        check('10. doing it earns three times as much', done == [['did something from Later: “Read paper”', 'life', 18]], done)
        check('no page errors', not errs, errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
print('ALL PASS' if all(ok) else f'{ok.count(False)} FAILED')
