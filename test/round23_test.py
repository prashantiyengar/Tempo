# Goals: "+" per head, add popup, repeating goals; compact category picker in forms; categories in the newspaper.
import asyncio, sys, subprocess, time, re, json
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8812','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
INIT = """
const FIX = Date.parse('2026-10-22T13:00:00Z'); const _Date = Date; globalThis.__off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false, goalNotice: false, horoscopeSource: 'off', reviewAllEvents: true,
    categories: [{id:'work',name:'Work',color:'#039be5',icon:'💼'},{id:'meet',name:'Meetings',color:'#7986cb',parent:'work'},{id:'personal',name:'Personal',color:'#33b679',icon:'🏠'},{id:'sport',name:'Sport',color:'#e67c73',icon:'🏃'}]}));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2099-01-01'));
}"""
def ev(id_, t, d, a, b, cat=None):
    e = {'id': id_, 'summary': t, 'status': 'confirmed', 'start': {'dateTime': f'2026-10-{d}T{a}:00:00+02:00'}, 'end': {'dateTime': f'2026-10-{d}T{b}:00:00+02:00'}}
    if cat: e['extendedProperties'] = {'private': {'tempoCategory': cat}}
    return e
async def main():
    g = MockGoogle(); errs = []
    E = g.events['me@example.com']
    for e in [ev('a', 'Client work', '20', '09', '13', 'work'), ev('b', 'Standup', '21', '09', '10', 'meet'), ev('c', 'Climbing', '21', '18', '20', 'sport'), ev('d', 'Dinner with Ana', '23', '19', '21', 'personal'), ev('e', 'Dentist', '22', '08', '09')]:
        E[e['id']] = e
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1440, 'height': 900}, timezone_id='Europe/Berlin')
        await ctx.add_init_script(INIT)
        await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        await ctx.route(re.compile(r'https://(commons\.wikimedia\.org|icanhazdadjoke\.com|upload\.wikimedia\.org)/.*'), lambda r: r.fulfill(status=503, body=''))
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8812/app.html'); await page.wait_for_selector('.tg-col'); await page.wait_for_function('window.tempo'); await page.wait_for_timeout(1500)
        # 1. goals
        await page.click('#view-seg button[data-view=goals]'); await page.wait_for_selector('.g-card')
        print('1. inputs on page:', len(await page.query_selector_all('.g-card input[name=t]')), '| + buttons:', len(await page.query_selector_all('.g-plus')))
        nov = '.g-card:has(h3:text("November"))'
        await page.click(nov + ' .g-plus[data-head=personal]'); await page.wait_for_selector('dialog .g-addform')
        await page.screenshot(path=f'{OUT}/m1-add.png')
        await page.fill('dialog [name=t]', 'Call friends'); await page.fill('dialog [name=b]', '2'); await page.check('dialog [name=rep]'); await page.click('dialog .g-addform button.primary'); await page.wait_for_timeout(500)
        texts = lambda card: page.eval_on_selector_all(card + ' .g-text', 'xs => xs.map(x => x.textContent.trim())')
        print('   repeat monthly → Nov:', await texts(nov), '| Dec:', await texts('.g-card:has(h3:text("December"))'), '| Jan:', await texts('.g-card:has(h3:text("January 2027"))'))
        await page.click('.g-mtoggle [data-m="12"]'); await page.wait_for_timeout(500)
        print('   12 months: copies in', len(await page.query_selector_all('.g-row:has-text("Call friends")')), 'months')
        await page.click('.g-mtoggle [data-m="3"]'); await page.wait_for_timeout(300)
        # remove only December's
        await page.click('.g-card:has(h3:text("December")) .g-row:has-text("Call friends") .g-del'); await page.click('dialog .choice-btn:has-text("Only this month")'); await page.wait_for_timeout(400)
        print('   only December removed:', await texts('.g-card:has(h3:text("December"))'), '| Jan still:', await texts('.g-card:has(h3:text("January 2027"))'))
        await page.click('.g-mtoggle [data-m="12"]'); await page.wait_for_timeout(300)
        await page.click('.g-card:has(h3:text("January 2027")) .g-row:has-text("Call friends") .g-del'); await page.click('dialog .choice-btn:has-text("Stop repeating")'); await page.wait_for_timeout(400)
        print('   stop from January: copies left', await page.eval_on_selector_all('.g-row:has-text("Call friends")', 'rs => rs.map(r => r.closest(".g-card").querySelector("h3").textContent)'), '| repeats:', await page.evaluate('(window.__tempo.app.state.settings.goalRepeats || []).length'))
        await page.click('.g-mtoggle [data-m="3"]'); await page.wait_for_timeout(300)
        # weekly repeat from this week
        await page.click('.g-card:first-child .g-plus[data-head=fitness]'); await page.fill('dialog [name=t]', 'Run 3×'); await page.click('dialog .g-addbox .g-catbox'); await page.click('dialog .g-pick .cat-chip[data-cat=sport]'); await page.click('dialog .g-pick ~ .actions button.primary')
        await page.check('dialog [name=rep]'); await page.click('dialog .g-addform button.primary'); await page.wait_for_timeout(500)
        print('   weekly repeat: this week', await texts('.g-card:first-child .g-head[data-head=fitness]'), '| next week', await texts('.g-card >> nth=1 >> .g-head[data-head=fitness]'), '| cats', await page.evaluate("Object.entries(window.__tempo.app.state.settings.goals).filter(([k]) => k.startsWith('w:')).map(([k, l]) => [k, l.map(g => g.cats)])"))
        await page.screenshot(path=f'{OUT}/m2-goals.png', full_page=True)
        # 2. compact picker in forms
        await page.click('#view-seg button[data-view=week]'); await page.wait_for_selector('.tg-col')
        cols = await page.query_selector_all('.tg-col'); box = await cols[4].bounding_box(); hh = await page.evaluate('window.__tempo.app.state.settings.hourHeight')
        top = await page.evaluate("document.querySelector('.tg-col').getBoundingClientRect().top")
        await page.evaluate("document.querySelector('.tg-scroll').scrollTop = 10 * window.__tempo.app.state.settings.hourHeight - 100"); await page.wait_for_timeout(200)
        top = await page.evaluate("document.querySelector('.tg-col').getBoundingClientRect().top")
        await page.mouse.move(box['x'] + 20, top + 10 * hh + 2); await page.mouse.down(); await page.mouse.move(box['x'] + 20, top + 11 * hh - 2, steps=4); await page.mouse.up(); await page.wait_for_selector('.popover .qc')
        print('2. quick create chips visible:', len(await page.query_selector_all('.popover .cat-chip')), '| box:', await page.text_content('.popover .cat-cur'))
        await page.click('.popover .cat-cur'); await page.wait_for_selector('dialog .cat-pop')
        print('   popup chips:', await page.eval_on_selector_all('dialog .cat-pop .cat-chip:not(.add)', 'xs => xs.map(x => x.textContent.replace("↳", "↳ ").trim())'))
        await page.click('dialog .cat-pop .cat-chip:has-text("Meetings")'); await page.wait_for_timeout(200)
        print('   chosen:', await page.text_content('.popover .cat-cur'))
        await page.fill('.popover [name=title]', 'Sprint review'); await page.click('.popover button[type=submit]'); await page.wait_for_timeout(1200)
        sr = [e for e in E.values() if e.get('summary') == 'Sprint review']
        print('   saved with category:', sr and sr[0]['extendedProperties']['private'].get('tempoCategory'))
        await page.click('#btn-new-event'); await page.wait_for_selector('dialog .ev-cat-host .cat-cur'); print('   event dialog box:', await page.text_content('dialog .ev-cat-host .cat-cur')); await page.keyboard.press('Escape'); await page.wait_for_timeout(300)
        await page.click('#btn-new-task'); await page.wait_for_selector('dialog .cat-host .cat-cur'); print('   task dialog box:', await page.text_content('dialog .cat-host .cat-cur')); await page.keyboard.press('Escape'); await page.wait_for_timeout(300)
        # 3. categories in the newspaper
        await page.click('#view-seg button[data-view=review]'); await page.wait_for_selector('.np-title'); await page.wait_for_timeout(800)
        before = await page.eval_on_selector_all('.np-bar span', 'xs => xs.map(x => x.textContent)')
        await page.click('.np-cats'); await page.uncheck('dialog input[value=work]'); await page.uncheck('dialog input[value=__none]'); await page.click('dialog button.primary'); await page.wait_for_timeout(1200)
        print('3. chart before:', before, '| after:', await page.eval_on_selector_all('.np-bar span', 'xs => xs.map(x => x.textContent)'))
        print('   Termine:', await page.eval_on_selector_all('.np-termine li', 'xs => xs.map(x => x.innerText)'), '| button:', await page.text_content('.np-cats'))
        await page.click('#btn-settings'); await page.click('dialog .tabs button[data-tab="7"]')
        print('   settings unticked:', await page.eval_on_selector_all('dialog .paper-cats .pc:not(:checked)', 'xs => xs.map(x => x.value)'))
        await page.check('dialog .paper-cats .pc[value=work]'); await page.click('dialog button[type=submit] >> nth=-1'); await page.wait_for_timeout(1000)
        print('   Work back:', any('Work' in x for x in await page.eval_on_selector_all('.np-bar span', 'xs => xs.map(x => x.textContent)')))
        await page.screenshot(path=f'{OUT}/m3-paper.png')
        print('ERRORS:', errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
