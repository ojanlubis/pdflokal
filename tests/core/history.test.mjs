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
import { addSource, addPages, removePage, reorderPage, rotatePage, addAnnotation, updateAnnotation, removeAnnotation, selectAnnotation } from '../../js/core/operations.js';
import { createHistory, record, undo, redo, canUndo, canRedo } from '../../js/core/history.js';

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
