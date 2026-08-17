/*
 * Opt-in device-saved signature — `#sig-save` and `pdflokal_signature`.
 * ============================================================================
 * spec-signature-save.md §7 names three behaviours and requires each to go RED
 * on revert: checked → written, unchecked → absent, unchecked-after-a-save →
 * removed. The row documenting the key to users lives in
 * tests/privasi-storage-table.spec.js.
 *
 * WHY EVERY TEST PLACES THE ANNOTATION FIRST: "the key is absent" passes for
 * free if the signature flow never ran at all (an assertion over an empty set
 * is free). The placed annotation is the known-positive that says the flow got
 * as far as writing — so a null key means "chose not to save", not "nothing
 * happened". Same reason test 3 asserts the key is PRESENT before asserting it
 * was removed: without that, the removal branch could be dead and the test
 * would still be green.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');
const KEY = 'pdflokal_signature';

async function openDoc(page) {
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await expectFirstPage(page);
}

async function openSigSheet(page) {
  await page.click('[data-tool="signature"]');
  await expect(page.locator('#sig-modal')).toBeVisible();
}

async function drawStroke(page) {
  const box = await page.locator('#sig-canvas').boundingBox();
  await page.mouse.move(box.x + 40, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 90, { steps: 6 });
  await page.mouse.move(box.x + 200, box.y + 50, { steps: 6 });
  await page.mouse.up();
}

// Place it, then read the annotation back. This is the known-positive: it
// proves #sig-use actually completed, which is what makes a null key meaningful.
async function placeAndRead(page) {
  await page.click('.pv-page >> nth=0', { position: { x: 150, y: 250 } });
  const anno = await page.evaluate(() => window.v2.getDoc().pages[0].annotations[0]);
  expect(anno.type).toBe('signature');
  expect(anno.image).toMatch(/^data:image\/png/);
  return anno;
}

const readKey = (page) => page.evaluate((k) => localStorage.getItem(k), KEY);

test.describe('signature save — opt-in, one key, unchecking deletes', () => {
  test('box CHECKED → pdflokal_signature holds the placed signature', async ({ page }) => {
    await openDoc(page);
    await openSigSheet(page);
    await drawStroke(page);
    await page.check('#sig-save');
    await page.click('#sig-use');
    const anno = await placeAndRead(page);

    const stored = await readKey(page);
    expect(stored).toMatch(/^data:image\/png/);
    // Same artifact, not a re-render: what was placed is what was kept.
    expect(stored).toBe(anno.image);
  });

  test('box UNCHECKED (the default) → the key is never written', async ({ page }) => {
    await openDoc(page);
    await openSigSheet(page);
    // Opt-in: the shared-machine case is why this must start off.
    await expect(page.locator('#sig-save')).not.toBeChecked();
    await drawStroke(page);
    await page.click('#sig-use');
    await placeAndRead(page); // the flow DID run — so the null below is a choice

    expect(await readKey(page)).toBeNull();
  });

  test('UNCHECKED after a save → restored on open, box pre-checked, and Pakai removes the key', async ({ page }) => {
    await openDoc(page);
    await openSigSheet(page);
    await drawStroke(page);
    await page.check('#sig-save');
    await page.click('#sig-use');
    await placeAndRead(page);
    const saved = await readKey(page);
    expect(saved).toMatch(/^data:image\/png/); // known-positive: there IS something to remove

    // Fresh page load — the in-memory signature is gone, only the device copy remains.
    await openDoc(page);
    await openSigSheet(page);
    // Stored → the box reads as "kept", so leaving it alone keeps it.
    await expect(page.locator('#sig-save')).toBeChecked();
    // And it is SHOWN: the pad canvas has ink on it without the user drawing.
    // (pad.clear() leaves every pixel at alpha 0, so any opaque pixel is the paint.)
    await expect.poll(async () => page.evaluate(() => {
      const c = document.getElementById('sig-canvas');
      const { data } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
      let n = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 10) n += 1;
      return n;
    }), { timeout: 5_000 }).toBeGreaterThan(0);

    await page.uncheck('#sig-save');
    await page.click('#sig-use');
    const anno = await placeAndRead(page);

    // Verbatim reuse: the untouched restore is handed back as the stored bytes,
    // not re-read off the pad canvas (which would re-scale it every cycle).
    expect(anno.image).toBe(saved);
    // Unchecking + Pakai is the delete control.
    expect(await readKey(page)).toBeNull();
  });
});
