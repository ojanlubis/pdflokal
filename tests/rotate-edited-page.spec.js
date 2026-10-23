/*
 * ROTATING A PAGE THAT CARRIES A COMMITTED EDIT TURNS ITS PICTURE TOO.
 * ============================================================================
 * The edited page is rendered from single-page bytes that page-surgery bakes
 * with /Rotate = the page's total rotation at bake time, and core/import.js
 * caches that pdf.js document by editSignature, which ignores rotation on
 * purpose (a rotate needs no re-bake). The rasterizer then read the cached
 * bytes' OWN /Rotate, so after a rotate the edited page was drawn in its OLD
 * orientation and stretched into the rotated slot, while the downloaded file
 * was right. Screen and file disagreed.
 *
 * Asserts the artifact (the installed raster's pixel shape), not the model's
 * rotation number, which was always right.
 */
import { test, expect } from '@playwright/test';
import { armGanti, tapLine } from './helpers/lines.js';
import { LINE, openDoc } from './helpers/original-delete.js';

const raster = (page) => page.evaluate(() => {
  const r = window.v2.getDoc().pages[0].raster;
  return r ? { w: r.width, h: r.height, key: r.key } : null;
});

test('an edited page rotated 90 degrees is rastered landscape', async ({ page }) => {
  test.setTimeout(60000);
  await openDoc(page);
  await armGanti(page);
  await tapLine(page, { str: LINE, nth: 1 });
  await page.keyboard.type('Rapat Baru');
  await page.keyboard.press('Enter');
  await expect(page.locator('.v2-text-edit')).toHaveCount(0);
  // Known-positive: the edit is baked and the page is portrait before the turn.
  await expect.poll(() => page.evaluate(() => !!window.v2.getDoc().pages[0].editApplied), { timeout: 15000 }).toBe(true);
  const before = await raster(page);
  expect(before.h, 'the fixture page must start portrait').toBeGreaterThan(before.w);

  await page.locator('.pv-strip >> nth=0').locator('[data-strip-act="rotate"]').click();
  await expect.poll(async () => {
    const r = await raster(page);
    return r && r.key !== before.key ? r.w > r.h : null;
  }, { timeout: 15000, message: 'the edited page was re-rastered in its OLD orientation' }).toBe(true);
});
