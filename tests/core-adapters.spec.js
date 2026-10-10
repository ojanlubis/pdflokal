/*
 * PDFLokal — core I/O adapters (browser-tested, because they use vendored PDF.js).
 *
 * The headless model/operations are tested by `npm run test:core` (node). The
 * import/export ADAPTERS touch window.pdfjsLib / window.PDFLib, so they're
 * verified here in a real browser. This proves the core can ingest a real PDF
 * into the new Doc model and rasterize a page to a real image (the raster that
 * becomes a purge-proof <img> in Phase 1).
 */
import { test, expect } from '@playwright/test';

test.describe('core import adapter', () => {
  test('importPdf builds a Doc; rasterizePage produces a real image', async ({ page }) => {
    await page.goto('/alat-gambar.html');
    await page.waitForFunction(() => !!window.pdfjsLib);

    const r = await page.evaluate(async () => {
      const model = await import('/js/core/model.js');
      const imp = await import('/js/core/import.js');

      const res = await fetch('/tests/fixtures/sample-2pages.pdf');
      const bytes = new Uint8Array(await res.arrayBuffer());

      const doc = model.createDoc();
      const pages = await imp.importPdf(doc, { name: 'sample.pdf', bytes });

      // Rasterize the first page at scale 1.
      const raster = await imp.rasterizePage(doc, doc.pages[0], { scale: 1 });

      return {
        pageCount: doc.pages.length,
        sourceCount: doc.sources.length,
        p0w: Math.round(doc.pages[0].width),
        p0h: Math.round(doc.pages[0].height),
        // page metadata comes from importPdf, not a parallel map:
        annotationsOwnedByPage: Array.isArray(doc.pages[0].annotations),
        importReturnedPages: pages.length,
        hasRaster: !!doc.pages[0].raster,
        rasterW: raster?.width || 0,
        rasterH: raster?.height || 0,
        isPngDataUrl: (raster?.dataUrl || '').startsWith('data:image/png'),
        // Decode the PNG and COUNT INK (pixels that are not near-white). A blank
        // 612x792 PNG is still a few KB of base64, so a byte length passed for a
        // page that rendered nothing.
        ...(await (async () => {
          if (!raster?.dataUrl) return { inkPx: 0, totalPx: 0 };
          const img = new Image();
          img.src = raster.dataUrl;
          await img.decode();
          const c = document.createElement('canvas');
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0);
          const d = ctx.getImageData(0, 0, c.width, c.height).data;
          let ink = 0;
          for (let i = 0; i < d.length; i += 4) {
            if (d[i + 3] > 0 && (d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200)) ink += 1;
          }
          return { inkPx: ink, totalPx: c.width * c.height };
        })()),
      };
    });

    // Structure: 1 source, 2 pages, each owning its own annotations array.
    expect(r.pageCount).toBe(2);
    expect(r.sourceCount).toBe(1);
    expect(r.importReturnedPages).toBe(2);
    expect(r.annotationsOwnedByPage).toBe(true);
    expect(r.p0w).toBeGreaterThan(0);
    expect(r.p0h).toBeGreaterThan(0);

    // Raster: a real, non-trivial PNG matching the page dimensions.
    expect(r.hasRaster).toBe(true);
    expect(r.isPngDataUrl).toBe(true);
    expect(r.rasterW).toBe(r.p0w); // scale 1 → raster px == point size
    expect(r.rasterH).toBe(r.p0h);
    // Catches: a raster that is blank (nothing drawn) or solid (a black/garbage
    // fill) — the old `dataUrlLen > 1000` passed a blank page.
    expect(r.totalPx).toBe(r.rasterW * r.rasterH);
    expect(r.inkPx, 'the raster has no ink: the page rendered blank').toBeGreaterThan(0);
    expect(r.inkPx, 'the raster is mostly ink: not a page, a fill').toBeLessThan(r.totalPx / 2);
  });
});
