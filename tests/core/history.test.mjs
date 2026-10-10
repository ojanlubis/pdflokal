/*
 * Headless tests for core/history.js — unified undo/redo on the Doc model.
 * Run: npm run test:core   (node --test, no browser)
 *
 * The contract: record() BEFORE a mutation (gesture-level, not per-frame),
 * undo()/redo() swap full model snapshots. Sources (bytes) are shared by
 * reference — never cloned. Annotation strings (signature dataUrls) are
 * immutable in JS, so shallow copies share them for free (no imageRegistry).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDoc, createSource, createPage, createAnnotation, _resetIds } from '../../js/core/model.js';
import { addSource, addPages, removePage, reorderPage, rotatePage, addAnnotation, updateAnnotation, removeAnnotation, moveAnnotation, resizeAnnotation, selectAnnotation } from '../../js/core/operations.js';
import { createHistory, record, undo, redo, canUndo, canRedo, isDirty, markClean, markChanged, settle } from '../../js/core/history.js';
import { rasterKey, rasterFitsShape, rasterIsCurrent } from '../../js/core/raster-key.js';

function docWithTwoPages() {
  _resetIds();
  const doc = createDoc();
  const src = addSource(doc, createSource({ name: 'a.pdf', bytes: new Uint8Array([1, 2, 3]), numPages: 2 }));
  addPages(doc, [
    createPage({ source: src, sourcePageNum: 0, width: 595, height: 842 }),
    createPage({ source: src, sourcePageNum: 1, width: 595, height: 842 }),
  ]);
  return doc;
}

test('undo restores a removed page WITH its annotations', () => {
  const doc = docWithTwoPages();
  const [p1] = doc.pages;
  const anno = addAnnotation(doc, p1.id, createAnnotation('text', { x: 10, y: 20, text: 'halo' }));

  const h = createHistory();
  record(h, doc);
  removePage(doc, p1.id);
  assert.equal(doc.pages.length, 1);

  undo(h, doc);
  assert.equal(doc.pages.length, 2);
  assert.equal(doc.pages[0].id, p1.id);
  assert.equal(doc.pages[0].annotations.length, 1);
  assert.equal(doc.pages[0].annotations[0].id, anno.id);
  assert.equal(doc.pages[0].annotations[0].text, 'halo');
});

test('undo/redo round-trips a reorder', () => {
  const doc = docWithTwoPages();
  const [p1, p2] = doc.pages;
  const h = createHistory();

  record(h, doc);
  reorderPage(doc, p1.id, 1);
  assert.deepEqual(doc.pages.map((p) => p.id), [p2.id, p1.id]);

  undo(h, doc);
  assert.deepEqual(doc.pages.map((p) => p.id), [p1.id, p2.id]);
  redo(h, doc);
  assert.deepEqual(doc.pages.map((p) => p.id), [p2.id, p1.id]);
});

test('undo of an annotation edit does not disturb later unrelated state', () => {
  const doc = docWithTwoPages();
  const [p1, p2] = doc.pages;
  const anno = addAnnotation(doc, p1.id, createAnnotation('whiteout', { x: 0, y: 0, width: 50, height: 20 }));
  const h = createHistory();

  record(h, doc);
  updateAnnotation(doc, anno.id, { x: 99 });
  // A later, un-recorded change to page 2's rotation is NOT part of the undo step
  // contract — undo restores the recorded snapshot wholesale. Verify exactly that.
  rotatePage(doc, p2.id, 90);

  undo(h, doc);
  assert.equal(doc.pages[0].annotations[0].x, 0, 'annotation x restored');
  assert.equal(doc.pages[1].rotation, 0, 'snapshot restore is wholesale');
});

test('new record() clears the redo stack (no branching)', () => {
  const doc = docWithTwoPages();
  const [p1] = doc.pages;
  const h = createHistory();

  record(h, doc);
  rotatePage(doc, p1.id, 90);
  undo(h, doc);
  assert.equal(canRedo(h), true);

  record(h, doc);
  rotatePage(doc, p1.id, 180);
  assert.equal(canRedo(h), false, 'divergent edit kills redo branch');
});

test('history is capped at its limit (oldest dropped)', () => {
  const doc = docWithTwoPages();
  const [p1] = doc.pages;
  const h = createHistory(3);
  for (let i = 0; i < 5; i++) {
    record(h, doc);
    rotatePage(doc, p1.id, 90);
  }
  assert.equal(h.undoStack.length, 3);
  // 5 rotations = 450° → normalized 90. Undo x3 lands at rotation after 2 rotations = 180.
  undo(h, doc); undo(h, doc); undo(h, doc);
  assert.equal(canUndo(h), false);
  assert.equal(doc.pages[0].rotation, 180);
});

test('snapshots share source bytes and signature dataUrls by reference (no clone)', () => {
  const doc = docWithTwoPages();
  const [p1] = doc.pages;
  const bigString = 'data:image/png;base64,' + 'x'.repeat(1000);
  addAnnotation(doc, p1.id, createAnnotation('signature', { x: 0, y: 0, width: 150, height: 60, image: bigString }));
  const h = createHistory();
  record(h, doc);

  const snap = h.undoStack[0];
  assert.equal(snap.pages[0].annotations[0].image, bigString, 'string shared');
  assert.equal(doc.sources[0].bytes, snap.sources ? snap.sources[0].bytes : doc.sources[0].bytes, 'bytes never cloned');
});

test('undo restores selection as-of the snapshot', () => {
  const doc = docWithTwoPages();
  const [p1] = doc.pages;
  const anno = addAnnotation(doc, p1.id, createAnnotation('text', { x: 1, y: 1, text: 'a' }));
  selectAnnotation(doc, anno.id);

  const h = createHistory();
  record(h, doc);
  removeAnnotation(doc, anno.id);
  assert.equal(doc.selection.annotationId, null);

  undo(h, doc);
  assert.equal(doc.selection.annotationId, anno.id);
});

test('undo() / redo() on empty stacks are safe no-ops', () => {
  const doc = docWithTwoPages();
  const h = createHistory();
  assert.equal(undo(h, doc), false);
  assert.equal(redo(h, doc), false);
  assert.equal(canUndo(h), false);
  assert.equal(canRedo(h), false);
});

// ============================================================================
// Rasters are NOT history (2026-10-02). Snapshots used to carry page.raster by
// reference, pinning every raster a page had at record time. Measured: 5 pages
// x 40 edits x 1.3 MiB rasters retained 266 MiB; with the fix, ~0.
// ============================================================================
const fakeRaster = (page, n = 0) => ({ dataUrl: 'data:image/png;base64,' + 'A'.repeat(64) + n, width: 10, height: 10, scale: 2, key: rasterKey(page) });

// Every object reachable from the history stacks, so a snapshot cannot hide a
// raster behind a new field name. Strings are values; objects are identity.
function reachable(root) {
  const seen = new Set();
  const walk = (v) => {
    if (!v || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    for (const k of Object.keys(v)) walk(v[k]);
  };
  walk(root);
  return seen;
}

test('history keeps NO page raster alive, however many rasters replace each other between edits', () => {
  const doc = docWithTwoPages();
  const h = createHistory(50, { carryRaster: rasterFitsShape });
  const live = new Set();
  for (let i = 0; i < 30; i++) {
    record(h, doc);
    addAnnotation(doc, doc.pages[0].id, createAnnotation('text', { x: i, y: i, text: 'e' + i }));
    for (const p of doc.pages) { p.raster = fakeRaster(p, i); live.add(p.raster); } // zoom-sharpen / re-render swaps it
  }
  const held = [...reachable([h.undoStack, h.redoStack])].filter((o) => o.dataUrl !== undefined || live.has(o));
  assert.equal(held.length, 0, 'no raster object is reachable from the undo/redo stacks');
  for (const snap of h.undoStack) for (const p of snap.pages) assert.equal('raster' in p, false, 'snapshot page has no raster field');
});

test('undo/redo restores every tool\'s state exactly (rasters excluded)', () => {
  const sig = 'data:image/png;base64,SIG';
  const steps = {
    'add text': (d, [p1]) => addAnnotation(d, p1.id, createAnnotation('text', { x: 5, y: 6, text: 'halo', fontSize: 14 })),
    'add signature': (d, [p1]) => addAnnotation(d, p1.id, createAnnotation('signature', { x: 0, y: 0, width: 150, height: 60, image: sig })),
    'add whiteout (Tip-Ex)': (d, [p1]) => addAnnotation(d, p1.id, createAnnotation('whiteout', { x: 1, y: 2, width: 40, height: 10 })),
    'ganti pair': (d, [p1]) => {
      const c = addAnnotation(d, p1.id, createAnnotation('whiteout', { x: 1, y: 2, width: 40, height: 10, replaceTargets: [{ x0: 1, y0: 2, ux: 1, uy: 0, size: 12, len: 40 }], replaceBox: { x: 1, y: 2, w: 40, h: 10 } }));
      addAnnotation(d, p1.id, createAnnotation('text', { x: 1, y: 2, text: 'baru', replaceCoverId: c.id }));
    },
    'move': (d, [p1]) => moveAnnotation(d, p1.annotations[0].id, 7, 9),
    'resize': (d, [p1]) => resizeAnnotation(d, p1.annotations[0].id, { width: 99, height: 33 }),
    'style (format bar)': (d, [p1]) => updateAnnotation(d, p1.annotations[0].id, { bold: true, color: '#f00', fontSize: 22 }),
    'delete annotation (Hapus)': (d, [p1]) => removeAnnotation(d, p1.annotations[0].id),
    'rotate page': (d, [p1]) => rotatePage(d, p1.id, 90),
    'reorder page': (d, [p1]) => reorderPage(d, p1.id, 1),
    'delete page': (d, [p1]) => removePage(d, p1.id),
  };
  const state = (d) => JSON.parse(JSON.stringify({ pages: d.pages.map(({ raster, ...p }) => p), selection: d.selection }));
  for (const [name, step] of Object.entries(steps)) {
    const doc = docWithTwoPages();
    const [p1] = doc.pages;
    addAnnotation(doc, p1.id, createAnnotation('text', { x: 3, y: 3, text: 'seed' }));
    for (const p of doc.pages) p.raster = fakeRaster(p);
    const h = createHistory(50, { carryRaster: rasterFitsShape });
    const before = state(doc);
    record(h, doc);
    step(doc, doc.pages);
    const after = state(doc);
    assert.notDeepEqual(after, before, `${name}: the step changed something`);
    assert.equal(undo(h, doc), true);
    assert.deepEqual(state(doc), before, `${name}: undo restores the pre-state`);
    assert.equal(redo(h, doc), true);
    assert.deepEqual(state(doc), after, `${name}: redo restores the post-state`);
  }
});

test('restore carries a live raster that still fits the page, and only that', () => {
  const doc = docWithTwoPages();
  const [p1, p2] = doc.pages;
  p1.raster = fakeRaster(p1); p2.raster = fakeRaster(p2);
  const r1 = p1.raster, r2 = p2.raster;
  const h = createHistory(50, { carryRaster: rasterFitsShape });

  // annotation edit: the page PICTURE is unchanged (annotations are DOM overlay) -> no re-render on undo
  record(h, doc);
  addAnnotation(doc, p1.id, createAnnotation('text', { x: 1, y: 1, text: 'a' }));
  undo(h, doc);
  assert.equal(doc.pages[0].raster, r1, 'unchanged picture keeps its live raster (no re-render)');
  assert.equal(doc.pages[1].raster, r2);

  // rotation: the raster is pre-rotated, so the restored page must NOT inherit the live one
  record(h, doc);
  rotatePage(doc, doc.pages[0].id, 90);
  doc.pages[0].raster = fakeRaster(doc.pages[0], 'rot'); // the render layer re-rendered it rotated
  undo(h, doc);
  assert.equal(doc.pages[0].rotation, 0);
  assert.equal(doc.pages[0].raster, null, 'a raster of the other orientation is dropped, render layer re-derives');
  assert.equal(doc.pages[1].raster, r2, 'the untouched page keeps its raster');
});

test('restore never resurrects a raster for a deleted page, and never carries without a cacheKey', () => {
  const doc = docWithTwoPages();
  const [p1] = doc.pages;
  p1.raster = fakeRaster(p1);
  const h = createHistory(50, { carryRaster: rasterFitsShape });
  record(h, doc);
  removePage(doc, p1.id);
  undo(h, doc);
  assert.equal(doc.pages[0].id, p1.id);
  assert.equal(doc.pages[0].raster, null, 'a restored deleted page has no raster until re-rendered');

  const bare = docWithTwoPages();
  bare.pages[0].raster = fakeRaster(bare.pages[0]);
  const h2 = createHistory(); // no carryRaster configured: always safe, never carries
  record(h2, bare);
  addAnnotation(bare, bare.pages[0].id, createAnnotation('text', { x: 1, y: 1, text: 'a' }));
  undo(h2, bare);
  assert.equal(bare.pages[0].raster, null);
});

test('a stale raster (edits moved on) may stand in for the no-seam swap, but is identifiable as stale', () => {
  // Same shape, other edits: carried so the page never blanks (spec-live-surgery §7),
  // and rasterIsCurrent says false so the app re-bakes it. This is also the in-flight
  // case: the live page already has the new edit while its raster predates it.
  const doc = docWithTwoPages();
  const [p1] = doc.pages;
  p1.raster = fakeRaster(p1); // stamped for the no-edit picture
  const stale = p1.raster;
  const h = createHistory(50, { carryRaster: rasterFitsShape });
  const c = addAnnotation(doc, p1.id, createAnnotation('whiteout', { x: 1, y: 2, width: 40, height: 10, replaceTargets: [{ x0: 1, y0: 2, ux: 1, uy: 0, size: 12, len: 40 }], replaceBox: { x: 1, y: 2, w: 40, h: 10 } }));
  addAnnotation(doc, p1.id, createAnnotation('text', { x: 1, y: 2, text: 'baru', replaceCoverId: c.id }));
  record(h, doc);                     // snapshot WITH the edit
  addAnnotation(doc, p1.id, createAnnotation('text', { x: 9, y: 9, text: 'nudge' }));
  undo(h, doc);
  assert.equal(doc.pages[0].raster, stale, 'carried (no blank frame)');
  assert.equal(rasterIsCurrent(doc.pages[0].raster, doc.pages[0]), false, 'but flagged stale, so the app re-bakes');
});

test('rasterIsCurrent: a raster rendered for exactly this page is current', () => {
  const doc = docWithTwoPages();
  const p = doc.pages[0];
  p.raster = fakeRaster(p);
  assert.equal(rasterIsCurrent(p.raster, p), true);
  assert.equal(rasterIsCurrent({ dataUrl: 'x', scale: 2 }, p), false, 'a raster with no provenance is never trusted');
});

// ---- dirty = "changed since the last file the user got" (leave-site guard) ----------------
test('dirty: a fresh history is clean; record() makes it dirty and tells the listener once per flip', () => {
  const doc = docWithTwoPages();
  const flips = [];
  const h = createHistory(50, { onDirtyChange: (d) => flips.push(d) });
  assert.equal(isDirty(h), false);
  record(h, doc);
  record(h, doc);
  assert.equal(isDirty(h), true);
  assert.deepEqual(flips, [true], 'one flip, not one call per record');
  markClean(h);
  assert.equal(isDirty(h), false);
  assert.deepEqual(flips, [true, false]);
});

test('dirty: undo back to exactly the downloaded state is clean; redo past it is dirty again', () => {
  const doc = docWithTwoPages();
  const h = createHistory();
  record(h, doc); addAnnotation(doc, doc.pages[0].id, createAnnotation('text', { x: 1, y: 1, text: 'a' }));
  markClean(h); // "downloaded" with one annotation
  assert.equal(isDirty(h), false);
  record(h, doc); addAnnotation(doc, doc.pages[0].id, createAnnotation('text', { x: 2, y: 2, text: 'b' }));
  assert.equal(isDirty(h), true);
  undo(h, doc);
  assert.equal(isDirty(h), false, 'back on the downloaded state');
  redo(h, doc);
  assert.equal(isDirty(h), true);
  undo(h, doc); undo(h, doc); // past it, to the pre-edit state
  assert.equal(isDirty(h), true, 'a state that was never downloaded is dirty');
  redo(h, doc);
  assert.equal(isDirty(h), false);
});

test('dirty: a new edit after undoing past the clean state cannot alias it back to clean', () => {
  const doc = docWithTwoPages();
  const h = createHistory();
  record(h, doc); addAnnotation(doc, doc.pages[0].id, createAnnotation('text', { x: 1, y: 1, text: 'a' }));
  markClean(h);
  undo(h, doc);                 // pre-edit state, dirty
  record(h, doc); addAnnotation(doc, doc.pages[0].id, createAnnotation('text', { x: 5, y: 5, text: 'other' }));
  assert.equal(isDirty(h), true, 'a different edit is not the downloaded one');
  undo(h, doc);
  assert.equal(isDirty(h), true, 'and its pre-state is the pre-edit state, still not the downloaded one');
});

test('dirty: markChanged (an un-undoable mutation) dirties; settle() takes back a recorded-then-cancelled gesture', () => {
  const doc = docWithTwoPages();
  const h = createHistory();
  markChanged(h);
  assert.equal(isDirty(h), true);
  markClean(h);
  record(h, doc);               // gesture starts...
  assert.equal(isDirty(h), true);
  settle(h);                    // ...and backs out with the doc untouched
  assert.equal(isDirty(h), false);
  assert.equal(canUndo(h), true, 'undo behaviour is unchanged by settle');
  settle(createHistory());      // empty stack: no throw, nothing to do
});

// A merge is not undoable, so it only calls markChanged(). Every snapshot taken
// before it holds the doc WITHOUT the merged pages: undoing an earlier edit
// after a merge used to restore one of those wholesale and silently drop every
// page the merge added. An un-undoable mutation is a barrier: nothing before
// it is reachable any more.
test('markChanged is an undo barrier: undo after a merge never drops the merged pages', () => {
  const doc = docWithTwoPages();
  const h = createHistory();
  const [p1] = doc.pages;
  record(h, doc);
  addAnnotation(doc, p1.id, createAnnotation('text', { x: 10, y: 20, text: 'ttd' }));
  assert.equal(canUndo(h), true, 'known-positive: the edit is undoable before the merge');

  const src = addSource(doc, createSource({ name: 'b.pdf', bytes: new Uint8Array([4]), numPages: 1 }));
  addPages(doc, [createPage({ source: src, sourcePageNum: 0, width: 595, height: 842 })]);
  markChanged(h);

  assert.equal(undo(h, doc), false, 'undo crossed the merge barrier');
  assert.equal(doc.pages.length, 3, 'the merged page is gone after undo');
  assert.equal(canUndo(h), false);
  assert.equal(canRedo(h), false);
});
