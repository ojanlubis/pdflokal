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
    const vp = pdfPage.getViewport({ scale: 1 }); // intrinsic, unrotated size
    pages.push(createPage({
      source,
      sourcePageNum: n - 1,
      width: vp.width,
      height: vp.height,
      rotation: 0,
    }));
  }
  addPages(doc, pages);
  await pdf.destroy();
  return pages;
}

// Rasterize ONE page to a PNG image at `scale`. Lazy: the render layer calls
// this on demand. Result is stashed on `page.raster` so the DOM can show an
// <img> that survives the mobile GPU-backing-store purge (unlike a live canvas).
//
// NOTE: reloads the PDF.js document per call for now — a per-source doc cache
// is a render-layer concern (Phase 2), deliberately not baked into the adapter.
export async function rasterizePage(doc, page, { scale = 2 } = {}) {
  const source = getSource(doc, page.sourceId);
  if (!source) return null;

  const pdf = await window.pdfjsLib.getDocument({ data: source.bytes.slice() }).promise;
  const pdfPage = await pdf.getPage(page.sourcePageNum + 1);
  const vp = pdfPage.getViewport({ scale, rotation: page.rotation });

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  await pdfPage.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  await pdf.destroy();

  page.raster = {
    dataUrl: canvas.toDataURL('image/png'),
    width: canvas.width,
    height: canvas.height,
    scale,
  };
  return page.raster;
}
