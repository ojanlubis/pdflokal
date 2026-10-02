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
