# Offline (web app), per-goal categories, newspaper picture in the middle column / name / sources / hours,
# printing keeps the columns, goal reminder popup with snooze.
import asyncio, sys, subprocess, time, re, json
from urllib.parse import urlparse, parse_qs
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8808','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
web = subprocess.Popen(['python3','-m','http.server','8809','-d','dist/web'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
def init(iso, extra=''):
    return """
const FIX = Date.parse('%s'); const _Date = Date; globalThis.__off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify(Object.assign({tz: 'Europe/Berlin', askCategory: false, horoscopeSource: 'off',
    categories: [{id:'work',name:'Work',color:'#039be5',icon:'💼'},{id:'personal',name:'Personal',color:'#33b679',icon:'🏠'},{id:'sport',name:'Sport',color:'#e67c73',icon:'🏃'},{id:'study',name:'Study',color:'#8e24aa',icon:'📚'}]}, %s)));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2099-01-01'));
}""" % (iso, extra or '{}')
PIC = open('test/pic600x420.png', 'rb').read()
async def main():
    g = MockGoogle(); errs = []; searches = []
    E = g.events['me@example.com']
    E['a'] = {'id': 'a', 'summary': 'Dentist', 'status': 'confirmed', 'start': {'dateTime': '2026-10-22T16:00:00+02:00'}, 'end': {'dateTime': '2026-10-22T17:00:00+02:00'}}
    E['s'] = {'id': 's', 'summary': 'Climbing', 'status': 'confirmed', 'extendedProperties': {'private': {'tempoCategory': 'sport'}}, 'start': {'dateTime': '2026-10-20T18:00:00+02:00'}, 'end': {'dateTime': '2026-10-20T20:00:00+02:00'}}
    cors = {'Access-Control-Allow-Origin': '*'}
    async def commons(route):
        q = parse_qs(urlparse(route.request.url).query)
        if q.get('list') == ['search']:
            searches.append(q['srsearch'][0]); return await route.fulfill(json={'query': {'search': [{'title': 'File:Poster.jpg'}]}}, headers=cors)
        await route.fulfill(json={'query': {'pages': {'1': {'title': 'File:Poster.jpg', 'imageinfo': [{'thumburl': 'https://upload.wikimedia.org/p.png', 'thumbwidth': 960, 'thumbheight': 672, 'descriptionurl': 'https://commons.wikimedia.org/wiki/File:Poster.jpg', 'extmetadata': {'ObjectName': {'value': 'A poster'}}}]}}}}, headers=cors)
    async def aic(route):
        searches.append('aic:' + parse_qs(urlparse(route.request.url).query)['q'][0])
        await route.fulfill(json={'data': [{'id': 27992, 'title': 'A Sunday on La Grande Jatte', 'image_id': 'abc', 'artist_display': 'Georges Seurat\nFrench', 'date_display': '1884–86'}]}, headers=cors)
    async def setup(ctx):
        await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        await ctx.route(re.compile(r'https://commons\.wikimedia\.org/w/api\.php.*'), commons)
        await ctx.route(re.compile(r'https://api\.artic\.edu/.*'), aic)
        await ctx.route(re.compile(r'https://(upload\.wikimedia\.org|www\.artic\.edu)/.*'), lambda r: r.fulfill(body=PIC, content_type='image/png', headers=cors))
        await ctx.route('https://icanhazdadjoke.com/', lambda r: r.fulfill(json={'id': 'j', 'joke': 'Joke.'}, headers=cors))
    async with async_playwright() as p:
        b = await p.chromium.launch()
        # 1. offline: the web app (with its service worker) opens offline and shows the saved calendar
        ctx = await b.new_context(viewport={'width': 1440, 'height': 900}, timezone_id='Europe/Berlin', service_workers='allow')
        await ctx.add_init_script(init('2026-10-22T10:00:00Z', '{goalNotice: false}')); await setup(ctx)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8809/'); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(2500)
        await page.evaluate("navigator.serviceWorker.ready"); await page.wait_for_timeout(500)
        print('1. online events:', await page.eval_on_selector_all('.ev:not(.chunk) .ev-t', 'xs => xs.map(x => x.textContent)'))
        await ctx.set_offline(True)
        await page.reload(); await page.wait_for_selector('.tg-col', timeout=15000); await page.wait_for_timeout(2500)
        print('   offline reload events:', await page.eval_on_selector_all('.ev:not(.chunk) .ev-t', 'xs => xs.map(x => x.textContent)'), '| status:', await page.text_content('#sync-status'), '| error toast:', 'rror' in (await page.text_content('#toast') or ''))
        await page.screenshot(path=f'{OUT}/o1-offline.png')
        await ctx.set_offline(False); await page.evaluate("dispatchEvent(new Event('online'))"); await page.wait_for_timeout(2500)
        print('   back online:', await page.text_content('#sync-status'))
        await ctx.close()
        # 2–4 (desktop source build)
        ctx = await b.new_context(viewport={'width': 1440, 'height': 900}, timezone_id='Europe/Berlin')
        await ctx.add_init_script(init('2026-10-22T13:00:00Z', '{goalNotice: false}')); await setup(ctx)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8808/app.html'); await page.wait_for_selector('.tg-col'); await page.wait_for_function('window.tempo'); await page.wait_for_timeout(1000)
        await page.click('#view-seg button[data-view=goals]'); await page.wait_for_selector('.g-card')
        await page.click('.g-card:first-child .g-plus[data-head=personal]'); await page.fill('dialog [name=t]', 'Climb twice'); await page.fill('dialog [name=b]', '4'); await page.click('dialog .g-addbox .g-catbox'); await page.click('dialog .g-pick .cat-chip[data-cat=sport]'); await page.click('dialog .g-pick ~ .actions button.primary'); await page.click('dialog .g-addform button.primary'); await page.wait_for_timeout(400)
        print('2. goal with own category:', re.sub(r'\s+', ' ', await page.inner_text('.g-card:first-child .g-head[data-head=personal] .g-row')), '| box:', await page.inner_text('.g-card:first-child .g-head[data-head=personal] .g-row .g-catbox'))
        print('   stored cats:', await page.evaluate("Object.values(window.__tempo.app.state.settings.goals)[0][0].cats"))
        # 3. settings: name, hours, sources (built-in off, Commons search + AIC)
        await page.click('#btn-settings'); await page.click('dialog .tabs button[data-tab="7"]')
        await page.fill('dialog [name=paperName]', 'The Daily Planner'); await page.select_option('dialog [name=paperScope]', 'full')
        await page.uncheck('dialog .pic-src >> nth=0 >> .ps-on')
        await page.click('dialog .add-pic-src'); await page.fill('dialog .pic-src >> nth=1 >> .ps-name', 'Posters'); await page.fill('dialog .pic-src >> nth=1 >> .ps-val', 'Art Nouveau poster')
        await page.screenshot(path=f'{OUT}/o2-settings.png')
        await page.click('dialog button[type=submit] >> nth=-1'); await page.wait_for_timeout(500)
        await page.click('#view-seg button[data-view=review]'); await page.wait_for_selector('.np-figure img'); await page.wait_for_timeout(800)
        print('3. name:', await page.text_content('.np-title'), '| search:', searches[-1], '| hours select:', await page.input_value('[data-np=scope]'), '| lead:', (await page.text_content('.np-drop'))[:70])
        geo = await page.evaluate("""(() => { const r = (s) => document.querySelector(s).getBoundingClientRect(); const pic = r('.np-grid > .np-pic-s'), biz = r('.np-biz'), fe = r('.np-feuil'), img = r('.np-pic-s img');
          return { middle: pic.left > biz.right - 2 && pic.right < fe.left + 2, sameRow: Math.abs(pic.top - biz.top) < 3 && Math.abs(fe.top - biz.top) < 3, imgFits: img.width <= pic.width && img.height <= 341, imgH: Math.round(img.height), imgW: Math.round(img.width) }; })()""")
        print('   picture:', geo)
        await page.screenshot(path=f'{OUT}/o3-paper.png', full_page=True)
        # AIC source
        await page.click('#btn-settings'); await page.click('dialog .tabs button[data-tab="7"]')
        await page.uncheck('dialog .pic-src >> nth=1 >> .ps-on'); await page.click('dialog .add-pic-src'); await page.select_option('dialog .pic-src >> nth=2 >> .ps-kind', 'aic'); await page.fill('dialog .pic-src >> nth=2 >> .ps-val', 'Seurat')
        await page.click('dialog button[type=submit] >> nth=-1'); await page.wait_for_timeout(300)
        await page.click('.np-pic-new'); await page.wait_for_timeout(1000)
        print('   AIC:', searches[-1], '|', await page.get_attribute('.np-figure img', 'src'), '|', re.sub(r'\s+', ' ', await page.text_content('.np-figure figcaption')))
        # 4. print keeps the columns
        await page.emulate_media(media='print'); await page.set_viewport_size({'width': 720, 'height': 1000}); await page.wait_for_timeout(400)
        pr = await page.evaluate("""(() => { const g = getComputedStyle(document.querySelector('.np-grid')).gridTemplateColumns.split(' ').length; const r = (s) => document.querySelector(s).getBoundingClientRect();
          return { cols: g, bizFeuilSideBySide: Math.abs(r('.np-biz').top - r('.np-feuil').top) < 3 && r('.np-feuil').left > r('.np-biz').right, sidebarHidden: getComputedStyle(document.querySelector('.side')).display === 'none', mainOverflow: getComputedStyle(document.querySelector('.main')).overflow }; })()""")
        print('4. print:', pr)
        await page.screenshot(path=f'{OUT}/o4-print.png', full_page=True)
        pdf = await page.pdf(path=f'{OUT}/o4-print.pdf', format='A4'); print('   pdf bytes:', len(pdf))
        await page.emulate_media(media='screen'); await ctx.close()
        # 5. goal reminder: Monday 26 Oct, 08:55 → nothing; 09:05 → popup; snooze 1 h; +61 min → again; Got it → not again
        g = MockGoogle()  # a fresh account: the earlier part synced "reminder off" to the shared settings
        ctx = await b.new_context(viewport={'width': 1440, 'height': 900}, timezone_id='Europe/Berlin')
        await ctx.add_init_script(init('2026-10-26T07:55:00Z', "{goals: {'w:2026-10-26': [{id:'a', text:'Finish report', head:'work', budget:360}, {id:'b', text:'Run 3x', head:'fitness'}], 'm:2026-10': [{id:'c', text:'Old month goal', head:'personal'}]}}")); await setup(ctx)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8808/app.html'); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(4000)
        print('5. 08:55 popup:', bool(await page.query_selector('dialog .goal-notice')))
        await page.evaluate("globalThis.__off += 10*60000"); await page.evaluate("void window.__tempo.checkGoalNotice()"); await page.wait_for_timeout(800)
        await page.wait_for_selector('dialog .goal-notice')
        print('   09:05:', await page.text_content('dialog .goal-notice h2'), '|', await page.eval_on_selector_all('dialog .gn-head', 'xs => xs.map(x => x.innerText.replace(/\\s+/g, " "))'), '|', await page.eval_on_selector_all('dialog .gn-h', 'xs => xs.map(x => x.textContent)'))
        await page.screenshot(path=f'{OUT}/o5-notice.png')
        await page.fill('dialog .gn-h-in', '1'); await page.click('dialog .gn-snz'); await page.wait_for_timeout(300)
        await page.evaluate("void window.__tempo.checkGoalNotice()"); await page.wait_for_timeout(300)
        print('   snoozed, still hidden:', not await page.query_selector('dialog .goal-notice'))
        await page.evaluate("globalThis.__off += 61*60000"); await page.evaluate("void window.__tempo.checkGoalNotice()"); await page.wait_for_selector('dialog .goal-notice')
        print('   after 61 min: shown again')
        await page.click('dialog .gn-ok'); await page.wait_for_timeout(300); await page.evaluate("void window.__tempo.checkGoalNotice()"); await page.wait_for_timeout(300)
        print('   after Got it: hidden', not await page.query_selector('dialog .goal-notice'), '| recorded:', list((await page.evaluate("window.__tempo.app.state.settings.goalNoticeShown")).keys()))
        print('ERRORS:', errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate(); web.terminate()
