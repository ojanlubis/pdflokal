/*
 * THE BROWSER'S LANGUAGE CHOOSES BETWEEN `/` AND `/en`, AND NOTHING ELSE.
 * ============================================================================
 * The founder's ruling 2026-10-02: the default language follows the browser. The
 * mechanism is the inline script first in index.html's <head> (read its comment).
 * Each case here is a way that script could be wrong:
 *
 *   - an English browser on `/` must land on /en, query string and hash intact;
 *   - an Indonesian browser must stay (and an English SECOND language must not
 *     count: only the first does);
 *   - a stored choice beats the browser, both ways, and survives a reload;
 *   - a crawler (Googlebot renders as en-US!) must never be moved, or `/` would
 *     lose its index;
 *   - it must do NOTHING off the exact path `/` (the same head is copied into
 *     /en, /dukung and the twelve tool pages);
 *   - choosing a language in the menu must be remembered, or an English browser
 *     that picks "Bahasa Indonesia" on /en is bounced straight back;
 *   - private modes where storage throws still redirect, with no page error.
 *
 * WHY THESE CONTEXTS SET A USER AGENT: playwright.config.js pins the browser
 * language to id-ID so every other spec keeps testing the Indonesian `/`. Here
 * each case builds its own context. `navigator.webdriver` is true under
 * Playwright, so the script does not test it (the user agent is the only
 * crawler signal it reads), and Playwright's headless default UA says
 * "HeadlessChrome", which the script rightly treats as a bot: the cases that
 * must redirect therefore carry the ordinary desktop Chrome UA.
 *
 * Each expectation is paired with a control (a case that must NOT redirect next
 * to one that must), so a script that did nothing at all fails the positive
 * half and a script that always redirected fails the negative half.
 */
import { test, expect, devices } from '@playwright/test';

const CHROME = devices['Desktop Chrome'].userAgent;
const GOOGLEBOT = 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const BOTS = [
  GOOGLEBOT,
  `${CHROME} Google-InspectionTool/1.0`,
  `${CHROME} Chrome-Lighthouse`,
  CHROME.replace('Chrome/', 'HeadlessChrome/'),
  'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
];

async function open(browser, baseURL, { locale, userAgent = CHROME, stored, init } = {}) {
  const ctx = await browser.newContext({ baseURL, locale, userAgent });
  if (stored) await ctx.addInitScript((v) => { try { localStorage.setItem('pdflokal_lang', v); } catch { /* no storage */ } }, stored);
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { ctx, page, errors };
}
const where = (page) => { const u = new URL(page.url()); return u.pathname + u.search + u.hash; };
// "Stays" has to mean stayed for a while, not "had not moved yet".
const settle = (page) => page.waitForTimeout(900);

test.describe('the browser language chooses `/` or `/en`', () => {
  test('1. an English browser on `/` lands on /en, and the query and hash travel with it', async ({ browser, baseURL }) => {
    const { ctx, page, errors } = await open(browser, baseURL, { locale: 'en-US' });
    await page.goto('/?x=1#y');
    await expect(page).toHaveURL(/\/en\?x=1#y$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('h1')).toHaveText('For all your PDF Needs');
    expect(errors).toEqual([]);
    // `replace`, not `assign`: Back must not return to `/` (it would bounce straight forward again).
    await page.goBack();
    expect(page.url()).toBe('about:blank');
    await ctx.close();
  });

  test('2. any English variant redirects; an Indonesian browser stays, and so does one whose SECOND language is English', async ({ browser, baseURL }) => {
    const gb = await open(browser, baseURL, { locale: 'en-GB' });
    await gb.page.goto('/');
    await expect(gb.page).toHaveURL(/\/en$/);
    await gb.ctx.close();

    const id = await open(browser, baseURL, { locale: 'id-ID' });
    await id.page.goto('/');
    await settle(id.page);
    expect(where(id.page)).toBe('/');
    await expect(id.page.locator('html')).toHaveAttribute('lang', 'id');
    await id.ctx.close();

    const second = await open(browser, baseURL, { locale: 'id-ID', init: () => Object.defineProperty(Navigator.prototype, 'languages', { get: () => ['id-ID', 'en-US'] }) });
    await second.page.goto('/');
    await settle(second.page);
    expect(where(second.page)).toBe('/');
    await second.ctx.close();
  });

  test('3. a stored choice wins over the browser, both ways', async ({ browser, baseURL }) => {
    const stayId = await open(browser, baseURL, { locale: 'en-US', stored: 'id' });
    await stayId.page.goto('/');
    await settle(stayId.page);
    expect(where(stayId.page)).toBe('/');
    await stayId.ctx.close();

    const goEn = await open(browser, baseURL, { locale: 'id-ID', stored: 'en' });
    await goEn.page.goto('/');
    await expect(goEn.page).toHaveURL(/\/en$/);
    await goEn.ctx.close();
  });

  test('4. a crawler is never moved, even with an English browser language', async ({ browser, baseURL }) => {
    for (const userAgent of BOTS) {
      const { ctx, page } = await open(browser, baseURL, { locale: 'en-US', userAgent });
      await page.goto('/');
      await settle(page);
      expect(where(page), userAgent).toBe('/');
      await expect(page.locator('html')).toHaveAttribute('lang', 'id');
      await ctx.close();
    }
    // CONTROL: the same locale with an ordinary browser does move (so the loop above is not vacuous).
    const { ctx, page } = await open(browser, baseURL, { locale: 'en-US' });
    await page.goto('/');
    await expect(page).toHaveURL(/\/en$/);
    await ctx.close();
  });

  test('5. it does nothing off the exact path `/`: a tool page, /dukung, /privasi and /en stay put for an English browser', async ({ browser, baseURL }) => {
    const { ctx, page } = await open(browser, baseURL, { locale: 'en-US', stored: 'en' });
    for (const p of ['/kompres-pdf', '/dukung', '/privasi', '/en', '/en/support']) {
      await page.goto(p);
      await settle(page);
      expect(new URL(page.url()).pathname, p).toBe(p);
    }
    await ctx.close();
  });

  test('6. an Indonesian browser on /en is not sent back to `/`', async ({ browser, baseURL }) => {
    const { ctx, page } = await open(browser, baseURL, { locale: 'id-ID', stored: 'id' });
    await page.goto('/en');
    await settle(page);
    expect(where(page)).toBe('/en');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await ctx.close();
  });

  test('7. picking "Bahasa Indonesia" on /en lands on `/` and stays there (the choice is remembered)', async ({ browser, baseURL }) => {
    const { ctx, page } = await open(browser, baseURL, { locale: 'en-US' });
    await page.goto('/en');
    await page.locator('.ld-lang-btn').click();
    await page.locator('.ld-lang-menu a[hreflang="id"]').click();
    await expect(page).toHaveURL(/\/$/);
    await settle(page);
    expect(where(page)).toBe('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'id');
    expect(await page.evaluate(() => localStorage.getItem('pdflokal_lang'))).toBe('id');
    // Still true on a fresh visit to `/` in the same browser.
    await page.goto('/');
    await settle(page);
    expect(where(page)).toBe('/');
    // And the other direction: picking English on `/` is remembered for an Indonesian browser.
    await page.locator('.ld-lang-btn').click();
    await page.locator('.ld-lang-menu a[hreflang="en"]').click();
    await expect(page).toHaveURL(/\/en$/);
    expect(await page.evaluate(() => localStorage.getItem('pdflokal_lang'))).toBe('en');
    await ctx.close();
  });

  test('8. the choice is written from the mobile drawer and from /dukung and /en/support too', async ({ browser, baseURL }) => {
    // id-ID with nothing stored: `/` stays, so the drawer can be opened (an init-script
    // `stored` would re-write the key on every navigation and mask what the click wrote).
    const { ctx, page } = await open(browser, baseURL, { locale: 'id-ID' });
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto('/');
    await page.click('#ld-burger');
    await page.locator('#ld-burger-menu a[hreflang="en"]').click();
    await expect(page).toHaveURL(/\/en$/);
    expect(await page.evaluate(() => localStorage.getItem('pdflokal_lang'))).toBe('en');

    await page.goto('/dukung');
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.locator('.ld-lang-btn').click();
    await page.locator('.ld-lang-menu a[hreflang="en"]').click();
    await expect(page).toHaveURL(/\/en\/support$/);
    await page.locator('.ld-lang-btn').click();
    await page.locator('.ld-lang-menu a[hreflang="id"]').click();
    await expect(page).toHaveURL(/\/dukung$/);
    expect(await page.evaluate(() => localStorage.getItem('pdflokal_lang'))).toBe('id');
    await ctx.close();
  });

  test('9. where storage throws, an English browser still lands on /en with no page error', async ({ browser, baseURL }) => {
    const init = () => Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('denied', 'SecurityError'); } });
    const { ctx, page, errors } = await open(browser, baseURL, { locale: 'en-US', init });
    await page.goto('/');
    await expect(page).toHaveURL(/\/en$/);
    expect(errors.filter((m) => !/denied/.test(m) || /pdflokal_lang/.test(m))).toEqual([]);
    await ctx.close();
  });
});
