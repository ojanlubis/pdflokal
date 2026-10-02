/*
 * PDFLokal — core/vendor.js  (ON-DEMAND VENDOR LOADER)
 * ============================================================================
 * SINGLE SOURCE OF TRUTH for pulling in the heavy vendor libraries, lazily.
 *
 * WHY this exists (Jul 2026, SEO/performance pass):
 *   index.html used to load five vendor libs as plain <script> tags at the
 *   bottom of <body> — pdf.js (312 KB) + pdf-lib (512 KB) + fontkit (740 KB) +
 *   SignaturePad (11 KB) + fflate (32 KB) = ~1.6 MB, on EVERY page load,
 *   including for a visitor who never opens a file and for Googlebot. Nothing
 *   painted until they finished downloading and parsing — brutal on the
 *   mid-range Android our paid funnel buys, and a Core Web Vitals failure that
 *   directly caps how well the landing pages can rank.
 *
 *   None of them is needed to show a landing page:
 *     pdf.js       — only when a PDF is imported / rasterized
 *     pdf-lib      — only at export (building the output PDF)
 *     fontkit      — only at export (embedding custom fonts)
 *     SignaturePad — only when the signature sheet opens
 *     fflate       — only on the images-ZIP path
 *
 * HOW: each ensureX() injects its <script> once and caches the PROMISE, so N
 * concurrent callers cause exactly ONE network fetch. Idempotent: calling it
 * after the lib is already up is a no-op that resolves immediately.
 *
 * CONTRACT: call `await ensureX()` in the SHELL (js/v2/*), at the point of
 * intent — before importing a PDF, before an export, before opening the
 * signature sheet. The pure core (compress.js / export-images.js / export.js)
 * keeps taking its libs via injected `deps`; it must never grow a dependency on
 * this module, or it stops being testable headlessly (tests/core/).
 *
 * Paths are ABSOLUTE ('/js/vendor/…') on purpose: the SEO landing pages live at
 * /gabung-pdf, /kompres-pdf, … and a relative path would resolve against the
 * wrong base on any nested route we add later.
 */

const inflight = new Map(); // src -> Promise

// ONE ATTEMPT = one <script> element. A failed element is removed so a retry
// does not leave a dead tag behind for every blip.
function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = false; // preserve execution order if two land together
    el.onload = () => resolve();
    el.onerror = () => {
      el.remove();
      reject(new Error(`Gagal memuat ${src}`));
    };
    document.head.appendChild(el);
  });
}

// WHY MORE THAN ONE ATTEMPT (rail 2026-09-18 → 09-30, five sessions): these
// libs load at the moment of intent, and on export that moment is the first
// time a photo-only or text-only document needs pdf-lib/fontkit at all
// (~1.2 MB, fetched on whatever network the phone has right then). One dropped
// request aborted the whole build, reported as export/unknown, and the user
// retyped Unduh against a stored error until they closed and reopened the
// sheet. A blip is not a verdict: try again once, shortly, before saying so.
//
// The thrown error is marked `vendorLoadFailed`. core/failure-reason.js reads
// the flag (it has no imports, by design) to file this under cause `fetch`
// instead of letting the message's own words — "fontkit" — read as a font
// fault; download-sheet.js reads it to know a rebuild is worth trying.
export const LOAD_ATTEMPTS = 2;
export const LOAD_RETRY_MS = 800;

function loadScript(src) {
  if (inflight.has(src)) return inflight.get(src);

  const p = (async () => {
    let lastErr;
    for (let attempt = 0; attempt < LOAD_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, LOAD_RETRY_MS));
      try {
        await loadScriptOnce(src);
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    // Drop the cached rejection so a later attempt can retry (flaky network
    // on a phone is the normal case here, not the exception).
    inflight.delete(src);
    lastErr.vendorLoadFailed = true;
    throw lastErr;
  })();

  inflight.set(src, p);
  return p;
}

// PDF.js — importing and rasterizing PDFs.
export async function ensurePdfJs() {
  if (!window.pdfjsLib) {
    await loadScript('/js/vendor/pdf.min.js');
    // WHY the worker path is set HERE (it used to be a top-level line in
    // app.js): it must be assigned exactly once, after the lib lands and before
    // anyone calls getDocument(). Owning it in the loader is what let app.js
    // stop needing pdf.js at boot at all. Without a real worker PDF.js silently
    // falls back to a fake one on the main thread — see memory/pdfjs-worker.md.
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/js/vendor/pdf.worker.min.js';
  }
  return window.pdfjsLib;
}

// pdf-lib + fontkit — the export path. They always travel together (fontkit is
// what pdf-lib uses to embed our non-standard fonts), so one call fetches both
// in parallel.
export async function ensurePdfLib() {
  await Promise.all([
    window.PDFLib ? Promise.resolve() : loadScript('/js/vendor/pdf-lib.min.js'),
    window.fontkit ? Promise.resolve() : loadScript('/js/vendor/fontkit.umd.min.js'),
  ]);
  return { PDFLib: window.PDFLib, fontkit: window.fontkit };
}

// fontkit alone — Rung C's live-font-preview dry run (js/v2/app.js's
// prepareDocFont) only needs to LEARN a font's coverage at draft-open time; it
// doesn't need pdf-lib's full export surface for that. In practice the export
// path's ensurePdfLib() above already fetches this alongside PDFLib (they
// "always travel together" per that function's own comment) so a caller doing
// BOTH reads (pdf-lib parsing + fontkit coverage) — as app.js's dry run
// does — should still prefer ensurePdfLib() for one round trip; this exists
// for a caller that genuinely only needs fontkit, mirroring the same
// idempotent lazy-loader shape as ensureSignaturePad/ensureFflate below.
export async function ensureFontkit() {
  if (!window.fontkit) await loadScript('/js/vendor/fontkit.umd.min.js');
  return window.fontkit;
}

// SignaturePad — the draw pane of the signature/paraf sheet.
export async function ensureSignaturePad() {
  if (!window.SignaturePad) await loadScript('/js/vendor/signature_pad.umd.min.js');
  return window.SignaturePad;
}

// fflate — zipping the PDF→image export.
export async function ensureFflate() {
  if (!window.fflate) await loadScript('/js/vendor/fflate.min.js');
  return window.fflate;
}
