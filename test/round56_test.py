# Round 56: onboarding wizard and updated descriptions.
import sys, json
sys.path.insert(0, 'test')
from harness import App

UNCONNECTED_AUTH = {'connected': False}

async def main(app):
    # ——————————————————————————————————————————————
    # 1. Onboarding wizard appears when not connected
    # ——————————————————————————————————————————————
    page = await app.page(
        settings={'tz': 'America/New_York'},
        now='2026-10-28T14:00:00Z',
        auth=UNCONNECTED_AUTH,
        extra='localStorage.removeItem("tempo:onboardDone");',
        wait=3000,
    )
    dlg = await page.query_selector('dialog.modal .ob-form')
    app.check('1. onboarding wizard shown when not connected', dlg is not None)

    # Check that the welcome slide is visible
    slide0 = await page.query_selector('[data-ob="0"]:not([hidden])')
    app.check('2. welcome slide visible', slide0 is not None)

    # Check it mentions Claude
    text = await page.inner_text('.ob-form .dlg-body')
    app.check('3. mentions Claude', 'Claude' in text)
    app.check('4. mentions free', 'free' in text.lower())

    # Navigate to slide 2 (connect)
    await page.click('.ob-next')
    await page.wait_for_timeout(300)
    slide1 = await page.query_selector('[data-ob="1"]:not([hidden])')
    app.check('5. connect slide visible after Next', slide1 is not None)

    # Navigate to slide 3 (tips)
    await page.click('.ob-next')
    await page.wait_for_timeout(300)
    slide2 = await page.query_selector('[data-ob="2"]:not([hidden])')
    app.check('6. tips slide visible after second Next', slide2 is not None)

    # Check tips content
    tips_text = await page.inner_text('[data-ob="2"]')
    app.check('7. tips mention categories', 'Categories' in tips_text or 'categories' in tips_text)
    app.check('8. tips mention command bar', 'Command bar' in tips_text or 'Ctrl+K' in tips_text)

    # Click "Get started" to close
    btn_text = await page.inner_text('.ob-next')
    app.check('9. final button says Get started', btn_text == 'Get started')
    await page.click('.ob-next')
    await page.wait_for_timeout(500)

    # Dialog should be closed
    dlg_after = await page.query_selector('dialog[open] .ob-form')
    app.check('10. wizard closed after Get started', dlg_after is None)

    # localStorage flag should be set
    flag = await page.evaluate('() => { try { return localStorage.getItem("tempo:onboardDone"); } catch { return null; } }')
    app.check('11. onboardDone flag set in localStorage', flag == '1')
    await page.close()

    # ——————————————————————————————————————————————
    # 2. Onboarding wizard does NOT show when connected
    # ——————————————————————————————————————————————
    page2 = await app.page(
        settings={'tz': 'America/New_York'},
        now='2026-10-28T14:00:00Z',
        wait=3000,
    )
    dlg2 = await page2.query_selector('dialog.modal .ob-form')
    app.check('12. no wizard when connected', dlg2 is None)
    await page2.close()

    # ——————————————————————————————————————————————
    # 3. Onboarding does not re-show once dismissed
    # ——————————————————————————————————————————————
    page3 = await app.page(
        settings={'tz': 'America/New_York'},
        now='2026-10-28T14:00:00Z',
        auth=UNCONNECTED_AUTH,
        extra='localStorage.setItem("tempo:onboardDone", "1");',
        wait=3000,
    )
    dlg3 = await page3.query_selector('dialog.modal .ob-form')
    app.check('13. no wizard when already dismissed', dlg3 is None)
    await page3.close()

    # ——————————————————————————————————————————————
    # 4. Back button works
    # ——————————————————————————————————————————————
    page4 = await app.page(
        settings={'tz': 'America/New_York'},
        now='2026-10-28T14:00:00Z',
        auth=UNCONNECTED_AUTH,
        extra='localStorage.removeItem("tempo:onboardDone");',
        wait=3000,
    )
    # Go to slide 2
    await page4.click('.ob-next')
    await page4.wait_for_timeout(300)
    # Go back
    await page4.click('.ob-back')
    await page4.wait_for_timeout(300)
    slide0_again = await page4.query_selector('[data-ob="0"]:not([hidden])')
    app.check('14. back button returns to first slide', slide0_again is not None)
    await page4.close()

App.run(main, port=8916)
