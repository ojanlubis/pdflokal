/*
 * A PORTRAIT PHONE PHOTO MUST EXPORT PORTRAIT.
 * ============================================================================
 * Phone cameras store the sensor's landscape pixels and an EXIF Orientation tag
 * saying how to turn them. `createImageBitmap` (and every <img>) applies the
 * tag, so the preview is right. pdf-lib's embedJpg does NOT read EXIF: it
 * embeds the raw landscape pixels. If import stores the raw bytes and sizes the
 * page from the oriented bitmap, export stretches sideways pixels into a
 * portrait box — the preview is right and the file is wrong, which is the
 * worst version of a bug because the user only finds out after they have it.
 *
 * MEASURED 2026-09-06 against the pre-fix import.js: the page and preview came
 * out 200×300 (correct) and the exported top pixel read (1, 1, 255) — blue
 * where red belongs. The bug was real; js/core/import.js re-encodes a turned
 * JPEG from the oriented bitmap now, and this is its red-on-revert proof.
 *
 * FIXTURE: 300×200 raw pixels (left half red, right half blue) with
 * Orientation=6 (rotate 90° CW to display). Displayed correctly it is 200 wide
 * × 300 tall with RED ON TOP and BLUE AT THE BOTTOM. Generated with PIL, byte
 * for byte in tests/fixtures/exif-o6-red-blue.jpg.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'exif-o6-red-blue.jpg');

async function renderPage(pdfBytes, pageNum, scale) {
  const out = await window.pdfjsLib.getDocument({ data: pdfBytes.slice() }).promise;
  const pdfPage = await out.getPage(pageNum);
  const vp = pdfPage.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  await pdfPage.render({ canvasContext: ctx, viewport: vp }).promise;
  return {
    vpWidth: Math.round(vp.width / scale),
    vpHeight: Math.round(vp.height / scale),
    px(x, y) {
      const d = ctx.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data;
      return [d[0], d[1], d[2]];
    },
  };
}

test.describe('image import — EXIF orientation', () => {
  test('an Orientation=6 JPEG imports as a portrait page and exports with red on top', async ({ page }) => {
    await page.goto('/alat-gambar.html');
    await page.waitForFunction(() => !!window.pdfjsLib && !!window.PDFLib);
    const bytes = Array.from(fs.readFileSync(FIXTURE));

    const r = await page.evaluate(`(async (arr) => {
      ${renderPage}
      const model = await import('/js/core/model.js');
      const imp = await import('/js/core/import.js');
      const exp = await import('/js/core/export.js');
      const doc = model.createDoc();
      await imp.importImage(doc, { name: 'foto.jpg', bytes: new Uint8Array(arr), mimeType: 'image/jpeg' });
      const p0 = doc.pages[0];
      // The preview the user sees: the rasterizer, scale 1.
      const raster = await imp.rasterizePage(doc, p0, { scale: 1 });
      const outBytes = await exp.buildPdfBytes(doc);
      const s = await renderPage(outBytes, 1, 1);
      return {
        pageW: p0.width, pageH: p0.height,
        rasterW: raster.width, rasterH: raster.height,
        vpWidth: s.vpWidth, vpHeight: s.vpHeight,
        top: s.px(100, 40),      // should be RED (displayed top)
        bottom: s.px(100, 260),  // should be BLUE (displayed bottom)
      };
    })(${JSON.stringify(bytes)})`);

    // The page is the DISPLAYED shape: portrait 200×300.
    expect([r.pageW, r.pageH]).toEqual([200, 300]);
    expect([r.rasterW, r.rasterH]).toEqual([200, 300]);
    expect([r.vpWidth, r.vpHeight]).toEqual([200, 300]);
    // And the exported pixels are the displayed pixels: red on top, blue below.
    // (Pre-fix: top read (1,1,255) — the raw landscape pixels stretched sideways.)
    expect(r.top[0], 'top must be red').toBeGreaterThan(200);
    expect(r.top[2], 'top must not be blue').toBeLessThan(80);
    expect(r.bottom[2], 'bottom must be blue').toBeGreaterThan(200);
    expect(r.bottom[0], 'bottom must not be red').toBeLessThan(80);
  });
});
