# Shared setup for the browser tests: a static server for src/, a fixed clock, stored settings and sign-in, the fake
# Google APIs, and PASS/FAIL bookkeeping. New tests use this instead of repeating the boilerplate:
#
#   from harness import App
#   async def main(app):
#       page = await app.page(settings={'tz': 'Europe/Berlin'}, now='2026-10-28T09:30:00Z')
#       app.check('1. something', cond, extra)
#   App.run(main, port=8870)
import asyncio, sys, subprocess, time, re, json
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
from mockgoogle import MockGoogle

AUTH = {'clientId': 'x.apps.googleusercontent.com', 'connected': True, 'consented': True, 'token': 'tok', 'expires': 9e15, 'email': 'me@example.com'}
GOOGLE = re.compile(r'https://(www|openidconnect|oauth2)\.googleapis\.com/.*')

def init_script(settings, now=None, auth=AUTH, extra=''):
    """The page's starting point: a fixed (moving) clock from `now`, and the stored settings / sign-in on first load."""
    clock = '' if not now else """
const FIX = Date.parse(%s); const _Date = Date; globalThis.__off = (+(sessionStorage.getItem('test:off') || 0)) + FIX - _Date.now();
class D extends _Date { constructor(...a){ if(a.length===0){ super(_Date.now()+globalThis.__off);} else super(...a);} static now(){ return _Date.now()+globalThis.__off; } } globalThis.Date = D;""" % json.dumps(now)
    store = """
if (!localStorage.getItem('tempo:auth')) {
  localStorage.setItem('tempo:auth', JSON.stringify(%s));
  localStorage.setItem('tempo:settings', JSON.stringify(%s));
  localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2099-01-01'));
}""" % (json.dumps(auth), json.dumps({'askCategory': False, 'goalNotice': False, **settings}))
    return clock + store + extra

class App:
    def __init__(self, out, port):
        self.out, self.port, self.results, self.errors = out, port, [], []
        self.google = MockGoogle()
    @property
    def url(self): return f'http://localhost:{self.port}/app.html'
    def check(self, label, cond, extra=''):
        self.results.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + label, extra)
    async def page(self, settings, now=None, viewport=None, device=None, auth=AUTH, extra='', routes=(), wait=2500):
        """A new browser context with the app loaded and its .tg-col drawn."""
        opts = dict(self.pw.devices[device]) if device else {'viewport': viewport or {'width': 1400, 'height': 900}}
        ctx = await self.browser.new_context(timezone_id=settings.get('tz', 'Europe/Berlin'), **opts)
        await ctx.add_init_script(init_script(settings, now, auth, extra))
        await ctx.route(GOOGLE, self.google.handle)
        for pat, handler in routes: await ctx.route(pat, handler)
        page = await ctx.new_page(); page.on('pageerror', lambda e: self.errors.append(str(e)))
        await page.goto(self.url); await page.wait_for_function('window.tempo'); await page.wait_for_selector('.tg-col'); await page.wait_for_timeout(wait)
        return page
    @classmethod
    def run(cls, main, port):
        app = cls(sys.argv[1] if len(sys.argv) > 1 else '/tmp', port)
        srv = subprocess.Popen(['python3', '-m', 'http.server', str(port), '-d', 'src'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
        async def go():
            async with async_playwright() as p:
                app.pw = p; app.browser = await p.chromium.launch()
                try: await main(app)
                finally:
                    app.check('no page errors', not app.errors, app.errors)
                    await app.browser.close()
        try: asyncio.run(go())
        finally: srv.terminate()
        print('ALL PASS' if all(app.results) else f'{app.results.count(False)} FAILED')
