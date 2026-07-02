/*
 * PDFLokal — core/export-images adapter (browser-tested, uses vendored PDF.js +
 * fflate). Proves the new Doc→images path: rasterize PDF bytes to per-page JPG/
 * PNG at a long-edge cap, and bundle them into a round-trippable ZIP. This is
 * the engine behind Editor v2's "Unduh → gambar" sheet.
 *
 * fflate is loaded via page.addScriptTag (it is not in editor-v2.html/lab.html
 * yet), matching how it will be wired as a <script> global (window.fflate).
 */
import { test, expect } from '@playwright/test';

// Build an N-page PDF in-page with PDFLib, each page a solid color fill so the
// rasterized output can be color-checked. Returns Uint8Array bytes.
async function makeColoredPdf(page, colors, w = 400, h = 600) {
  return page.evaluate(async ({ colors, w, h }) => {
    const doc = await window.PDFLib.PDFDocument.create();
    for (const [r, g, b] of colors) {
      const p = doc.addPage([w, h]);
      p.drawRectangle({ x: 0, y: 0, width: w, height: h, color: window.PDFLib.rgb(r, g, b) });
    }
    return Array.from(await doc.save());
  }, { colors, w, h });
}

test.describe('core export-images adapter', () => {
  test('renderPdfToImages: jpg at maxDim, correct names/dims/colors', async ({ page }) => {
    await page.goto('/alat-gambar.html');
    await page.waitForFunction(() => !!window.pdfjsLib && !!window.PDFLib);
    // page 0 red, page 1 blue.
    const pdfBytes = await makeColoredPdf(page, [[1, 0, 0], [0, 0, 1]]);

    const r = await page.evaluate(async (pdfArr) => {
      const mod = await import('/js/core/export-images.js');
      const files = await mod.renderPdfToImages(new Uint8Array(pdfArr), { format: 'jpg', maxDim: 800 });

      // Decode each image → {w, h, centre rgb}.
      const decoded = [];
      for (const f of files) {
        const bmp = await window.createImageBitmap(new Blob([f.bytes], { type: 'image/jpeg' }));
        const canvas = document.createElement('canvas');
        canvas.width = bmp.width;
        canvas.height = bmp.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bmp, 0, 0);
        const px = ctx.getImageData(bmp.width >> 1, bmp.height >> 1, 1, 1).data;
        decoded.push({ name: f.name, w: bmp.width, h: bmp.height, rgb: [px[0], px[1], px[2]] });
      }
      return { count: files.length, decoded };
    }, pdfBytes);

    expect(r.count).toBe(2);
    expect(r.decoded.map((d) => d.name)).toEqual(['halaman-1.jpg', 'halaman-2.jpg']);
    for (const d of r.decoded) {
      const longEdge = Math.max(d.w, d.h);
      expect(longEdge).toBeLessThanOrEqual(800);
      expect(longEdge).toBeGreaterThanOrEqual(700);
    }
    // page 1 red, page 2 blue (JPEG is lossy — generous tolerance).
    expect(r.decoded[0].rgb[0]).toBeGreaterThan(200); // red channel high
    expect(r.decoded[0].rgb[2]).toBeLessThan(80);     // blue channel low
    expect(r.decoded[1].rgb[2]).toBeGreaterThan(200); // blue channel high
    expect(r.decoded[1].rgb[0]).toBeLessThan(80);     // red channel low
  });

  test('renderPdfToImages: pageNumbers selects a subset', async ({ page }) => {
    await page.goto('/alat-gambar.html');
    await page.waitForFunction(() => !!window.pdfjsLib && !!window.PDFLib);
    const pdfBytes = await makeColoredPdf(page, [[1, 0, 0], [0, 0, 1]]);

    const names = await page.evaluate(async (pdfArr) => {
      const mod = await import('/js/core/export-images.js');
      const files = await mod.renderPdfToImages(new Uint8Array(pdfArr), { format: 'jpg', pageNumbers: [2] });
      return files.map((f) => f.name);
    }, pdfBytes);

    expect(names).toEqual(['halaman-2.jpg']);
  });

  test('zipFiles: PK header + round-trips via fflate.unzipSync', async ({ page }) => {
    await page.goto('/alat-gambar.html');
    await page.waitForFunction(() => !!window.pdfjsLib && !!window.PDFLib);
    await page.addScriptTag({ path: 'js/vendor/fflate.min.js' });
    await page.waitForFunction(() => !!window.fflate);
    const pdfBytes = await makeColoredPdf(page, [[1, 0, 0], [0, 0, 1]]);

    const r = await page.evaluate(async (pdfArr) => {
      const mod = await import('/js/core/export-images.js');
      const files = await mod.renderPdfToImages(new Uint8Array(pdfArr), { format: 'jpg', maxDim: 800 });
      const zip = mod.zipFiles(files);
      const back = window.fflate.unzipSync(zip);
      return {
        magic: Array.from(zip.slice(0, 4)),
        original: files.map((f) => ({ name: f.name, len: f.bytes.length })),
        unzipped: Object.keys(back).map((name) => ({ name, len: back[name].length })),
      };
    }, pdfBytes);

    // Local file header signature "PK\x03\x04".
    expect(r.magic).toEqual([0x50, 0x4b, 0x03, 0x04]);
    // Same names + byte lengths survive the round-trip.
    expect(r.unzipped.sort((a, b) => a.name.localeCompare(b.name)))
      .toEqual(r.original.sort((a, b) => a.name.localeCompare(b.name)));
  });

  test('renderPdfToImages: png format produces valid PNG magic bytes', async ({ page }) => {
    await page.goto('/alat-gambar.html');
    await page.waitForFunction(() => !!window.pdfjsLib && !!window.PDFLib);
    const pdfBytes = await makeColoredPdf(page, [[1, 0, 0]]);

    const r = await page.evaluate(async (pdfArr) => {
      const mod = await import('/js/core/export-images.js');
      const files = await mod.renderPdfToImages(new Uint8Array(pdfArr), { format: 'png' });
      return { name: files[0].name, magic: Array.from(files[0].bytes.slice(0, 8)) };
    }, pdfBytes);

    expect(r.name).toBe('halaman-1.png');
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A.
    expect(r.magic).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });
});
