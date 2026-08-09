/*
 * The Unduh sheet — output pipeline (founder-approved via tappable simulation).
 * Covers: 2-tap fast path with a TRUE size on the button, the honest-compress
 * path (small text PDFs can't shrink → "sudah optimal", never a bigger file),
 * images (single → .jpg, many → .zip), and page picking via Kelola Halaman.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from '../helpers/render.js';
import {
  downloadBytes, expectRealPdf, expectRealJpeg, unzipInPage,
} from '../helpers/download-bytes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'sample-2pages.pdf');
// sample-2pages.pdf is A4 portrait, 595x842pt (read off the fixture). Any
// rasterised page of it must come back at that ratio — an image of some OTHER
// page geometry is not the page it is named after.
const A4_RATIO = 595 / 842;

// core/compress.js ships the INPUT verbatim when the rebuild doesn't win by 3%
// ("file sudah optimal"), and re-rasterises every page to JPEG when it does.
// Those two outcomes differ in whether the export contains extractable text at
// all, so the byte assertions have to know which one happened. Reading the
// label the product itself printed is how — the alternative is asserting text
// that compression legitimately removed and failing a working product.
async function compressKeptTheOriginal(page) {
  const label = await page.locator('#ds-size [data-v="kompres"]').innerText();
  return /optimal/i.test(label);
}

async function openSheet(page) {
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await expectFirstPage(page);
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
    // ⚠️ THIS FILE HAD FIVE DOWNLOAD ASSERTIONS AND OPENED THE BYTES ZERO TIMES
    // (docs/test-suite-audit.md, Class 1). It could not have told the difference
    // between the mobile output pipeline working and it emitting 0-byte,
    // truncated, or blank files — on the surface that most users are on.
    const { buf, filename } = await downloadBytes(page, () => page.tap('#ds-cta'));
    expect(filename).toMatch(/pdflokal\.pdf$/);
    await expectRealPdf(page, buf, { pages: 2, text: ['Test Page 1', 'Test Page 2'] });
    await expect(page.locator('#dl-sheet')).toBeHidden();
  });

  test('compress is HONEST: a tiny text PDF reports "sudah optimal", never grows', async ({ page }) => {
    await openSheet(page);
    await page.tap('#ds-size [data-v="kompres"]');
    // The result lands: either savings or the honesty message.
    await expect(page.locator('#ds-size [data-v="kompres"]')).toContainText(/hemat|optimal/, { timeout: 20000 });

    const kept = await compressKeptTheOriginal(page);
    const { buf, filename } = await downloadBytes(page, () => page.tap('#ds-cta'));
    expect(filename).toMatch(/\.pdf$/);
    // The compress path shipped a file whose only checked property was its
    // extension. Page count and ink hold on BOTH compress outcomes; the text
    // check holds on the one where text still exists (see the helper above).
    await expectRealPdf(page, buf, {
      pages: 2,
      text: kept ? ['Test Page 1', 'Test Page 2'] : [],
    });

    // Never bigger than the original build.
    const sizes = await page.evaluate(() => window.__dsSizes || null);
    if (sizes) expect(sizes.out).toBeLessThanOrEqual(sizes.base);
  });

  test('gambar: all pages → one ZIP', async ({ page }) => {
    await openSheet(page);
    await page.tap('#ds-format [data-v="img"]');
    await expect(page.locator('#ds-cta-main')).toContainText('2 Gambar');
    const { buf, filename } = await downloadBytes(page, () => page.tap('#ds-cta'));
    expect(filename).toMatch(/gambar\.zip$/);

    // `gambar.zip` was the whole assertion. An empty archive, an archive of one
    // page, or an archive of two truncated files all end with that name.
    const entries = await unzipInPage(page, buf);
    expect(entries).toHaveLength(2);
    expect(entries[0].name).toMatch(/-hal-1\.jpg$/);
    expect(entries[1].name).toMatch(/-hal-2\.jpg$/);
    for (const entry of entries) {
      await expectRealJpeg(page, entry.buf, { aspect: A4_RATIO });
    }
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

    const { buf, filename } = await downloadBytes(page, () => page.tap('#ds-cta'));
    expect(filename).toMatch(/hal-1\.jpg$/);

    // ⚠️ A raster carries no text, so this cannot prove page ONE was the page
    // exported — say that out loud rather than let the name imply it. What it
    // DOES prove is that a real, complete, non-blank A4 render came out, which
    // `hal-1.jpg` could never distinguish from 0 bytes or a white sheet.
    await expectRealJpeg(page, buf, { aspect: A4_RATIO });
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
    // 4. …and the download must not be stuck, NOR hand back the pre-re-pick
    //    file. "A .pdf arrived" was the entire assertion, so the two-page
    //    (stale) build and the one-page (correct) build were indistinguishable
    //    — which is the whole failure this test is named after.
    const kept = await compressKeptTheOriginal(page);
    const { buf, filename } = await downloadBytes(page, () => page.tap('#ds-cta'));
    expect(filename).toMatch(/\.pdf$/);
    await expectRealPdf(page, buf, {
      pages: 1,
      text: kept ? ['Test Page 1'] : [],
      absent: kept ? ['Test Page 2'] : [],
    });
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
