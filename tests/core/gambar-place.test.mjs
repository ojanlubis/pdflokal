/*
 * GAMBAR: WHERE AND HOW BIG A BROUGHT PICTURE LANDS (core/operations.js placeImage)
 * ============================================================================
 * The Gambar tool (a tap after the picker) and Ctrl/Cmd+V both end here, so one
 * rule serves both. A picture is the signature object, so everything below is
 * the model's numbers in the page's DISPLAYED frame (the frame the screen and
 * the export both measure in; see core/annotation-geometry.js).
 *
 * RED WITHOUT THE FEATURE: before this commit placeImage / imageBoxFor did not
 * exist (the import below throws). The mutation checks named in the PR then
 * prove each assertion can go red on its own: drop the `Math.min(1, ...)`
 * (a small logo is upscaled), swap frame.w/frame.h (a turned page is sized on
 * the wrong axis), or drop originInside (a tap at the edge overhangs the page).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDoc, createSource, createPage, cloneForPaste, isCopyable, _resetIds } from '../../js/core/model.js';
import { addSource, addPages, placeImage, imageBoxFor, IMAGE_PAGE_FRAC, rotatePage, duplicateAnnotation } from '../../js/core/operations.js';
import { createHistory, record, undo } from '../../js/core/history.js';
import { displayedBox } from '../../js/core/annotation-geometry.js';

const IMG = 'data:image/png;base64,AAAA';

function fixture({ rotation = 0, width = 600, height = 800 } = {}) {
  _resetIds();
  const doc = createDoc();
  const src = addSource(doc, createSource({ name: 'a.pdf', bytes: new Uint8Array([1]), numPages: 1 }));
  addPages(doc, [createPage({ source: src, sourcePageNum: 0, width, height, rotation })]);
  return { doc, page: doc.pages[0] };
}

const insidePage = (doc, page, a) => {
  const rotated = (page.rotation || 0) % 180 !== 0;
  const W = rotated ? page.height : page.width;
  const H = rotated ? page.width : page.height;
  const box = displayedBox(a, { w: a.width, h: a.height });
  return box.x >= -1e-6 && box.y >= -1e-6 && box.x + box.w <= W + 1e-6 && box.y + box.h <= H + 1e-6;
};

test('a picture is the signature object, centred on the tap, aspect kept', () => {
  const { doc, page } = fixture();
  const a = placeImage(doc, page.id, { image: IMG, pxWidth: 300, pxHeight: 150 }, 300, 400);
  assert.equal(a.type, 'signature', 'the one image object the model, resize and export already have');
  assert.equal(a.image, IMG);
  assert.equal(a.width, 300);
  assert.equal(a.height, 150);
  assert.deepEqual([a.x, a.y], [150, 325], 'centred on the tap (300, 400)');
  assert.equal(page.annotations.length, 1);
  assert.equal(page.annotations[0], a);
});

test('a picture never lands bigger than its pixels, so a small logo is not blown up', () => {
  const { doc, page } = fixture();
  const a = placeImage(doc, page.id, { image: IMG, pxWidth: 100, pxHeight: 50 }, 300, 400);
  assert.deepEqual([a.width, a.height], [100, 50]);
});

test('a big photo is shrunk, uniformly, to the page share on its tighter side', () => {
  const { doc, page } = fixture(); // 600 x 800
  const wide = placeImage(doc, page.id, { image: IMG, pxWidth: 2000, pxHeight: 1000 }, 300, 400);
  assert.equal(wide.width, 600 * IMAGE_PAGE_FRAC, 'width is the tight side');
  assert.ok(Math.abs(wide.width / wide.height - 2) < 1e-9, 'aspect kept');
  const tall = placeImage(doc, page.id, { image: IMG, pxWidth: 1000, pxHeight: 2000 }, 300, 400);
  assert.equal(tall.height, 800 * IMAGE_PAGE_FRAC, 'height is the tight side');
  assert.ok(Math.abs(tall.width / tall.height - 0.5) < 1e-9, 'aspect kept');
});

test('a tap at an edge or corner holds the picture whole inside the page', () => {
  const { doc, page } = fixture();
  for (const [cx, cy] of [[0, 0], [600, 800], [600, 0], [0, 800], [-50, 900], [5, 400]]) {
    const a = placeImage(doc, page.id, { image: IMG, pxWidth: 300, pxHeight: 300 }, cx, cy);
    assert.ok(insidePage(doc, page, a), `tap (${cx}, ${cy}) left the picture off the page: ${JSON.stringify([a.x, a.y, a.width, a.height])}`);
  }
});

test('on a page turned 90 the size and the clamp use the page AS DISPLAYED (800 wide, 600 tall)', () => {
  const { doc, page } = fixture({ rotation: 90 });
  assert.deepEqual(imageBoxFor(page, 3000, 1500), { width: 480, height: 240 }, '0.6 of 800 wide, not of 600');
  const a = placeImage(doc, page.id, { image: IMG, pxWidth: 3000, pxHeight: 1500 }, 790, 590);
  assert.ok(insidePage(doc, page, a));
  assert.equal(a.turn, undefined, 'born upright as the user sees it');
  const b = placeImage(doc, page.id, { image: IMG, pxWidth: 1000, pxHeight: 3000 }, 400, 300);
  assert.equal(b.height, 600 * IMAGE_PAGE_FRAC, 'the displayed height (600) is the tight side');
});

test('a picture then follows its page when the page is turned (everything turns with the page)', () => {
  const { doc, page } = fixture();
  const a = placeImage(doc, page.id, { image: IMG, pxWidth: 300, pxHeight: 100 }, 150, 100);
  rotatePage(doc, page.id, 90);
  assert.equal(page.annotations[0].turn, 90);
  assert.ok(insidePage(doc, page, page.annotations[0]));
  assert.equal(a.width, 300, 'its own size is kept');
});

test('no page, no pixels, no image: nothing is added', () => {
  const { doc, page } = fixture();
  assert.equal(placeImage(doc, 'nope', { image: IMG, pxWidth: 10, pxHeight: 10 }, 1, 1), null);
  assert.equal(placeImage(doc, page.id, { image: IMG, pxWidth: 0, pxHeight: 10 }, 1, 1), null);
  assert.equal(placeImage(doc, page.id, { image: IMG, pxWidth: 10, pxHeight: Number.NaN }, 1, 1), null);
  assert.equal(placeImage(doc, page.id, { image: '', pxWidth: 10, pxHeight: 10 }, 1, 1), null);
  assert.equal(page.annotations.length, 0);
});

test('one placement is one undo step', () => {
  const { doc, page } = fixture();
  const h = createHistory();
  record(h, doc);
  placeImage(doc, page.id, { image: IMG, pxWidth: 200, pxHeight: 100 }, 300, 400);
  assert.equal(doc.pages[0].annotations.length, 1);
  assert.ok(undo(h, doc));
  assert.equal(doc.pages[0].annotations.length, 0);
});

test('a placed picture copies and pastes like any signature (Ctrl+C / Ctrl+V of the object)', () => {
  const { doc, page } = fixture();
  const a = placeImage(doc, page.id, { image: IMG, pxWidth: 200, pxHeight: 100 }, 300, 400);
  assert.ok(isCopyable(a));
  const c = cloneForPaste(a);
  assert.notEqual(c.id, a.id);
  assert.equal(c.image, IMG);
  assert.deepEqual([c.width, c.height], [200, 100]);
  const dup = duplicateAnnotation(doc, page.id, a, 1);
  assert.equal(page.annotations.length, 2);
  assert.deepEqual([dup.x, dup.y], [a.x + 10, a.y + 10]);
});
