/*
 * PDFLokal — core/model.js  (HEADLESS domain model — no DOM, no vendor libs)
 * ============================================================================
 * The ONE source of truth for a document. This layer must run in Node with no
 * browser (that's the litmus test; the plan was docs/foundation-plan.md, deleted, see `git log -- docs/foundation-plan.md`).
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

import { normaliseEnteredText } from './text-encode.js';

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
// `encrypted` — this source carries a PDF standard-security handler. PDF.js
// decrypts for VIEWING, so these documents open and render perfectly; pdf-lib
// has no decryption at all, so they can never be written back out. Recorded at
// import so the app can say so BEFORE the user invests an edit, instead of
// failing at the download (founder field report, the 444-page KBLI table).
// `signed` — this source carries a PDF digital signature or an Indonesian
// e-meterai (both are PAdES/PKCS#7 signature dictionaries). The VISIBLE stamp
// is page content and survives anything; the cryptographic seal does not.
// core/export.js rebuilds the document with pdf-lib and there is no
// incremental-update path anywhere in this stack, so a rebuild breaks the
// digest and the file then fails Peruri verification while looking perfect.
// Recorded at import so the download sheet can say so at the one moment it
// matters (core/import.js detectSigned).
export function createSource({ name, bytes, numPages = 0, encrypted = false, signed = false }) {
  return { id: nextId('src'), name, bytes, numPages, encrypted, signed };
}

// An annotation — stable id, referenced directly (never by {pageIndex,index}).
// `type` is one of: 'whiteout' | 'text' | 'signature' | 'watermark' | 'pageNumber'.
// `props` carries the type-specific fields (x, y, width, text, …).
export function createAnnotation(type, props = {}) {
  // WHY here and in updateAnnotation: every text the user pastes or types lands
  // through one of these two, and the screen and the file must read one string.
  if (type === 'text' && typeof props.text === 'string') props = { ...props, text: normaliseEnteredText(props.text) };
  return { id: nextId('anno'), type, ...props };
}

// ---- copy / paste -----------------------------------------------------------
// SINGLE SOURCE OF TRUTH for "what of an annotation travels when it is copied".
// WHY a per-type WHITELIST and not {...anno} minus a blacklist: an annotation
// can be bound to the document's own original content (a Ganti cover's
// replaceTargets/replaceBox, an OCR cover's ocrBox/paperImage, a replacement's
// replaceCoverId/ocrCoverId/docFontFamily/fontDecision, a paragraph `block`).
// Copying those would stamp a second cut onto the original or point at a cover
// that is not its own. A whitelist means a binding added tomorrow cannot leak
// into a paste until someone deliberately lists it here.
//   - text:      visible text + style. A replacement's text copies as PLAIN text
//                (it is the words the user sees); a paragraph `block` does not
//                (its line layout cannot be reproduced as one plain line).
//   - whiteout:  only a user-drawn one. A cover bound to the original (any of
//                replaceTargets/replaceBox/ocrBox/paperImage) IS the binding.
//   - signature: image (an immutable data-URL string, shared by reference as
//                history snapshots and "Semua Hal." already do) + geometry.
//   - `turn` (text, signature): the quarter turn a page turn gave the object
//                (core/annotation-geometry.js turnAnnotation). A paste reads
//                the way its source does on screen.
//   - anything else (watermark/pageNumber are unreachable from v2): not copyable.
const COPY_FIELDS = {
  text: ['text', 'x', 'y', 'turn', 'fontSize', 'fontFamily', 'bold', 'italic', 'color'],
  whiteout: ['x', 'y', 'width', 'height', 'color'],
  signature: ['image', 'x', 'y', 'turn', 'width', 'height'],
};
const DOC_BOUND_COVER = ['replaceTargets', 'replaceBox', 'ocrBox', 'paperImage'];

// A NEW annotation (fresh id, no page) from `anno`, or null if it is not
// copyable. Pure: never mutates `anno`, never adds to a doc (operations.js does).
export function isCopyable(anno) {
  if (!anno || !COPY_FIELDS[anno.type]) return false;
  if (anno.type === 'text') return !anno.block;
  if (anno.type === 'whiteout') return !DOC_BOUND_COVER.some((k) => anno[k] != null);
  if (anno.type === 'signature') return !!anno.image;
  return false;
}

export function cloneForPaste(anno) {
  if (!isCopyable(anno)) return null;
  const props = {};
  for (const k of COPY_FIELDS[anno.type]) if (anno[k] !== undefined) props[k] = anno[k];
  return createAnnotation(anno.type, props);
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
    // WHY a second copy of the same numbers: `width`/`height` are the LIVE
    // display size and normalizePageWidths (core/operations.js) rewrites them
    // when files are merged. `baseWidth`/`baseHeight` are what the source
    // artifact actually measured, recorded once and never mutated, so the
    // export/raster layers can recover the scale factor (width / baseWidth)
    // instead of re-deriving it from a vendor object that may disagree —
    // a copied pdf-lib page reports its UNROTATED MediaBox, which is not the
    // frame these dims live in. Ratio is uniform by construction: the
    // normalizer only ever scales both by the same factor.
    baseWidth: width,
    baseHeight: height,
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
