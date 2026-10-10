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
 *   - page.raster is a render-layer cache and is NEVER stored in a snapshot.
 *     It used to be ({...p} carried it by reference), which pinned every
 *     raster the page had ever had at record time: a PNG data URL per page
 *     per undo step, multiplied by zoom-sharpen (4x+ rasters), and nothing
 *     could free them while the step sat in the 50-deep stack. Measured
 *     2026-10-02: 5 pages x 40 edits at 1.3 MiB/raster retained 266 MiB.
 *     On restore the raster is RE-DERIVED: the live page's raster is carried
 *     over when it still fits the restored page (history.carryRaster says
 *     so), else it is null and the render layer re-rasterizes, exactly as it
 *     does for any page that has not been drawn yet.
 *
 * Contract: call record(h, doc) BEFORE a user-level mutation (one per gesture,
 * not per pointermove). undo/redo swap wholesale snapshots — no re-keying, no
 * index math, no special cases.
 */

const DEFAULT_LIMIT = 50;

// WHY a snapshot and not a command log: the op set is still growing (v2 build)
// and wholesale restore is impossible to get subtly wrong. Snapshot cost is
// O(pages + annotations) small objects — bytes/dataUrls/rasters are shared.
function snapshotPage(p) {
  const copy = { ...p, annotations: p.annotations.map((a) => ({ ...a })) };
  delete copy.raster; // render cache, re-derived on restore — see header
  return copy;
}

function snapshot(doc) {
  return {
    pages: doc.pages.map(snapshotPage),
    sources: doc.sources, // append-only; shared by reference on purpose
    selection: { ...doc.selection },
  };
}

function restore(history, doc, snap) {
  // Restore hands back the snapshot's own objects (they are private copies —
  // record() never reuses them), re-copying so a later undo of THIS state
  // still has a pristine copy to return to.
  //
  // The raster comes from the LIVE page (about to be replaced), never from the
  // snapshot, and only if history.carryRaster(raster, restoredPage) says it
  // still fits (app: core/raster-key.js rasterFitsShape — right grid and
  // orientation; it may be STALE in content, the app re-bakes those). A page
  // that did not exist live (undo of a delete), or whose raster does not fit
  // (rotated, resized), gets null and is re-rasterized by the render layer.
  // With no carryRaster configured nothing is carried: always safe.
  const carry = history.carryRaster;
  const live = new Map(doc.pages.map((p) => [p.id, p]));
  doc.pages = snap.pages.map((p) => {
    const page = { ...p, annotations: p.annotations.map((a) => ({ ...a })), raster: null };
    const was = carry ? live.get(p.id) : null;
    if (was && was.raster && carry(was.raster, page)) page.raster = was.raster;
    return page;
  });
  doc.sources = snap.sources;
  doc.selection = { ...snap.selection };
}

// `carryRaster(raster, page)` (optional) -> boolean: may a live raster stand in
// for a restored page? Supplied by the app (core/raster-key.js); this module
// stays ignorant of what a raster shows.
// `onDirtyChange(dirty)` (optional): called when "has changes since the last
// markClean" flips, never otherwise. The app hangs the leave-site guard on it.
//
// DIRTY IS AN ID, NOT A FLAG. Every state the doc passes through between
// record() calls has a serial; `current` is the live one, `cleanId` the one
// last handed to the user as a file. Each snapshot carries the serial of the
// state it holds, so undo/redo move `current` back and forth along the same
// ids and "undo back to exactly the downloaded state" is clean again for free.
// A flag could not do that: it would stay dirty after the undo.
export function createHistory(limit = DEFAULT_LIMIT, { carryRaster = null, onDirtyChange = null } = {}) {
  return {
    undoStack: [], redoStack: [], limit, carryRaster,
    current: 0, cleanId: 0, nextId: 1, wasDirty: false, onDirtyChange,
  };
}

function syncDirty(history) {
  const dirty = history.current !== history.cleanId;
  if (dirty === history.wasDirty) return;
  history.wasDirty = dirty;
  if (history.onDirtyChange) history.onDirtyChange(dirty);
}

// Call BEFORE mutating. Clears redo (no branching timelines).
export function record(history, doc) {
  history.undoStack.push({ ...snapshot(doc), id: history.current });
  if (history.undoStack.length > history.limit) history.undoStack.shift();
  history.redoStack.length = 0;
  history.current = history.nextId++;
  syncDirty(history);
}

export function undo(history, doc) {
  const snap = history.undoStack.pop();
  if (!snap) return false;
  history.redoStack.push({ ...snapshot(doc), id: history.current });
  restore(history, doc, snap);
  history.current = snap.id;
  syncDirty(history);
  return true;
}

export function redo(history, doc) {
  const snap = history.redoStack.pop();
  if (!snap) return false;
  history.undoStack.push({ ...snapshot(doc), id: history.current });
  restore(history, doc, snap);
  history.current = snap.id;
  syncDirty(history);
  return true;
}

export function isDirty(history) { return history.current !== history.cleanId; }

// The doc as it is NOW is the one the user has in a file (or just opened).
export function markClean(history) {
  history.cleanId = history.current;
  syncDirty(history);
}

// A mutation that is NOT undoable and so never went through record() (merging
// another file into the open doc). Gives the live state a serial no file has.
//
// WHY it also clears both stacks: every snapshot taken before this mutation
// holds a doc WITHOUT it, and restore() swaps doc.pages wholesale. Undoing an
// earlier edit after a merge used to silently drop every merged page. An
// un-undoable mutation is a barrier; nothing on the far side is reachable.
export function markChanged(history) {
  history.undoStack.length = 0;
  history.redoStack.length = 0;
  history.current = history.nextId++;
  syncDirty(history);
}

// A gesture that record()ed and then backed out leaving the doc exactly as it
// was (Ganti: the cover is placed after record(), removed again on Escape). The
// undo entry stays — undo behaviour is unchanged — but the state is the one
// before it, so the serial goes back too. Call ONLY when nothing else changed
// since that record().
export function settle(history) {
  const top = history.undoStack.at(-1);
  if (!top) return;
  history.current = top.id;
  syncDirty(history);
}

export function canUndo(history) { return history.undoStack.length > 0; }
export function canRedo(history) { return history.redoStack.length > 0; }
