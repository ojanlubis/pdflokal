/*
 * MERGE NORMALISATION MOVES A PAGE'S ANNOTATIONS WITH THE PAGE.
 * ============================================================================
 * Annotation geometry lives in the page's NORMALISED display frame (export.js
 * scaleAnnotationGeometry divides it back out by width/baseWidth). When a merge
 * rescales a page that already carries annotations — a landscape page 2 in a
 * portrait document, a phone photo opened first — normalizePageWidths changed
 * page.width/height and left every annotation at its old numbers: a signature
 * at x=800 on an 842-wide page stayed at 800 on a page now 595 wide, off the
 * page on screen and in the file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDoc, createSource, createPage, createAnnotation, _resetIds } from '../../js/core/model.js';
import { addSource, addPages, addAnnotation, normalizePageWidths } from '../../js/core/operations.js';

function mixedDoc() {
  _resetIds();
  const doc = createDoc();
  const a = addSource(doc, createSource({ name: 'a.pdf', bytes: new Uint8Array([1]), numPages: 2 }));
  addPages(doc, [
    createPage({ source: a, sourcePageNum: 0, width: 595, height: 842 }),
    createPage({ source: a, sourcePageNum: 1, width: 842, height: 595 }), // landscape
  ]);
  return doc;
}

test('1. annotations on a rescaled page scale with it; untouched pages keep theirs', () => {
  const doc = mixedDoc();
  const [p1, p2] = doc.pages;
  const keep = addAnnotation(doc, p1.id, createAnnotation('signature', { x: 100, y: 200, width: 150, height: 50, image: 'data:,' }));
  const sig = addAnnotation(doc, p2.id, createAnnotation('signature', { x: 800, y: 500, width: 30, height: 10, image: 'data:,' }));
  const txt = addAnnotation(doc, p2.id, createAnnotation('text', { x: 421, y: 100, fontSize: 20, text: 'halo' }));
  const block = { k: 2, disp: { x: 10, y: 20 }, below: 300, width: 100, lines: [] };
  const para = addAnnotation(doc, p2.id, createAnnotation('text', { x: 10, y: 20, fontSize: 12, text: 'p', block }));

  const b = addSource(doc, createSource({ name: 'b.pdf', bytes: new Uint8Array([2]), numPages: 1 }));
  addPages(doc, [createPage({ source: b, sourcePageNum: 0, width: 595, height: 842 })]);
  const moved = normalizePageWidths(doc);

  const f = 595 / 842;
  // Known-positive: the page really was rescaled, or every check below is vacuous.
  assert.deepEqual(moved.map((p) => p.id), [p2.id]);
  assert.ok(Math.abs(p2.width - 595) < 1e-9);

  const get = (page, id) => page.annotations.find((x) => x.id === id);
  const s = get(p2, sig.id);
  for (const [k, v] of [['x', 800], ['y', 500], ['width', 30], ['height', 10]]) {
    assert.ok(Math.abs(s[k] - v * f) < 1e-9, `signature.${k} = ${s[k]}, expected ${v * f}`);
  }
  assert.ok(s.x + s.width <= p2.width, 'the signature is off the rescaled page');
  assert.ok(Math.abs(get(p2, txt.id).fontSize - 20 * f) < 1e-9, 'text did not scale its size with the page');

  const pb = get(p2, para.id).block;
  assert.ok(Math.abs(pb.k - 2 * f) < 1e-9 && Math.abs(pb.disp.x - 10 * f) < 1e-9 && Math.abs(pb.below - 300 * f) < 1e-9,
    'a paragraph block kept its display frame');
  assert.equal(pb.width, 100, 'block.width is in PDF units and must not move');
  assert.equal(block.k, 2, 'the block was mutated in place: history snapshots share it by reference');

  assert.equal(get(p1, keep.id).x, 100, 'a page at the anchor width must be untouched');
});
