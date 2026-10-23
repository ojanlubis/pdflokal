/*
 * A PHONE PHOTO IS NEVER RASTERED PAST ITS OWN PIXELS.
 * ============================================================================
 * Image pages are one point per source pixel, and the editor asked every page
 * for raster scale 2 or more. A 4032×3024 photo (an ordinary phone camera
 * frame, the jpg-ke-pdf flow) became an 8064×6048 canvas: 48.8MP of pure
 * upsampling, ~195MB, and over iOS Safari's ~16.7MP canvas limit, where it
 * comes back BLANK. render/sharpen.js imageScaleCap now caps an image page at
 * its native density and the device's pixel budget.
 *
 * Asserts the installed raster (the artifact), not the scale we asked for.
 */
import { test, expect } from '@playwright/test';
import { PNG } from 'pngjs';
import { expectFirstPage } from './helpers/render.js';

function photoPng(w, h) {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 200; png.data[i + 1] = 120; png.data[i + 2] = 40; png.data[i + 3] = 255;
  }
  return PNG.sync.write(png, { deflateLevel: 1 });
}

test('a 4032×3024 photo is rastered at no more than its own pixel count', async ({ page }) => {
  test.setTimeout(60000);
  await page.goto('/');
  await page.setInputFiles('#file-input', { name: 'foto.png', mimeType: 'image/png', buffer: photoPng(4032, 3024) });
  await expectFirstPage(page);
  const r = await page.evaluate(() => {
    const p = window.v2.getDoc().pages[0];
    return p.raster ? { w: p.raster.width, h: p.raster.height, scale: p.raster.scale, pw: p.width } : null;
  });
  // Known-positive: this really is a pixels-as-points image page.
  expect(r, 'no raster was installed').not.toBeNull();
  expect(r.pw).toBe(4032);
  expect(r.w * r.h, `raster ${r.w}x${r.h} upsamples the photo`).toBeLessThanOrEqual(4032 * 3024);
  expect(r.w * r.h, `raster ${r.w}x${r.h} is over the 16MP desktop budget`).toBeLessThanOrEqual(16_777_216);
  expect(Math.abs(r.w - r.pw * r.scale), 'raster.scale no longer describes the raster (crops would misread it)').toBeLessThanOrEqual(1);
});
