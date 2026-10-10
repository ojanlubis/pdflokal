/*
 * PDFLokal — v2/edit-bake.js  (A PAGE'S COMMITTED EDITS, BAKED INTO ITS PICTURE)
 * ============================================================================
 * Moved out of js/v2/app.js (2026-10-10), behaviour unchanged. Everything
 * between "the model says this page has edits" and "the screen shows the page
 * with them": the edited-page provider the rasterizer reads, the re-bake and
 * its no-blank-frame swap, the undo/redo re-sync, and the two instruments that
 * read the bake afterwards (the visual oracle, the consent-gated feedback
 * sample). Each WHY travelled with its code.
 *
 * deps (getters, never captured values: Buka Baru replaces doc, slots and the
 * rasterizer):
 *   getDoc() / getSlots() / getRasterizer()
 *   rasterScaleFor(page)    app.js's one door for raster scale (sharpen-aware)
 *   tel(event, props)       app.js's OWN tel wrapper, never telemetry.js
 *                           directly: the wrapper also drives the bug-report
 *                           prompt, and bypassing it silently stops that
 *   getSentry()             window.Sentry or null
 */
import { getSource } from '../core/model.js';
import { ensurePdfLib } from '../core/vendor.js';
import { loadSourceForRebuild } from '../core/pdflib-load.js';
import { editSignature } from '../core/page-surgery.js';
import { rasterIsCurrent, boxToRasterPx, boxFitsRaster } from '../core/raster-key.js';
import { compareRegions } from '../core/visual-oracle.js';
import { ratioBucket, inkRatioBucket } from '../core/telemetry-schema.js';
import { validateSample } from '../core/feedback-sample.js';
import { createEditedPageProvider } from './edited-page-provider.js';
import { createBakeFailureReporter, scrubbedError } from './bake-failure.js';

// WHY requestIdleCallback (setTimeout fallback for Safari, which still
// doesn't ship it): measuring must not disturb what it measures. Even the
// off-thread createImageBitmap path above still ends in a main-thread canvas
// draw + getImageData — running that right when the bake resolves competes
// with the commit paint the user is watching. A telemetry number arriving
// ~200ms late costs nothing; a stutter at the commit moment costs the exact
// thing this instrument exists to protect against. Do NOT move this back
// onto the commit path as an "optimization" — that reintroduces the jank
// risk this fix removes.
export function runWhenIdle(fn) {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 2000 });
  else setTimeout(fn, 0);
}

async function cropRasterRegion(raster, box) {
  const { cx, cy, cw, ch } = boxToRasterPx(raster, box);

  try {
    const blob = await (await fetch(raster.dataUrl)).blob();
    const bitmap = await createImageBitmap(blob, cx, cy, cw, ch);
    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return ctx.getImageData(0, 0, cw, ch);
  } catch {
    // Fallback: the original main-thread Image decode. Still correct, just
    // not off-thread — covers any browser/shape that declines the bitmap
    // crop overload above.
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = raster.dataUrl; });
    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, -cx, -cy);
    return ctx.getImageData(0, 0, cw, ch);
  }
}


// spec-edit-fidelity-instrumentation.md Increment D: encodes ONE already-
// cropped ImageData region (the SAME crop cropRasterRegion produces for the
// oracle above — no second cropper) down to a bounded PNG data URL for the
// consent-gated feedback sample. PNG, not JPEG: these crops are a single
// text line on a flat page background — overwhelmingly solid colour with
// sharp glyph edges, exactly the content PNG's lossless compression handles
// well, while JPEG's block-DCT would blur the very glyph edges the
// founder's own bug is about ("thin vs bold") without reliably beating PNG's
// size on this content. SAMPLE_MAX_WIDTH matches the spec's "~600px wide".
const SAMPLE_MAX_WIDTH = 600;
function imageDataToSampleDataUrl(imageData) {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  canvas.getContext('2d').putImageData(imageData, 0, 0);
  if (imageData.width <= SAMPLE_MAX_WIDTH) return canvas.toDataURL('image/png');
  const scale = SAMPLE_MAX_WIDTH / imageData.width;
  const small = document.createElement('canvas');
  small.width = SAMPLE_MAX_WIDTH;
  small.height = Math.max(1, Math.round(imageData.height * scale));
  small.getContext('2d').drawImage(canvas, 0, 0, small.width, small.height);
  return small.toDataURL('image/png');
}

export function createEditBake({ getDoc, getSlots, getRasterizer, rasterScaleFor, tel, getSentry }) {
  // pdf-lib load of a SOURCE's bytes, cached per sourceId — a throwaway dry-run
  // doc, never mutated or saved, shared across every line tapped on that source
  // so re-tapping the same page doesn't re-parse the PDF each time.
  const pdfLibDocCache = new Map(); // sourceId -> Promise<PDFLib PDFDocument>
  function getDryRunDoc(PDFLib, source) {
    if (!pdfLibDocCache.has(source.id)) {
      pdfLibDocCache.set(source.id, loadSourceForRebuild(PDFLib, source));
    }
    return pdfLibDocCache.get(source.id);
  }

  // The rasterizer's door onto a page's committed edits — js/v2/edited-page-provider.js
  // holds the body and its WHY (moved 2026-10-01 so the failure report below is
  // testable against the real provider). A bake that throws still falls back to
  // the plain source render; what changed is that it now SAYS so, on the rail
  // and in Sentry (js/v2/bake-failure.js — seat ruling 2026-10-01).
  const reportBakeFailure = createBakeFailureReporter({ tel, getSentry });
  const editedPageProvider = createEditedPageProvider({
    getSource: (sourceId) => getSource(getDoc(), sourceId),
    loadPdfLib: ensurePdfLib,
    getSrcDoc: getDryRunDoc,
    onBakeFailure: (err, page) => {
      // The SCRUBBED error, not `err`: Sentry turns console calls into
      // breadcrumbs, and a raw message can quote the document (bake-failure.js).
      console.warn('editedPageProvider gagal, pakai raster asli:', scrubbedError(err));
      // The key must not throw: the page that broke the build may be the very
      // thing editSignature cannot read.
      let sig = '?';
      try { sig = editSignature(page); } catch { /* keep '?' */ }
      reportBakeFailure(err, `${page.id}:${sig}`);
    },
  });

  // spec-live-surgery.md §5/§8.3 (increment 3): re-render `pageId`'s background
  // raster from its CURRENT edit set and swap it in with no blank frame
  // (page-view.js's swapPageRaster — holds the old raster until the new
  // dataUrl's img.decode() resolves). Called right after a Ganti commit touches
  // a page's edit set, and after any undo/redo whose edit-signature changed
  // (see syncEditedRasters below). editedPageProvider (above) is what actually
  // determines the applied/declined outcome, as a side effect of the SAME
  // buildEditedPageBytes call the raster is built from — this function never
  // re-derives that outcome itself.
  //
  // RETURN CONTRACT (fixed 2026-07-27, bug 1 — founder field test, 444-page
  // doc): returns the raster THIS call actually attached, or a falsy value
  // when it stood down. Confirmed empirically (not the originally-suspected
  // mechanism — see decisions.md): calling rebuildStage() alone mid-flight
  // does NOT corrupt page.raster, because rasterizer.rasterize() (core/
  // import.js) writes page.raster itself as a side effect, independent of
  // THIS function's own slot-identity check — that check only gates the DOM
  // swap (slot.reattach), so a stood-down bake used to leave page.raster
  // correct but the on-screen pixels stale. The confirmed data-corrupting path
  // is undo/redo: history.js's restore() SPREAD-COPIES doc.pages into fresh
  // objects (`{...p}`), so a rebakePage() in flight when that happens writes
  // its result onto the now-orphaned OLD page object — invisible to anyone
  // who re-reads `getPage(doc, pageId).raster` afterward, which instead sees
  // whatever the POST-undo page object's raster is. On a 444-page doc the
  // rasterize() await is slow enough to widen this window a lot. The caller
  // (this commit's own .then()) must use THIS return value as the after-
  // raster and decline entirely when it's falsy — never re-derive from
  // page.raster, which may have moved on to a different object by the time
  // the caller reads it. Same law as the style-race fix (stamp.js): derive
  // from what was actually produced, never inherit from shared state that may
  // not reflect it anymore.
  async function rebakePage(pageId) {
    const rasterizer = getRasterizer();
    if (!rasterizer) return null;
    const slot = getSlots().find((s) => s.page.id === pageId);
    if (!slot) return null;
    const page = slot.page;
    rasterizer.invalidateEditedPage(page.id); // reuse inc.2's invalidate (spec §8.2)
    if (!editSignature(page)) page.editApplied = null; // no edits left — nothing to suppress
    // rasterScaleFor, not a hardcoded 2: committing a Ganti edit on the page you
    // are zoomed into must not SOFTEN it. Baking at the baseline here would undo
    // the sharpen at exactly the moment the user is staring at the result.
    const raster = await rasterizer.rasterize(page, { scale: rasterScaleFor(page) });
    // Stale guard: a fast undo/redo (or page delete) may have rebuilt the stage
    // while this rasterize() was in flight — only swap if this slot is still
    // the page's current, live one. syncEditedRasters below re-derives from
    // scratch for whatever page set actually ends up live, so this rebake
    // simply stands down rather than clobbering newer state.
    if (getSlots().find((s) => s.page.id === pageId) !== slot) return null;
    await slot.reattach(raster);
    return raster;
  }

  // spec-edit-fidelity-instrumentation.md Increment C: the visual oracle. Crops
  // the edited line's OWN region (the cover's replaceBox — the birth-time rect
  // that already bounds the ORIGINAL text, the same box surgery/insert use) out
  // of the PRISTINE raster (the page as it looked right before this commit's
  // bake — `prevRaster`, captured by the caller before rebakePage overwrote
  // page.raster) and the STAMPED one (the raster rebakePage just produced),
  // then fires content-blind ink-shape ratios. Wrapped whole and never awaited
  // by its caller (fire-and-forget past that point too) — a crop/decode
  // failure, a scale mismatch, or a declined compareRegions() (no ink on one
  // side, e.g. a pure-deletion edit with nothing painted back) just means no
  // event fires. NEVER blocks or fails the commit — same discipline as every
  // other ladder event on this path (surgery/insert already follow it).
  async function runVisualOracle(prevRaster, newRaster, box) {
    try {
      if (!prevRaster || !newRaster || !box) return;
      if (prevRaster.scale !== newRaster.scale) return; // different render generations — not comparable
      // Decline before ever fetching/decoding when the box would spill past
      // EITHER raster's own edge (boxFitsRaster's own WHY comment) — a line
      // near a page border, or a replaceBox wider than the remaining margin.
      if (!boxFitsRaster(prevRaster, box) || !boxFitsRaster(newRaster, box)) return;
      const [pristineImg, stampedImg] = await Promise.all([
        cropRasterRegion(prevRaster, box),
        cropRasterRegion(newRaster, box),
      ]);
      const result = compareRegions(pristineImg, stampedImg);
      if (!result) return;
      tel('visual_oracle', {
        weight_ratio: ratioBucket(result.weightRatio),
        height_ratio: ratioBucket(result.heightRatio),
        // ink_ratio (2026-07-28 incident fix): a DIFFERENT bucketer than
        // weight_ratio/height_ratio on purpose — see inkRatioBucket's own
        // header comment in core/telemetry-schema.js for why reusing
        // ratioBucket()'s cuts here would silently hide the exact defect this
        // field exists to catch.
        ink_ratio: inkRatioBucket(result.inkRatio),
        overflow: result.overflow,
      });
    } catch (err) {
      console.warn('[v2/app] visual oracle gagal (skip):', err);
    }
  }

  // spec-edit-fidelity-instrumentation.md Increment D: the consent-gated
  // sample. Reuses Increment C's own crop path (boxFitsRaster/cropRasterRegion)
  // rather than a second cropper — same box, same decline discipline: a box
  // that doesn't fit either raster means no sample, exactly like the oracle
  // above declines a comparison it can't trust. Returns null (never throws) on
  // ANY decline — a missing raster, a box that doesn't fit, or either encoded
  // crop landing over its byte cap after downsampling (validateSample, shared
  // with js/v2/telemetry.js and mirrored server-side in api/feedback.js).
  // The caller only ever gets back a sample that's already safe to render and
  // send, never a partial one.
  async function captureFeedbackSample(prevRaster, newRaster, box) {
    try {
      if (!prevRaster || !newRaster || !box) return null;
      if (prevRaster.scale !== newRaster.scale) return null;
      if (!boxFitsRaster(prevRaster, box) || !boxFitsRaster(newRaster, box)) return null;
      const [beforeImg, afterImg] = await Promise.all([
        cropRasterRegion(prevRaster, box),
        cropRasterRegion(newRaster, box),
      ]);
      const sample = {
        before: imageDataToSampleDataUrl(beforeImg),
        after: imageDataToSampleDataUrl(afterImg),
      };
      return validateSample(sample); // enforces the byte caps; null if either/both over
    } catch (err) {
      console.warn('[v2/app] feedback sample gagal (skip):', err);
      return null;
    }
  }

  // spec-live-surgery.md §5/§8.3 (increment 3): after undo/redo swaps in a new
  // set of pages, any page whose edit-signature actually CHANGED needs its
  // raster re-baked — a page that lost its last edit must revert to the plain
  // source render, a page whose edits came back (redo) must re-bake. Diffed by
  // page.id against the PRE-history-op pages (ids are stable across undo/redo —
  // history.js's snapshot/restore both spread-copy the same id onto a fresh
  // object), so this is a plain signature comparison, never a re-derivation of
  // WHAT changed. Pages whose signature is unchanged are left alone — undo/redo
  // elsewhere in the doc must not pay for a re-bake it didn't cause.
  function syncEditedRasters(prevPages) {
    const prevSig = new Map(prevPages.map((p) => [p.id, editSignature(p)]));
    for (const page of getDoc().pages) {
      // history.js no longer snapshots rasters: restore() carries the LIVE raster
      // when it still fits the page's shape, which may be stale in content (core/
      // raster-key.js). So the test is no longer only "signature moved vs the
      // pre-op page" but also "does the raster it now holds show THIS page's
      // edits" — the second catches a bake that was still in flight at undo time,
      // where both pages share a signature but the picture predates it. A page
      // with NO raster (rotated, resized, or restored from a delete) is skipped:
      // the viewport stream renders it, and the rasterizer's edited-doc cache is
      // keyed by signature, so that render is already the right bake; a rebake
      // here would invalidate the build the stream just started and bake twice.
      const sigMoved = editSignature(page) !== (prevSig.get(page.id) ?? '');
      if (!page.raster) {
        if (!editSignature(page)) page.editApplied = null; // same as rebakePage: no edits left
        continue;
      }
      if (sigMoved || !rasterIsCurrent(page.raster, page)) {
        rebakePage(page.id).catch((err) => console.warn('rebakePage (undo/redo) gagal:', err));
      }
    }
  }

  return {
    editedPageProvider,
    getDryRunDoc,
    rebakePage,
    syncEditedRasters,
    runVisualOracle,
    captureFeedbackSample,
    // Buka Baru: the dry-run pdf-lib docs belong to the document being closed.
    reset() { pdfLibDocCache.clear(); },
  };
}
