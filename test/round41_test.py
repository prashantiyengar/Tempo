# Round 41: leisure earns much less life XP; notes (sidebar tab, newest first, a post-it under the date); day
# ratings 0–5 with smileys and a reason; "until now" stretches the latest item that ended in the last 4 hours.
import asyncio, sys, subprocess, time, re, json
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8836','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
NOTES = [{'id': 'n0', 'text': 'Old thought from Thursday', 'at': 1792663200000}]  # 2026-10-22 12:00 Berlin
INIT = """
const FIX = Date.parse('2026-10-24T13:00:00Z'); const _Date = Date; globalThis.__off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false, goalNotice: false, notes: NOTES, game: {on: true, started: '2026-10-20', active: ['2026-10-24']}}));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2099-01-01'));
}""".replace('NOTES', json.dumps(NOTES))
ok = []
def check(label, cond, extra=''):
    ok.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + label, extra)

async def main():
    g = MockGoogle(); errs = []
    E = g.events['me@example.com']
    E['hc'] = {'id': 'hc', 'summary': 'House cleaning', 'status': 'confirmed', 'start': {'dateTime': '2026-10-24T12:00:00+02:00'}, 'end': {'dateTime': '2026-10-24T13:34:00+02:00'}}
    E['early'] = {'id': 'early', 'summary': 'Breakfast', 'status': 'confirmed', 'start': {'dateTime': '2026-10-24T08:00:00+02:00'}, 'end': {'dateTime': '2026-10-24T09:00:00+02:00'}}
    async with async_playwright() as p:
        b = await p.chromium.launch(); ctx = await b.new_context(viewport={'width': 1400, 'height': 900}, timezone_id='Europe/Berlin', compact_ui=True)
        await ctx.add_init_script(INIT); await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8836/app.html'); await page.wait_for_function('window.tempo'); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(2500)
        # 1. leisure
        lx = await page.evaluate("""(async () => { const GM = await import('./js/game.js'); const s = { ...window.__tempo.app.state.settings, game: { ...window.__tempo.app.state.settings.game, restCats: ['leisure'], lifeCats: ['study'] } };
          const it = (cat) => ({ kind: 'event', title: 'x', catId: cat, start: Date.parse('2026-10-23T16:00:00Z'), end: Date.parse('2026-10-23T18:00:00Z') });
          return [GM.cfg(s).leisurePerHour, GM.itemXP(it('leisure'), s).life, GM.itemXP(it('study'), s).life]; })()""")
        check('1. leisure earns much less life XP (1.5 an hour; 2 h = 3, vs 60 for life growth)', lx[0] == 1.5 and lx[1] == 3 and lx[2] == 60, lx)
        # 2. notes
        await page.click('.side-tabs [data-st=notes]'); await page.wait_for_selector('#note-list .note-add')
        await page.fill('#note-list textarea', 'Idea A'); await page.click('#note-list .note-add button[type=submit]'); await page.wait_for_timeout(400)
        await page.evaluate("globalThis.__off += 60000")
        await page.fill('#note-list textarea', 'Idea B'); await page.click('#note-list .note-add button[type=submit]'); await page.wait_for_timeout(400)
        order = await page.eval_on_selector_all('#note-list .note-t', 'xs => xs.map(x => x.textContent)')
        check('2. the Notes tab lists notes newest first', order == ['Idea B', 'Idea A', 'Old thought from Thursday'], order)
        tab = await page.text_content('.side-tabs [data-st=notes]')
        pit = await page.evaluate("[...document.querySelectorAll('.tg-dayhead .dm-note')].map(b => b.closest('[data-day]').dataset.day + ':' + b.textContent)")
        check('3. a post-it under the date on days with notes (with the count)', '2026-10-24:🗒2' in pit and '2026-10-22:🗒' in pit and '3' in tab, (pit, tab))
        await page.screenshot(path=f'{OUT}/r41-notes.png')
        await page.click('.tg-dayhead[data-day="2026-10-22"] .dm-note'); await page.wait_for_selector('dialog[open] .day-notes')
        dn = await page.eval_on_selector_all('dialog[open] .dn-list .note-t', 'xs => xs.map(x => x.textContent)')
        await page.fill('dialog[open] .note-add textarea', 'Added later'); await page.click('dialog[open] .note-add button[type=submit]'); await page.wait_for_timeout(500)
        dn2 = await page.eval_on_selector_all('dialog[open] .dn-list .note-t', 'xs => xs.map(x => x.textContent)')
        await page.keyboard.press('Escape'); await page.wait_for_timeout(300)
        saved = await page.evaluate("window.__tempo.app.state.settings.notes.find(n => n.text === 'Added later')")
        check('4. clicking the post-it shows that day\'s notes and adds to that day', dn == ['Old thought from Thursday'] and dn2 == ['Old thought from Thursday', 'Added later'] and saved and saved['at'] == 1792663200000, (dn, dn2, saved))
        # 3. ratings
        faint = await page.evaluate("[...document.querySelectorAll('.tg-dayhead .dm-rate')].map(b => b.closest('[data-day]').dataset.day)")
        check('5. past days and today can be rated; future days can\'t', '2026-10-23' in faint and '2026-10-24' in faint and '2026-10-25' not in faint, faint)
        await page.click('.tg-dayhead[data-day="2026-10-23"] .dm-rate'); await page.wait_for_selector('.popover .rate-pop')
        n = await page.eval_on_selector_all('.popover .rate-b', 'xs => xs.map(x => x.textContent)')
        await page.click('.popover .rate-b[data-v="4"]'); await page.fill('.popover .rate-why', 'good run'); await page.click('.popover .rate-pop button.primary'); await page.wait_for_timeout(500)
        r = await page.evaluate("window.__tempo.app.state.settings.dayRatings['2026-10-23']")
        hd = await page.evaluate("(() => { const b = document.querySelector('.tg-dayhead[data-day=\"2026-10-23\"] .dm-rate'); return [b.textContent, b.title]; })()")
        check('6. six smileys 0–5; a rating and a reason are saved and shown under the date', len(n) == 6 and r['v'] == 4 and r['why'] == 'good run' and hd[0] == '🙂' and 'good run' in hd[1], (n, r, hd))
        await page.screenshot(path=f'{OUT}/r41-rating.png')
        # 4. until now
        btn = await page.evaluate("(() => { const b = document.querySelector('.tonow-btn'); return b && [b.closest('[data-day]').dataset.day, b.title]; })()")
        check('7. the latest item that ended in the last 4 hours gets an “until now” button', btn and btn[0] == '2026-10-24' and 'House cleaning' in btn[1], btn)
        await page.screenshot(path=f'{OUT}/r41-tonow.png')
        await page.click('.tonow-btn'); await page.wait_for_timeout(2000)
        end = E['hc']['end'].get('dateTime')
        check('8. clicking it makes the block end now (15:01)', end and end.startswith('2026-10-24T13:01:00') or end.startswith('2026-10-24T15:01:00+02:00'), end)
        gone = await page.evaluate("!document.querySelector('.tonow-btn')")
        check('9. no button while something is going on (the block now runs until now)', gone)
        ext = await page.evaluate("""(async () => { const S = await import('./js/scheduler.js');
          const t = { id: 't', title: 'T', totalMinutes: 120, planned: [], frozen: [{ id: 'c1', start: 0, end: 3600e3, status: 'done' }] };
          const t2 = S.extendSession(t, 'c1', 5400e3); return [t2.frozen[0].end, t2.frozen[0].status, t2.frozen[0].actualMin]; })()""")
        check('10. a task session stays done and counts the extra time', ext == [5400000, 'done', 90], ext)
        check('no page errors', not errs, errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
print('ALL PASS' if all(ok) else f'{ok.count(False)} FAILED')
