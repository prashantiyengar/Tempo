# Newspaper: events grouped by day, historical picture + archive, joke, quote, period, online horoscope, ornaments.
import asyncio, sys, subprocess, time, re, json
from urllib.parse import urlparse, parse_qs
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8805','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
INIT = """
const FIX = Date.parse('2026-10-22T13:00:00Z'); const _Date = Date; globalThis.__off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false, goalNotice: false, reviewAllEvents: true, zodiac: 'scorpio'}));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2026-10-19'));
}"""
PNG = bytes.fromhex('89504e470d0a1a0a0000000d4948445200000001000000010806000000'+'1f15c4890000000d49444154789c6360000000000200015e2b2a8d0000000049454e44ae426082')
async def main():
    g = MockGoogle(); errs = []; n = {'pic': 0, 'joke': 0}; horo = []
    E = g.events['me@example.com']
    for i, (d, h, t) in enumerate([('20', '10', 'Dentist'), ('20', '15', 'Call with Anna'), ('21', '09', 'Workshop'), ('23', '18', 'Dinner')]):
        E[f'e{i}'] = {'id': f'e{i}', 'summary': t, 'status': 'confirmed', 'start': {'dateTime': f'2026-10-{d}T{h}:00:00+02:00'}, 'end': {'dateTime': f'2026-10-{d}T{h}:45:00+02:00'}}
    E['m1'] = {'id': 'm1', 'summary': 'Conference', 'status': 'confirmed', 'start': {'dateTime': '2026-10-06T09:00:00+02:00'}, 'end': {'dateTime': '2026-10-06T17:00:00+02:00'}}
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1440, 'height': 900}, timezone_id='Europe/Berlin')
        await ctx.add_init_script(INIT)
        await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        cors = {'Access-Control-Allow-Origin': '*'}
        async def commons(route):
            q = parse_qs(urlparse(route.request.url).query)
            if q.get('list') == ['search']:
                return await route.fulfill(json={'query': {'search': [{'title': f'File:Punch cartoon {i}.jpg'} for i in range(8)] + [{'title': 'File:Scan.pdf'}]}}, headers=cors)
            n['pic'] += 1; t = q['titles'][0]
            await route.fulfill(json={'query': {'pages': {'1': {'title': t, 'imageinfo': [{'thumburl': f'https://upload.wikimedia.org/thumb/{n["pic"]}.png', 'descriptionurl': f'https://commons.wikimedia.org/wiki/{t.replace(" ", "_")}', 'extmetadata': {'ObjectName': {'value': f'A Punch cartoon no. {n["pic"]}'}, 'Artist': {'value': '<a href="x">John Tenniel</a>'}, 'DateTimeOriginal': {'value': '1864'}, 'LicenseShortName': {'value': 'Public domain'}}}]}}}}, headers=cors)
        await ctx.route(re.compile(r'https://commons\.wikimedia\.org/w/api\.php.*'), commons)
        await ctx.route(re.compile(r'https://upload\.wikimedia\.org/.*'), lambda r: r.fulfill(body=PNG, content_type='image/png', headers=cors))
        async def joke(route):
            n['joke'] += 1; await route.fulfill(json={'id': f'j{n["joke"]}', 'joke': f'Online joke number {n["joke"]}.', 'status': 200}, headers=cors)
        await ctx.route('https://icanhazdadjoke.com/', joke)
        async def horoscope(route):
            horo.append(route.request.url)
            if 'apiverve' in route.request.url:
                return await route.fulfill(json={'status': 'ok', 'data': {'sign': 'scorpio', 'horoscope': 'APIVerve says: a fine day for scorpions.' if route.request.headers.get('x-api-key') == 'k123' else ''}}, headers=cors)
            await route.fulfill(json={'data': {'date': 'Oct 22, 2026', 'horoscope_data': 'Community says: you will find a lost sock.'}, 'status': 200, 'success': True}, headers=cors)
        await ctx.route(re.compile(r'https://(horoscope-app-api\.vercel\.app|api\.apiverve\.com)/.*'), horoscope)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8805/app.html'); await page.wait_for_selector('.tg-col'); await page.wait_for_function('window.tempo'); await page.wait_for_timeout(1200)
        await page.click('#view-seg button[data-view=review]'); await page.wait_for_selector('.np-title'); await page.wait_for_timeout(1500)
        print('1. days:', await page.eval_on_selector_all('.np-dayh', 'xs => xs.map(x => x.textContent)'), '| Tue:', await page.eval_on_selector_all('.np-day >> nth=0 >> li', 'xs => xs.map(x => x.innerText)'))
        print('2. picture:', await page.get_attribute('.np-figure img', 'src'), '|', re.sub(r'\s+', ' ', await page.text_content('.np-figure figcaption')))
        print('   joke:', await page.text_content('.np-joke'), '| quote:', (await page.text_content('.np-quote'))[:80])
        print('   ornaments:', len(await page.query_selector_all('.np-titlerow .np-orn')), '| crown:', bool(await page.query_selector('.np-crown svg')), '| motto:', await page.text_content('.np-motto'))
        print('   horoscope:', await page.text_content('.np-horo-txt'), '|', horo[-1].split('?')[0] if horo else None)
        await page.screenshot(path=f'{OUT}/z1-paper.png', full_page=True)
        q1 = await page.text_content('.np-quote')
        await page.click('.np-pic-new'); await page.wait_for_timeout(800)
        await page.click('.np-joke-new'); await page.wait_for_timeout(500)
        for _ in range(5):
            await page.click('.np-quote-new')
            if await page.text_content('.np-quote') != q1: break
        print('3. new picture:', await page.get_attribute('.np-figure img', 'src'), '| archive:', await page.text_content('.np-pic-hist'), '| new quote:', await page.text_content('.np-quote') != q1, '| joke now:', await page.text_content('.np-joke'))
        # leave and come back: a new picture is fetched, archive keeps all
        await page.click('#view-seg button[data-view=week]'); await page.wait_for_timeout(400); await page.click('#view-seg button[data-view=review]'); await page.wait_for_selector('.np-figure img'); await page.wait_for_timeout(500)
        print('   revisit picture:', await page.get_attribute('.np-figure img', 'src'), '| archive entries:', await page.eval_on_selector_all('.np-archive li', 'xs => xs.length'))
        await page.click('.np-pic-hist'); await page.wait_for_timeout(300)
        print('   archive open:', await page.eval_on_selector('.np-archive', 'd => d.open'), '|', await page.eval_on_selector_all('.np-archive li a', 'xs => xs.map(x => x.textContent)'))
        # 4. period: month
        await page.select_option('[data-np=period]', 'month'); await page.wait_for_timeout(1500)
        print('4. month:', await page.text_content('#range-title'), '|', await page.text_content('.np-ears'), '| Termine heading:', await page.eval_on_selector_all('.np-feuil .np-h4', 'xs => xs.map(x => x.textContent)'))
        print('   days in month view:', len(await page.query_selector_all('.np-dayh')), '| has 6 Oct:', any('6' in x for x in await page.eval_on_selector_all('.np-dayh', 'xs => xs.map(x => x.textContent)')))
        await page.click('#btn-prev'); await page.wait_for_timeout(800); print('   prev:', await page.text_content('#range-title'))
        await page.click('#btn-today'); await page.wait_for_timeout(800)
        await page.select_option('[data-np=period]', 'quarter'); await page.wait_for_timeout(1000); print('   quarter:', await page.text_content('#range-title'), '|', (await page.text_content('.np-ears'))[:40])
        await page.select_option('[data-np=period]', 'week'); await page.wait_for_timeout(800)
        # 5. horoscope source: APIVerve with key
        await page.click('.np-hsrc'); await page.check('dialog [name=src][value=apiverve]'); await page.fill('dialog [name=key]', 'k123'); await page.click('dialog button.primary'); await page.wait_for_timeout(1200)
        print('5. APIVerve:', await page.text_content('.np-horo-txt'), '| key kept local only:', 'k123' not in json.dumps(await page.evaluate('window.__tempo.app.state.settings')))
        await page.click('.np-hsrc'); await page.check('dialog [name=src][value=off]'); await page.click('dialog button.primary'); await page.wait_for_timeout(600)
        print('   off:', not await page.query_selector('.np-horo-txt'))
        await page.screenshot(path=f'{OUT}/z2-paper.png', full_page=True)
        print('ERRORS:', errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
