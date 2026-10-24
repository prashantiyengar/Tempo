# Round 32: habits and goals kept by the time something starts by / ends before (e.g. sleep ends before 07:00).
import asyncio, sys, subprocess, time, re, json
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8826','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
INIT = """
const FIX = Date.parse('2026-10-24T11:30:00Z'); const _Date = Date; globalThis.__off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false, goalNotice: false}));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2099-01-01'));
}"""
ok = []
def check(label, cond, extra=''):
    ok.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + label, extra)
def ev(i, title, d0, h0, d1, h1, cat=None):
    e = {'id': i, 'summary': title, 'status': 'confirmed', 'start': {'dateTime': f'{d0}T{h0}:00+02:00'}, 'end': {'dateTime': f'{d1}T{h1}:00+02:00'}}
    if cat: e['extendedProperties'] = {'private': {'tempoCategory': cat}}
    return e

async def main():
    g = MockGoogle(); errs = []
    E = g.events['me@example.com']
    # sleep: Tue ends 06:40 ✓, Wed 07:30 ✗, Thu split 23–02 + 03–06:50 ✓, Fri 06:55 ✓, Sat 08:00 ✗
    E['s1'] = ev('s1', '😴 Sleep', '2026-10-19', '23:00', '2026-10-20', '06:40')
    E['s2'] = ev('s2', '😴 Sleep', '2026-10-20', '23:30', '2026-10-21', '07:30')
    E['s3a'] = ev('s3a', '😴 Sleep', '2026-10-21', '23:00', '2026-10-22', '02:00'); E['s3b'] = ev('s3b', '😴 Sleep', '2026-10-22', '03:00', '2026-10-22', '06:50')
    E['s4'] = ev('s4', '😴 Sleep', '2026-10-22', '23:00', '2026-10-23', '06:55')
    E['s5'] = ev('s5', '😴 Sleep', '2026-10-23', '23:59', '2026-10-24', '08:00')
    # work starting by 09:00: Mon 08:30 ✓, Tue 09:30 ✗, Wed 08:55 ✓
    E['w1'] = ev('w1', 'Desk work', '2026-10-19', '08:30', '2026-10-19', '12:00', 'work')
    E['w2'] = ev('w2', 'Desk work', '2026-10-20', '09:30', '2026-10-20', '12:00', 'work')
    E['w3'] = ev('w3', 'Desk work', '2026-10-21', '08:55', '2026-10-21', '12:00', 'work')
    async with async_playwright() as p:
        b = await p.chromium.launch(); ctx = await b.new_context(viewport={'width': 1400, 'height': 900}, timezone_id='Europe/Berlin', compact_ui=True)
        await ctx.add_init_script(INIT); await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8826/app.html'); await page.wait_for_function('window.tempo'); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(1500)
        await page.click('#view-seg button[data-view=goals]'); await page.wait_for_timeout(1000)
        # habit: sleep ends before 07:00
        await page.click('.g-habits .hb-add'); await page.wait_for_selector('dialog[open] .habit-form')
        await page.fill('dialog[open] [name=name]', 'Up by 7')
        await page.click('dialog[open] details[data-sect=hb-adv] > summary')
        await page.select_option('dialog[open] [name=amode]', 'timing')
        await page.select_option('dialog[open] [name=twhich]', 'endBy'); await page.fill('dialog[open] [name=ttime]', '07:00'); await page.fill('dialog[open] [name=twords]', 'sleep'); await page.fill('dialog[open] [name=afrom]', '2026-10-18')
        await page.screenshot(path=f'{OUT}/r32-habit.png')
        await page.click('dialog[open] button[type=submit]'); await page.wait_for_timeout(2500)
        cells = await page.eval_on_selector_all('.g-habits .hb-row:has-text("Up by 7") .hb-c', 'cs => cs.map(c => c.textContent.trim())')
        # Sat 24, Fri 23, Thu 22, Wed 21, Tue 20, Mon 19, Sun 18
        check('1. habit "sleep ends before 07:00": Sat ✕ (08:00), Fri ✓, Thu ✓ (split sleep), Wed ✕ (07:30), Tue ✓', cells[:5] == ['✕', '✓', '✓', '✕', '✓'], cells)
        tip = await page.get_attribute('.g-habits .hb-row:has-text("Up by 7") .hb-c[data-k="2026-10-21"]', 'title')
        check('1b. tooltip explains', '07:30' in tip, tip)
        # goal: work starts by 09:00 on at least 2 days this week
        await page.click('.g-card:has-text("This week") .g-plus[data-head=work]'); await page.wait_for_selector('dialog[open] .g-addform')
        await page.fill('dialog[open] [name=t]', 'Start work by 9')
        await page.click('dialog[open] details[data-sect=g-rule] > summary')
        await page.select_option('dialog[open] [name=rkind]', 'timing')
        await page.select_option('dialog[open] [name=rwhich]', 'startBy'); await page.fill('dialog[open] [name=rtime]', '09:00'); await page.select_option('dialog[open] [name=rdays]', '2'); await page.check('dialog[open] input[name=rcat][value=work]')
        await page.screenshot(path=f'{OUT}/r32-goal.png')
        await page.click('dialog[open] button.primary'); await page.wait_for_timeout(1200)
        row = page.locator('.g-card:has-text("This week") .g-row:has-text("Start work by 9")')
        badge = await row.locator('.g-rule-b').text_content()
        check('2a. goal "work starts by 09:00 on 2 days" reached (Mon, Wed)', await row.locator('.g-done').is_checked() and '2/2' in badge, badge)
        await page.click('.g-card:has-text("This week") .g-plus[data-head=personal]'); await page.wait_for_selector('dialog[open] .g-addform')
        await page.fill('dialog[open] [name=t]', 'Sleep ends by 7 every day')
        await page.click('dialog[open] details[data-sect=g-rule] > summary')
        await page.select_option('dialog[open] [name=rkind]', 'timing'); await page.select_option('dialog[open] [name=rwhich]', 'endBy'); await page.fill('dialog[open] [name=rtime]', '07:00'); await page.fill('dialog[open] [name=rwords]', 'sleep')
        await page.click('dialog[open] button.primary'); await page.wait_for_timeout(1200)
        b2 = await page.locator('.g-card:has-text("This week") .g-row:has-text("Sleep ends by 7") .g-rule-b').get_attribute('class')
        check('2b. "every day" goal shows as missed (Wednesday 07:30)', 'bad' in b2, b2)
        await page.screenshot(path=f'{OUT}/r32-goals.png')
        check('no page errors', not errs, errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
print('ALL PASS' if all(ok) else f'{ok.count(False)} FAILED')
