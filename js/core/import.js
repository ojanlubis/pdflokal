/*
 * PDFLokal — core/import.js  (I/O ADAPTER at the browser edge)
 * ============================================================================
 * Turns PDF bytes into a core Doc using the vendored PDF.js (window.pdfjsLib).
 * This is an adapter — it's the ONE place PDF.js touches the model on the way
 * in. The pure core (model.js/operations.js) never imports a vendor lib.
 *
 * `importPdf` reads only METADATA (page count, size, rotation) so opening a
 * 50-page file stays instant. Rasterization is per-page and LAZY via
 * `rasterizePage` — the render layer (Phase 1/2) calls it for pages near the
 * viewport. The raster is what becomes a purge-proof <img> on screen.
 */

import { createSource, createPage, getSource } from './model.js';
import { addSource, addPages } from './operations.js';

// bytes → append a Source + its Pages (metadata only) to `doc`. Returns the pages.
export async function importPdf(doc, { name, bytes }) {
  // Defensive .slice(): PDF.js may detach the ArrayBuffer it's handed.
  const pdf = await window.pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  const source = addSource(doc, createSource({ name, bytes, numPages: pdf.numPages }));

  const pages = [];
  for (let n = 1; n <= pdf.numPages; n += 1) {
    const pdfPage = await pdf.getPage(n);
    const vp = pdfPage.getViewport({ scale: 1 }); // honors the PDF's intrinsic /Rotate
    const page = createPage({
      source,
      sourcePageNum: n - 1,
      width: vp.width,
      height: vp.height,
      rotation: 0,
    });
    // WHY: scanned/landscape PDFs carry an intrinsic /Rotate. PDF.js's explicit
    // `rotation:` param OVERRIDES it (not additive), so rasterize must pass
    // intrinsic + user rotation or pre-rotated documents render sideways.
    page.baseRotation = pdfPage.rotate || 0;
    pages.push(page);
  }
  addPages(doc, pages);
  await pdf.destroy();
  return pages;
}

// Rasterize ONE page to a PNG image at `scale`. Lazy: the render layer calls
// this on demand. Result is stashed on `page.raster` so the DOM can show an
// <img> that survives the mobile GPU-backing-store purge (unlike a live canvas).
//
// One-shot convenience (reloads the PDF.js doc each call). For streaming/windowed
// rendering use createPageRasterizer() below, which caches the doc per source.
export async function rasterizePage(doc, page, opts = {}) {
  const r = createPageRasterizer(doc);
  try { return await r.rasterize(page, opts); }
  finally { await r.destroy(); }
}

// A rasterizer that caches the PDF.js document per source, so windowed/streaming
// rendering (Phase 2) can rasterize many pages without reloading the whole PDF
// each time. This is the render-layer's tool for "3-nearest" loading on any
// document size within a bounded memory budget.
export function createPageRasterizer(doc) {
  const docCache = new Map(); // sourceId -> PDF.js document promise

  function getPdf(sourceId) {
    if (!docCache.has(sourceId)) {
      const source = getSource(doc, sourceId);
      docCache.set(sourceId, window.pdfjsLib.getDocument({ data: source.bytes.slice() }).promise);
    }
    return docCache.get(sourceId);
  }

  async function renderToCanvas(page, scale) {
    const pdf = await getPdf(page.sourceId);
    const pdfPage = await pdf.getPage(page.sourcePageNum + 1);
    // Intrinsic /Rotate + the user's rotation (PDF.js `rotation:` is absolute).
    const rotation = ((page.baseRotation || 0) + (page.rotation || 0)) % 360;
    const vp = pdfPage.getViewport({ scale, rotation });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    await pdfPage.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    return canvas;
  }

  return {
    async rasterize(page, { scale = 2 } = {}) {
      const canvas = await renderToCanvas(page, scale);
      page.raster = { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height, scale };
      return page.raster;
    },
    // Small render for page-manager tiles. Does NOT touch page.raster (the main
    // view's streaming state) — callers cache the result themselves by page.id.
    async rasterizeThumb(page, { width = 150 } = {}) {
      const rotated = (page.rotation || 0) % 180 !== 0;
      const pageW = rotated ? page.height : page.width;
      const canvas = await renderToCanvas(page, width / pageW);
      return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height };
    },
    async destroy() {
      for (const p of docCache.values()) { try { (await p).destroy(); } catch { /* already gone */ } }
      docCache.clear();
    },
  };
}
