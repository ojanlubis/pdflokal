/*
 * Headless tests for the interaction-facing core ops: move / resize with
 * clamping. These exist so drag/resize UI code goes through the SINGLE
 * mutation path (invariant #5) instead of poking annotation.x directly
 * (which is what js/lab.js's demo drag did — harness-only, now retired).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDoc, createSource, createPage, createAnnotation, _resetIds } from '../../js/core/model.js';
import { addSource, addPages, addAnnotation, moveAnnotation, resizeAnnotation } from '../../js/core/operations.js';

function docWithPage() {
  _resetIds();
  const doc = createDoc();
  const src = addSource(doc, createSource({ name: 'a.pdf', bytes: new Uint8Array([1]), numPages: 1 }));
  addPages(doc, [createPage({ source: src, sourcePageNum: 0, width: 600, height: 800 })]);
  return doc;
}

test('moveAnnotation applies a delta in page space', () => {
  const doc = docWithPage();
  const anno = addAnnotation(doc, doc.pages[0].id, createAnnotation('text', { x: 100, y: 100, text: 'a' }));
  moveAnnotation(doc, anno.id, 15, -30);
  assert.equal(anno.x, 115);
  assert.equal(anno.y, 70);
});

test('moveAnnotation keeps the annotation anchor inside the page bounds', () => {
  const doc = docWithPage();
  const anno = addAnnotation(doc, doc.pages[0].id, createAnnotation('whiteout', { x: 10, y: 10, width: 50, height: 20 }));
  moveAnnotation(doc, anno.id, -500, -500);
  assert.equal(anno.x, 0);
  assert.equal(anno.y, 0);
  moveAnnotation(doc, anno.id, 5000, 5000);
  // Anchor clamps to page size minus the annotation's own size.
  assert.equal(anno.x, 550);
  assert.equal(anno.y, 780);
});

test('resizeAnnotation enforces a minimum size', () => {
  const doc = docWithPage();
  const anno = addAnnotation(doc, doc.pages[0].id, createAnnotation('signature', { x: 10, y: 10, width: 150, height: 60 }));
  resizeAnnotation(doc, anno.id, { width: 2, height: 1 });
  assert.ok(anno.width >= 8, `width ${anno.width} respects minimum`);
  assert.ok(anno.height >= 8, `height ${anno.height} respects minimum`);
});

test('resizeAnnotation can set bounds (x, y, width, height) atomically', () => {
  const doc = docWithPage();
  const anno = addAnnotation(doc, doc.pages[0].id, createAnnotation('whiteout', { x: 10, y: 10, width: 50, height: 20 }));
  resizeAnnotation(doc, anno.id, { x: 20, y: 30, width: 100, height: 40 });
  assert.deepEqual({ x: anno.x, y: anno.y, width: anno.width, height: anno.height }, { x: 20, y: 30, width: 100, height: 40 });
});

test('move/resize on unknown id are safe no-ops returning null', () => {
  const doc = docWithPage();
  assert.equal(moveAnnotation(doc, 'anno_nope', 1, 1), null);
  assert.equal(resizeAnnotation(doc, 'anno_nope', { width: 10 }), null);
});
