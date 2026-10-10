/*
 * PDFLokal — core/operations.js  (HEADLESS — the single mutation path)
 * ============================================================================
 * Every change to a Doc goes through one of these (invariant #5). They are pure
 * w.r.t. the DOM: they take a Doc, mutate it in place, and return the affected
 * entity. No rendering, no vendor libs, no globals.
 *
 * The headline the old code couldn't make: reorder / delete a page and there is
 * NO re-keying. Annotations ride on the page object; selection points at ids.
 * `mutatePages()` and its six-parallel-map dance simply don't exist here.
 */

import { getPage, findAnnotation, getSource, cloneForPaste } from './model.js';
import { scaleAnnotationGeometry, turnAnnotation } from './annotation-geometry.js';

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

// ---- sources ---------------------------------------------------------------

export function addSource(doc, source) {
  doc.sources.push(source);
  return source;
}

// ---- pages -----------------------------------------------------------------

export function addPages(doc, pages) {
  doc.pages.push(...pages);
  return pages;
}

// SINGLE SOURCE OF TRUTH for WHICH page's width every other page adopts.
//
// Founder ruling 2026-08-09, verbatim:
//   "no, make it descending priority. width is determined by the first
//    non-image file. then image"
//
// Descending priority, and the order is the whole rule: the FIRST PDF page in
// the document sets the width. An image page sets it only when the document
// contains no PDF page at all.
//
// WHY it is not simply "page 1" (which is what shipped first and he corrected):
// image pages are sized pixels-as-points (core/import.js), so a phone photo is
// a ~3024pt page — about 107cm. Anchoring on page 1 meant a photo dropped in
// front of an A4 contract dragged the CONTRACT up to 107cm wide. Descending
// priority kills that at the root instead of with a magic maximum: the photo
// comes down to A4, the document stays a document. He rejected the clamp
// framing and gave this rule instead, so there is no constant to tune here.
//
// Note the consequence, which is intent and not a side effect: when page 1 is
// an image it gets RESIZED like any other page. Pages follow the anchor, and
// the anchor is not necessarily page 1.
export function anchorPage(pages) {
  return pages.find((p) => !p.isFromImage) || pages[0] || null;
}

// Apply the anchor's width to every page, ratio kept. Returns the pages that
// actually moved.
//
// The rulings this encodes (PM seat, 2026-08-09 — decisions live there, not
// here; this comment only says what the code does and why it does not do more):
//   - MERGE ONLY. A document assembled from a single file is never reflowed.
//     That is the `contributing < 2` bail: a lone PDF's own mixed page sizes
//     are the author's, not ours to rewrite.
//   - Every page follows the ANCHOR (see anchorPage above), including the
//     anchor file's own later pages, and including page 1 when it is an image.
//   - The anchor width is a DISPLAYED width, so an intrinsic /Rotate (already
//     baked into width/height by import.js's rotate-honouring viewport) and a
//     user rotate are both honoured BEFORE normalising, never after.
//   - Scaling is UNIFORM — height follows width, ratio kept. Every downstream
//     reader (export.js, the rasterizer, text-runs.js) relies on
//     width/baseWidth == height/baseHeight; do not make this anisotropic.
//   - No clamp, anywhere. Descending priority is what makes one unnecessary.
//
// Idempotent: a page already at the anchor width gets factor 1 and is untouched.
// Callers: the merge path only (js/v2/app.js's loadFilesInner). Reorder and
// rotate deliberately do NOT call this — re-anchoring under the user's finger
// would resize the document mid-gesture.
export function normalizePageWidths(doc) {
  if (doc.pages.length < 2) return [];
  // Count sources that actually CONTRIBUTED a page: a failed import can leave
  // a Source behind with no pages (js/v2/app.js's per-file try/catch), and
  // that must not make a single-file document look like a merge.
  const contributing = new Set(doc.pages.map((p) => p.sourceId));
  if (contributing.size < 2) return [];

  const displayedWidth = (p) => ((p.rotation || 0) % 180 !== 0 ? p.height : p.width);
  const anchor = displayedWidth(anchorPage(doc.pages));
  if (!(anchor > 0)) return []; // a degenerate anchor must not zero the document

  const changed = [];
  for (const page of doc.pages) {
    const dw = displayedWidth(page);
    if (!(dw > 0)) continue;
    const factor = anchor / dw;
    if (factor === 1) continue;
    page.width *= factor;
    page.height *= factor;
    // Annotations live in this same display frame, so they move with it, or a
    // signature at x=800 stays at 800 on a page now 595 wide. New objects, not
    // in-place edits: history snapshots share nested fields (block) by reference.
    page.annotations = page.annotations.map((a) => scaleAnnotationGeometry(a, factor));
    // Drop the cached raster: it was rendered at the OLD point size. The view
    // stretches a raster to fit, so a stale one is geometrically right and
    // merely soft — but on a page scaled up several times over (a photo
    // anchoring a PDF) "merely soft" is unreadable, and the streaming layer
    // has no other signal that this page needs re-rendering. null is exactly
    // what a not-yet-rasterized page carries, so every reader already handles
    // it. Only pages that actually MOVED lose their raster.
    page.raster = null;
    changed.push(page);
  }
  return changed;
}

export function removePage(doc, pageId) {
  const i = doc.pages.findIndex((p) => p.id === pageId);
  if (i === -1) return null;
  const [removed] = doc.pages.splice(i, 1);
  // Selection is by id → clearing it is trivial and can't dangle.
  if (doc.selection.pageId === pageId) {
    doc.selection = { pageId: null, annotationId: null };
  } else if (doc.selection.annotationId && !findAnnotation(doc, doc.selection.annotationId)) {
    // The selected annotation lived on the removed page.
    doc.selection.annotationId = null;
  }
  return removed;
}

// Move a page to a new display index. NO re-keying of anything — this is the
// whole point. Annotations and selection are untouched and still correct.
export function reorderPage(doc, pageId, toIndex) {
  const from = doc.pages.findIndex((p) => p.id === pageId);
  if (from === -1) return null;
  const [pg] = doc.pages.splice(from, 1);
  doc.pages.splice(clamp(toIndex, 0, doc.pages.length), 0, pg);
  return pg;
}

// WHY rotatePage moves annotations (2026-10-10): their geometry lives in the
// page's DISPLAYED frame (core/annotation-geometry.js), so turning only
// `rotation` left a signature at y=700 on an A4 page that is now 595 tall: off
// the page on screen and in the file. The whole turn is ONE mapping
// (core/annotation-geometry.js turnAnnotation), clamped once at the end.
export function rotatePage(doc, pageId, deltaDeg = 90) {
  const pg = getPage(doc, pageId);
  if (!pg) return null;
  if (deltaDeg % 90 !== 0) { // not a page turn the UI can make; no frame mapping exists for it
    pg.rotation = (((pg.rotation + deltaDeg) % 360) + 360) % 360;
    return pg;
  }
  const steps = (((deltaDeg / 90) % 4) + 4) % 4;
  if (steps === 0) return pg;
  const rotated = (pg.rotation || 0) % 180 !== 0;
  const W = rotated ? pg.height : pg.width; // displayed size BEFORE the turn
  const H = rotated ? pg.width : pg.height;
  pg.annotations = pg.annotations.map((a) => turnAnnotation(a, steps, W, H));
  pg.rotation = ((pg.rotation || 0) + 90 * steps) % 360;
  return pg;
}

// ---- annotations (all by id / object; never by index) ----------------------

export function addAnnotation(doc, pageId, annotation) {
  const pg = getPage(doc, pageId);
  if (!pg) return null;
  pg.annotations.push(annotation);
  return annotation;
}

// Paste/duplicate: a fresh copy of `src` on `pageId`, stepped (+10px x and y)
// `n` times from the SOURCE's own position. moveAnnotation does the stepping,
// so the clamp inside the page (in the rotated view frame) is the one every
// move already uses. Returns the new annotation, or null if `src` is not
// copyable (core/model.js cloneForPaste) or the page is gone. The caller
// records history first: one paste = one undo step.
export const PASTE_OFFSET = 10;
export function duplicateAnnotation(doc, pageId, src, n = 1) {
  if (!getPage(doc, pageId)) return null;
  const clone = cloneForPaste(src);
  if (!clone) return null;
  addAnnotation(doc, pageId, clone);
  moveAnnotation(doc, clone.id, PASTE_OFFSET * n, PASTE_OFFSET * n);
  return clone;
}

export function updateAnnotation(doc, annotationId, patch) {
  const found = findAnnotation(doc, annotationId);
  if (!found) return null;
  Object.assign(found.annotation, patch);
  return found.annotation;
}

export function removeAnnotation(doc, annotationId) {
  const found = findAnnotation(doc, annotationId);
  if (!found) return null;
  found.page.annotations.splice(found.index, 1);
  if (doc.selection.annotationId === annotationId) doc.selection.annotationId = null;
  return found.annotation;
}

// Minimum annotation edge in page points — small enough for a tight whiteout,
// large enough that a resize handle can't collapse the object to untouchable.
const MIN_ANNO_SIZE = 8;

// Move by delta in PAGE space (the UI converts screen→page first). The anchor
// clamps inside the page so an annotation can never be dragged unrecoverably
// off-canvas — the failure mode behind several old "invisible annotation" bugs.
export function moveAnnotation(doc, annotationId, dx, dy) {
  const found = findAnnotation(doc, annotationId);
  if (!found) return null;
  const { page, annotation } = found;
  // Annotations live in the ROTATED view frame — the clamp box swaps at 90/270.
  const rotated = (page.rotation || 0) % 180 !== 0;
  const frameW = rotated ? page.height : page.width;
  const frameH = rotated ? page.width : page.height;
  const w = annotation.width || 0;
  const h = annotation.height || 0;
  annotation.x = clamp((annotation.x || 0) + dx, 0, Math.max(0, frameW - w));
  annotation.y = clamp((annotation.y || 0) + dy, 0, Math.max(0, frameH - h));
  return annotation;
}

// Set bounds atomically (any subset of x/y/width/height). Sizes are floored at
// MIN_ANNO_SIZE so resize handles can't produce a zero-size object.
export function resizeAnnotation(doc, annotationId, bounds = {}) {
  const found = findAnnotation(doc, annotationId);
  if (!found) return null;
  const a = found.annotation;
  if (bounds.x !== undefined) a.x = bounds.x;
  if (bounds.y !== undefined) a.y = bounds.y;
  if (bounds.width !== undefined) a.width = Math.max(MIN_ANNO_SIZE, bounds.width);
  if (bounds.height !== undefined) a.height = Math.max(MIN_ANNO_SIZE, bounds.height);
  return a;
}

// ---- selection (by id — cannot go stale) -----------------------------------

export function selectPage(doc, pageId) {
  doc.selection = { pageId, annotationId: null };
  return getPage(doc, pageId);
}

export function selectAnnotation(doc, annotationId) {
  const found = annotationId ? findAnnotation(doc, annotationId) : null;
  doc.selection.annotationId = found ? annotationId : null;
  if (found) doc.selection.pageId = found.page.id;
  return found ? found.annotation : null;
}

export function clearSelection(doc) {
  doc.selection = { pageId: null, annotationId: null };
}

// ---- export intent (headless boundary contract) ----------------------------

// The export adapter (core/export.js, Phase 0b) will consume exactly this:
// each entry pairs a page with its source bytes. No DOM, no ueState — proving
// the core can drive a PDF build in Node. Returned here as data only.
export function buildExportPlan(doc) {
  return doc.pages.map((page) => ({
    page,
    source: getSource(doc, page.sourceId),
    annotations: page.annotations,
  }));
}
