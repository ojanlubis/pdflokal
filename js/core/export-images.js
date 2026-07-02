/*
 * PDFLokal — core/export-images.js  (I/O ADAPTER at the browser edge — IMAGES OUT)
 * ============================================================================
 * Rasterizes PDF bytes to per-page image files (JPG/PNG) and bundles them into
 * a ZIP. This is the engine behind Editor v2's "Unduh → gambar" sheet, which
 * absorbs the old standalone PDF-to-Image tool.
 *
 * Like import.js/export.js this is an ADAPTER: the vendor libs (PDF.js for
 * rasterizing, fflate for zipping) are INJECTED via `opts`/`deps` defaulting to
 * the browser globals, so the module has zero vendor imports and no ueState/DOM
 * coupling beyond the canvas it needs to rasterize.
 *
 * SCALE — the one knob that matters. `maxDim` caps the LONG edge of each output
 * image in pixels; null means native@2x (crisp on retina without a manual cap).
 * A native-points viewport is scale 1, so the scale to hit a long-edge target is
 * maxDim / max(vw, vh). We clamp to 3× so a tiny page asked for a huge maxDim
 * doesn't balloon into a multi-megapixel canvas (memory + upscaling artifacts).
 */

// jpg → image/jpeg is the ONE spot the short format name maps to a MIME type.
const FORMAT_MIME = { jpg: 'image/jpeg', png: 'image/png' };

// WHY 3: never upscale a page past 3× its native points. Beyond that a raster
// is all interpolation — bigger file, no real detail — and risks blowing the
// canvas pixel budget on low-end phones (the target device, see product docs).
const MAX_UPSCALE = 3;

// WHY 2: native@2x is the crisp-on-retina default when no maxDim cap is given,
// matching the render layer's default rasterize scale (import.js rasterize).
const NATIVE_SCALE = 2;

function scaleForPage(viewport1x, maxDim) {
  if (maxDim == null) return NATIVE_SCALE;
  const longEdge = Math.max(viewport1x.width, viewport1x.height);
  // maxDim is a CAP, not a target we upscale to — a page already larger than
  // maxDim shrinks; a smaller one stays capped at MAX_UPSCALE, never inflated
  // to fill maxDim.
  return Math.min(maxDim / longEdge, MAX_UPSCALE);
}

async function canvasToBytes(canvas, mime, quality) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, mime, quality));
  if (!blob) throw new Error('renderPdfToImages: canvas.toBlob returned null');
  return new Uint8Array(await blob.arrayBuffer());
}

// Rasterize PDF `bytes` to an array of { name, bytes } image files, one per
// requested page. Returns the files in requested-page order.
export async function renderPdfToImages(bytes, opts = {}) {
  const {
    pdfjsLib = globalThis.pdfjsLib,
    format = 'jpg',
    maxDim = null,
    quality = 0.85,
    pageNumbers = null, // 1-based; null = all pages
    baseName = 'halaman',
    onProgress = null,
  } = opts;

  if (!pdfjsLib) throw new Error('renderPdfToImages: pdfjsLib is required (inject via opts or load the vendor script)');
  const mime = FORMAT_MIME[format];
  if (!mime) throw new Error(`renderPdfToImages: unsupported format "${format}" (jpg|png)`);
  const ext = format === 'png' ? 'png' : 'jpg';

  // Defensive .slice(): PDF.js may detach the ArrayBuffer it's handed (same
  // guard as import.js / loadPdfDocument).
  const pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  try {
    // null → every page, 1..numPages, in order.
    const nums = pageNumbers ?? Array.from({ length: pdf.numPages }, (_, i) => i + 1);
    const files = [];
    for (let i = 0; i < nums.length; i += 1) {
      const n = nums[i];
      const pdfPage = await pdf.getPage(n);
      const vp1 = pdfPage.getViewport({ scale: 1 }); // honors the PDF's intrinsic /Rotate
      const scale = scaleForPage(vp1, maxDim);
      const vp = pdfPage.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      await pdfPage.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      files.push({ name: `${baseName}-${n}.${ext}`, bytes: await canvasToBytes(canvas, mime, quality) });
      if (onProgress) onProgress({ done: i + 1, total: nums.length, page: n });
    }
    return files;
  } finally {
    await pdf.destroy();
  }
}

// Bundle { name, bytes } files into a ZIP (Uint8Array). `deps` injects fflate so
// the module stays vendor-import-free.
export function zipFiles(files, deps = { fflate: globalThis.fflate }) {
  const fflate = deps.fflate || globalThis.fflate;
  if (!fflate) throw new Error('zipFiles: fflate is required (inject via deps or load the vendor script)');

  const zippable = {};
  for (const { name, bytes } of files) {
    // WHY level 0 for JPEG: JPEG is already entropy-coded — DEFLATE can't shrink
    // it and only burns CPU. Store it (level 0). PNG uses fflate's default level
    // (its internal DEFLATE stream leaves little to gain, but the cost is tiny).
    const isJpeg = /\.jpe?g$/i.test(name);
    zippable[name] = isJpeg ? [bytes, { level: 0 }] : bytes;
  }
  return fflate.zipSync(zippable);
}
