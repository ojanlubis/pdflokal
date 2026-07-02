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

import { getPage, findAnnotation, getSource } from './model.js';

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

export function rotatePage(doc, pageId, deltaDeg = 90) {
  const pg = getPage(doc, pageId);
  if (!pg) return null;
  pg.rotation = (((pg.rotation + deltaDeg) % 360) + 360) % 360;
  return pg;
}

// ---- annotations (all by id / object; never by index) ----------------------

export function addAnnotation(doc, pageId, annotation) {
  const pg = getPage(doc, pageId);
  if (!pg) return null;
  pg.annotations.push(annotation);
  return annotation;
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
  const w = annotation.width || 0;
  const h = annotation.height || 0;
  annotation.x = clamp((annotation.x || 0) + dx, 0, Math.max(0, page.width - w));
  annotation.y = clamp((annotation.y || 0) + dy, 0, Math.max(0, page.height - h));
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
