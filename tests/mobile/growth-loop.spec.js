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
  await page.goto('/editor-v2.html');
  await page.setInputFiles('#file-input', FIXTURE);
  await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();
}

test.describe('growth loop — mobile', () => {
  test('download celebrates (confetti) and then invites — once per session', async ({ page }) => {
    await openDoc(page);
    await downloadOnce(page);
    // Confetti canvas exists briefly (fixed, pointer-events none), then self-removes.
    await expect(page.locator('canvas[style*="pointer-events"]').last()).toBeAttached();
    // The card arrives after the sheet closes.
    await expect(page.locator('#support-card')).toBeVisible({ timeout: 4000 });
    await expect(page.locator('.sc-head')).toContainText('Berkas kamu jadi');

    // Dismiss, download again: same session → no second ask.
    await page.tap('#sc-close');
    await expect(page.locator('#support-card')).toBeHidden();
    await downloadOnce(page);
    await page.waitForTimeout(1600);
    await expect(page.locator('#support-card')).toBeHidden();
  });

  test('Traktir Kopi reveals the QRIS inline — no navigation away', async ({ page }) => {
    await openDoc(page);
    await downloadOnce(page);
    await expect(page.locator('#support-card')).toBeVisible({ timeout: 4000 });
    await page.tap('#sc-donate');
    await expect(page.locator('.sc-qr img[src*="qris"]')).toBeVisible();
    expect(page.url()).toContain('editor-v2'); // still in the editor
  });

  test('"jangan tampilkan lagi" is permanent (survives reload)', async ({ page }) => {
    await openDoc(page);
    await downloadOnce(page);
    await expect(page.locator('#support-card')).toBeVisible({ timeout: 4000 });
    await page.tap('#sc-never');
    await expect(page.locator('#support-card')).toBeHidden();

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
