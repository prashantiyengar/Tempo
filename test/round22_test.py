# Sub-categories, saved weather for past days, goal category box + popup, events across the newspaper.
import asyncio, sys, subprocess, time, re, json, datetime
from urllib.parse import urlparse, parse_qs
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8811','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
INIT = """
const FIX = Date.parse('2026-10-22T13:00:00Z'); const _Date = Date; globalThis.__off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false, goalNotice: false, horoscopeSource: 'off', reviewAllEvents: true,
    weather: {on: true, name: 'Berlin, Germany', lat: 52.52, lon: 13.4, unit: 'C'},
    categories: [{id:'work',name:'Work',color:'#039be5',icon:'💼', prefer: 'morning'},{id:'personal',name:'Personal',color:'#33b679',icon:'🏠'},{id:'sport',name:'Sport',color:'#e67c73',icon:'🏃'}]}));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2099-01-01'));
}"""
def wx():
    d0 = datetime.date(2026, 10, 22) - datetime.timedelta(31)
    n = 47
    return {'daily': {'time': [(d0 + datetime.timedelta(i)).isoformat() for i in range(n)], 'weather_code': [61 if i % 3 == 0 else 2 for i in range(n)], 'temperature_2m_max': [10 + i % 7 for i in range(n)], 'temperature_2m_min': [3] * n, 'precipitation_probability_max': [40] * n, 'precipitation_sum': [2.4 if i % 3 == 0 else 0 for i in range(n)]}}
async def main():
    g = MockGoogle(); errs = []; wxq = []
    E = g.events['me@example.com']
    evs = [('20', '09', '10', 'Standup notes'), ('20', '14', '16', 'Board meeting'), ('21', '10', '11', 'Dentist'), ('21', '18', '19', 'Choir'), ('22', '09', '12', 'Client work'), ('23', '15', '16', 'Call mum'), ('24', '11', '13', 'Brunch')]
    for i, (d, a, b2, t) in enumerate(evs):
        E[f'e{i}'] = {'id': f'e{i}', 'summary': t, 'status': 'confirmed', 'start': {'dateTime': f'2026-10-{d}T{a}:00:00+02:00'}, 'end': {'dateTime': f'2026-10-{d}T{b2}:00:00+02:00'}}
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1440, 'height': 900}, timezone_id='Europe/Berlin')
        await ctx.add_init_script(INIT)
        await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        cors = {'Access-Control-Allow-Origin': '*'}
        async def meteo(route): wxq.append(route.request.url); await route.fulfill(json=wx(), headers=cors)
        await ctx.route(re.compile(r'https://api\.open-meteo\.com/.*'), meteo)
        await ctx.route(re.compile(r'https://(commons\.wikimedia\.org|icanhazdadjoke\.com|upload\.wikimedia\.org)/.*'), lambda r: r.fulfill(status=503, body=''))
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8811/app.html'); await page.wait_for_selector('.tg-col'); await page.wait_for_function('window.tempo'); await page.wait_for_timeout(2000)
        # 1. sub-category, created from an event's category picker
        await page.click('.ev:has-text("Board meeting")'); await page.click('.popover .pop-evcat'); await page.wait_for_selector('dialog .cat-chips')
        await page.click('dialog .cat-chip.add'); await page.fill('dialog .cat-name', 'Meetings'); await page.select_option('dialog .cat-parent', 'work'); await page.click('dialog .cat-save'); await page.wait_for_timeout(1200)
        cats = await page.evaluate("window.__tempo.app.state.settings.categories.map(c => [c.name, c.parent || ''])")
        print('1. categories:', cats)
        await page.click('.ev:has-text("Client work")'); await page.click('.popover .pop-evcat'); await page.wait_for_selector('dialog .cat-chips')
        print('   picker order:', await page.eval_on_selector_all('dialog .cat-chip:not(.add):not(.none)', 'xs => xs.map(x => (x.classList.contains("sub") ? "  ↳" : "") + x.textContent.replace("↳", "").trim())'))
        await page.click('dialog .cat-chip:has-text("Work"):not(.sub)'); await page.wait_for_timeout(1200)
        # settings rows
        await page.click('#btn-settings'); await page.click('dialog .tabs button[data-tab="5"]')
        print('   settings rows:', await page.eval_on_selector_all('dialog .cat-row', 'rs => rs.map(r => (r.classList.contains("sub") ? "  " : "") + r.querySelector(".cat-nm").value + " [" + r.querySelector(".cat-par").selectedOptions[0].text + "]")'))
        await page.keyboard.press('Escape'); await page.wait_for_timeout(300)
        # analysis: sub shown as "Work › Meetings"; main categories roll up
        await page.click('#view-seg button[data-view=analysis]'); await page.wait_for_selector('[data-o=by]')
        await page.select_option('[data-o=period]', 'week'); await page.wait_for_timeout(500)
        print('   analysis by category:', await page.eval_on_selector_all('.an-table tbody tr', 'rs => rs.map(r => r.innerText.replace(/\\s+/g, " ").split(" item")[0].slice(0, 40))'))
        await page.select_option('[data-o=by]', 'maincat'); await page.wait_for_timeout(500)
        print('   main categories:', await page.eval_on_selector_all('.an-table tbody tr', 'rs => rs.map(r => r.innerText.replace(/\\s+/g, " ").slice(0, 34))'))
        await page.select_option('[data-o=by]', 'category')
        # goals: Work counts Work → Meetings counted too
        await page.click('#view-seg button[data-view=goals]'); await page.wait_for_selector('.g-card')
        print('   work head time:', await page.text_content('.g-card:first-child .g-head[data-head=work] .g-time'))
        # 3. goal category box + popup (add form, then a row)
        f = '.g-card:first-child .g-add[data-head=fitness]'
        await page.click(f + ' .g-catbox'); await page.wait_for_selector('dialog .g-pick')
        await page.screenshot(path=f'{OUT}/k1-pick.png')
        await page.click('dialog .g-pick .cat-chip:has-text("Sport")'); await page.click('dialog button.primary'); await page.wait_for_timeout(200)
        print('3. add-form box:', await page.inner_text(f + ' .g-catbox'))
        await page.fill(f + ' input[name=t]', 'Run twice'); await page.press(f + ' input[name=t]', 'Enter'); await page.wait_for_timeout(400)
        print('   saved cats:', await page.evaluate("Object.values(window.__tempo.app.state.settings.goals).flat().map(g => [g.text, g.cats])"))
        await page.fill('.g-card:first-child .g-add[data-head=work] input[name=t]', 'Prepare board deck'); await page.press('.g-card:first-child .g-add[data-head=work] input[name=t]', 'Enter'); await page.wait_for_timeout(400)
        row = '.g-card:first-child .g-head[data-head=work] .g-row'
        await page.click(row + ' .g-catbox'); await page.wait_for_selector('dialog .g-pick'); await page.click('dialog .g-pick .cat-chip:has-text("Meetings")'); await page.click('dialog button.primary'); await page.wait_for_timeout(400)
        print('   row box:', await page.inner_text(row + ' .g-catbox'), '|', await page.get_attribute(row + ' .g-catbox', 'title'), '|', re.sub(r'\s+', ' ', await page.inner_text(row + ' .g-text')))
        await page.click(row + ' .g-catbox'); await page.click('dialog .g-pick-clear'); await page.wait_for_timeout(300)
        print('   back to head\'s:', await page.evaluate("Object.values(window.__tempo.app.state.settings.goals).flat().find(g => g.text === 'Prepare board deck').cats"))
        await page.screenshot(path=f'{OUT}/k2-goals.png')
        # 2. weather for past days
        await page.click('#view-seg button[data-view=week]'); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(800)
        print('2. request past_days:', 'past_days=31' in (wxq[-1] if wxq else ''), '| this week:', await page.eval_on_selector_all('.tg-dayhead', 'hs => hs.map(h => (h.querySelector(".wx")?.className.includes("past") ? "past " : "") + (h.querySelector(".wx")?.innerText.replace(/\\s+/g, " ") || "-"))'))
        await page.click('#btn-prev'); await page.wait_for_timeout(600)
        print('   last week:', await page.eval_on_selector_all('.tg-dayhead .wx', 'xs => xs.length'), 'days with weather | tip:', await page.get_attribute('.tg-dayhead .wx', 'title'))
        await page.click('#view-seg button[data-view=month]'); await page.wait_for_timeout(600)
        print('   month cells with weather:', len(await page.query_selector_all('.m-cell .wx-m')), '| past:', len(await page.query_selector_all('.m-cell .wx-m.past')))
        await page.click('#btn-today')
        # 4. events across the paper
        await page.click('#view-seg button[data-view=review]'); await page.wait_for_selector('.np-termine'); await page.wait_for_timeout(800)
        w = await page.evaluate("(() => { const t = document.querySelector('.np-termine').getBoundingClientRect(), g = document.querySelector('.np-grid').getBoundingClientRect(); return { full: Math.abs(t.width - g.width) < 3, cols: getComputedStyle(document.querySelector('.np-termine .np-days')).columnCount, days: document.querySelectorAll('.np-termine .np-dayh').length, inFeuil: !!document.querySelector('.np-feuil .np-days') }; })()")
        print('4. Termine:', w)
        await page.screenshot(path=f'{OUT}/k3-paper.png', full_page=True)
        await page.wait_for_timeout(2500)
        sh = [e for e in E.values() if (e.get('extendedProperties') or {}).get('private', {}).get('tempoSettings')]
        print('   parent synced:', bool(sh) and '"parent":"work"' in ''.join(v for k, v in sorted(sh[0]['extendedProperties']['private'].items()) if k.startswith('s_')))
        print('ERRORS:', errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
