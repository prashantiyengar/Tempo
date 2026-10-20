# Quick create: Save works with any minute; compact −/+ and Now; AI command interface (window.tempo + AI console).
import asyncio, sys, subprocess, time, re, json
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8780','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
INIT = """
const FIX = Date.parse('2026-10-20T07:12:00Z'); const _Date = Date; globalThis.__off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false}));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2026-10-19'));
}"""
async def main():
    g = MockGoogle(); errs = []
    g.events['me@example.com']['w1'] = {'id': 'w1', 'summary': 'Workshop', 'status': 'confirmed', 'start': {'dateTime': '2026-10-20T09:00:00+02:00'}, 'end': {'dateTime': '2026-10-20T10:00:00+02:00'}}
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1440, 'height': 900}, timezone_id='Europe/Berlin')
        await ctx.add_init_script(INIT)
        await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8780/app.html'); await page.wait_for_selector('.tg-col'); await page.wait_for_function('window.tempo'); await page.wait_for_timeout(1500)
        # 1/2. quick create: Now buttons, compact nudges, odd minute → Save works
        cols = await page.query_selector_all('.tg-col'); box = await cols[2].bounding_box(); hh = await page.evaluate('window.__tempo.app.state.settings.hourHeight')
        await page.mouse.move(box['x'] + 20, box['y'] + 15 * hh + 2); await page.mouse.down(); await page.mouse.move(box['x'] + 20, box['y'] + 16 * hh - 2, steps=5); await page.mouse.up()
        await page.wait_for_selector('.popover .qc')
        await page.fill('.popover input[name=title]', 'Odd minute'); await page.fill('.popover [name=qs]', '15:07'); await page.dispatch_event('.popover [name=qs]', 'change')
        await page.click('.popover .nudge .dur-add[data-add="-10"]')
        print('1. quick create:', await page.text_content('.popover .qc-when'), '| nudge groups:', await page.eval_on_selector_all('.popover .nudge', 'e => e.length'), '| Now buttons:', await page.eval_on_selector_all('.popover .now-btn', 'e => e.length'))
        await page.screenshot(path=f'{OUT}/a0-quick-create.png')
        await page.click('.popover button[type=submit]'); await page.wait_for_timeout(1500)
        e = [x for x in g.events['me@example.com'].values() if x.get('summary') == 'Odd minute']
        print('   saved with odd minute:', bool(e), e[0]['start']['dateTime'] if e else None)
        # 3. AI interface
        h = await page.evaluate("tempo.help().commands.map(c => c.cmd)")
        print('3. commands:', h)
        r = await page.evaluate("""tempo.run([
          { cmd: 'addTask', title: 'Thesis chapter', hours: 4, deadline: 'friday 17:00', rank: 1, category: 'Study' },
          { cmd: 'addTask', text: 'Exercise 2h per week for 4 weeks, Personal' },
          { cmd: 'addEvent', title: 'Dentist', start: 'tomorrow 14:00', minutes: 45 },
          { cmd: 'listSessions', task: 'Thesis chapter' }
        ], { label: 'AI plan' })""")
        print('   batch:', json.dumps([{k: (v if k != 'result' else (v if not isinstance(v, list) else v[:2])) for k, v in x.items()} for x in r])[:900])
        sid = r[3]['result'][0]['id']
        prev = await page.evaluate(f"tempo.run([{{ cmd: 'moveSession', session: '{sid}', start: 'today 16:00' }}], {{ dryRun: true }})")
        print('   dry run:', json.dumps(prev)[:400])
        mv = await page.evaluate(f"tempo.moveSession({{ session: '{sid}', start: 'today 16:00' }})"); print('   move:', mv)
        print('   free time:', (await page.evaluate("tempo.freeTime({ from: 'today', to: 'tomorrow', minMinutes: 60 })"))['result'][:3])
        print('   error example:', await page.evaluate("tempo.updateTask({ task: 'nope', rank: 2 })"))
        print('   now:', await page.evaluate("tempo.today()"))
        fe = await page.evaluate("tempo.finishEarly({ item: 'Workshop', then: 'keep free' })"); print('   finish early:', fe)
        print('   tasks:', [t['title'] for t in (await page.evaluate("tempo.listTasks()"))['result']], '| Google Dentist:', any(x.get('summary') == 'Dentist' for x in g.events['me@example.com'].values()))
        # undo the batch as one step (after undoing the finish-early and move first)
        for _ in range(3): await page.evaluate("tempo.undo()"); await page.wait_for_timeout(800)
        await page.wait_for_timeout(1500)
        print('   after undoing 3 steps:', [t['title'] for t in (await page.evaluate("tempo.listTasks()"))['result']], '| Google Dentist:', any(x.get('summary') == 'Dentist' for x in g.events['me@example.com'].values()))
        # AI console (?ai=1) for assistants that can only click and type
        await page.goto('http://localhost:8780/app.html?ai=1'); await page.wait_for_selector('#ai-input')
        await page.fill('#ai-input', json.dumps({'cmd': 'addTask', 'title': 'Taxes', 'hours': 2, 'deadline': '2026-10-30 12:00'}))
        await page.click('#ai-run'); await page.wait_for_function("document.querySelector('#ai-output').textContent.length > 10")
        print('4. console result:', (await page.text_content('#ai-output'))[:200].replace('\n', ' '))
        await page.screenshot(path=f'{OUT}/a1-ai-console.png')
        print('ERRORS:', errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
