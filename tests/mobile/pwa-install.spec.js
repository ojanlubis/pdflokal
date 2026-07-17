// PWA install nudge — the recall play (GA4 finding Jul 2026: paid users don't
// return unprompted; put PDFLokal on the home screen so the next job returns free).
// Verifies: manifest present, SW registers, and the post-download routing —
// first win → install card; installable prompt fires; later wins → share card.
import { test, expect } from '@playwright/test';

test.describe('PWA install nudge — mobile', () => {
  test('manifest is linked and the service worker registers', async ({ page }) => {
    await page.goto('/');
    const manifestHref = await page.getAttribute('link[rel="manifest"]', 'href');
    expect(manifestHref).toBe('/manifest.webmanifest');
    // registration happens on window 'load'
    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => !!r)))
      .toBe(true);
  });

  test('first successful download → install card fires the native prompt', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => { try { localStorage.clear(); } catch { /* private mode */ } });

    // Simulate Chrome deeming the app installable (celebrate.js captured the listener at load).
    await page.evaluate(() => {
      const e = new Event('beforeinstallprompt');
      e.prompt = () => { window.__prompted = true; };
      e.userChoice = Promise.resolve({ outcome: 'accepted' });
      window.dispatchEvent(e);
    });

    // A user's first successful download.
    await page.evaluate(() => window.v2.celebration.onDownloadSuccess());

    const installCard = page.locator('#install-card');
    await expect(installCard).toBeVisible();
    await expect(page.locator('#ic-install')).toBeVisible(); // prompt path, not the manual hint
    await expect(page.locator('#ic-hint')).toBeHidden();

    await page.locator('#ic-install').click();
    expect(await page.evaluate(() => window.__prompted === true)).toBe(true);
    await expect(page.locator('#toast')).toContainText('layar HP');
    await expect(installCard).toBeHidden();
  });

  test('first download WITHOUT beforeinstallprompt (Android) → card with the manual hint', async ({ page }) => {
    // The real-device case (Jul 2026): Chrome hadn't fired beforeinstallprompt yet,
    // but the app is installable. The recall moment must still appear — with the
    // "⋮ → Add to Home screen" hint instead of the one-tap button.
    // Block the manifest so the app isn't installable → Chromium never fires
    // beforeinstallprompt → we deterministically exercise the manual fallback.
    // canOfferInstall stays true via the Android UA (mobile-chrome).
    await page.route('**/manifest.webmanifest', (r) => r.abort());
    await page.goto('/');
    await page.evaluate(() => { try { localStorage.clear(); } catch { /* private mode */ } });
    await page.evaluate(() => window.v2.celebration.onDownloadSuccess());

    await expect(page.locator('#install-card')).toBeVisible();
    await expect(page.locator('#ic-install')).toBeHidden();       // no native prompt → no button
    await expect(page.locator('#ic-hint')).toContainText('Layar utama');
    await expect(page.locator('#support-card')).toBeHidden();     // never both
  });

  test('second download → the share card, never the install card again', async ({ page }) => {
    await page.goto('/');
    // Simulate a returning user who already downloaded + already saw the install nudge.
    await page.evaluate(() => {
      try {
        localStorage.clear();
        localStorage.setItem('pdflokal-has-downloaded', '1');
        localStorage.setItem('pdflokal-install-seen', '1');
      } catch { /* private mode */ }
    });
    await page.evaluate(() => {
      const e = new Event('beforeinstallprompt');
      e.prompt = () => {}; e.userChoice = Promise.resolve({ outcome: 'dismissed' });
      window.dispatchEvent(e);
    });

    await page.evaluate(() => window.v2.celebration.onDownloadSuccess());

    await expect(page.locator('#support-card')).toBeVisible();
    await expect(page.locator('#install-card')).toBeHidden();
  });
});
