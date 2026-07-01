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
    await page.goto('/');
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
        dataUrlLen: (raster?.dataUrl || '').length,
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
    expect(r.dataUrlLen).toBeGreaterThan(1000); // not a blank/empty image
  });
});
