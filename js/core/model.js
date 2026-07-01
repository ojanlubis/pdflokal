/*
 * PDFLokal — core/model.js  (HEADLESS domain model — no DOM, no vendor libs)
 * ============================================================================
 * The ONE source of truth for a document. This layer must run in Node with no
 * browser (that's the litmus test — see docs/foundation-plan.md).
 *
 * The two rules that kill the old spaghetti:
 *   1. A Page OWNS its annotations (page.annotations[]). There is NO parallel
 *      `annotations{pageIndex:[...]}` map to keep in sync.
 *   2. Everything is referenced by STABLE ID / object, never by array index.
 *      Reorder or delete a page and nothing needs re-keying — the annotations
 *      travel on the page object; selection points at ids.
 *
 * Factories only here (pure shapes). Mutations live in core/operations.js so
 * there is exactly one mutation path (invariant #5).
 */

// Monotonic ids — deterministic within a session, collision-free, and (unlike
// array indices) stable across reorder/delete. Not persisted; identity only.
let _seq = 0;
export function nextId(prefix) {
  _seq += 1;
  return `${prefix}_${_seq}`;
}
// Test-only: reset the counter so id assertions are deterministic per test.
export function _resetIds() { _seq = 0; }

// A source file — the ONLY place raw bytes live. Pages reference it by id.
export function createSource({ name, bytes, numPages = 0 }) {
  return { id: nextId('src'), name, bytes, numPages };
}

// An annotation — stable id, referenced directly (never by {pageIndex,index}).
// `type` is one of: 'whiteout' | 'text' | 'signature' | 'watermark' | 'pageNumber'.
// `props` carries the type-specific fields (x, y, width, text, …).
export function createAnnotation(type, props = {}) {
  return { id: nextId('anno'), type, ...props };
}

// A page. Immutable identity (id). Owns its annotations. `raster` is filled by
// the render/import layer in Phase 1 (an image of the page) — null in pure core.
export function createPage({
  source,            // a Source object (we store source.id)
  sourcePageNum,     // 0-based page index within that source
  width, height,     // intrinsic (unrotated) size, PDF points
  rotation = 0,      // 0 | 90 | 180 | 270
  isFromImage = false,
}) {
  return {
    id: nextId('page'),
    sourceId: source.id,
    sourcePageNum,
    width,
    height,
    rotation,
    isFromImage,
    raster: null,          // Phase 1: rasterized page image (render-time artifact)
    annotations: [],       // annotations live HERE — no parallel map
  };
}

// The whole document — one source of truth. Selection is by id, never index.
export function createDoc() {
  return {
    sources: [],   // Source[]
    pages: [],     // Page[] in display order
    selection: { pageId: null, annotationId: null },
  };
}

// ---- read helpers (pure lookups; no mutation) ------------------------------

export function getPage(doc, pageId) {
  return doc.pages.find((p) => p.id === pageId) || null;
}

export function getSource(doc, sourceId) {
  return doc.sources.find((s) => s.id === sourceId) || null;
}

// Locate an annotation anywhere in the doc by id. Returns { page, annotation,
// index } or null. `index` is only for splicing inside operations — callers
// hold the annotation OBJECT, never the number.
export function findAnnotation(doc, annotationId) {
  for (const page of doc.pages) {
    const index = page.annotations.findIndex((a) => a.id === annotationId);
    if (index !== -1) return { page, annotation: page.annotations[index], index };
  }
  return null;
}

// The currently selected page / annotation objects (or null). Derived from ids
// so they can never go stale the way a cached {pageIndex,index} did.
export function selectedPage(doc) {
  return doc.selection.pageId ? getPage(doc, doc.selection.pageId) : null;
}
export function selectedAnnotation(doc) {
  const found = doc.selection.annotationId ? findAnnotation(doc, doc.selection.annotationId) : null;
  return found ? found.annotation : null;
}
