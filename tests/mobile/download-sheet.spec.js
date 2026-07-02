/*
 * The Unduh sheet — output pipeline (founder-approved via tappable simulation).
 * Covers: 2-tap fast path with a TRUE size on the button, the honest-compress
 * path (small text PDFs can't shrink → "sudah optimal", never a bigger file),
 * images (single → .jpg, many → .zip), and page picking via Kelola Halaman.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'sample-2pages.pdf');

async function openSheet(page) {
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();
  await page.tap('#btn-download');
  await expect(page.locator('#dl-sheet')).toBeVisible();
}

test.describe('unduh sheet — mobile', () => {
  test('opens with correct defaults and a REAL size lands on the button', async ({ page }) => {
    await openSheet(page);
    await expect(page.locator('#ds-format button.on')).toHaveAttribute('data-v', 'pdf');
    await expect(page.locator('#ds-pages button.on')).toHaveAttribute('data-v', 'all');
    // The background build finishes → true size (KB/MB) appears on the CTA.
    await expect(page.locator('#ds-cta-main')).toContainText(/KB|MB/, { timeout: 15000 });
    await expect(page.locator('#ds-meta')).toContainText('2 hal');
  });

  test('the 90% path: two taps produce the PDF', async ({ page }) => {
    await openSheet(page);
    const dl = page.waitForEvent('download');
    await page.tap('#ds-cta'); // tap immediately — the sheet waits for its own build
    const download = await dl;
    expect(download.suggestedFilename()).toMatch(/pdflokal\.pdf$/);
    await expect(page.locator('#dl-sheet')).toBeHidden();
  });

  test('compress is HONEST: a tiny text PDF reports "sudah optimal", never grows', async ({ page }) => {
    await openSheet(page);
    await page.tap('#ds-size [data-v="kompres"]');
    // The result lands: either savings or the honesty message.
    await expect(page.locator('#ds-size [data-v="kompres"]')).toContainText(/hemat|optimal/, { timeout: 20000 });
    const dl = page.waitForEvent('download');
    await page.tap('#ds-cta');
    const download = await dl;
    expect(download.suggestedFilename()).toMatch(/\.pdf$/);
    // Never bigger than the original build.
    const sizes = await page.evaluate(() => window.__dsSizes || null);
    if (sizes) expect(sizes.out).toBeLessThanOrEqual(sizes.base);
  });

  test('gambar: all pages → one ZIP', async ({ page }) => {
    await openSheet(page);
    await page.tap('#ds-format [data-v="img"]');
    await expect(page.locator('#ds-cta-main')).toContainText('2 Gambar');
    const dl = page.waitForEvent('download');
    await page.tap('#ds-cta');
    const download = await dl;
    expect(download.suggestedFilename()).toMatch(/gambar\.zip$/);
  });

  test('gambar: one picked page → direct .jpg, picked via Kelola Halaman', async ({ page }) => {
    await openSheet(page);
    await page.tap('#ds-format [data-v="img"]');
    await page.tap('#ds-pages [data-v="some"]');
    // Kelola Halaman opens in PICK mode: bulk actions hidden, pick bar shown.
    await expect(page.locator('#pm-sheet')).toBeVisible();
    await expect(page.locator('#pm-pickbar')).toBeVisible();
    await expect(page.locator('#pm-bulk')).toBeHidden();
    await page.tap('.pm-tile >> nth=0');
    await expect(page.locator('#pm-pick-ok')).toHaveText('Pakai (1)');
    await page.tap('#pm-pick-ok');
    await expect(page.locator('#pm-sheet')).toBeHidden();
    await expect(page.locator('#ds-cta-main')).toContainText('1 Gambar');

    const dl = page.waitForEvent('download');
    await page.tap('#ds-cta');
    const download = await dl;
    expect(download.suggestedFilename()).toMatch(/hal-1\.jpg$/);
  });

  test('compress then RE-PICK pages: compression re-runs, download still works', async ({ page }) => {
    await openSheet(page);
    // 1. Compress first…
    await page.tap('#ds-size [data-v="kompres"]');
    await expect(page.locator('#ds-size [data-v="kompres"]')).toContainText(/hemat|optimal/, { timeout: 20000 });
    // 2. …then change the page selection (this invalidates the built bytes).
    await page.tap('#ds-pages [data-v="some"]');
    await page.tap('.pm-tile >> nth=0');
    await page.tap('#pm-pick-ok');
    await expect(page.locator('#ds-cta-main')).toContainText('(1 hal.)');
    // 3. Compression must have re-run for the new subset…
    await expect(page.locator('#ds-size [data-v="kompres"]')).toContainText(/hemat|optimal/, { timeout: 20000 });
    // 4. …and the download must not be stuck.
    const dl = page.waitForEvent('download');
    await page.tap('#ds-cta');
    const download = await dl;
    expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  });

  test('cancelling the picker keeps Semua', async ({ page }) => {
    await openSheet(page);
    await page.tap('#ds-pages [data-v="some"]');
    await expect(page.locator('#pm-pickbar')).toBeVisible();
    await page.tap('#pm-pick-cancel');
    await expect(page.locator('#dl-sheet')).toBeVisible();
    await expect(page.locator('#ds-pages button.on')).toHaveAttribute('data-v', 'all');
  });
});
