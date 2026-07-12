/*
 * PDFLokal — core/compress.js  (RASTERIZING COMPRESSOR at the browser edge)
 * ============================================================================
 * Real, honest PDF compression for Editor v2's "Unduh" sheet.
 *
 * THE PLACEBO HISTORY — read this before "improving" it back to a save():
 *   The old standalone tool (js/pdf-tools/standalone-tools.js `compressPDF`)
 *   only re-ran pdf-lib `save({ useObjectStreams: true })`. That rewrites the
 *   PDF's object structure but NEVER touches the embedded images — for the
 *   image-heavy scans users actually try to shrink (KTP photos, WhatsApp'd
 *   documents, upload-limit fights) it saved ~0%. It even told the user so.
 *   This module does the thing that actually wins: RE-RASTERIZE.
 *
 * THE PIPELINE:
 *   pdfjsLib renders each page to a canvas at a scale that caps the page's
 *   LONG edge at `maxDim` px → the canvas is JPEG-encoded at `quality` → the
 *   JPEG is embedded into a NEW pdf-lib doc as a full-bleed image on a page
 *   sized to the ORIGINAL page's point dimensions. The output prints at the
 *   same physical size; only the pixel payload shrinks.
 *
 * THE TRADE-OFF (documented on purpose):
 *   Output pages are IMAGES — text is no longer selectable/searchable. That is
 *   the correct trade for the target use case (scans, photo-heavy docs, hard
 *   upload caps) and is exactly what commercial "Compress PDF" tools do for
 *   image-heavy files. For a text PDF this pipeline usually LOSES (a rasterized
 *   page of text is bigger than the vector original) — the honesty guard below
 *   catches that and returns the input untouched.
 *
 * THE HONESTY GUARD:
 *   If the rebuilt PDF is not at least `SIGNIFICANT_SAVING_RATIO` smaller than
 *   the input, we return the INPUT bytes with `unchanged: true`. We never hand
 *   back a "compressed" file that is the same size or bigger.
 *
 * BOUNDARIES (same discipline as import.js/export.js):
 *   Vendor libs (PDFLib, pdfjsLib) are INJECTED via `deps`, defaulting to the
 *   browser globals — this module has zero vendor imports, no ueState, and no
 *   knowledge of the DOM model. Rasterization inherently needs a canvas; that
 *   is the one platform dependency, and it prefers OffscreenCanvas so a future
 *   Web Worker (see docs/future-architecture.md) can run this off the main
 *   thread unchanged.
 */

// WHY 0.97: require the rebuilt PDF to be at least 3% smaller before we ship
// it. Below that the "win" is noise (or negative) and not worth degrading text
// to images — return the original instead. See the honesty guard above.
const SIGNIFICANT_SAVING_RATIO = 0.97;

// WHY cap upscale at 2×: `maxDim / longEdge` is the scale that makes the long
// edge exactly `maxDim`. For a small page that ratio is > 1 (upscaling), which
// only inflates the file without adding real detail. A standard Letter/A4 page
// (~792pt long) renders at ~2× ≈ 1584px, plenty for a readable scan, so 2 is
// both the natural cap and a sane ceiling.
const MAX_UPSCALE = 2;

// Prefer OffscreenCanvas (Worker-safe, future-proof) but fall back to a DOM
// canvas on the main thread. PDF.js renders into either via a 2D context.
function makeCanvas(width, height) {
  // globalThis.OffscreenCanvas (not the bare global) keeps this lint-clean under
  // the browser-globals eslint config without touching that config.
  if (typeof globalThis.OffscreenCanvas !== 'undefined') return new globalThis.OffscreenCanvas(width, height);
  if (typeof document !== 'undefined' && document.createElement) {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    return c;
  }
  throw new Error('compressPdfBytes: no canvas implementation available');
}

// Canvas → JPEG bytes, handling both OffscreenCanvas (convertToBlob) and a DOM
// canvas (toBlob). Returns a Uint8Array ready for pdf-lib embedJpg.
async function canvasToJpegBytes(canvas, quality) {
  let blob;
  if (typeof canvas.convertToBlob === 'function') {
    blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  } else {
    blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  }
  if (!blob) throw new Error('compressPdfBytes: canvas JPEG encoding failed');
  return new Uint8Array(await blob.arrayBuffer());
}

// Compress PDF bytes by re-rasterizing every page to a capped-resolution JPEG.
// `deps` injects the vendor libs + tuning so the module stays vendor-free.
//   { PDFLib, pdfjsLib, quality = 0.72, maxDim = 1600, onProgress = null }
// Returns { bytes, originalSize, size, unchanged }:
//   unchanged === true  → `bytes` is the untouched input (see honesty guard).
//   onProgress(done, total) fires once per finished page.
export async function compressPdfBytes(bytes, deps = {}) {
  const PDFLib = deps.PDFLib || globalThis.PDFLib;
  const pdfjsLib = deps.pdfjsLib || globalThis.pdfjsLib;
  if (!PDFLib) throw new Error('compressPdfBytes: PDFLib is required (inject via deps or load the vendor script)');
  if (!pdfjsLib) throw new Error('compressPdfBytes: pdfjsLib is required (inject via deps or load the vendor script)');

  const quality = deps.quality ?? 0.72;
  const maxDim = deps.maxDim ?? 1600;
  const onProgress = deps.onProgress ?? null;

  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const originalSize = input.length;
  return compressOnce(input, { PDFLib, pdfjsLib, quality, maxDim, onProgress, originalSize });
}

// The single-pass rebuild. Split out of compressPdfBytes so the target-size search
// below can call it repeatedly at different settings without duplicating the
// pipeline. Behaviour is byte-identical to what compressPdfBytes always did.
async function compressOnce(input, { PDFLib, pdfjsLib, quality, maxDim, onProgress, originalSize }) {

  // WHY .slice(): PDF.js detaches the ArrayBuffer it's handed. We MUST keep
  // `input` intact — the honesty guard returns it verbatim when compression
  // doesn't win, so it can't be left detached.
  const pdf = await pdfjsLib.getDocument({ data: input.slice() }).promise;
  const total = pdf.numPages;

  const newDoc = await PDFLib.PDFDocument.create();

  for (let n = 1; n <= total; n += 1) {
    const pdfPage = await pdf.getPage(n);
    // scale:1 viewport already honors the page's intrinsic /Rotate (same as
    // import.js) — width/height are the UPRIGHT point dims the viewer shows.
    const base = pdfPage.getViewport({ scale: 1 });
    const pointW = base.width;
    const pointH = base.height;

    const longEdge = Math.max(pointW, pointH);
    const renderScale = Math.min(maxDim / longEdge, MAX_UPSCALE);
    const vp = pdfPage.getViewport({ scale: renderScale });

    const canvas = makeCanvas(Math.max(1, Math.ceil(vp.width)), Math.max(1, Math.ceil(vp.height)));
    const ctx = canvas.getContext('2d');
    // Flatten transparency onto white — JPEG has no alpha, and a scan's
    // background should be paper-white, not black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await pdfPage.render({ canvasContext: ctx, viewport: vp }).promise;

    const jpegBytes = await canvasToJpegBytes(canvas, quality);
    const img = await newDoc.embedJpg(jpegBytes);
    // New page carries NO /Rotate — the pixels are already upright, so a
    // rotation flag would double-rotate them. Size follows the rotated view.
    const outPage = newDoc.addPage([pointW, pointH]);
    outPage.drawImage(img, { x: 0, y: 0, width: pointW, height: pointH });

    // Free per-page memory eagerly — big docs on 1-juta phones can't hold every
    // page's canvas + PDF.js operator list at once.
    pdfPage.cleanup();
    canvas.width = 0;
    canvas.height = 0;

    if (onProgress) onProgress(n, total);
  }

  await pdf.destroy();

  const rebuilt = await newDoc.save({ useObjectStreams: true, addDefaultPage: false });

  // Honesty guard: only ship the rebuild if it genuinely won.
  if (rebuilt.length > originalSize * SIGNIFICANT_SAVING_RATIO) {
    return { bytes: input, originalSize, size: originalSize, unchanged: true };
  }
  return { bytes: rebuilt, originalSize, size: rebuilt.length, unchanged: false };
}

// ---- TARGET-SIZE COMPRESSION ------------------------------------------------
//
// WHY THIS EXISTS (Jul 2026 — the SEO/keyword research is the product research):
//   Indonesians do not search for "compress PDF". They search for "kompres pdf
//   500kb", "kompres pdf 1mb", "kompres pdf 100kb". Google's own Keyword Planner
//   clusters these into a concept group it names "Jumlah: 1mb, 500kb, 100kb…".
//   The reason is CPNS, SNBP, SNBT, beasiswa and e-filing portals, which reject a
//   berkas over a hard cap — usually without saying why.
//
//   So the job is not "make it smaller". The job is "MAKE IT FIT". Every global
//   competitor serves the first. Nobody serves the second. This function is the
//   difference, and it is the reason /kompres-pdf-500kb is allowed to exist as a
//   page at all (a page must change what the tool DOES, or it's a doorway page).
//
//   This also supersedes the old "the ONE preset, no levels until data asks"
//   call in download-sheet.js. The data asked.
//
// THE LADDER: quality and resolution fall together. Dropping only one of them
// looks worse at the same file size — a sharp-but-blocky page (low quality, high
// res) and a smooth-but-mushy page (high quality, low res) are both worse than
// stepping both down in concert.
export const COMPRESS_LADDER = [
  { quality: 0.82, maxDim: 2000 },
  { quality: 0.72, maxDim: 1600 }, // the old fixed preset — still the sane default
  { quality: 0.62, maxDim: 1400 },
  { quality: 0.55, maxDim: 1200 },
  { quality: 0.46, maxDim: 1000 },
  { quality: 0.38, maxDim: 850 },
  { quality: 0.30, maxDim: 700 },
  { quality: 0.24, maxDim: 560 },
];

// Compress until the output fits `targetBytes`, at the HIGHEST quality that fits.
//   { targetBytes, PDFLib, pdfjsLib, onProgress }
// Returns { bytes, originalSize, size, unchanged, reachedTarget, rung, attempts }.
//   reachedTarget === false → we could not get under the cap; `bytes` is the
//   smallest we managed. TELL THE USER THAT. Never round a 620 KB result down to
//   "500 KB ✓" — a berkas that silently fails the portal's check is worse than one
//   the user knows is too big.
export async function compressToTargetBytes(bytes, deps = {}) {
  const PDFLib = deps.PDFLib || globalThis.PDFLib;
  const pdfjsLib = deps.pdfjsLib || globalThis.pdfjsLib;
  if (!PDFLib) throw new Error('compressToTargetBytes: PDFLib is required');
  if (!pdfjsLib) throw new Error('compressToTargetBytes: pdfjsLib is required');
  const targetBytes = deps.targetBytes;
  if (!targetBytes || targetBytes <= 0) throw new Error('compressToTargetBytes: targetBytes is required');
  const onProgress = deps.onProgress ?? null;

  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const originalSize = input.length;

  // Already fits. Never re-encode a file that is already compliant — that only
  // degrades it for nothing. (The honesty guard's sibling.)
  if (originalSize <= targetBytes) {
    return { bytes: input, originalSize, size: originalSize, unchanged: true, reachedTarget: true, rung: null, attempts: 0 };
  }

  // BINARY SEARCH, not a linear walk. Output size falls monotonically as the rung
  // index rises, so we can find the highest-quality rung that fits in ~3 passes
  // instead of up to 8. Each pass re-rasterizes every page — on a 1-juta phone
  // with a 20-page scan, 3 passes vs 8 is the difference between "slow" and
  // "the tab died".
  let lo = 0;
  let hi = COMPRESS_LADDER.length - 1;
  let fit = null;      // best (highest-quality) result that fits
  let smallest = null; // fallback if nothing fits
  let attempts = 0;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const rung = COMPRESS_LADDER[mid];
    attempts += 1;
    const pass = attempts;
    const out = await compressOnce(input, {
      PDFLib, pdfjsLib, ...rung, originalSize,
      onProgress: onProgress ? (done, total) => onProgress({ done, total, pass }) : null,
    });

    if (!smallest || out.size < smallest.size) smallest = { ...out, rung };

    if (out.size <= targetBytes) {
      fit = { ...out, rung };
      hi = mid - 1; // try for better quality
    } else {
      lo = mid + 1; // need more compression
    }
  }

  const win = fit || smallest;
  return {
    bytes: win.bytes,
    originalSize,
    size: win.size,
    unchanged: win.unchanged,
    reachedTarget: Boolean(fit),
    rung: win.rung,
    attempts,
  };
}
