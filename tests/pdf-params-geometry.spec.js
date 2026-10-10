/*
 * PDFLokal — page geometry, attacked from the format's parameters.
 * Strategy and axes: tests/helpers/pdf-params.js (his ruling 2026-10-10).
 *
 * The promise under test is the product's: what the screen shows is what the
 * download holds. For every pairwise case of MediaBox origin x CropBox x
 * /Rotate x inherited /Rotate x /UserUnit:
 *   - the downloaded page has the shape the screen showed, and
 *   - a word typed on screen sits at the same place in the downloaded page.
 * A failing case prints its parameters in its name; that is the whole repro.
 * Not run by the foreground gate (nightly CI).
 */
import { test, expect } from '@playwright/test';
import { expectFirstPage } from './helpers/render.js';
import { downloadBytes } from './helpers/download-bytes.js';
import { GEOMETRY_AXES, pairwise, caseName, buildGeometryPdf } from './helpers/pdf-params.js';

// Shape of page 1 and where `word` sits, in fractions of the page a reader shows.
async function readDownload(page, buf, word) {
  return page.evaluate(async ({ arr, word }) => {
    const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(arr) }).promise;
    const p = await doc.getPage(1);
    const vp = p.getViewport({ scale: 1 });
    const item = (await p.getTextContent()).items.find((it) => it.str.includes(word));
    const at = item && vp.convertToViewportPoint(item.transform[4], item.transform[5]); // baseline start
    return { aspect: vp.width / vp.height, word: at ? { fx: at[0] / vp.width, fy: at[1] / vp.height } : null };
  }, { arr: Array.from(buf), word });
}

for (const c of pairwise(GEOMETRY_AXES)) {
  test(`geometry: ${caseName(c)}`, async ({ page }) => {
    await page.goto('/');
    const src = await buildGeometryPdf(page, c);
    await page.setInputFiles('#file-input', { name: 'parameter.pdf', mimeType: 'application/pdf', buffer: src });
    await expectFirstPage(page);

    const box = await page.locator('.pv-page').first().boundingBox();
    await page.keyboard.press('t');
    await page.click('.pv-page >> nth=0', { position: { x: box.width * 0.25, y: box.height * 0.3 } });
    await page.keyboard.insertText('Posisi');
    await page.keyboard.press('Enter');
    await expect(page.locator('.pv-anno-text').last()).toHaveText('Posisi');
    const tb = await page.locator('.pv-anno-text').last().boundingBox();
    const screen = { fx: (tb.x - box.x) / box.width, fy: (tb.y + tb.height - box.y) / box.height };

    await page.click('#btn-download');
    const { buf } = await downloadBytes(page, () => page.click('#ds-cta'));
    const file = await readDownload(page, buf, 'Posisi');

    expect(file.aspect / (box.width / box.height), 'the downloaded page has the shape the screen showed').toBeCloseTo(1, 1);
    expect(file.word, 'the typed word is in the downloaded page').not.toBeNull();
    expect(Math.abs(file.word.fy - screen.fy), `down/up: screen ${screen.fy.toFixed(3)} vs file ${file.word.fy.toFixed(3)}`).toBeLessThan(0.04);
    expect(Math.abs(file.word.fx - screen.fx), `across: screen ${screen.fx.toFixed(3)} vs file ${file.word.fx.toFixed(3)}`).toBeLessThan(0.04);
  });
}
