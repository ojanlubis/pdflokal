/*
 * PDFLokal — ueRemoveAnnotation keeps selectedAnnotation correct (Sentry JS-4).
 * Removing an EARLIER sibling on the same page used to leave selection pointing
 * one slot off (→ crash in ueGetResizeHandle on the next tap).
 */
import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_PDF = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');

async function loadWithThreeAnnos(page) {
  await page.goto('/alat-gambar.html');
  await page.setInputFiles('#file-input', SAMPLE_PDF);
  await page.waitForFunction(() => window.ueState?.pages?.length === 2);
  await page.evaluate(() => {
    for (const x of [100, 200, 300]) {
      window.ueAddAnnotation(0, { type: 'whiteout', x, y: 1, width: 10, height: 10 });
    }
  });
}

const sel = (page) => page.evaluate(() => window.ueState.selectedAnnotation);
const selX = (page) => page.evaluate(() => {
  const s = window.ueState.selectedAnnotation;
  return s ? window.ueState.annotations[s.pageIndex][s.index].x : null;
});

test.describe('ueRemoveAnnotation selection integrity', () => {
  test('removing an earlier sibling shifts selection down by one (same anno)', async ({ page }) => {
    await loadWithThreeAnnos(page);
    await page.evaluate(() => { window.ueState.selectedAnnotation = { pageIndex: 0, index: 2 }; });

    await page.evaluate(() => window.ueRemoveAnnotation(0, 0)); // remove index 0

    expect(await sel(page)).toEqual({ pageIndex: 0, index: 1 });
    expect(await selX(page)).toBe(300); // still the SAME annotation
  });

  test('removing the selected annotation clears selection', async ({ page }) => {
    await loadWithThreeAnnos(page);
    await page.evaluate(() => { window.ueState.selectedAnnotation = { pageIndex: 0, index: 1 }; });
    await page.evaluate(() => window.ueRemoveAnnotation(0, 1));
    expect(await sel(page)).toBeNull();
  });

  test('removing a later sibling leaves selection untouched', async ({ page }) => {
    await loadWithThreeAnnos(page);
    await page.evaluate(() => { window.ueState.selectedAnnotation = { pageIndex: 0, index: 0 }; });
    await page.evaluate(() => window.ueRemoveAnnotation(0, 2));
    expect(await sel(page)).toEqual({ pageIndex: 0, index: 0 });
    expect(await selX(page)).toBe(100);
  });
});
