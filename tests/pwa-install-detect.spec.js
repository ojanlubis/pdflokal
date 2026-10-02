// PWA install card — device detection. A touchscreen Windows laptop reports
// maxTouchPoints=10 but its primary pointer is fine; it must be told
// "komputermu"/desktop steps, not "hapemu". An Android phone in "desktop site"
// mode (Linux UA, no "Android") has a coarse primary pointer and is still a phone.
import { test, expect } from '@playwright/test';

const WIN_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

test.describe('install card — touch laptop is a computer', () => {
  test.use({ userAgent: WIN_CHROME });
  test('maxTouchPoints=10 + fine pointer → "komputermu"', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 10 });
      // a real Windows laptop says Win32; the host here is a Mac (MacIntel), which
      // would trip the unrelated iPadOS-masquerade check and hide what we test.
      Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
    });
    await page.goto('/');
    await expect(page.locator('#ip-chip .ip-chip-label')).toContainText('komputermu');
    await page.locator('#ip-chip').click();
    await expect(page.locator('#install-card .sc-head')).toContainText('komputermu');
    await expect(page.locator('#install-card .sc-sub')).toContainText('desktop');
  });
});

test.describe('install card — coarse pointer without an Android UA is a phone', () => {
  test.use({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' });
  test('(pointer: coarse) → "hapemu"', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'platform', { get: () => 'Linux x86_64' });
      const real = window.matchMedia.bind(window);
      window.matchMedia = (q) => (/pointer:\s*coarse/.test(q) && !/any-/.test(q)
        ? { ...real('all'), matches: true, media: q } : real(q));
    });
    await page.goto('/');
    await expect(page.locator('#ip-chip .ip-chip-label')).toContainText('hapemu');
  });
});
