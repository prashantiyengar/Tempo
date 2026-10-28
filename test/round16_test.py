# Assumed sleep in the 24-hour analysis; the "Later" notes list; weather in day headers (C/F).
import asyncio, sys, subprocess, time, re, json
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8801','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
INIT = """
const FIX = Date.parse('2026-10-21T08:00:00Z'); const _Date = Date; globalThis.__off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false, goalNotice: false}));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2026-10-19'));
}"""
import datetime
def wx_days():
    d0 = datetime.date(2026, 10, 21)
    return {'time': [(d0 + datetime.timedelta(i)).isoformat() for i in range(16)], 'weather_code': [0, 2, 61, 3, 71, 95, 1, 45, 0, 2, 61, 3, 71, 95, 1, 45],
            'temperature_2m_max': [18.4] * 16, 'temperature_2m_min': [9.0] * 16, 'precipitation_probability_max': [10] * 16}
async def main():
    g = MockGoogle(); errs = []; calls = []
    E = g.events['me@example.com']
    # Thu night logged (sleep 22:30–06:30) → that night isn't assumed
    E['s'] = {'id': 's', 'summary': 'Sleep', 'status': 'confirmed', 'start': {'dateTime': '2026-10-22T22:30:00+02:00'}, 'end': {'dateTime': '2026-10-23T06:30:00+02:00'}}
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1440, 'height': 900}, timezone_id='Europe/Berlin')
        await ctx.add_init_script(INIT)
        await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        async def meteo(route):
            calls.append(route.request.url)
            if 'geocoding' in route.request.url:
                return await route.fulfill(json={'results': [{'name': 'Berlin', 'admin1': 'Land Berlin', 'country': 'Germany', 'latitude': 52.52, 'longitude': 13.405}, {'name': 'Berlin', 'admin1': 'New Hampshire', 'country': 'United States', 'latitude': 44.47, 'longitude': -71.18}]}, headers={'Access-Control-Allow-Origin': '*'})
            await route.fulfill(json={'daily': wx_days()}, headers={'Access-Control-Allow-Origin': '*'})
        await ctx.route(re.compile(r'https://(api|geocoding-api)\.open-meteo\.com/.*'), meteo)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8801/app.html'); await page.wait_for_selector('.tg-col'); await page.wait_for_function('window.tempo'); await page.wait_for_timeout(1500)
        # 1. analysis, this week, full 24 h
        await page.click('.view-switch button:has-text("Analysis"), button:has-text("Analysis") >> nth=0'); await page.wait_for_selector('[data-o=scope]')
        await page.select_option('[data-o=period]', 'week'); await page.wait_for_timeout(500)
        await page.select_option('[data-o=scope]', 'full'); await page.wait_for_selector('.sleep-note')
        print('1. note:', re.sub(r'\s+', ' ', await page.text_content('.sleep-note'))[:260])
        rows = await page.eval_on_selector_all('.an-table tbody tr', 'rs => rs.map(r => r.innerText.replace(/\\s+/g, " ").slice(0, 60))')
        print('   table:', rows[:4])
        await page.screenshot(path=f'{OUT}/s1-sleep.png')
        await page.select_option('.sleep-note [data-sleep=cat]', label='🏠 Personal'); await page.wait_for_timeout(600)
        rows2 = await page.eval_on_selector_all('.an-table tbody tr', 'rs => rs.map(r => r.innerText.replace(/\\s+/g, " ").slice(0, 50))')
        print('   as Personal:', rows2[:3], '| saved', await page.evaluate('window.__tempo.app.state.settings.sleepCategory'), '| note:', 'category Personal' in await page.text_content('.sleep-note'))
        await page.click('.an-table tbody tr >> nth=0 >> summary'); print('   listed under it:', await page.eval_on_selector_all('.an-table tbody tr >> nth=0 >> .an-items li', 'xs => xs.map(x => x.innerText.replace(/\\s+/g, " "))'))
        await page.select_option('[data-o=by]', 'type'); await page.wait_for_timeout(500)
        print('   grouped by type → own group:', (await page.eval_on_selector_all('.an-table tbody tr', 'rs => rs.map(r => r.innerText.replace(/\\s+/g, " ").slice(0, 30))'))[:2])
        await page.select_option('[data-o=by]', 'category'); await page.wait_for_timeout(500)
        await page.click('#btn-settings'); print('   settings shows:', await page.eval_on_selector('dialog [name=sleepCategory]', 's => s.selectedOptions[0].text'))
        await page.select_option('dialog [name=sleepCategory]', ''); await page.click('dialog button[type=submit] >> nth=-1'); await page.wait_for_timeout(800)
        print('   back to own group:', (await page.eval_on_selector_all('.an-table tbody tr', 'rs => rs.map(r => r.innerText.replace(/\\s+/g, " ").slice(0, 30))'))[:1])
        await page.fill('.sleep-note [data-sleep=start]', '22:00'); await page.dispatch_event('.sleep-note [data-sleep=start]', 'change'); await page.wait_for_timeout(600)
        print('   22:00 start:', re.sub(r'\s+', ' ', await page.text_content('.sleep-note'))[:120], '| saved', await page.evaluate('window.__tempo.app.state.settings.sleepStart'))
        await page.uncheck('.sleep-note [data-sleep=on]'); await page.wait_for_timeout(600)
        print('   off:', re.sub(r'\s+', ' ', await page.text_content('.sleep-note'))[:90], '| sleep row gone:', not any('Sleep' in r for r in await page.eval_on_selector_all('.an-table tbody tr', 'rs => rs.map(r => r.innerText)')))
        await page.check('.sleep-note [data-sleep=on]'); await page.wait_for_timeout(400)
        await page.select_option('[data-o=scope]', 'bounds'); await page.wait_for_timeout(400)
        print('   not shown for day bounds:', not await page.query_selector('.sleep-note'))
        await page.click('button:has-text("Week") >> nth=0'); await page.wait_for_selector('.tg-col')
        # 2. Later list
        await page.click('.side-tabs [data-st=later]')
        await page.fill('.later-add input', 'Book dentist'); await page.press('.later-add input', 'Enter'); await page.wait_for_timeout(300)
        await page.fill('.later-add input', 'Renew passport'); await page.press('.later-add input', 'Enter'); await page.wait_for_timeout(300)
        print('2. later:', await page.eval_on_selector_all('.later-row .later-t', 'xs => xs.map(x => x.innerText.split(" · ")[0])'), '| badge', await page.text_content('#later-n'))
        await page.screenshot(path=f'{OUT}/s2-later.png')
        # → event: dialog opens prefilled; save → note removed
        await page.click('.later-row:has-text("Book dentist") .l-event'); await page.wait_for_selector('dialog [name=summary]')
        print('   event dialog title:', await page.input_value('dialog [name=summary]'))
        await page.click('dialog button[type=submit] >> nth=-1'); await page.wait_for_timeout(1500)
        print('   after saving event:', await page.eval_on_selector_all('.later-row .later-t', 'xs => xs.map(x => x.innerText.split(" · ")[0])'), '| in Google:', any(e.get('summary') == 'Book dentist' for e in E.values()))
        # → task, cancelled: stays
        await page.click('.later-row:has-text("Renew passport") .l-task'); await page.wait_for_selector('dialog [name=title]')
        print('   task dialog title:', await page.input_value('dialog [name=title]')); await page.keyboard.press('Escape'); await page.wait_for_timeout(300)
        print('   cancelled → still there:', await page.eval_on_selector_all('.later-row .later-t', 'xs => xs.length'))
        await page.click('.later-row .l-del'); await page.wait_for_timeout(300)
        print('   deleted:', await page.eval_on_selector_all('.later-row', 'xs => xs.length'))
        await page.click('#btn-undo'); await page.wait_for_timeout(300)
        print('   undo:', await page.eval_on_selector_all('.later-row .later-t', 'xs => xs.map(x => x.innerText.split(" · ")[0])'))
        r = await page.evaluate("window.tempo.run([{cmd:'addLater', text:'Call plumber'}, {cmd:'listLater'}])")
        print('   AI:', [x['text'] for x in r[1]['result']])
        await page.wait_for_timeout(2500)
        sh = [e for e in E.values() if (e.get('extendedProperties') or {}).get('private', {}).get('tempoSettingsV2')]
        print('   synced in settings event:', bool(sh) and 'Renew passport' in json.dumps(sh[0]))
        await page.click('.side-tabs [data-st=tasks]')
        # 3. weather
        await page.click('#btn-settings')
        await page.fill('dialog [name=wxPlace]', 'Berlin'); await page.click('dialog .wx-find'); await page.wait_for_selector('dialog .wx-pl')
        await page.click('dialog .wx-pl >> nth=0'); await page.screenshot(path=f'{OUT}/s3-wx-settings.png')
        await page.click('dialog button[type=submit] >> nth=-1'); await page.wait_for_timeout(1500)
        heads = await page.eval_on_selector_all('.tg-dayhead', 'hs => hs.map(h => (h.querySelector(".wx")?.innerText || "").replace(/\\s+/g, " "))')
        print('3. week headers:', heads, '| tip:', await page.get_attribute('.tg-dayhead.today .wx', 'title'))
        print('   requests:', [c.split('?')[0] for c in calls], '| coords in request:', 'latitude=52.520' in calls[-1])
        await page.screenshot(path=f'{OUT}/s3-week.png')
        await page.click('#btn-settings'); await page.select_option('dialog [name=wxUnit]', 'F'); await page.click('dialog button[type=submit] >> nth=-1'); await page.wait_for_timeout(1000)
        print('   °F:', await page.eval_on_selector('.tg-dayhead.today .wx', 'x => x.innerText.replace(/\\s+/g, " ")'))
        await page.click('button:has-text("Month") >> nth=0'); await page.wait_for_selector('.m-cell'); await page.wait_for_timeout(500)
        print('   month cells with weather:', await page.eval_on_selector_all('.m-cell .wx-m', 'xs => xs.length'))
        await page.screenshot(path=f'{OUT}/s3-month.png')
        print('ERRORS:', errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
