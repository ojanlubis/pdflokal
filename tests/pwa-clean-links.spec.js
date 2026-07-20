/*
 * PWA navigation guard.
 * On Vercel, an internal link to "/x.html" 308-redirects to "/x". When that
 * redirect passes through the service worker's navigate handler, the browser
 * refuses the redirected response and the navigation SILENTLY FAILS in an
 * installed PWA — the "Dukung Kami does nothing" field report (Jul 2026, a
 * friend's Lenovo). Clean URLs (no ".html") never redirect, so they navigate
 * everywhere: browser tab AND installed PWA.
 *
 * This pins the fix: no landing/static page may link to a ".html" internal URL.
 */
import { test, expect } from '@playwright/test';

const PAGES = ['/', '/dukung', '/privasi', '/alat-gambar'];

for (const path of PAGES) {
  test(`${path} has no internal .html links (they redirect → break PWA nav)`, async ({ page }) => {
    await page.goto(path);
    const htmlLinks = await page
      .locator('a[href$=".html"]')
      .evaluateAll((els) => els.map((a) => a.getAttribute('href')));
    expect(htmlLinks).toEqual([]);
  });
}

test('"Dukung Kami" points at the clean URL', async ({ page }) => {
  await page.goto('/');
  const href = await page.locator('.ld-foot a', { hasText: 'Dukung' }).first().getAttribute('href');
  expect(href).toBe('/dukung');
});
