# Round 54: tasks can be scheduled as one block instead of split into sessions; categories are shown as their
# tree (main categories with their sub-categories) in pickers, lists and Analysis; Later notes have a category.
import asyncio, sys, subprocess, time, re, json
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
OUT = sys.argv[1]
PORT = 8857
srv = subprocess.Popen(['python3','-m','http.server',str(PORT),'-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
CATS = [{'id': 'work', 'name': 'Work', 'color': '#039be5', 'icon': '💼'}, {'id': 'meet', 'name': 'Meetings', 'color': '#3f51b5', 'icon': '', 'parent': 'work'},
        {'id': 'mail', 'name': 'Email', 'color': '#7986cb', 'icon': '', 'parent': 'work'}, {'id': 'admin', 'name': 'Admin', 'color': '#616161', 'icon': ''},
        {'id': 'zen', 'name': 'Leisure', 'color': '#33b679', 'icon': '🌿'}]
INIT = """
const FIX = Date.parse('2026-10-28T08:00:00Z'); const _Date = Date; globalThis.__off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false, goalNotice: false, categories: CATS, later: [{id: 'l1', text: 'Plan offsite', created: 1792000000000, minutes: 90}]}));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2099-01-01'));
}""".replace('CATS', json.dumps(CATS))
ok = []
def check(label, cond, extra=''):
    ok.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + label, extra)
def ev(i, title, d, h0, h1, cat=None):
    e = {'id': i, 'summary': title, 'status': 'confirmed', 'start': {'dateTime': f'{d}T{h0}:00+01:00'}, 'end': {'dateTime': f'{d}T{h1}:00+01:00'}}
    if cat: e['extendedProperties'] = {'private': {'tempoCategory': cat}}
    return e
SESS = """(async () => { const S = await import('./js/scheduler.js'); const t = window.__tempo.app.state.tasks.find(t => t.title === TITLE);
  return t && { single: !!t.single, cat: t.categoryId || null, ss: S.sessions(t).filter(c => c.kind !== 'done').map(c => Math.round((c.end - c.start) / 60000)) }; })()"""

async def main():
    g = MockGoogle(); errs = []
    E = g.events['me@example.com']
    E['a'] = ev('a', 'Standup', '2026-10-29', '09:00', '11:00', 'meet'); E['b'] = ev('b', 'Inbox', '2026-10-29', '11:00', '12:00', 'mail')
    E['c'] = ev('c', 'Deep work', '2026-10-29', '13:00', '14:00', 'work'); E['d'] = ev('d', 'Walk', '2026-10-30', '09:00', '13:00', 'zen')
    async with async_playwright() as p:
        b = await p.chromium.launch(); ctx = await b.new_context(viewport={'width': 1400, 'height': 900}, timezone_id='Europe/Berlin')
        await ctx.add_init_script(INIT); await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(f'http://localhost:{PORT}/app.html'); await page.wait_for_function('window.tempo'); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(2500)
        # ---- 1. one block
        await page.click('#btn-new-task'); await page.wait_for_selector('dialog[open] .task-form')
        head = await page.evaluate("(() => { const f = document.querySelector('dialog[open] .task-form'); const seg = f.querySelector('.blockmode'); const title = f.querySelector('.title-input'); return seg && [seg.textContent.replace(/\\s+/g, ' ').trim(), !!(title.compareDocumentPosition(seg) & 4), f.querySelector('[name=blockmode]:checked').value]; })()")
        check('1. the task dialog offers “Split into sessions” or “One block” at the top (split by default)', head and 'Split into sessions' in head[0] and 'One block' in head[0] and head[1] and head[2] == 'split', head)
        await page.fill('dialog[open] [name=title]', 'Write report'); await page.fill('dialog[open] [name=hours]', '3')
        await page.click('dialog[open] .blockmode label:has-text("One block")'); await page.wait_for_timeout(400)
        calc = await page.text_content('dialog[open] .calc'); dis = await page.evaluate("document.querySelector('dialog[open] [name=chunk]').disabled")
        check('2. picking “One block” says so and turns off the session settings', 'One block of 3h' in calc and dis, (calc, dis))
        await page.screenshot(path=f'{OUT}/r54-oneblock.png')
        await page.click('dialog[open] .task-form button.primary'); await page.wait_for_timeout(2500)
        r = await page.evaluate(SESS.replace('TITLE', "'Write report'"))
        check('3. it is planned as a single 3-hour block', r and r['single'] and r['ss'] == [180], r)
        await page.click('#btn-new-task'); await page.wait_for_selector('dialog[open] .task-form')
        await page.fill('dialog[open] [name=title]', 'Split one'); await page.fill('dialog[open] [name=hours]', '3')
        await page.click('dialog[open] .task-form button.primary'); await page.wait_for_timeout(2500)
        r2 = await page.evaluate(SESS.replace('TITLE', "'Split one'"))
        check('4. the default still splits into sessions', r2 and not r2['single'] and len(r2['ss']) == 3, r2)
        u = await page.evaluate("""(async () => { const S = await import('./js/scheduler.js'); const s = window.__tempo.app.state.settings, now = Date.parse('2026-10-28T08:00:00Z');
          const base = { id: 'x', title: 'X', kind: 'generic', rank: 3, totalMinutes: 240, deadline: now + 7 * 864e5, single: true, frozen: [{ id: 'c0', start: now - 864e5, end: now - 864e5 + 3600e3, status: 'done' }], planned: [], created: now };
          const a = S.rescheduleAll([base], [], s, now).tasks[0];
          const rep = { ...base, id: 'y', frozen: [], totalMinutes: 0, repeat: { every: 'week', minutes: 150, count: 4 }, repeatStart: now };
          const b2 = S.rescheduleAll([rep], [], s, now).tasks[0];
          return [S.sessions(a).filter(c => c.kind !== 'done').map(c => (c.end - c.start) / 60000), S.sessions(b2).map(c => (c.end - c.start) / 60000).slice(0, 3)]; })()""")
        check('5. what is left of a one-block task stays one block (3 h after 1 h done); a repeating one gets one block each week', u[0] == [180] and u[1][:2] == [150, 150], u)
        # ---- 2. categories as a tree
        await page.click('#btn-new-task'); await page.wait_for_selector('dialog[open] .task-form')
        await page.click('dialog[open] .cat-host .cat-cur'); await page.wait_for_selector('dialog[open] .cat-pop .cat-chips')
        tree = await page.evaluate("""(() => { const box = [...document.querySelectorAll('dialog[open] .cat-pop .cat-chips')].pop();
          return { groups: [...box.querySelectorAll('.cat-tree')].map(g => [...g.querySelectorAll('.cat-chip')].map(c => c.textContent.trim())),
                   loose: [...box.children].filter(x => x.classList.contains('cat-chip') && !x.classList.contains('none') && !x.classList.contains('add')).map(c => c.textContent.trim()) }; })()""")
        check('6. the category picker shows the tree: Work with its sub-categories on one line, the others on their own', tree['groups'] == [['💼Work', '↳Email', '↳Meetings']] and tree['loose'] == ['Admin', '🌿Leisure'], tree)
        await page.screenshot(path=f'{OUT}/r54-tree.png')
        await page.keyboard.press('Escape'); await page.wait_for_timeout(200); await page.keyboard.press('Escape'); await page.wait_for_timeout(300)
        opts = await page.evaluate("(async () => { const A = await import('./js/analysis.js'); const d = document.createElement('select'); d.innerHTML = A.sleepCatOptions(window.__tempo.app.state.settings); return [...d.options].map(o => o.textContent.trim()); })()")
        check('7. category lists (e.g. sleep’s category) follow the tree, sub-categories indented under their main one', opts[1:] == ['Admin', '🌿 Leisure', '💼 Work', '↳ Email', '↳ Meetings'], opts)
        await page.click('#view-seg button[data-view=analysis]'); await page.wait_for_selector('.an-table'); await page.wait_for_timeout(500)
        await page.select_option('[data-o=by]', 'category'); await page.wait_for_timeout(800)
        rows = await page.eval_on_selector_all('.an-table tbody tr:not(.free-row):not(.gap-row)', 'rs => rs.map(r => [r.className, r.querySelector("summary").textContent.replace(/\\d+ items? ▾/, "").trim()])')
        check('8. Analysis by category: each main category followed by its sub-categories', (lambda L: '💼 Work' in L and L[L.index('💼 Work') + 1:L.index('💼 Work') + 3] == ['↳ Meetings', '↳ Email'])([r[1] for r in rows]) and [r[0] for r in rows].count('an-subrow') == 2, rows)
        await page.screenshot(path=f'{OUT}/r54-analysis.png')
        await page.click('#view-seg button[data-view=week]'); await page.wait_for_timeout(500)
        # ---- 3. Later with a category
        await page.click('.side-tabs [data-st=later]'); await page.wait_for_selector('#later-list .later-add')
        await page.fill('#later-list [name=t]', 'Call the accountant'); await page.select_option('#later-list [name=c]', 'admin')
        await page.click('#later-list .later-add button[type=submit]'); await page.wait_for_timeout(600)
        it = await page.evaluate("window.__tempo.app.state.settings.later.find(x => x.text === 'Call the accountant')")
        chip = await page.text_content('.later-row:has-text("Call the accountant") .later-cat')
        check('9. a Later note can get a category when added, shown on the note', it and it.get('catId') == 'admin' and 'Admin' in chip, (it, chip))
        await page.click('.later-row:has-text("Plan offsite") .later-t'); await page.wait_for_selector('dialog[open] [name=c]')
        await page.select_option('dialog[open] [name=c]', 'meet'); await page.click('dialog[open] button.primary'); await page.wait_for_timeout(600)
        it2 = await page.evaluate("window.__tempo.app.state.settings.later.find(x => x.id === 'l1')")
        check('10. … or later, when editing it', it2.get('catId') == 'meet', it2)
        await page.click('.later-row:has-text("Plan offsite") .l-task'); await page.wait_for_selector('dialog[open] .task-form')
        cur = await page.text_content('dialog[open] .cat-host')
        await page.click('dialog[open] .task-form button.primary'); await page.wait_for_timeout(2500)
        r3 = await page.evaluate(SESS.replace('TITLE', "'Plan offsite'"))
        check('11. making it a task keeps its category', 'Meetings' in cur and r3 and r3['cat'] == 'meet', (cur, r3))
        await page.click('.later-row:has-text("Call the accountant") .l-event'); await page.wait_for_selector('dialog [name=summary]'); await page.wait_for_timeout(300)
        ecat = await page.evaluate("document.querySelector('dialog[open] .ev-cat-host, dialog[open] .cat-host')?.textContent || ''")
        await page.click('dialog[open] button.primary'); await page.wait_for_timeout(2500)
        made = next((e for e in E.values() if e.get('summary') == 'Call the accountant'), None)
        check('12. making it an event keeps its category', made and made.get('extendedProperties', {}).get('private', {}).get('tempoCategory') == 'admin', (ecat, made and made.get('extendedProperties')))
        check('no page errors', not errs, errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
print('ALL PASS' if all(ok) else f'{ok.count(False)} FAILED')
