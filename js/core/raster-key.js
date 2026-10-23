/*
 * PDFLokal — core/raster-key.js  (HEADLESS)
 * ============================================================================
 * "Is the raster rendered for a page still the right picture for it?" — the
 * question undo/redo needs answered now that history snapshots no longer hold
 * rasters (core/history.js header). The rasterizer stamps every raster with
 * rasterKey(page) as of the moment the render was ISSUED (`raster.key`).
 *
 * The key has two halves, joined by a newline (editSignature is JSON, which
 * never contains a raw one):
 *   SHAPE — what decides the pixel grid and orientation: which source page,
 *     the user's rotation + the source's own, the merge-width factor
 *     (width / baseWidth, core/import.js renderPdfToCanvas), image-or-PDF.
 *     A raster of the wrong shape is geometrically wrong (pre-rotated, wrong
 *     aspect) and must never be shown for the page.
 *   EDITS — editSignature(page): the committed Ganti edits baked into the
 *     picture (the SAME key import.js's edited-doc cache uses). A raster of
 *     the right shape but other edits is merely STALE: right grid, old
 *     content. Showing it until the re-bake lands is the "no visible seam"
 *     law (spec-live-surgery.md §7) and syncEditedRasters re-bakes it.
 * Plain annotations are in neither: they are DOM overlay, never in the pixels.
 *
 * Scale is in neither on purpose: a sharpened raster is better kept than
 * dropped, and the sharpen pass re-checks scale itself.
 */
import { editSignature } from './page-surgery.js';

function shapeOf(page) {
  return [
    page.sourceId, page.sourcePageNum, page.rotation || 0, page.baseRotation || 0,
    page.width, page.height, page.baseWidth, page.isFromImage ? 1 : 0,
  ].join('|');
}

export function rasterKey(page) {
  return shapeOf(page) + '\n' + editSignature(page);
}

// Right grid and orientation for `page` (content may be stale). What history
// needs to decide a live raster can stand in across a restore.
export function rasterFitsShape(raster, page) {
  return typeof raster?.key === 'string' && raster.key.split('\n', 1)[0] === shapeOf(page);
}

// Exactly the picture `page` should show right now (shape AND edits).
export function rasterIsCurrent(raster, page) {
  return typeof raster?.key === 'string' && raster.key === rasterKey(page);
}

// Page-space box -> integer pixel rect of `raster` (its own scale). Moved here
// from js/v2/app.js (2026-10-10): raster geometry, pure, testable headless.
export function boxToRasterPx(raster, box) {
  const s = raster.scale;
  return {
    cx: Math.round(box.x * s),
    cy: Math.round(box.y * s),
    cw: Math.max(1, Math.round(box.w * s)),
    ch: Math.max(1, Math.round(box.h * s)),
  };
}


// spec-edit-fidelity-instrumentation.md Increment C: crops ONE box (page-
// space points, top-left frame — same convention as annotation x/y/w/h and
// replaceBox) out of an already-rasterized {dataUrl,width,height,scale} and
// returns it as ImageData.
//
// PM-flagged 2026-07-26: the original version of this function did a plain
// `new Image()` + drawImage, which decodes the ENTIRE page PNG synchronously
// on the main thread — twice (pristine + stamped), right when the bake
// resolves and the user is looking at their fresh edit. On a low-end phone
// with a large page that's plausibly 100-300ms of jank landing at exactly
// the wrong moment. Preferred path now: `createImageBitmap(blob, sx, sy, sw,
// sh)` decodes OFF the main thread and only the requested region — precisely
// this use case. `img.decode()`+drawImage is kept as a FALLBACK (never worse
// than before this fix) for any engine/shape where the bitmap path throws.
// PM question, 2026-07-26: should a crop that spills past its raster's own
// edge decline outright, rather than trust ALPHA_MIN alone to neutralize the
// padding? Yes — this is the layer that CAN answer it (core/visual-oracle.js
// only ever sees already-cropped ImageData, no raster dimensions to compare
// against, see that module's own header note). A box whose requested pixels
// spill outside [0,raster.width) x [0,raster.height) means the geometry
// itself doesn't fit what's being measured against — decline before even
// fetching/decoding, rather than return a technically-alpha-correct but
// still partially-fabricated comparison.
export function boxFitsRaster(raster, box) {
  const { cx, cy, cw, ch } = boxToRasterPx(raster, box);
  return cx >= 0 && cy >= 0 && cx + cw <= raster.width && cy + ch <= raster.height;
}

