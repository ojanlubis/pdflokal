// PWA install nudge — the recall play (GA4 finding Jul 2026: paid users don't
// return unprompted; put PDFLokal on the home screen so the next job returns free).
// RULE (founder, Jul 2026): the install nudge appears ONLY as the strong native
// one-tap, and NEVER on a user's first win (that moment belongs to the share ask).
// So: first download → share card; 2nd+ download WITH beforeinstallprompt armed →
// install card, once. No weak "⋮ menu" instruction card.
import { test, expect } from '@playwright/test';

// Simulate Chrome arming the one-tap install (celebrate.js captured the listener at load).
async function armInstallPrompt(page) {
  await page.evaluate(() => {
    const e = new Event('beforeinstallprompt');
    e.prompt = () => { window.__prompted = true; };
    e.userChoice = Promise.resolve({ outcome: 'accepted' });
    window.dispatchEvent(e);
  });
}

test.describe('PWA install nudge — mobile', () => {
  test('manifest is linked and the service worker registers', async ({ page }) => {
    await page.goto('/');
    expect(await page.getAttribute('link[rel="manifest"]', 'href')).toBe('/manifest.webmanifest');
    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => !!r)))
      .toBe(true);
  });

  test('returning user + one-tap armed → install card fires the native prompt', async ({ page }) => {
    await page.goto('/');
    // Returning user (has downloaded before), one-tap armed, nudge not yet seen.
    await page.evaluate(() => {
      try { localStorage.clear(); localStorage.setItem('pdflokal-has-downloaded', '1'); } catch { /* private */ }
    });
    await armInstallPrompt(page);
    await page.evaluate(() => window.v2.celebration.onDownloadSuccess());

    await expect(page.locator('#install-card')).toBeVisible();
    await expect(page.locator('#support-card')).toBeHidden();     // never both
    await page.locator('#ic-install').click();
    expect(await page.evaluate(() => window.__prompted === true)).toBe(true);
    await expect(page.locator('#toast')).toContainText('layar HP');
    await expect(page.locator('#install-card')).toBeHidden();
  });

  test('FIRST download → always the share card, never the install nudge', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => { try { localStorage.clear(); } catch { /* private */ } }); // fresh = first win
    await armInstallPrompt(page); // even with the prompt armed, the first win is the share ask's
    await page.evaluate(() => window.v2.celebration.onDownloadSuccess());

    await expect(page.locator('#support-card')).toBeVisible();
    await expect(page.locator('#install-card')).toBeHidden();
  });

  test('returning user WITHOUT one-tap → share card (no weak manual nudge)', async ({ page }) => {
    // No beforeinstallprompt armed → canOfferInstall is false → share card, not a
    // menu-instruction card (the rule: only the strong one-tap ever shows).
    await page.goto('/');
    await page.evaluate(() => {
      try { localStorage.clear(); localStorage.setItem('pdflokal-has-downloaded', '1'); } catch { /* private */ }
    });
    await page.evaluate(() => window.v2.celebration.onDownloadSuccess());

    await expect(page.locator('#support-card')).toBeVisible();
    await expect(page.locator('#install-card')).toBeHidden();
  });
});
