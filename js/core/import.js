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
import { editSignature } from './page-surgery.js';

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
//
// `opts.editedPageProvider` (spec-live-surgery.md §4, increment 2): an
// optional async `(page) => ({ bytes } | null)`. When present AND a page
// carries committed edits (`editSignature(page)` non-empty), that page
// rasterizes from page 1 of the PROVIDER's bytes instead of `sourcePageNum`
// of the shared source doc — the edited single-page pdf.js document is
// cached per page.id, keyed by the edit-signature that produced it, so an
// unchanged edit set never re-asks the provider (which itself re-runs the
// surgery pipeline — not free). Injected rather than imported directly: this
// module stays ignorant of how bytes get built (pdf-lib/fontkit loading,
// pairing cover+text annotations into an edit) — that's js/v2/app.js's job,
// kept OUT of this headless-adjacent I/O adapter. `editSignature` itself is
// imported directly (pure core, zero vendor deps, not "v2 code") purely so
// this cache can know WHEN to ask again.
export function createPageRasterizer(doc, opts = {}) {
  const docCache = new Map(); // sourceId -> PDF.js document promise
  const imgCache = new Map(); // sourceId -> ImageBitmap promise (image sources)
  const editedDocCache = new Map(); // page.id -> { signature, docPromise: Promise<PDF.js doc|null> }
  const renderSeq = new Map(); // page.id -> latest ISSUED rasterize seq (stale-guard, see rasterize)

  // Drop (and destroy) any cached edited-page doc for `pageId`. Increment 2
  // wires this method but nothing yet CALLS it on commit/undo/redo (spec
  // build order §8.2 — that's increment 3's job); it exists now so the cache
  // is self-correcting the moment that wiring lands, and so a page whose
  // edit-signature has already changed (checked below) never serves a stale
  // doc even before that wiring exists.
  function invalidateEditedPage(pageId) {
    const cached = editedDocCache.get(pageId);
    if (!cached) return;
    editedDocCache.delete(pageId);
    cached.docPromise.then((pdfDoc) => pdfDoc && pdfDoc.destroy()).catch(() => { /* already gone */ });
  }

  // Resolve the edited-page pdf.js document for `page`, or null when there's
  // no provider, no committed edits, or the provider declined (any throw is
  // swallowed here too — belt and suspenders alongside the provider's own
  // guard — a broken provider must never break rasterization).
  function getEditedDoc(page) {
    if (!opts.editedPageProvider) return null;
    const signature = editSignature(page);
    if (!signature) {
      invalidateEditedPage(page.id); // edits were undone/removed — stop serving stale bytes
      return null;
    }
    const cached = editedDocCache.get(page.id);
    if (cached && cached.signature === signature) return cached.docPromise;
    if (cached) invalidateEditedPage(page.id); // signature moved on — rebuild
    const docPromise = (async () => {
      let result;
      try {
        result = await opts.editedPageProvider(page);
      } catch (err) {
        console.warn('[core/import] editedPageProvider threw, falling back to source render:', err);
        return null;
      }
      if (!result || !result.bytes) return null;
      const pdfjsLib = await ensurePdfJs();
      const bytes = result.bytes;
      return pdfjsLib.getDocument({ data: bytes.slice ? bytes.slice() : Uint8Array.from(bytes) }).promise;
    })();
    editedDocCache.set(page.id, { signature, docPromise });
    return docPromise;
  }

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
    const editedDoc = await getEditedDoc(page);
    const pdf = editedDoc || await getPdf(page.sourceId);
    const pdfPage = editedDoc ? await pdf.getPage(1) : await pdf.getPage(page.sourcePageNum + 1);
    // Edited docs are a single already-baked page — buildEditedPageBytes sets
    // its /Rotate exactly the way buildPdfBytes does (see page-surgery.js),
    // so its OWN metadata is authoritative and pdf.js should just read it —
    // no explicit override, unlike the plain path below. This is also
    // exactly what a downloaded PDF would render as, so the editor's live
    // raster and the final export stay pixel-consistent by construction.
    // Plain path: intrinsic /Rotate + the user's rotation (PDF.js
    // `rotation:` is absolute, not additive over the intrinsic value).
    const vp = editedDoc
      ? pdfPage.getViewport({ scale })
      : pdfPage.getViewport({ scale, rotation: ((page.baseRotation || 0) + (page.rotation || 0)) % 360 });
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
      // Stale-guard (founder doubling bug, 2026-07-20): renderToCanvas is async
      // (getEditedDoc + pdf.js render), so a rasterize issued EARLIER — e.g. a
      // viewport-stream "page entered view" render of the PLAIN page, started
      // before an edit committed — can resolve AFTER a later rebake's render of
      // the EDITED page. Last-ISSUED must win, not last-RESOLVED: otherwise the
      // stale plain raster overwrites page.raster and the edit visually reverts
      // (the intermittent "doubling"/loss the founder saw). Tag each call with a
      // per-page monotonic seq; if a newer rasterize for this page was issued
      // while we rendered, DISCARD this result and keep what the newer one set
      // (return the current raster so a caller's attach() shows it, not stale).
      const seq = (renderSeq.get(page.id) || 0) + 1;
      renderSeq.set(page.id, seq);
      const canvas = await renderToCanvas(page, scale);
      if (renderSeq.get(page.id) !== seq) return page.raster;
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
    invalidateEditedPage,
    async destroy() {
      for (const p of docCache.values()) { try { (await p).destroy(); } catch { /* already gone */ } }
      docCache.clear();
      for (const p of imgCache.values()) { try { (await p).close(); } catch { /* already gone */ } }
      imgCache.clear();
      for (const { docPromise } of editedDocCache.values()) {
        try { const pdfDoc = await docPromise; if (pdfDoc) await pdfDoc.destroy(); } catch { /* already gone */ }
      }
      editedDocCache.clear();
    },
  };
}
