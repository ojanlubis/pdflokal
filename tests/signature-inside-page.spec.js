/*
 * A SIGNATURE PLACED OR ENLARGED AT THE PAGE EDGE STAYS WHOLE INSIDE THE PAGE.
 * ============================================================================
 * The screen does not clip an object at the page edge (.pv-page), every PDF
 * viewer clips the file there. A signature tapped near the bottom-right
 * margin, or dragged bigger by its corner handle, looked whole on screen and
 * arrived cut off in the download.
 *
 * The headless half is tests/core/annotation-inside-page.test.mjs (the clamp
 * in core/operations.js). This spec proves the wiring only a browser can: the
 * tap really goes through placeSignature, the handle drag really goes through
 * resizeAnnotation, and the painted signature sits inside the painted page.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');

const modelInside = (page) => page.evaluate(() => {
  const pg = window.v2.getDoc().pages[0];
  const a = pg.annotations.find((x) => x.type === 'signature');
  return {
    a: { x: a.x, y: a.y, w: a.width, h: a.height },
    page: { w: pg.width, h: pg.height },
    inside: a.x >= 0 && a.y >= 0 && a.x + a.width <= pg.width + 1e-6 && a.y + a.height <= pg.height + 1e-6,
  };
});

async function expectPaintedInside(page) {
  const pv = await page.locator('.pv-page').first().boundingBox();
  const sig = await page.locator('.pv-anno-signature img').first().boundingBox();
  // 1px of slack for sub-pixel layout rounding.
  expect(sig.x).toBeGreaterThanOrEqual(pv.x - 1);
  expect(sig.y).toBeGreaterThanOrEqual(pv.y - 1);
  expect(sig.x + sig.width).toBeLessThanOrEqual(pv.x + pv.width + 1);
  expect(sig.y + sig.height).toBeLessThanOrEqual(pv.y + pv.height + 1);
}

test('a signature tapped at the corner, then dragged bigger, stays whole inside the page', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await expectFirstPage(page);

  await page.click('[data-tool="signature"]');
  await expect(page.locator('#sig-modal')).toBeVisible();
  await expect(page.locator('#sig-canvas')).toHaveAttribute('data-ready', 'true');
  const pad = await page.locator('#sig-canvas').boundingBox();
  await page.mouse.move(pad.x + 40, pad.y + 60);
  await page.mouse.down();
  await page.mouse.move(pad.x + 200, pad.y + 90, { steps: 6 });
  await page.mouse.up();
  await page.click('#sig-use');

  // A tap 4px in from the bottom-right corner: the old placement hung most of
  // the signature off both edges.
  const pv = await page.locator('.pv-page').first().boundingBox();
  await page.click('.pv-page >> nth=0', { position: { x: pv.width - 4, y: pv.height - 4 } });
  await expect(page.locator('.pv-anno-signature')).toHaveCount(1);
  const placed = await modelInside(page);
  expect(placed.inside, JSON.stringify(placed)).toBe(true);
  await expectPaintedInside(page);

  // Drag it in from the corner (a real move gesture), then drag its handle
  // far past the right edge.
  const sb = await page.locator('.pv-anno-signature').first().boundingBox();
  await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
  await page.mouse.down();
  await page.mouse.move(sb.x + sb.width / 2 - pv.width * 0.3, sb.y + sb.height / 2 - pv.height * 0.5, { steps: 8 });
  await page.mouse.up();
  const handle = page.locator('.pv-handle').first();
  await expect(handle).toBeVisible();
  // The page is taller than the viewport: bring the handle on screen first.
  await handle.scrollIntoViewIfNeeded();
  const hb = await handle.boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + 400, hb.y + 150, { steps: 8 });
  await page.mouse.up();
  const grown = await modelInside(page);
  expect(grown.a.w, 'the drag did enlarge it (known-positive)').toBeGreaterThan(placed.a.w);
  expect(grown.inside, JSON.stringify(grown)).toBe(true);
  await expectPaintedInside(page);
});
