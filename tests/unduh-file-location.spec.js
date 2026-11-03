/*
 * PDFLokal — after Unduh, one toast says where the file went.
 *
 * WHY (founder-approved 2026-11-03, the seat's copy): an <a download> saves
 * silently on most phones, and a first-time user does not know to look in
 * Download, or on an iPhone in the Files app. The sheet's one toast now carries
 * the location after every successful download, PDF, image and ZIP alike, and
 * never after a failed one. The toast is a single slot, so a success note that
 * fires on the same download (the ZIP note, the font heads-up) carries the
 * location appended rather than being replaced by it.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';
import { downloadBytes, expectRealPdf } from './helpers/download-bytes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');
const DOWNLOAD = 'File-nya ada di folder Download.';
const IOS = 'File-nya ada di app File, folder Unduhan.';

async function openSheet(page) {
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await expectFirstPage(page);
  await page.click('#btn-download');
  await expect(page.locator('#dl-sheet')).toBeVisible();
}

test('a PDF download says the file is in Download', async ({ page }) => {
  await openSheet(page);
  const { buf } = await downloadBytes(page, () => page.click('#ds-cta'));
  await expectRealPdf(page, buf, { pages: 2 }); // the download really happened
  await expect(page.locator('#toast')).toHaveText(DOWNLOAD);
});

test.describe('on an iPhone', () => {
  test.use({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' });
  test('a PDF download points at the Files app', async ({ page }) => {
    await openSheet(page);
    await downloadBytes(page, () => page.click('#ds-cta'));
    await expect(page.locator('#toast')).toHaveText(IOS);
  });
});

test('a ZIP of images keeps its own note, with the location after it', async ({ page }) => {
  await openSheet(page);
  await page.click('#ds-format [data-v="img"]');
  const { filename } = await downloadBytes(page, () => page.click('#ds-cta'));
  expect(filename).toMatch(/gambar\.zip$/);
  await expect(page.locator('#toast')).toHaveText(`Selesai! 2 gambar dibungkus jadi satu ZIP. ${DOWNLOAD}`);
});

test('a failed export never says where a file went', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await expectFirstPage(page);
  // An untouched file is handed back as its own bytes (core/export.js
  // passThroughSource), so the poisoned loader below needs an edit to reach.
  await page.click('[data-tool="whiteout"]');
  const box = await page.locator('.pv-page').first().boundingBox();
  await page.mouse.move(box.x + 60, box.y + 80);
  await page.mouse.down();
  await page.mouse.move(box.x + 220, box.y + 130, { steps: 8 });
  await page.mouse.up();
  await page.evaluate(async () => {
    const { ensurePdfLib } = await import('/js/core/vendor.js');
    await ensurePdfLib();
    window.PDFLib.PDFDocument.load = () => { throw new Error('Failed to parse PDF document'); };
  });
  await page.click('#btn-download');
  await expect(page.locator('#dl-sheet')).toBeVisible();
  await page.click('#ds-cta');
  // VACUITY GUARD: the failure toast is the one on screen, so the export ran and failed.
  await expect(page.locator('#toast')).toHaveClass(/show/);
  await expect(page.locator('#toast')).not.toHaveText('');
  await expect(page.locator('#toast')).not.toContainText('folder Download');
  await expect(page.locator('#toast')).not.toContainText('Unduhan');
});
