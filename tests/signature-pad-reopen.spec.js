/*
 * BATAL + REOPEN WHILE SIGNATUREPAD IS STILL DOWNLOADING: ONE PAD, NOT TWO.
 * ============================================================================
 * initPad() off()s the previous pad, but on a first open over a slow network
 * there is no pad yet: a cancel + reopen before the library arrives ran two
 * initPads that BOTH constructed a pad on the same canvas once it landed, and
 * the first was never detached (every stroke drawn twice, isEmpty() asking
 * only one of them). Counts the pointer listeners actually live on the canvas.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');
// page.route only sees requests the page makes itself; with the service worker
// up, the vendor fetch is the WORKER's and the delay below never applies.
test.use({ serviceWorkers: 'block' });

test('a reopen during the SignaturePad fetch leaves exactly one live pad', async ({ page }) => {
  await page.addInitScript(() => {
    window.__padDown = 0;
    const add = EventTarget.prototype.addEventListener;
    const rm = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function (type, ...rest) {
      if (this.id === 'sig-canvas' && type === 'pointerdown') window.__padDown += 1;
      return add.call(this, type, ...rest);
    };
    EventTarget.prototype.removeEventListener = function (type, ...rest) {
      if (this.id === 'sig-canvas' && type === 'pointerdown') window.__padDown -= 1;
      return rm.call(this, type, ...rest);
    };
  });
  let release;
  const gate = new Promise((r) => { release = r; });
  await page.route('**/js/vendor/signature_pad.umd.min.js', async (route) => { await gate; await route.continue(); });

  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await expectFirstPage(page);
  await page.click('[data-tool="signature"]');
  await expect(page.locator('#sig-modal')).toBeVisible();
  await page.click('#sig-cancel');
  await expect(page.locator('#sig-modal')).toBeHidden();
  await page.click('[data-tool="signature"]');
  await expect(page.locator('#sig-modal')).toBeVisible();
  release();
  await expect(page.locator('#sig-canvas')).toHaveAttribute('data-ready', 'true');
  await page.waitForTimeout(300); // let a stale init (if any) finish constructing
  // Known-positive: one pad attaches at least one pointerdown listener.
  expect(await page.evaluate(() => window.__padDown), 'two SignaturePads are live on one canvas').toBe(1);
});
