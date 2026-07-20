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
import { ensurePdfJs } from './vendor.js';

// bytes → append a Source + its Pages (metadata only) to `doc`. Returns the pages.
export async function importPdf(doc, { name, bytes }) {
  // WHY the ensure: pdf.js is no longer a <script> tag in index.html — it is
  // fetched on demand (core/vendor.js). This is the first moment it's genuinely
  // needed, and it's already async, so the load costs the user nothing extra.
  const pdfjsLib = await ensurePdfJs();
  // Defensive .slice(): PDF.js may detach the ArrayBuffer it's handed.
  const pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
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

// Additive, standalone from importPdf's own document handle (already
// destroyed by the time telemetry fires): checks ONLY page 1's text content
// for telemetry's doc_open (spec-telemetry.md §3 — scan-vs-born-digital
// ratio). Full-document text extraction would cost real time on a 200-page
// file for a bucketed yes/no the first page already answers accurately in
// practice. Never throws — a probe failure just means "don't know", and the
// caller treats that as "no text layer" rather than blocking the import.
export async function probeTextLayer(bytes) {
  const pdfjsLib = await ensurePdfJs();
  const pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  try {
    const page = await pdf.getPage(1);
    const content = await page.getTextContent();
    return content.items.some((it) => it.str && it.str.trim().length > 0);
  } finally {
    await pdf.destroy();
  }
}

// pdf-lib (the export adapter) can only embed PNG and JPEG. Anything else
// (WEBP/GIF/BMP/…) is transcoded to PNG HERE, at the browser edge, so the bytes
// stored on the Source are always export-safe and export never has to sniff for
// a format it can't handle.
const EMBEDDABLE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg']);

// bytes (a raw image file) → append a Source + ONE image page to `doc`.
// Sizing convention: the page's point size EQUALS the image's pixel dimensions,
// and export draws the image full-bleed edge-to-edge. This matches BOTH the old
// editor (utils.js convertImageToPdf: addPage([img.width, img.height]) + a
// filling drawImage) AND core/export.js addImagePage — so a JPG dropped into the
// new core produces the same PDF page the old editor did. Chosen over
// fit-in-A4 because it is what shipped and what export already expects; keeping
// the pair consistent is worth more than a paper-size default here.
export async function importImage(doc, { name, bytes, mimeType }) {
  // createImageBitmap decodes PNG/JPEG/WEBP/GIF(first frame) and gives us the
  // intrinsic pixel size — which becomes the page's point size (see above).
  const type = (mimeType || '').toLowerCase();
  const blob = new Blob([bytes.slice()], type ? { type } : undefined);
  const bitmap = await window.createImageBitmap(blob);
  const width = bitmap.width;
  const height = bitmap.height;

  let storeBytes = bytes;
  if (!EMBEDDABLE_IMAGE_TYPES.has(type)) {
    // Transcode to PNG so export's embedPng always succeeds. We already have the
    // decoded bitmap, so this is one canvas draw + toBlob.
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    const pngBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    storeBytes = new Uint8Array(await pngBlob.arrayBuffer());
  }
  if (typeof bitmap.close === 'function') bitmap.close();

  const source = addSource(doc, createSource({ name, bytes: storeBytes, numPages: 1 }));
  const page = createPage({
    source,
    sourcePageNum: 0,
    width,
    height,
    rotation: 0,
    isFromImage: true,
  });
  addPages(doc, [page]);
  return [page];
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
  const imgCache = new Map(); // sourceId -> ImageBitmap promise (image sources)

  function getPdf(sourceId) {
    if (!docCache.has(sourceId)) {
      const source = getSource(doc, sourceId);
      // Chained off ensurePdfJs() rather than reading window.pdfjsLib directly:
      // in practice importPdf() has already loaded it (you cannot rasterize a
      // page you never imported), but rasterizing is the hot path and must not
      // depend on that ordering holding forever. The cached promise makes the
      // already-loaded case free.
      docCache.set(
        sourceId,
        ensurePdfJs().then((lib) => lib.getDocument({ data: source.bytes.slice() }).promise),
      );
    }
    return docCache.get(sourceId);
  }

  function getImageBitmap(sourceId) {
    if (!imgCache.has(sourceId)) {
      const source = getSource(doc, sourceId);
      imgCache.set(sourceId, window.createImageBitmap(new Blob([source.bytes.slice()])));
    }
    return imgCache.get(sourceId);
  }

  async function renderPdfToCanvas(page, scale) {
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

  // Image sources have no PDF.js document — draw the decoded bitmap to a canvas
  // at `scale` (page point size × scale, matching the PDF path's raster px) and
  // bake in the page rotation. Image pages carry no intrinsic /Rotate, so only
  // page.rotation applies. Rotation is clockwise, matching PDF.js viewports.
  async function renderImageToCanvas(page, scale) {
    const bitmap = await getImageBitmap(page.sourceId);
    const rotation = (page.rotation || 0) % 360;
    const drawW = page.width * scale;   // unrotated draw size in px
    const drawH = page.height * scale;
    const rotated = rotation % 180 !== 0; // 90/270 swap the canvas dimensions
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(rotated ? drawH : drawW);
    canvas.height = Math.ceil(rotated ? drawW : drawH);
    const ctx = canvas.getContext('2d');
    // Rotate about the canvas centre, then draw the image centred: the swapped
    // canvas dims mean the rotated image lands edge-to-edge for every quadrant.
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.drawImage(bitmap, -drawW / 2, -drawH / 2, drawW, drawH);
    return canvas;
  }

  function renderToCanvas(page, scale) {
    return page.isFromImage ? renderImageToCanvas(page, scale) : renderPdfToCanvas(page, scale);
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
      for (const p of imgCache.values()) { try { (await p).close(); } catch { /* already gone */ } }
      imgCache.clear();
    },
  };
}
