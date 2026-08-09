/*
 * PDFLokal — core/page-rotation.js  (HOW A PAGE IS TURNED — SINGLE SOURCE OF TRUTH)
 * ============================================================================
 * A page carries TWO rotations and they are not the same kind of thing:
 *
 *   page.baseRotation — the source document's own /Rotate, read off the file at
 *                       import (core/import.js: `pdfPage.rotate`, with PDF.js
 *                       having already resolved inheritance up the Pages tree).
 *                       DOCUMENT DATA, like sourcePageNum.
 *   page.rotation     — what the USER turned it to in the editor. 0 on import.
 *
 * What the reader sees is the SUM. core/import.js's rasterizer already renders
 * at `(baseRotation + rotation) % 360`, and js/v2/text-runs.js already maps hit
 * targets through the same sum — but the two EXPORT writers
 * (core/export.js, core/page-surgery.js) each called pdf-lib's setRotation with
 * `page.rotation` alone. setRotation is ABSOLUTE, so a source PDF's inherited
 * /Rotate was discarded: a document carrying /Rotate 90, rotated once in the
 * editor, showed 180 on screen and exported at 90. Screen and file disagreed,
 * and the user only found out once they had the file (bug found 2026-08-09).
 *
 * The formula was never in doubt — it was written correctly in two places and
 * missing from two others. That is what this module is for: the sum has ONE
 * home now, and a fifth reader gets it right by importing rather than by
 * remembering.
 *
 * ⚠️ DELIBERATELY NOT DERIVED FROM THE COPIED pdf-lib PAGE's getRotation().
 * That would bet on copyPages materialising a TREE-INHERITED /Rotate onto the
 * leaf page — unverified, and a leaf-level fixture would pass either way, so
 * the test could not tell the two implementations apart. `baseRotation` is read
 * from the document by PDF.js, which resolves the inheritance for us.
 *
 * NOTE ON page.width/height: import.js sizes pages from a rotate-HONOURING
 * viewport, so baseRotation is ALREADY baked into them. That is why
 * core/operations.js's merge-width `displayedWidth` helper swaps w/h on
 * `page.rotation` alone and is CORRECT to do so — it reads the user rotation
 * over base-baked dims, this file reads base + user over the raw MediaBox.
 * Same decomposition, different frame; the two agree and neither needs the
 * other changed.
 */

// The page's total rotation in degrees, normalised to 0 | 90 | 180 | 270.
// Image pages have no source document and therefore no inherited /Rotate —
// guarded explicitly (not merely inert) so a future image-page shape that
// happens to carry a stray baseRotation cannot start double-counting.
export function totalPageRotation(page) {
  const base = page?.isFromImage ? 0 : (page?.baseRotation || 0);
  const user = page?.rotation || 0;
  return (((base + user) % 360) + 360) % 360;
}
