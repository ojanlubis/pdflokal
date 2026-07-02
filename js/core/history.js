/*
 * PDFLokal — core/history.js  (HEADLESS — unified undo/redo)
 * ============================================================================
 * ONE history for everything (page ops AND annotation edits). The old editor
 * needed two stacks + an imageRegistry because its state was six parallel
 * index-keyed maps and snapshots had to dodge base64 blobs. On the Doc model
 * none of that is needed:
 *
 *   - Snapshots are shallow-ish copies: pages and annotations are copied as
 *     fresh objects, but their STRING fields (signature dataUrls — the big
 *     stuff) are immutable in JS and shared by reference. Free.
 *   - Sources (raw PDF bytes) are append-only and never mutated → shared by
 *     reference, never cloned.
 *   - page.raster is a render-layer cache, carried by reference; the render
 *     layer re-rasterizes when missing/stale. Undo never re-renders PDFs.
 *
 * Contract: call record(h, doc) BEFORE a user-level mutation (one per gesture,
 * not per pointermove). undo/redo swap wholesale snapshots — no re-keying, no
 * index math, no special cases.
 */

const DEFAULT_LIMIT = 50;

// WHY a snapshot and not a command log: the op set is still growing (v2 build)
// and wholesale restore is impossible to get subtly wrong. Snapshot cost is
// O(pages + annotations) small objects — bytes/dataUrls/rasters are shared.
function snapshot(doc) {
  return {
    pages: doc.pages.map((p) => ({
      ...p,
      annotations: p.annotations.map((a) => ({ ...a })),
    })),
    sources: doc.sources, // append-only; shared by reference on purpose
    selection: { ...doc.selection },
  };
}

function restore(doc, snap) {
  // Restore hands back the snapshot's own objects (they are private copies —
  // record() never reuses them), re-copying so a later undo of THIS state
  // still has a pristine copy to return to.
  doc.pages = snap.pages.map((p) => ({
    ...p,
    annotations: p.annotations.map((a) => ({ ...a })),
  }));
  doc.sources = snap.sources;
  doc.selection = { ...snap.selection };
}

export function createHistory(limit = DEFAULT_LIMIT) {
  return { undoStack: [], redoStack: [], limit };
}

// Call BEFORE mutating. Clears redo (no branching timelines).
export function record(history, doc) {
  history.undoStack.push(snapshot(doc));
  if (history.undoStack.length > history.limit) history.undoStack.shift();
  history.redoStack.length = 0;
}

export function undo(history, doc) {
  const snap = history.undoStack.pop();
  if (!snap) return false;
  history.redoStack.push(snapshot(doc));
  restore(doc, snap);
  return true;
}

export function redo(history, doc) {
  const snap = history.redoStack.pop();
  if (!snap) return false;
  history.undoStack.push(snapshot(doc));
  restore(doc, snap);
  return true;
}

export function canUndo(history) { return history.undoStack.length > 0; }
export function canRedo(history) { return history.redoStack.length > 0; }
