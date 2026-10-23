/*
 * GAMBAR: A PICTURE STAYS A PICTURE (kind:'picture' on the signature object)
 * and the selected-object bar says so (core/sig-bar.js).
 *
 * RED WITHOUT THE FEATURE: placeImage set no kind, COPY_FIELDS dropped it, and
 * the bar offered "Gambar Ulang" (the signature drawing sheet) on a photo.
 * Run: npm run test:core
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createDoc, createSource, createPage, createAnnotation, cloneForPaste, _resetIds,
} from '../../js/core/model.js';
import {
  addSource, addPages, addAnnotation, placeImage, placeSignature, isPicture,
  duplicateAnnotation, copySignatureToAllPages,
} from '../../js/core/operations.js';
import { createHistory, record, undo, redo } from '../../js/core/history.js';
import { sigBarState } from '../../js/core/sig-bar.js';

function fixture() {
  _resetIds();
  const doc = createDoc();
  const src = addSource(doc, createSource({ name: 'a.pdf', bytes: new Uint8Array([1]), numPages: 2 }));
  addPages(doc, [0, 1].map((n) => createPage({ source: src, sourcePageNum: n, width: 600, height: 800 })));
  return doc;
}
const PX = { image: 'data:image/png;base64,AAAA', pxWidth: 100, pxHeight: 50 };

test('placeImage marks the object a picture; placeSignature does not', () => {
  const doc = fixture();
  const pic = placeImage(doc, doc.pages[0].id, PX, 300, 400);
  assert.equal(pic.kind, 'picture');
  assert.ok(isPicture(pic));
  const sig = placeSignature(doc, doc.pages[0].id, { image: 'data:image/png;base64,BBBB', ratio: 0.4 }, 300, 400);
  assert.ok(!isPicture(sig), 'a signature is not a picture');
  assert.ok(!isPicture({ type: 'signature', image: 'x' }), 'an old object without kind stays a signature');
});

test('Ctrl+C / Ctrl+V of a picture keeps it a picture; a signature stays one', () => {
  const doc = fixture();
  const pic = placeImage(doc, doc.pages[0].id, PX, 300, 400);
  assert.equal(cloneForPaste(pic).kind, 'picture');
  const copy = duplicateAnnotation(doc, doc.pages[1].id, pic);
  assert.ok(copy && isPicture(copy), 'duplicate onto another page keeps kind');
  const plain = createAnnotation('signature', { image: 'x', x: 1, y: 1, width: 5, height: 5 });
  assert.ok(!('kind' in cloneForPaste(plain)), 'no kind invented for a signature');
});

test('"Semua Hal." copies of a picture are pictures', () => {
  const doc = fixture();
  const pic = placeImage(doc, doc.pages[0].id, PX, 300, 400);
  const added = copySignatureToAllPages(doc, pic.id);
  assert.equal(added.length, 1);
  assert.ok(isPicture(added[0]));
});

test('undo / redo carry kind (it is a plain field on the object)', () => {
  const doc = fixture();
  const h = createHistory();
  const pic = placeImage(doc, doc.pages[0].id, PX, 300, 400);
  record(h, doc);
  addAnnotation(doc, doc.pages[0].id, createAnnotation('whiteout', { x: 1, y: 1, width: 10, height: 10 }));
  undo(h, doc);
  redo(h, doc);
  const back = doc.pages[0].annotations.find((a) => a.id === pic.id);
  assert.equal(back.kind, 'picture');
});

test('bar: a selected picture says so and hides Gambar Ulang; a signature keeps both', () => {
  const doc = fixture();
  const pic = placeImage(doc, doc.pages[0].id, PX, 300, 400);
  const sig = placeSignature(doc, doc.pages[0].id, { image: 'data:image/png;base64,BBBB', ratio: 0.4 }, 300, 400);
  const p = sigBarState({ selected: pic, armedSig: false, armedGambar: false, pageCount: 2 });
  assert.deepEqual(p, { show: true, showAllPages: true, showRedraw: false, label: 'picture' });
  const s = sigBarState({ selected: sig, armedSig: false, armedGambar: false, pageCount: 1 });
  assert.deepEqual(s, { show: true, showAllPages: false, showRedraw: true, label: 'signature' });
});

test('bar: armed states', () => {
  assert.deepEqual(sigBarState({ selected: null, armedSig: true, armedGambar: false, pageCount: 1 }),
    { show: true, showAllPages: false, showRedraw: true, label: 'armed' });
  assert.deepEqual(sigBarState({ selected: null, armedSig: false, armedGambar: true, pageCount: 1 }),
    { show: true, showAllPages: false, showRedraw: false, label: 'armed' });
  assert.deepEqual(sigBarState({ selected: null, armedSig: false, armedGambar: false, pageCount: 1 }),
    { show: false, showAllPages: false, showRedraw: false, label: '' });
});
