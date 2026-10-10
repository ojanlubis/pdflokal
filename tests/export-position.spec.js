/*
 * PDFLokal — what you see on screen is where it lands in the download.
 *
 * Field report 2026-10-09 (a friend of Fauzan's): Tip-Ex and text were right
 * on the laptop screen, and the downloaded PDF had everything moved DOWN.
 * Export measured from the MediaBox at (0,0); a page whose MediaBox starts
 * above 0 (some scanners and generators write [0 200 612 792]) put every
 * annotation lower by that origin. A CropBox inside the MediaBox shifted them
 * the other way, off the visible page. Fixed in js/core/export.js (visibleBox);
 * tests/core/export-cropbox.test.mjs pins the arithmetic. This spec pins the
 * whole path: type on screen, download, read where the file puts the words.
 *
 * Text, not Tip-Ex, is the probe: a Tip-Ex takes the colour of the paper
 * around it, so on a plain page it is invisible to a pixel check.
 * Not run by the foreground gate (nightly CI).
 */
import { test, expect } from '@playwright/test';
import { expectFirstPage } from './helpers/render.js';
import { downloadBytes } from './helpers/download-bytes.js';

// A blank source page with the given boxes, built with the product's pdf-lib.
async function sourcePdf(page, { media, crop }) {
  await page.addScriptTag({ url: '/js/vendor/pdf-lib.min.js' });
  return Buffer.from(await page.evaluate(async ({ media, crop }) => {
    const d = await window.PDFLib.PDFDocument.create();
    const p = d.addPage([612, 792]);
    p.setMediaBox(...media);
    if (crop) p.setCropBox(...crop);
    return Array.from(await d.save());
  }, { media, crop }));
}

// Where the downloaded file puts `word`, as fractions of the page the reader shows.
async function wordAt(page, buf, word) {
  return page.evaluate(async ({ arr, word }) => {
    const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(arr) }).promise;
    const p = await doc.getPage(1);
    const vp = p.getViewport({ scale: 1 });
    const item = (await p.getTextContent()).items.find((it) => it.str.includes(word));
    if (!item) return null;
    const [x, y] = vp.convertToViewportPoint(item.transform[4], item.transform[5]); // baseline start
    return { fx: x / vp.width, fy: y / vp.height };
  }, { arr: Array.from(buf), word });
}

for (const [label, boxes] of [
  ['a MediaBox that starts above 0 (the field report: everything went down)', { media: [0, 200, 612, 592] }],
  ['a CropBox inside the MediaBox', { media: [0, 0, 612, 792], crop: [0, 0, 612, 592] }],
]) {
  test(`typed text lands where it was typed, on ${label}`, async ({ page }) => {
    await page.goto('/');
    const src = await sourcePdf(page, boxes);
    await page.setInputFiles('#file-input', { name: 'kotak.pdf', mimeType: 'application/pdf', buffer: src });
    await expectFirstPage(page);

    const box = await page.locator('.pv-page').first().boundingBox();
    const at = { x: box.width * 0.25, y: box.height * 0.3 };
    await page.keyboard.press('t');
    await page.click('.pv-page >> nth=0', { position: at });
    await page.keyboard.insertText('Posisi');
    await page.keyboard.press('Enter');
    await expect(page.locator('.pv-anno-text').last()).toHaveText('Posisi');
    // The on-screen baseline start, measured off the rendered text box.
    const tb = await page.locator('.pv-anno-text').last().boundingBox();
    const screen = { fx: (tb.x - box.x) / box.width, fy: (tb.y + tb.height - box.y) / box.height };

    await page.click('#btn-download');
    const { buf } = await downloadBytes(page, () => page.click('#ds-cta'));
    const file = await wordAt(page, buf, 'Posisi');
    expect(file, 'the word is in the downloaded file').not.toBeNull();
    // Within 4% of the page: the text box's padding, never a 200pt shift (25%+).
    expect(Math.abs(file.fy - screen.fy), `down/up: screen ${screen.fy.toFixed(3)} vs file ${file.fy.toFixed(3)}`).toBeLessThan(0.04);
    expect(Math.abs(file.fx - screen.fx), `across: screen ${screen.fx.toFixed(3)} vs file ${file.fx.toFixed(3)}`).toBeLessThan(0.04);
  });
}
