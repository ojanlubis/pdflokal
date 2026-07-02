/*
 * PDFLokal — core image-as-page import (browser-tested: uses createImageBitmap,
 * vendored PDF.js for the rasterize round-trip, and pdf-lib for the export
 * round-trip).
 *
 * ~15% of files users add are images (a JPG/PNG photo dropped in as a page). This
 * proves js/core/import.js `importImage`:
 *   - decodes the image and makes ONE `isFromImage` page whose POINT size equals
 *     the image's PIXEL size (the convention the old editor + export already use),
 *   - rasterizes that page to a real image (the purge-proof <img> the render layer
 *     shows), honoring page.rotation,
 *   - transcodes non-PNG/JPEG (WEBP) to PNG at import so export can always embed it,
 *   - round-trips through buildPdfBytes to a full-bleed image in the output PDF.
 */
import { test, expect } from '@playwright/test';

// Render page `pageNum` (1-based) of `pdfBytes` with PDF.js at `scale` and return
// a sampler over the resulting canvas — same round-trip strategy as the export
// suite (rendered pixels are what the user actually sees).
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
    numPages: out.numPages,
    rotate: pdfPage.rotate,
    vpWidth: Math.round(vp.width / scale),
    vpHeight: Math.round(vp.height / scale),
    px(x, y) {
      const d = ctx.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data;
      return [d[0], d[1], d[2]];
    },
  };
}

// Sample a 1×1 pixel [r,g,b] from a rasterizer result's PNG dataUrl.
async function samplePixelOfDataUrl(dataUrl, x, y) {
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(x, y, 1, 1).data;
  return [d[0], d[1], d[2]];
}

// A 300×200 PNG: LEFT half (x 0..150) red, RIGHT half (x 150..300) blue. The two
// distinct halves let rotation orientation be asserted (a solid image can't).
function makeHalfRedHalfBluePng() {
  const c = document.createElement('canvas');
  c.width = 300; c.height = 200;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(0, 0, 150, 200);
  ctx.fillStyle = '#0000ff';
  ctx.fillRect(150, 0, 150, 200);
  return c; // caller turns it into bytes
}

test.describe('core image import', () => {
  test('importImage: one isFromImage page at pixel dims; rasterize produces matching pixels', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => !!window.pdfjsLib);

    const r = await page.evaluate(`(async () => {
      ${samplePixelOfDataUrl}
      ${makeHalfRedHalfBluePng}
      const model = await import('/js/core/model.js');
      const imp = await import('/js/core/import.js');

      const c = makeHalfRedHalfBluePng();
      const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
      const bytes = new Uint8Array(await blob.arrayBuffer());

      const doc = model.createDoc();
      const pages = await imp.importImage(doc, { name: 'foto.png', bytes, mimeType: 'image/png' });
      const p0 = doc.pages[0];

      // Rasterize at scale 1 → raster px == point size (== image pixel size).
      const raster = await imp.rasterizePage(doc, p0, { scale: 1 });
      const leftPx = await samplePixelOfDataUrl(raster.dataUrl, 75, 100);   // red half
      const rightPx = await samplePixelOfDataUrl(raster.dataUrl, 225, 100); // blue half

      return {
        returnedPages: pages.length,
        pageCount: doc.pages.length,
        sourceCount: doc.sources.length,
        isFromImage: p0.isFromImage,
        w: p0.width, h: p0.height,
        rotation: p0.rotation,
        sourceNumPages: doc.sources[0].numPages,
        annotationsOwnedByPage: Array.isArray(p0.annotations),
        rasterW: raster.width, rasterH: raster.height,
        isPng: raster.dataUrl.startsWith('data:image/png'),
        leftPx, rightPx,
      };
    })()`);

    expect(r.returnedPages).toBe(1);
    expect(r.pageCount).toBe(1);
    expect(r.sourceCount).toBe(1);
    expect(r.isFromImage).toBe(true);
    expect(r.w).toBe(300);
    expect(r.h).toBe(200);
    expect(r.rotation).toBe(0);
    expect(r.sourceNumPages).toBe(1);
    expect(r.annotationsOwnedByPage).toBe(true);

    // scale 1 → raster px equals the point size equals the image pixel size.
    expect(r.rasterW).toBe(300);
    expect(r.rasterH).toBe(200);
    expect(r.isPng).toBe(true);
    // Pixels: left half red, right half blue.
    expect(r.leftPx[0]).toBeGreaterThan(200); expect(r.leftPx[2]).toBeLessThan(80);
    expect(r.rightPx[2]).toBeGreaterThan(200); expect(r.rightPx[0]).toBeLessThan(80);
  });

  test('importImage → buildPdfBytes: image becomes a full-bleed page in the output PDF', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => !!window.pdfjsLib && !!window.PDFLib);

    const r = await page.evaluate(`(async () => {
      ${renderPage}
      ${makeHalfRedHalfBluePng}
      const model = await import('/js/core/model.js');
      const imp = await import('/js/core/import.js');
      const exp = await import('/js/core/export.js');

      const c = makeHalfRedHalfBluePng();
      const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
      const bytes = new Uint8Array(await blob.arrayBuffer());

      const doc = model.createDoc();
      await imp.importImage(doc, { name: 'foto.png', bytes, mimeType: 'image/png' });

      const outBytes = await exp.buildPdfBytes(doc);
      const s = await renderPage(outBytes, 1, 2);
      return {
        numPages: s.numPages,
        vpWidth: s.vpWidth, vpHeight: s.vpHeight,
        leftPx: s.px(75, 100),   // red half in the rendered PDF page
        rightPx: s.px(225, 100), // blue half
      };
    })()`);

    expect(r.numPages).toBe(1);
    expect(r.vpWidth).toBe(300);  // page point size == image pixel size
    expect(r.vpHeight).toBe(200);
    // Full-bleed image ink survived the round-trip, halves in place.
    expect(r.leftPx[0]).toBeGreaterThan(200); expect(r.leftPx[2]).toBeLessThan(80);
    expect(r.rightPx[2]).toBeGreaterThan(200); expect(r.rightPx[0]).toBeLessThan(80);
  });

  test('importImage with rotation:90: rasterize and export honor the rotated frame', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => !!window.pdfjsLib && !!window.PDFLib);

    const r = await page.evaluate(`(async () => {
      ${renderPage}
      ${samplePixelOfDataUrl}
      ${makeHalfRedHalfBluePng}
      const model = await import('/js/core/model.js');
      const ops = await import('/js/core/operations.js');
      const imp = await import('/js/core/import.js');
      const exp = await import('/js/core/export.js');

      const c = makeHalfRedHalfBluePng();
      const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
      const bytes = new Uint8Array(await blob.arrayBuffer());

      const doc = model.createDoc();
      await imp.importImage(doc, { name: 'foto.png', bytes, mimeType: 'image/png' });
      const p0 = doc.pages[0];
      ops.rotatePage(doc, p0.id, 90); // 90° clockwise: the RED left edge moves to the TOP

      // Rasterize the rotated page: canvas dims swap to 200×300; top half red.
      const raster = await imp.rasterizePage(doc, p0, { scale: 1 });
      const rasterTop = await samplePixelOfDataUrl(raster.dataUrl, 100, 50);    // red (was left)
      const rasterBottom = await samplePixelOfDataUrl(raster.dataUrl, 100, 250); // blue (was right)

      // Export: /Rotate 90 in the output; PDF.js default viewport applies it,
      // so samples are in the same rotated view the user sees.
      const outBytes = await exp.buildPdfBytes(doc);
      const s = await renderPage(outBytes, 1, 2);
      return {
        rasterW: raster.width, rasterH: raster.height,
        rasterTop, rasterBottom,
        rotate: s.rotate,
        vpWidth: s.vpWidth, vpHeight: s.vpHeight,
        exportTop: s.px(100, 50),     // red (was left) in rotated PDF view
        exportBottom: s.px(100, 250), // blue (was right)
      };
    })()`);

    // Rasterized canvas swapped to 200 wide × 300 tall.
    expect(r.rasterW).toBe(200);
    expect(r.rasterH).toBe(300);
    // 90° CW: original left (red) is now the top; original right (blue) the bottom.
    expect(r.rasterTop[0]).toBeGreaterThan(200); expect(r.rasterTop[2]).toBeLessThan(80);
    expect(r.rasterBottom[2]).toBeGreaterThan(200); expect(r.rasterBottom[0]).toBeLessThan(80);

    // Export: rotation is real metadata, viewport swaps, orientation matches raster.
    expect(r.rotate).toBe(90);
    expect(r.vpWidth).toBe(200);
    expect(r.vpHeight).toBe(300);
    expect(r.exportTop[0]).toBeGreaterThan(200); expect(r.exportTop[2]).toBeLessThan(80);
    expect(r.exportBottom[2]).toBeGreaterThan(200); expect(r.exportBottom[0]).toBeLessThan(80);
  });

  test('importImage transcodes non-PNG/JPEG (WEBP) to PNG bytes so export can embed it', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => !!window.pdfjsLib && !!window.PDFLib);

    const r = await page.evaluate(`(async () => {
      ${renderPage}
      ${makeHalfRedHalfBluePng}
      const model = await import('/js/core/model.js');
      const imp = await import('/js/core/import.js');
      const exp = await import('/js/core/export.js');

      const c = makeHalfRedHalfBluePng();
      const webpBlob = await new Promise((res) => c.toBlob(res, 'image/webp'));
      const inputWasWebp = webpBlob.type === 'image/webp'; // guard: Chromium supports webp encode
      const bytes = new Uint8Array(await webpBlob.arrayBuffer());

      const doc = model.createDoc();
      await imp.importImage(doc, { name: 'foto.webp', bytes, mimeType: 'image/webp' });

      const stored = doc.sources[0].bytes;
      // PNG magic: 89 50 4E 47 — the transcode must have run.
      const storedIsPng = stored[0] === 0x89 && stored[1] === 0x50 && stored[2] === 0x4e && stored[3] === 0x47;

      // Export must not throw (it would if bytes were still WEBP) and must render ink.
      const outBytes = await exp.buildPdfBytes(doc);
      const s = await renderPage(outBytes, 1, 2);
      return {
        inputWasWebp,
        storedIsPng,
        w: doc.pages[0].width, h: doc.pages[0].height,
        leftPx: s.px(75, 100),
        rightPx: s.px(225, 100),
      };
    })()`);

    expect(r.inputWasWebp).toBe(true); // confirms we actually exercised the transcode path
    expect(r.storedIsPng).toBe(true);  // source bytes were transcoded to PNG at import
    expect(r.w).toBe(300);
    expect(r.h).toBe(200);
    // Round-trips to a valid, embeddable image with correct colors.
    expect(r.leftPx[0]).toBeGreaterThan(200); expect(r.leftPx[2]).toBeLessThan(80);
    expect(r.rightPx[2]).toBeGreaterThan(200); expect(r.rightPx[0]).toBeLessThan(80);
  });
});
