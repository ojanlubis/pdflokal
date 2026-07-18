// PWA install — the recall play on the HOMEPAGE (GA4 finding Jul 2026: paid users
// complete the task but don't return unprompted). A quiet chip under the dropzone,
// shown only to RETURNING users, opens an adaptive card: one-tap when Chrome has
// armed beforeinstallprompt, point-by-point steps otherwise. Never on the download
// moment — install must not compete with the share ask.
import { test, expect } from '@playwright/test';

// Simulate a returning visitor (2nd session onward) so the chip is eligible.
async function seedReturning(page) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('pdflokal-visits', '2');
      sessionStorage.setItem('pdflokal-visit-counted', '1');
    } catch { /* private mode */ }
  });
}
async function armInstallPrompt(page) {
  await page.evaluate(() => {
    const e = new Event('beforeinstallprompt');
    e.prompt = () => { window.__prompted = true; };
    e.userChoice = Promise.resolve({ outcome: 'accepted' });
    window.dispatchEvent(e);
  });
}

test.describe('PWA install — mobile', () => {
  test('manifest is linked and the service worker registers', async ({ page }) => {
    await page.goto('/');
    expect(await page.getAttribute('link[rel="manifest"]', 'href')).toBe('/manifest.webmanifest');
    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => !!r)))
      .toBe(true);
  });

  test('chip is hidden on a first visit, shown for a returning visitor', async ({ page }) => {
    await page.goto('/'); // first visit → counted as visit 1
    await expect(page.locator('#ip-chip')).toBeHidden();

    await seedReturning(page);
    await page.goto('/');
    await expect(page.locator('#ip-chip')).toBeVisible();
  });

  test('returning + one-tap armed → chip opens the one-tap card', async ({ page }) => {
    await seedReturning(page);
    await page.goto('/');
    await armInstallPrompt(page);
    await page.locator('#ip-chip').click();

    await expect(page.locator('#install-card')).toBeVisible();
    await expect(page.locator('#ic-onetap')).toBeVisible();  // one-tap button path
    await expect(page.locator('#ic-steps')).toBeHidden();
    await page.locator('#ic-install').click();
    expect(await page.evaluate(() => window.__prompted === true)).toBe(true);
    await expect(page.locator('#install-card')).toBeHidden();
  });

  test('"jangan tampilkan lagi" hides the chip permanently', async ({ page }) => {
    await seedReturning(page);
    await page.goto('/');
    await page.locator('#ip-chip').click();
    await page.locator('#ic-never').click();
    await expect(page.locator('#ip-chip')).toBeHidden();

    await page.goto('/'); // still a returning visit, but dismissed → stays gone
    await expect(page.locator('#ip-chip')).toBeHidden();
  });
});

// iOS has no beforeinstallprompt → the card must show the manual Add-to-Home-Screen steps.
test.describe('PWA install — iOS steps', () => {
  test.use({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });

  test('returning iPhone user → chip opens the step-by-step card', async ({ page }) => {
    await seedReturning(page);
    await page.goto('/');
    await page.locator('#ip-chip').click();

    await expect(page.locator('#install-card')).toBeVisible();
    await expect(page.locator('#ic-steps')).toBeVisible();
    await expect(page.locator('#ic-onetap')).toBeHidden();     // no native prompt on iOS
    await expect(page.locator('.ic-steps-title')).toContainText('iPhone');
    await expect(page.locator('#ic-steps li').first()).toContainText('Share');
  });
});
