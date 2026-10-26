# Round 49: the Bookcase (renamed) with book covers — from the ISBN (Open Library) or an image address, downloaded
# once and shown at one size; the newspaper is "Remembrance of Things Past", with Proustian epigraphs, epithets
# and asides.
import asyncio, sys, subprocess, time, re, json, io
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle
from PIL import Image
OUT = sys.argv[1]
srv = subprocess.Popen(['python3','-m','http.server','8845','-d','src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
def png(w, h, col):
    b = io.BytesIO(); Image.new('RGB', (w, h), col).save(b, 'PNG'); return b.getvalue()
INIT = """
const FIX = Date.parse('2026-10-26T05:00:00Z'); const _Date = Date; globalThis.__off = FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify({clientId:'x.apps.googleusercontent.com', connected:true, consented:true, token:'tok', expires: 9e15, email:'me@example.com'}));
  localStorage.setItem('tempo:settings', JSON.stringify({tz: 'Europe/Berlin', askCategory: false, goalNotice: false, paperName: 'Der Zeitplan'}));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2099-01-01'));
}"""
ok = []
def check(label, cond, extra=''):
    ok.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + label, extra)
async def main():
    g = MockGoogle(); errs = []; hits = []
    async with async_playwright() as p:
        b = await p.chromium.launch(); ctx = await b.new_context(viewport={'width': 1400, 'height': 900}, timezone_id='Europe/Berlin', compact_ui=True)
        await ctx.add_init_script(INIT); await ctx.route(re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*'), g.handle)
        async def ol(route):
            hits.append(route.request.url)
            if '9780141182803' in route.request.url: await route.fulfill(body=png(300, 460, (180, 40, 40)), content_type='image/png', headers={'Access-Control-Allow-Origin': '*'})
            else: await route.fulfill(status=404, body='', headers={'Access-Control-Allow-Origin': '*'})
        await ctx.route(re.compile(r'https://covers\.openlibrary\.org/.*'), ol)
        await ctx.route(re.compile(r'https://pics\.example\.org/.*'), lambda r: r.fulfill(body=png(200, 200, (40, 90, 180)), content_type='image/png'))  # no CORS
        page = await ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('http://localhost:8845/app.html'); await page.wait_for_function('window.tempo'); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(1500)
        # a book with an ISBN, set up through the dialog
        await page.click('#btn-new-task'); await page.wait_for_selector('dialog[open] .task-form')
        await page.click('dialog[open] label:has(input[name=kind][value=reading])')
        await page.fill('dialog[open] [name=title]', 'Swann\'s Way'); await page.fill('dialog[open] [name=pages]', '200')
        await page.fill('dialog[open] [name=isbn]', '9780141182803'); await page.wait_for_timeout(1200)
        prev = await page.evaluate("(() => { const i = document.querySelector('dialog[open] .cov-box img'); return i && [i.src, i.complete && i.naturalWidth > 0]; })()")
        check('1. a reading plan takes an ISBN (or a cover address) and previews the cover', prev and 'covers.openlibrary.org/b/isbn/9780141182803' in prev[0] and prev[1], prev)
        await page.screenshot(path=f'{OUT}/r49-dialog.png')
        await page.click('dialog[open] button[type=submit]'); await page.wait_for_timeout(1500)
        r = await page.evaluate("window.__tempo.app.state.tasks.find(t => t.title === \"Swann's Way\").reading")
        await page.evaluate("""(() => { const a = window.__tempo.app.state, base = { kind: 'reading', rank: 3, planned: [], skipped: [], frozen: [], color: '#0f9d76', created: Date.now(), deadline: Date.now() + 20 * 864e5 };
          a.tasks.push({ ...base, id: 'b2', title: 'Pictures book', reading: { pages: 100, startPage: 1, speed: 30, unit: 'pph', cover: 'https://pics.example.org/c.png' } });
          a.tasks.push({ ...base, id: 'b3', title: 'No cover at all', color: '#8a5cf6', reading: { pages: 100, startPage: 1, speed: 30, unit: 'pph', isbn: '0000000000' } });
          window.__tempo.render(); })()""")
        await page.wait_for_timeout(800)
        lbl = await page.text_content('#task-list .lib-open')
        await page.click('#task-list .lib-open'); await page.wait_for_selector('dialog[open] .bookcase'); await page.wait_for_timeout(2500)
        info = await page.evaluate("""(() => [...document.querySelectorAll('dialog[open] .bc-book')].map(b => { const c = b.querySelector('.bc-cover'), r = c.getBoundingClientRect(); return [b.querySelector('.bc-t').textContent, c.tagName, (c.getAttribute('src') || '').slice(0, 30), Math.round(r.width), Math.round(r.height)]; }))()""")
        cache = await page.evaluate("Object.entries(JSON.parse(localStorage.getItem('tempo:covers') || '{}')).map(([k, v]) => [k.slice(0, 60), v.slice(0, 22)])")
        check('2. "Library" is now the Bookcase', '📚 Bookcase' in lbl and await page.text_content('dialog[open] .bookcase h2') == '📚 Bookcase', lbl)
        sw = next((x for x in info if x[0] == "Swann's Way"), None); pb = next((x for x in info if x[0] == 'Pictures book'), None); nc = next((x for x in info if x[0] == 'No cover at all'), None)
        check('3. the cover from the ISBN is downloaded once and kept on this device', r.get('isbn') == '9780141182803' and sw and sw[2].startswith('data:image/jpeg') and any(v.startswith('data:image/jpeg') for _, v in cache), (r, sw, cache))
        check('4. a cover from an image address is shown (downloaded, or from its address if the site won\'t allow that); no cover → a spine with the title', pb and pb[1] == 'IMG' and (pb[2].startswith('https://pics.example.org') or pb[2].startswith('data:image/jpeg')) and nc and nc[1] == 'SPAN', (pb, nc))
        check('5. all covers are the same size', len({(x[3], x[4]) for x in info}) == 1 and info[0][3] == 88 and info[0][4] == 132, info)
        await page.screenshot(path=f'{OUT}/r49-bookcase.png')
        await page.keyboard.press('Escape'); await page.wait_for_timeout(300)
        # the newspaper
        await page.click('#view-seg button[data-view=review]'); await page.wait_for_selector('.np'); await page.wait_for_timeout(2000)
        np = await page.evaluate("[document.querySelector('.np-title').textContent, document.querySelector('.np-epigraph')?.textContent, document.querySelector('.np-tag i')?.textContent, document.querySelectorAll('.np-aside').length]")
        PH = await page.evaluate("(async () => { const PH = await import('./js/phrases.js'); return [PH.PROUST_EPIGRAPHS.length, PH.PROUST_ASIDES.length, PH.PROUST_EPITHETS.length]; })()")
        check('6. the newspaper is "Remembrance of Things Past" (the old default name counts as unset)', np[0] == 'Remembrance of Things Past', np[0])
        check('7. ~100 Proustian phrases: an epigraph under the title, an epithet for the period, asides in the sections', sum(PH) >= 100 and np[1] and np[1].startswith('“') and np[2] and np[3] >= 3, (PH, np))
        await page.screenshot(path=f'{OUT}/r49-paper.png')
        check('no page errors', not errs, errs)
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
print('ALL PASS' if all(ok) else f'{ok.count(False)} FAILED')
