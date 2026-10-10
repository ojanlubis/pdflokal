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

import { getPage, findAnnotation, getSource, cloneForPaste, createAnnotation } from './model.js';
import { scaleAnnotationGeometry, turnAnnotation, withBlockFollowing, displayedBox, turnOf } from './annotation-geometry.js';
import { normaliseEnteredText } from './text-encode.js';

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
// (core/annotation-geometry.js turnAnnotation). Since 2026-10-11 (founder
// ruling, "semua harus ngikut rotasi") every object turns with the page, text
// and signatures included, so the mapping is rigid and needs no clamp.
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

// A fresh signature's width in page points, before the page caps it. The
// desktop ghost that rides the cursor (v2/app.js) draws at the same size.
export const SIGNATURE_PLACE_WIDTH = 150;

// Drop a signature centred on a tap at (cx, cy), held whole inside the page
// (displayedFrame): a tap near the margin used to leave half of it hanging off
// the edge, shown on screen and cut off in the file. `ratio` is the image's
// height / width; a page narrower or shorter than the default size gets a
// smaller signature with the same ratio. The caller records history first.
export function placeSignature(doc, pageId, { image, ratio }, cx, cy) {
  const pg = getPage(doc, pageId);
  if (!pg) return null;
  const frame = displayedFrame(pg);
  const width = Math.min(SIGNATURE_PLACE_WIDTH, frame.w, frame.h / ratio);
  const height = width * ratio;
  const anno = createAnnotation('signature', { image, x: 0, y: 0, width, height });
  const at = originInside(pg, anno, cx - width / 2, cy - height / 2);
  anno.x = at.x;
  anno.y = at.y;
  return addAnnotation(doc, pageId, anno);
}

// The size `src` takes on `page`: its own, or scaled UNIFORMLY (the screen draws
// a signature's height from the image ratio, so one axis alone would make screen
// and file disagree) until its displayed box fits the page. originInside only
// MOVES a box, and a box bigger than the page overhangs wherever it sits. One
// home, so the copy and the "already there" test cannot drift apart.
function signatureFitFor(page, src) {
  const frame = displayedFrame(page);
  const box = displayedBox(src, { w: src.width || 0, h: src.height || 0 });
  const f = Math.min(1, box.w > 0 ? frame.w / box.w : 1, box.h > 0 ? frame.h / box.h : 1);
  return { width: src.width * f, height: src.height * f };
}

// "Semua Hal.": the pages (other than the signature's own) that still need a copy.
// Separate from the copy so the caller can record history only when a tap will
// actually change something; a re-tap must not leave a dead undo step.
export function pagesMissingSignature(doc, annotationId) {
  const found = findAnnotation(doc, annotationId);
  if (!found || found.annotation.type !== 'signature') return [];
  const src = found.annotation;
  // Idempotent by state, not by timing: the selection survives the copy so the
  // button stays on screen, and a second tap must not stack a twin that makes
  // Hapus look broken. "Already there" = same image, same box.
  // The spot is the one copySignatureToAllPages gives THAT page: on a smaller
  // page the copy is held inside it, and comparing against the source's own
  // x/y would call that copy missing and stack another on every tap.
  const alreadyThere = (pg) => {
    const fit = signatureFitFor(pg, src);
    const at = originInside(pg, { ...src, ...fit }, src.x, src.y);
    return (a) => a.type === 'signature' && a.image === src.image
      && a.x === at.x && a.y === at.y && a.width === fit.width && a.height === fit.height
      && (a.turn || 0) === (src.turn || 0);
  };
  return doc.pages.filter((pg) => pg.id !== found.page.id && !pg.annotations.some(alreadyThere(pg)));
}

export function copySignatureToAllPages(doc, annotationId) {
  const found = findAnnotation(doc, annotationId);
  if (!found) return [];
  const src = found.annotation;
  const added = [];
  for (const pg of pagesMissingSignature(doc, annotationId)) {
    // Same position on every page; each copy is its OWN object (new id) so it
    // moves/deletes independently afterwards.
    // A turned source (its page was turned) stamps the same box the same way
    // round: "same position" is what the user sees, not the upright image.
    // A page smaller than the source's (a merged file) gets it moved inside.
    // A page too small for the box gets a smaller copy (signatureFitFor): moving
    // alone cannot hold a box taller or wider than the page.
    const fit = signatureFitFor(pg, src);
    const at = originInside(pg, { ...src, ...fit }, src.x, src.y);
    added.push(addAnnotation(doc, pg.id, createAnnotation('signature', {
      image: src.image, x: at.x, y: at.y, width: fit.width, height: fit.height,
      ...(src.turn ? { turn: src.turn } : {}),
    })));
  }
  return added;
}

export function updateAnnotation(doc, annotationId, patch) {
  const found = findAnnotation(doc, annotationId);
  if (!found) return null;
  // WHY: the editor commit lands here; see createAnnotation (core/model.js).
  if (found.annotation.type === 'text' && typeof patch.text === 'string') patch = { ...patch, text: normaliseEnteredText(patch.text) };
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

// SINGLE SOURCE OF TRUTH for "inside the page". The screen draws an object
// past the page edge (.pv-page does not clip) while every PDF viewer clips the
// file at the page box, so an object that overhangs looks whole on screen and
// arrives cut off in the download. Every path that sets where or how big an
// object is (move, resize, place, "Semua Hal.") holds it inside through here.

// The frame annotations live in: the page as displayed, so it swaps at 90/270.
function displayedFrame(page) {
  const rotated = (page.rotation || 0) % 180 !== 0;
  return rotated ? { w: page.height, h: page.width } : { w: page.width, h: page.height };
}

// The origin nearest (x, y) at which `anno`'s displayed box lies inside `page`.
// The box is the one the SCREEN shows (core/annotation-geometry.js
// displayedBox): a turned object's own width/height trade axes and its origin
// is no longer its top-left. Stored sizes only: text (no stored size) clamps
// its origin, exactly as it did unturned.
function originInside(page, anno, x, y) {
  const frame = displayedFrame(page);
  const box = displayedBox({ ...anno, x, y }, { w: anno.width || 0, h: anno.height || 0 });
  const bx = clamp(box.x, 0, Math.max(0, frame.w - box.w));
  const by = clamp(box.y, 0, Math.max(0, frame.h - box.h));
  return { x: x + (bx - box.x), y: y + (by - box.y) };
}

// Move by delta in PAGE space (the UI converts screen→page first). The anchor
// clamps inside the page so an annotation can never be dragged unrecoverably
// off-canvas — the failure mode behind several old "invisible annotation" bugs.
export function moveAnnotation(doc, annotationId, dx, dy) {
  const found = findAnnotation(doc, annotationId);
  if (!found) return null;
  const { page, annotation } = found;
  const to = originInside(page, annotation, (annotation.x || 0) + dx, (annotation.y || 0) + dy);
  const moved = withBlockFollowing({ ...annotation, x: to.x, y: to.y }, annotation);
  // In place: the drag holds this object and reads its x/y back.
  annotation.x = moved.x;
  annotation.y = moved.y;
  if (moved.block !== annotation.block) annotation.block = moved.block;
  return annotation;
}

// The largest factor s <= 1 that keeps the span [lo, hi], scaled about the
// origin o, inside [0, F]. A resize grows an object from its origin, so this
// is how far each displayed axis may go.
function fitFactor(o, lo, hi, F) {
  let s = 1;
  if (hi > F && hi > o) s = Math.min(s, (F - o) / (hi - o));
  if (lo < 0 && lo < o) s = Math.min(s, -o / (lo - o));
  return Math.max(0, s);
}

// Set bounds atomically (any subset of x/y/width/height). Sizes are floored at
// MIN_ANNO_SIZE so resize handles can't produce a zero-size object, and capped
// so the displayed box stays inside the page (see displayedFrame above).
// WHY a signature shrinks on both axes together: the screen draws its height
// from the image's own ratio (render/page-view.js) and the file from
// anno.height (core/export.js drawSignature), so capping one axis alone would
// make the screen and the file disagree again. A whiteout is a plain rect:
// only the axis that ran off the page is capped. The floor wins over the cap:
// an object too small to grab is worse than one that grazes the edge.
export function resizeAnnotation(doc, annotationId, bounds = {}) {
  const found = findAnnotation(doc, annotationId);
  if (!found) return null;
  const a = found.annotation;
  if (bounds.x !== undefined) a.x = bounds.x;
  if (bounds.y !== undefined) a.y = bounds.y;
  if (bounds.width !== undefined) a.width = Math.max(MIN_ANNO_SIZE, bounds.width);
  if (bounds.height !== undefined) a.height = Math.max(MIN_ANNO_SIZE, bounds.height);
  if (Number.isFinite(a.width) && Number.isFinite(a.height)) {
    const frame = displayedFrame(found.page);
    const box = displayedBox(a, { w: a.width, h: a.height });
    const sx = fitFactor(a.x || 0, box.x, box.x + box.w, frame.w);
    const sy = fitFactor(a.y || 0, box.y, box.y + box.h, frame.h);
    if (sx < 1 || sy < 1) {
      let sw;
      let sh;
      if (a.type === 'signature') {
        sw = sh = Math.min(sx, sy);
      } else {
        // At 90/270 the own width runs down the page.
        const across = turnOf(a) % 180 !== 0;
        sw = across ? sy : sx;
        sh = across ? sx : sy;
      }
      a.width = Math.max(MIN_ANNO_SIZE, a.width * sw);
      a.height = Math.max(MIN_ANNO_SIZE, a.height * sh);
    }
  }
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
