# Later notes with duration + deadline; goals under Work / Fitness / Personal with budgets, categories that count
# (shared by all periods), moving and carrying over unfinished goals; goal progress in the newspaper.
import asyncio, sys, subprocess, time, re, json
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8807','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
INIT = """
const FIX = Date.parse('2026-10-22T13:00:00Z'); const _Date = Date; globalThis.__off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false, goalNotice: false, horoscopeSource: 'off',
    categories: [{id:'work',name:'Work',color:'#039be5',icon:'💼'},{id:'personal',name:'Personal',color:'#33b679',icon:'🏠'},{id:'sport',name:'Sport',color:'#e67c73',icon:'🏃'},{id:'study',name:'Study',color:'#8e24aa',icon:'📚'}],
    goals: {'w:2026-10-12': [{id:'old1', text:'Call friends', done:false, head:'personal'}, {id:'old2', text:'Ship v2', done:true, head:'work'}]}}));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2026-10-19'));
}"""
def cat(c): return {'private': {'tempoCategory': c}}
async def main():
    g = MockGoogle(); errs = []
    E = g.events['me@example.com']
    E['w1'] = {'id': 'w1', 'summary': 'Client work', 'status': 'confirmed', 'extendedProperties': cat('work'), 'start': {'dateTime': '2026-10-20T09:00:00+02:00'}, 'end': {'dateTime': '2026-10-20T12:00:00+02:00'}}
    E['w2'] = {'id': 'w2', 'summary': 'Workshop', 'status': 'confirmed', 'extendedProperties': cat('work'), 'start': {'dateTime': '2026-10-23T09:00:00+02:00'}, 'end': {'dateTime': '2026-10-23T11:00:00+02:00'}}
    E['s1'] = {'id': 's1', 'summary': 'Gym', 'status': 'confirmed', 'extendedProperties': cat('sport'), 'start': {'dateTime': '2026-10-21T18:00:00+02:00'}, 'end': {'dateTime': '2026-10-21T19:30:00+02:00'}}
    E['s2'] = {'id': 's2', 'summary': 'Run', 'status': 'confirmed', 'extendedProperties': cat('sport'), 'start': {'dateTime': '2026-11-04T07:00:00+01:00'}, 'end': {'dateTime': '2026-11-04T08:00:00+01:00'}}
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1440, 'height': 900}, timezone_id='Europe/Berlin')
        await ctx.add_init_script(INIT)
        await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        await ctx.route(re.compile(r'https://(commons\.wikimedia\.org|icanhazdadjoke\.com|upload\.wikimedia\.org)/.*'), lambda r: r.fulfill(status=503, body=''))
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8807/app.html'); await page.wait_for_selector('.tg-col'); await page.wait_for_function('window.tempo'); await page.wait_for_timeout(1200)
        # 1. Later with duration + deadline
        await page.click('.side-tabs [data-st=later]')
        await page.fill('.later-add input[name=t]', 'Renew passport'); await page.fill('.later-add input[name=h]', '1.5'); await page.fill('.later-add input[name=d]', '2026-10-24')
        await page.click('.later-add button[type=submit]'); await page.wait_for_timeout(300)
        print('1. later row:', re.sub(r'\s+', ' ', await page.inner_text('.later-row .later-t')), '| soon:', bool(await page.query_selector('.later-due.soon')))
        await page.click('.later-row .l-task'); await page.wait_for_selector('dialog [name=hours]')
        print('   task dialog:', await page.input_value('dialog [name=title]'), '| hours', await page.input_value('dialog [name=hours]'), '| deadline', await page.input_value('dialog [name=deadline]'))
        await page.keyboard.press('Escape'); await page.wait_for_timeout(300)
        await page.click('.later-row .later-t'); await page.wait_for_selector('dialog [name=h]'); await page.fill('dialog [name=h]', '2'); await page.fill('dialog [name=d]', '2026-11-30'); await page.click('dialog button.primary'); await page.wait_for_timeout(300)
        print('   edited:', re.sub(r'\s+', ' ', await page.inner_text('.later-row .later-t')))
        await page.click('.side-tabs [data-st=tasks]')
        # 2. goals with heads
        await page.click('#view-seg button[data-view=goals]'); await page.wait_for_selector('.g-card')
        tw = '.g-card >> nth=0'
        print('2. heads:', await page.eval_on_selector_all('.g-card:first-child .g-hn', 'xs => xs.map(x => x.textContent)'))
        print('   carry-over:', re.sub(r'\s+', ' ', await page.inner_text('.g-card:first-child .g-left')))
        await page.click('.g-card:first-child .g-carry'); await page.wait_for_timeout(300)
        async def addg(card, head, text, h=''):
            sel = f'{card} >> .g-add[data-head={head}]'
            await page.fill(f'{sel} >> input[name=t]', text); await page.fill(f'{sel} >> input[name=b]', h); await page.press(f'{sel} >> input[name=t]', 'Enter'); await page.wait_for_timeout(250)
        await addg(tw, 'work', 'Finish report', '6'); await addg(tw, 'work', 'Inbox zero')
        await addg(tw, 'fitness', 'Exercise 3 times', '4')
        print('   this week work:', re.sub(r'\s+', ' ', await page.inner_text('.g-card:first-child .g-head[data-head=work] .g-hh')))
        print('   fitness before mapping:', re.sub(r'\s+', ' ', await page.inner_text('.g-card:first-child .g-head[data-head=fitness] .g-hh')))
        # map Sport → Fitness once; it applies to every section
        await page.click('.g-card:first-child .g-head[data-head=fitness] .g-cats'); await page.check('dialog input[value=sport]'); await page.click('dialog button.primary'); await page.wait_for_timeout(500)
        print('   fitness this week:', re.sub(r'\s+', ' ', await page.inner_text('.g-card:first-child .g-head[data-head=fitness] .g-hh')), '| bar:', await page.eval_on_selector('.g-card:first-child .g-head[data-head=fitness] .g-bar i.d', 'i => i.style.width'))
        print('   fitness in November:', re.sub(r'\s+', ' ', await page.inner_text('.g-card:has(h3:text("November")) .g-head[data-head=fitness] .g-hh')))
        print('   fitness in year:', re.sub(r'\s+', ' ', await page.inner_text('.g-year .g-head[data-head=fitness] .g-hh')))
        # tick + move to next week
        await page.check('.g-card:first-child .g-head[data-head=work] .g-row >> nth=0 >> .g-done'); await page.wait_for_timeout(250)
        await page.click('.g-card:first-child .g-head[data-head=work] .g-row >> nth=1 >> .g-mv'); await page.click('dialog .choice-btn:has-text("Next week")'); await page.wait_for_timeout(400)
        print('   moved → next week:', await page.eval_on_selector_all('.g-card >> nth=1 >> .g-text', 'xs => xs.map(x => x.textContent.trim())'))
        # edit: own categories + head change
        await page.click('.g-card:first-child .g-head[data-head=personal] .g-text'); await page.wait_for_selector('dialog [name=h]')
        await page.select_option('dialog [name=h]', 'personal'); await page.fill('dialog [name=b]', '2'); await page.click('dialog details summary'); await page.check('dialog input[name=c][value=personal]'); await page.click('dialog button.primary'); await page.wait_for_timeout(300)
        print('   personal goal:', re.sub(r'\s+', ' ', await page.inner_text('.g-card:first-child .g-head[data-head=personal] .g-row')))
        await page.screenshot(path=f'{OUT}/h1-goals.png', full_page=True)
        # 3. newspaper progress
        await page.click('#view-seg button[data-view=review]'); await page.wait_for_selector('.np-goals'); await page.wait_for_timeout(1500)
        print('3. paper:', await page.text_content('.np-goals .np-h3'), '| blocks:', await page.eval_on_selector_all('.np-goals .np-h4', 'xs => xs.map(x => x.textContent)'))
        print('   heads:', await page.eval_on_selector_all('.np-goals .np-ghh', 'xs => xs.map(x => x.innerText.replace(/\\s+/g, " "))'))
        await page.screenshot(path=f'{OUT}/h2-paper.png', full_page=True)
        await page.select_option('[data-np=period]', 'month'); await page.wait_for_timeout(1500)
        print('   month edition blocks:', await page.eval_on_selector_all('.np-goals .np-h4', 'xs => xs.map(x => x.textContent)'))
        print('ERRORS:', errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
