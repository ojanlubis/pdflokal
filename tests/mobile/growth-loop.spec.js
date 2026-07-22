/*
 * Wave 5 growth loop: celebrate the download, then invite (share / QRIS tip).
 * Never nags: once per session, permanent opt-out, file never held hostage.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'sample-2pages.pdf');

async function downloadOnce(page) {
  await page.tap('#btn-download');
  const dl = page.waitForEvent('download');
  await page.tap('#ds-cta');
  await dl;
}

async function openDoc(page) {
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();
}

test.describe('growth loop — mobile', () => {
  // TEMPORARY: during the Play Store drive the vote card takes the download
  // moment from share/tip for un-voted users. These tests exercise share/tip
  // itself, so we mark the vote as already cast — the moment then falls through
  // to share/tip, exactly as it does for a voted user or once the drive ends.
  // (Remove this hook when PLAYSTORE_CAMPAIGN is retired.)
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('pdflokal-ps-voted', '1'));
  });

  test('download celebrates (BERES stamp) and then invites — once per day', async ({ page }) => {
    await openDoc(page);
    await downloadOnce(page);
    // The stamp exists briefly (fixed, pointer-events none), then self-removes.
    await expect(page.locator('.v2-stamp', { hasText: 'Beres' })).toBeAttached();
    // The card arrives after the sheet closes.
    await expect(page.locator('#support-card')).toBeVisible({ timeout: 4000 });
    await expect(page.locator('#support-card .sc-head')).toContainText('filemu udah jadi');

    // Dismiss, download again: same day → no second ask.
    await page.tap('#sc-close');
    await expect(page.locator('#support-card')).toBeHidden();
    await downloadOnce(page);
    await page.waitForTimeout(1600);
    await expect(page.locator('#support-card')).toBeHidden();

    // Even across a reload (fresh session, same calendar day) → still quiet.
    await openDoc(page);
    await downloadOnce(page);
    await page.waitForTimeout(1600);
    await expect(page.locator('#support-card')).toBeHidden();

    // A NEW day → the card asks again (stub the day key to yesterday).
    await page.evaluate(() => localStorage.setItem('pdflokal-support-last', 'yesterday'));
    await openDoc(page);
    await downloadOnce(page);
    await expect(page.locator('#support-card')).toBeVisible({ timeout: 4000 });
  });

  test('Traktir Kopi reveals the QRIS inline — no navigation away', async ({ page }) => {
    await openDoc(page);
    await downloadOnce(page);
    await expect(page.locator('#support-card')).toBeVisible({ timeout: 4000 });
    await page.tap('#sc-donate');
    await expect(page.locator('.sc-qr img[src*="qris"]')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/'); // still in the editor, no navigation
  });

  test('"jangan tampilkan lagi" is permanent (survives reload)', async ({ page }) => {
    await openDoc(page);
    await downloadOnce(page);
    await expect(page.locator('#support-card')).toBeVisible({ timeout: 4000 });
    await page.tap('#sc-never');
    await expect(page.locator('#support-card')).toBeHidden();

    // Clear the once-a-day key so ONLY the opt-out can be keeping it hidden.
    await page.evaluate(() => localStorage.removeItem('pdflokal-support-last'));
    await openDoc(page); // fresh page load, same storage
    await downloadOnce(page);
    await page.waitForTimeout(1600);
    await expect(page.locator('#support-card')).toBeHidden();
  });

  test('Bagikan uses the native share sheet when available', async ({ page }) => {
    await openDoc(page);
    await page.evaluate(() => {
      window.__shared = null;
      navigator.share = (data) => { window.__shared = data; return Promise.resolve(); };
    });
    await downloadOnce(page);
    await expect(page.locator('#support-card')).toBeVisible({ timeout: 4000 });
    await page.tap('#sc-share');
    const shared = await page.evaluate(() => window.__shared);
    expect(shared.url).toContain('pdflokal.id');
    await expect(page.locator('#support-card')).toBeHidden(); // shared → card done
  });
});
