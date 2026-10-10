/*
 * Headless tests: an object the user places, resizes or copies stays INSIDE
 * its page. Run: npm run test:core
 *
 * WHY: the screen draws an annotation past the page edge (.pv-page does not
 * clip), while the file is clipped at the page box by every PDF viewer. A
 * signature tapped near the right margin, or enlarged by its corner handle,
 * looked whole on screen and arrived cut off in the download. moveAnnotation
 * already clamped; placement, resize and "Semua Hal." did not.
 *
 * The property asserted everywhere is the one the user sees: the DISPLAYED
 * box (core/annotation-geometry.js displayedBox) lies inside the displayed
 * frame, and a signature keeps its ratio (the screen draws its height from
 * the image's own ratio, the file from anno.height: a distorted clamp is a
 * second screen/file disagreement).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDoc, createSource, createPage, createAnnotation, _resetIds } from '../../js/core/model.js';
import {
  addSource, addPages, addAnnotation, resizeAnnotation, rotatePage,
  placeSignature, copySignatureToAllPages, pagesMissingSignature,
} from '../../js/core/operations.js';
import { displayedBox } from '../../js/core/annotation-geometry.js';
import { createHistory, record, undo, redo } from '../../js/core/history.js';

const IMG = 'data:image/png;base64,AAAA';

function docWith(sizes) {
  _resetIds();
  const doc = createDoc();
  const src = addSource(doc, createSource({ name: 'a.pdf', bytes: new Uint8Array([1]), numPages: sizes.length }));
  addPages(doc, sizes.map(([width, height], n) => createPage({ source: src, sourcePageNum: n, width, height })));
  return doc;
}

function frameOf(page) {
  const turned = (page.rotation || 0) % 180 !== 0;
  return turned ? { w: page.height, h: page.width } : { w: page.width, h: page.height };
}

function assertInside(page, a, label) {
  const box = displayedBox(a, { w: a.width, h: a.height });
  const f = frameOf(page);
  const eps = 1e-9;
  assert.ok(box.x >= -eps && box.y >= -eps && box.x + box.w <= f.w + eps && box.y + box.h <= f.h + eps,
    `${label}: box ${JSON.stringify(box)} must lie inside the ${f.w}x${f.h} page`);
}

const ratioOf = (a) => a.width / a.height;

// ---- resize ------------------------------------------------------------------

test('resizing a signature past the right edge stops at the edge and keeps its ratio', () => {
  const doc = docWith([[595, 842]]);
  const pg = doc.pages[0];
  const sig = addAnnotation(doc, pg.id, createAnnotation('signature', { image: IMG, x: 400, y: 100, width: 150, height: 50 }));
  resizeAnnotation(doc, sig.id, { width: 300, height: 100 });
  assertInside(pg, sig, 'enlarged signature');
  assert.equal(sig.x, 400, 'resize grows from the corner; the origin stays put');
  assert.equal(sig.width, 195, 'as wide as the page allows');
  assert.ok(Math.abs(ratioOf(sig) - 3) < 1e-9, `ratio kept: ${sig.width}x${sig.height}`);
});

test('resizing a signature past the bottom edge stops at the edge', () => {
  const doc = docWith([[595, 842]]);
  const pg = doc.pages[0];
  const sig = addAnnotation(doc, pg.id, createAnnotation('signature', { image: IMG, x: 50, y: 780, width: 150, height: 50 }));
  resizeAnnotation(doc, sig.id, { width: 300, height: 100 });
  assertInside(pg, sig, 'enlarged signature');
  assert.equal(sig.height, 62);
  assert.ok(Math.abs(ratioOf(sig) - 3) < 1e-9);
});

test('a turned signature is held inside by the box the screen shows, not its stored axes', () => {
  const doc = docWith([[595, 842]]);
  const pg = doc.pages[0];
  // turn 90: displayed box is [x - h, y, h, w], so growing the own width runs DOWN.
  const sig = addAnnotation(doc, pg.id, createAnnotation('signature', { image: IMG, x: 300, y: 600, width: 150, height: 50, turn: 90 }));
  resizeAnnotation(doc, sig.id, { width: 600, height: 200 });
  assertInside(pg, sig, 'turned signature');
  assert.ok(Math.abs(ratioOf(sig) - 3) < 1e-9);
});

test('a whiteout resized past the edge is capped per axis: only the axis that overflowed shrinks', () => {
  const doc = docWith([[595, 842]]);
  const pg = doc.pages[0];
  const wo = addAnnotation(doc, pg.id, createAnnotation('whiteout', { x: 500, y: 100, width: 50, height: 20 }));
  resizeAnnotation(doc, wo.id, { width: 300, height: 40 });
  assert.deepEqual({ w: wo.width, h: wo.height }, { w: 95, h: 40 });
});

test('a whiteout drawn past the bottom-right corner ends at the corner (draw sets x/y with the size)', () => {
  const doc = docWith([[595, 842]]);
  const pg = doc.pages[0];
  const wo = addAnnotation(doc, pg.id, createAnnotation('whiteout', { x: 500, y: 800, width: 8, height: 8 }));
  resizeAnnotation(doc, wo.id, { x: 500, y: 800, width: 200, height: 200 });
  assert.deepEqual({ x: wo.x, y: wo.y, w: wo.width, h: wo.height }, { x: 500, y: 800, w: 95, h: 42 });
});

test('the clamp reads the rotated frame on a 90-degree page', () => {
  const doc = docWith([[595, 842]]);
  const pg = doc.pages[0];
  rotatePage(doc, pg.id, 90); // displayed 842 x 595
  const sig = addAnnotation(doc, pg.id, createAnnotation('signature', { image: IMG, x: 700, y: 100, width: 100, height: 50 }));
  resizeAnnotation(doc, sig.id, { width: 300, height: 150 });
  assertInside(pg, sig, 'signature on a turned page');
  assert.equal(sig.width, 142, 'wide frame is 842, not the stored 595');
});

test('a resize inside the page is untouched by the clamp', () => {
  const doc = docWith([[595, 842]]);
  const sig = addAnnotation(doc, doc.pages[0].id, createAnnotation('signature', { image: IMG, x: 10, y: 10, width: 150, height: 50 }));
  resizeAnnotation(doc, sig.id, { width: 240, height: 80 });
  assert.deepEqual({ w: sig.width, h: sig.height }, { w: 240, h: 80 });
});

test('undo/redo across a clamped resize restore the before and the clamped after', () => {
  const doc = docWith([[595, 842]]);
  const pg = doc.pages[0];
  addAnnotation(doc, pg.id, createAnnotation('signature', { image: IMG, x: 400, y: 100, width: 150, height: 50 }));
  const h = createHistory();
  record(h, doc);
  resizeAnnotation(doc, doc.pages[0].annotations[0].id, { width: 300, height: 100 });
  undo(h, doc);
  const before = doc.pages[0].annotations[0];
  assert.deepEqual({ w: before.width, h: before.height }, { w: 150, h: 50 });
  redo(h, doc);
  const after = doc.pages[0].annotations[0];
  assert.deepEqual({ w: after.width, h: after.height }, { w: 195, h: 65 });
});

// ---- placement ---------------------------------------------------------------

test('a signature tapped at the bottom-right corner lands whole inside the page', () => {
  const doc = docWith([[595, 842]]);
  const pg = doc.pages[0];
  const sig = placeSignature(doc, pg.id, { image: IMG, ratio: 1 / 3 }, 560, 820);
  assertInside(pg, sig, 'placed signature');
  assert.deepEqual({ x: sig.x, y: sig.y, w: sig.width, h: sig.height }, { x: 445, y: 792, w: 150, h: 50 });
  assert.equal(pg.annotations.length, 1);
});

test('a tap in open space centres the signature on the tap, as before', () => {
  const doc = docWith([[595, 842]]);
  const sig = placeSignature(doc, doc.pages[0].id, { image: IMG, ratio: 1 / 3 }, 300, 400);
  assert.deepEqual({ x: sig.x, y: sig.y, w: sig.width, h: sig.height }, { x: 225, y: 375, w: 150, h: 50 });
});

test('placement on a 90-degree page reads the displayed frame', () => {
  const doc = docWith([[595, 842]]);
  const pg = doc.pages[0];
  rotatePage(doc, pg.id, 90); // displayed 842 x 595
  const sig = placeSignature(doc, pg.id, { image: IMG, ratio: 1 / 3 }, 830, 590);
  assertInside(pg, sig, 'placed on a turned page');
  assert.equal(sig.x, 692);
});

test('a page narrower than the default signature gets a signature that fits, ratio kept', () => {
  const doc = docWith([[100, 400]]);
  const pg = doc.pages[0];
  const sig = placeSignature(doc, pg.id, { image: IMG, ratio: 1 / 3 }, 50, 200);
  assertInside(pg, sig, 'signature on a narrow page');
  assert.ok(Math.abs(ratioOf(sig) - 3) < 1e-9);
});

// ---- Semua Hal. ----------------------------------------------------------------

test('"Semua Hal." onto a shorter page moves the copy inside it, and a second tap adds nothing', () => {
  const doc = docWith([[600, 800], [600, 400]]);
  const [home, short] = doc.pages;
  const sig = addAnnotation(doc, home.id, createAnnotation('signature', { image: IMG, x: 400, y: 700, width: 150, height: 50 }));
  const [copy] = copySignatureToAllPages(doc, sig.id);
  assertInside(short, copy, 'copy on the shorter page');
  assert.deepEqual({ x: copy.x, y: copy.y }, { x: 400, y: 350 });
  assert.deepEqual(pagesMissingSignature(doc, sig.id), [], 'the clamped copy counts as already there');
  assert.equal(copySignatureToAllPages(doc, sig.id).length, 0);
});
