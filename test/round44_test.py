# Round 44: the −/+ time buttons change only their own field — From buttons only the start, To buttons only the end —
# in quick create, the event dialog and the task dialog (the end is pushed on only if the start would pass it).
import asyncio, sys, subprocess, time, re, json
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8839','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
INIT = """
const FIX = Date.parse('2026-10-25T08:30:00Z'); const _Date = Date; globalThis.__off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false, goalNotice: false}));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2099-01-01'));
}"""
ok = []
def check(label, cond, extra=''):
    ok.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + label, extra)
async def main():
    g = MockGoogle(); errs = []
    async with async_playwright() as p:
        b = await p.chromium.launch(); ctx = await b.new_context(viewport={'width': 1400, 'height': 900}, timezone_id='Europe/Berlin', compact_ui=True)
        await ctx.add_init_script(INIT); await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8839/app.html'); await page.wait_for_function('window.tempo'); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(2000)
        # quick create
        col = await page.eval_on_selector('.tg-col[data-day="2026-10-25"]', 'e => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top }; }')
        hh = await page.evaluate("window.__tempo.app.state.settings.hourHeight")
        await page.mouse.click(col['x'], col['y'] + 14 * hh + 2); await page.wait_for_selector('.popover .qc')
        v = lambda: asyncio.gather(page.input_value('.popover [name=qs]'), page.input_value('.popover [name=qe]'))
        a0 = await v()
        await page.click('.popover .st-add[data-add="-10"]'); a1 = await v()
        await page.click('.popover .st-add[data-add="5"]'); a2 = await v()
        await page.click('.popover .dur-add[data-add="15"]'); a3 = await v()
        check('1. quick create: From ± moves only the start; To ± only the end', a1[1] == a0[1] and a1[0] != a0[0] and a2[1] == a0[1] and a3[0] == a2[0] and a3[1] != a2[1], (a0, a1, a2, a3))
        for _ in range(3): await page.click('.popover .st-add[data-add="60"]')
        a4 = await v()
        check('2. moving the start past the end pushes the end just after it', a4[1] > a4[0], a4)
        await page.click('.popover .qc-cancel')
        # event dialog
        await page.click('#btn-new-event'); await page.wait_for_selector('dialog[open] [name=sTime]')
        e = lambda: asyncio.gather(page.input_value('dialog[open] [name=sTime]'), page.input_value('dialog[open] [name=eTime]'))
        e0 = await e()
        await page.click('dialog[open] .st-add[data-add="-30"]'); e1 = await e()
        await page.click('dialog[open] .st-add[data-add="15"]'); e2 = await e()
        await page.click('dialog[open] .dur-add[data-add="30"]'); e3 = await e()
        check('3. event dialog: From ± moves only the start; To ± only the end', e1[1] == e0[1] and e1[0] != e0[0] and e2[1] == e0[1] and e3[0] == e2[0] and e3[1] != e2[1], (e0, e1, e2, e3))
        await page.click('dialog[open] [data-close] >> nth=-1'); await page.wait_for_timeout(300)
        # task dialog
        await page.click('#btn-new-task'); await page.wait_for_selector('dialog[open] .task-form')
        t = lambda: asyncio.gather(page.input_value('dialog[open] [name=earliest]'), page.input_value('dialog[open] [name=deadline]'))
        t0 = await t()
        await page.click('dialog[open] .es-add[data-add="60"]'); t1 = await t()
        await page.click('dialog[open] .es-add[data-add="1440"]'); t2 = await t()
        await page.click('dialog[open] .dl-add[data-add="-60"]'); t3 = await t()
        check('4. task dialog: From ± moves only "don\'t start before"; To ± only the deadline', t1[1] == t0[1] and t1[0] and t2[1] == t0[1] and t3[0] == t2[0] and t3[1] != t2[1], (t0, t1, t2, t3))
        check('no page errors', not errs, errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
print('ALL PASS' if all(ok) else f'{ok.count(False)} FAILED')
