# Goals tab (ranked goals per week / month / year, travel reminders), goals in the newspaper, picture at the top.
import asyncio, sys, subprocess, time, re, json
from urllib.parse import urlparse, parse_qs
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8806','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
INIT = """
const FIX = Date.parse('2026-10-22T13:00:00Z'); const _Date = Date; globalThis.__off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false, goalNotice: false, horoscopeSource: 'off'}));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2026-10-19'));
}"""
PIC = open('test/pic600x420.png', 'rb').read()
async def main():
    g = MockGoogle(); errs = []; n = {'pic': 0}
    E = g.events['me@example.com']
    E['f1'] = {'id': 'f1', 'summary': 'Flight to London', 'status': 'confirmed', 'start': {'dateTime': '2026-11-12T07:00:00+01:00'}, 'end': {'dateTime': '2026-11-12T09:00:00+01:00'}}
    E['f2'] = {'id': 'f2', 'summary': 'Urlaub Mallorca', 'status': 'confirmed', 'location': 'Palma', 'start': {'date': '2026-12-20'}, 'end': {'date': '2026-12-28'}}
    E['f3'] = {'id': 'f3', 'summary': 'Train to Munich', 'status': 'confirmed', 'start': {'dateTime': '2026-10-29T08:00:00+01:00'}, 'end': {'dateTime': '2026-10-29T12:00:00+01:00'}}
    E['x'] = {'id': 'x', 'summary': 'Team lunch', 'status': 'confirmed', 'start': {'dateTime': '2026-11-03T12:00:00+01:00'}, 'end': {'dateTime': '2026-11-03T13:00:00+01:00'}}
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1440, 'height': 900}, timezone_id='Europe/Berlin')
        await ctx.add_init_script(INIT)
        await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        cors = {'Access-Control-Allow-Origin': '*'}
        async def commons(route):
            q = parse_qs(urlparse(route.request.url).query)
            if q.get('list') == ['search']:
                return await route.fulfill(json={'query': {'search': [{'title': f'File:Punch cartoon {i}.jpg'} for i in range(5)]}}, headers=cors)
            n['pic'] += 1; t = q['titles'][0]
            await route.fulfill(json={'query': {'pages': {'1': {'title': t, 'imageinfo': [{'thumburl': f'https://upload.wikimedia.org/thumb/{n["pic"]}.png', 'thumbwidth': 960, 'thumbheight': 672, 'descriptionurl': 'https://commons.wikimedia.org/wiki/X', 'extmetadata': {'ObjectName': {'value': f'Cartoon {n["pic"]}'}, 'DateTimeOriginal': {'value': '1871'}}}]}}}}, headers=cors)
        await ctx.route(re.compile(r'https://commons\.wikimedia\.org/w/api\.php.*'), commons)
        # the first image is broken → Tempo should fetch another
        await ctx.route(re.compile(r'https://upload\.wikimedia\.org/thumb/1\.png'), lambda r: r.fulfill(status=404, body='nope'))
        await ctx.route(re.compile(r'https://upload\.wikimedia\.org/thumb/[2-9]\.png'), lambda r: r.fulfill(body=PIC, content_type='image/png', headers=cors))
        await ctx.route('https://icanhazdadjoke.com/', lambda r: r.fulfill(json={'id': 'j', 'joke': 'Online joke.'}, headers=cors))
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8806/app.html'); await page.wait_for_selector('.tg-col'); await page.wait_for_function('window.tempo'); await page.wait_for_timeout(1200)
        # 1. goals tab
        await page.click('#view-seg button[data-view=goals]'); await page.wait_for_selector('.g-card')
        print('1. sections:', await page.eval_on_selector_all('.g-card h3', 'xs => xs.map(x => x.textContent)'))
        print('   month note:', await page.text_content('.goals > p.muted.small:not(.g-intro)'))
        trips = await page.eval_on_selector_all('.g-card', 'cs => cs.map(c => [c.querySelector("h3").textContent, [...c.querySelectorAll(".g-trips li > span")].map(x => x.innerText)]).filter(x => x[1].length)')
        print('   travel reminders:', trips)
        wk = '.g-card >> nth=0'
        for t in ['Finish the grant draft', 'Book dentist', 'Run 3 times']:
            await page.click(f'{wk} >> .g-plus[data-head=personal]'); await page.fill('dialog [name=t]', t); await page.click('dialog button.primary'); await page.wait_for_timeout(250)
        await page.click(f'{wk} >> .g-row >> nth=2 >> .g-up'); await page.wait_for_timeout(250)
        await page.check(f'{wk} >> .g-row >> nth=0 >> .g-done'); await page.wait_for_timeout(250)
        await page.click(f'{wk} >> .g-row >> nth=2 >> .g-text'); await page.fill('dialog [name=t]', 'Book dentist for November'); await page.click('dialog button.primary'); await page.wait_for_timeout(250)
        print('   this week:', await page.eval_on_selector_all(f'.g-card:first-child .g-row', 'rs => rs.map(r => (r.classList.contains("done") ? "✓ " : "") + r.querySelector(".g-rank").textContent + ". " + r.querySelector(".g-text").textContent.trim())'), '|', await page.text_content('.g-card:first-child .g-count'))
        await page.click('.g-card >> nth=1 >> .g-plus[data-head=work]'); await page.fill('dialog [name=t]', 'Prepare Munich workshop'); await page.click('dialog button.primary'); await page.wait_for_timeout(250)
        await page.click('.g-card:has(h3:text("November")) .g-trip-add'); await page.wait_for_timeout(250)
        print('   November:', await page.eval_on_selector_all('.g-card:has(h3:text("November")) .g-text', 'xs => xs.map(x => x.textContent)'))
        await page.click('.g-year .g-plus[data-head=personal]'); await page.fill('dialog [name=t]', 'Learn Spanish to B1'); await page.click('dialog button.primary'); await page.wait_for_timeout(250)
        await page.click('.g-mtoggle [data-m="12"]'); await page.wait_for_timeout(400)
        print('   12 months shown:', len(await page.query_selector_all('.g-card')) - 3, 'month cards')
        await page.screenshot(path=f'{OUT}/g1-goals.png', full_page=True)
        await page.click('.g-mtoggle [data-m="3"]'); await page.wait_for_timeout(300)
        await page.click('#btn-undo'); await page.wait_for_timeout(300)
        print('   undo removes last goal:', await page.eval_on_selector_all('.g-year .g-text', 'xs => xs.length') == 0)
        r = await page.evaluate("window.tempo.run([{cmd:'addGoal', period:'year', text:'Learn Spanish to B1'}, {cmd:'markGoal', period:'next week', goal:1}, {cmd:'listGoals'}])")
        print('   AI:', json.dumps(r[2]['result'][:2])[:300])
        await page.wait_for_timeout(2500)
        sh = [e for e in E.values() if (e.get('extendedProperties') or {}).get('private', {}).get('tempoSettings')]
        print('   synced:', bool(sh) and 'grant draft' in json.dumps(sh[0]))
        # 2. newspaper
        await page.click('#view-seg button[data-view=review]'); await page.wait_for_selector('.np-goals'); await page.wait_for_timeout(2500)
        print('2. paper goals:', await page.text_content('.np-goals .np-h3'), '|', await page.eval_on_selector_all('.np-goal-list li', 'xs => xs.map(x => x.innerText)'), '| coming:', await page.eval_on_selector_all('.np-goals p.np-small', 'xs => xs.map(x => x.innerText)'))
        # 3. picture at top, fully visible
        info = await page.evaluate("""(() => { const img = document.querySelector('.np-pic-s img'); const col = document.querySelector('.np-grid > .np-pic-s').getBoundingClientRect(); const r = img.getBoundingClientRect(), np = document.querySelector('.np').getBoundingClientRect();
          return { src: img.getAttribute('src'), loaded: img.complete && img.naturalHeight > 0, fits: r.width <= col.width + 1 && r.height <= 341, centred: Math.abs((r.left + r.right) / 2 - (np.left + np.right) / 2) < 30 }; })()""")
        print('3. picture:', info)
        await page.screenshot(path=f'{OUT}/g2-paper.png', full_page=True)
        await page.select_option('[data-np=period]', 'year'); await page.wait_for_timeout(1500)
        print('   year edition goals:', await page.eval_on_selector_all('.np-goals .np-h4', 'xs => xs.map(x => x.textContent)'))
        print('ERRORS:', errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
