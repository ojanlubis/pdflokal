/*
 * Headless tests for "Terapkan ke Semua Hal." (core/operations.js
 * copySignatureToAllPages / pagesMissingSignature). Run: npm run test:core
 *
 * The contract: the button is IDEMPOTENT. The selection survives the copy, so
 * the button stays visible and a second tap is routine (double tap, "did it
 * work?"). A page that already carries this signature at this spot must not
 * get another one, or Hapus on a page seems to do nothing (the twin underneath
 * shows through) and the exported file carries stacked duplicates.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDoc, createSource, createPage, createAnnotation, _resetIds } from '../../js/core/model.js';
import {
  addSource, addPages, addAnnotation, removeAnnotation, moveAnnotation,
  copySignatureToAllPages, pagesMissingSignature,
} from '../../js/core/operations.js';

function fixture(numPages = 3) {
  _resetIds();
  const doc = createDoc();
  const src = addSource(doc, createSource({ name: 'a.pdf', bytes: new Uint8Array([1]), numPages }));
  addPages(doc, Array.from({ length: numPages }, (_, n) => createPage({ source: src, sourcePageNum: n, width: 600, height: 800 })));
  const sig = addAnnotation(doc, doc.pages[0].id, createAnnotation('signature', {
    image: 'data:image/png;base64,AAAA', x: 100, y: 200, width: 120, height: 40,
  }));
  return { doc, sig };
}

const sigCount = (pg) => pg.annotations.filter((a) => a.type === 'signature').length;

test('first tap puts exactly one copy on every other page, none extra on the home page', () => {
  const { doc, sig } = fixture();
  const added = copySignatureToAllPages(doc, sig.id);
  assert.equal(added.length, 2);
  assert.deepEqual(doc.pages.map(sigCount), [1, 1, 1]);
  assert.notEqual(doc.pages[1].annotations[0].id, sig.id, 'each copy is its own object');
});

test('second tap adds nothing: no page ends up with two signatures', () => {
  const { doc, sig } = fixture();
  copySignatureToAllPages(doc, sig.id);
  const again = copySignatureToAllPages(doc, sig.id);
  assert.equal(again.length, 0);
  assert.deepEqual(doc.pages.map(sigCount), [1, 1, 1]);
  assert.deepEqual(pagesMissingSignature(doc, sig.id), [], 'nothing left to record history for');
});

test('a page whose copy was deleted gets it back; pages that kept theirs do not double', () => {
  const { doc, sig } = fixture();
  copySignatureToAllPages(doc, sig.id);
  removeAnnotation(doc, doc.pages[2].annotations[0].id);
  copySignatureToAllPages(doc, sig.id);
  assert.deepEqual(doc.pages.map(sigCount), [1, 1, 1]);
});

test('a copy the user moved elsewhere is a different spot, so a fresh one is added', () => {
  const { doc, sig } = fixture(2);
  copySignatureToAllPages(doc, sig.id);
  moveAnnotation(doc, doc.pages[1].annotations[0].id, 50, 50);
  copySignatureToAllPages(doc, sig.id);
  assert.equal(sigCount(doc.pages[1]), 2);
});

test('a different signature image at the same spot is not "this signature"', () => {
  const { doc, sig } = fixture(2);
  addAnnotation(doc, doc.pages[1].id, createAnnotation('signature', {
    image: 'data:image/png;base64,BBBB', x: sig.x, y: sig.y, width: sig.width, height: sig.height,
  }));
  copySignatureToAllPages(doc, sig.id);
  assert.equal(sigCount(doc.pages[1]), 2);
});

test('a non-signature annotation is never copied', () => {
  const { doc } = fixture(2);
  const txt = addAnnotation(doc, doc.pages[0].id, createAnnotation('text', { text: 'x', x: 1, y: 1, fontSize: 12 }));
  assert.deepEqual(copySignatureToAllPages(doc, txt.id), []);
  assert.equal(doc.pages[1].annotations.length, 0);
});
