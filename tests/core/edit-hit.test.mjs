/*
 * core/edit-hit.js: which committed edit a tap lands on (headless since
 * 2026-10-10; it lived in js/v2/app.js and only Playwright could reach it).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hitTestEditedLine, hitTestOcrEdit, editOwningLine } from '../../js/core/edit-hit.js';
import { boxToRasterPx, boxFitsRaster } from '../../js/core/raster-key.js';

const MIN_HIT = 22;
function pageWithEdit({ painted = 0 } = {}) {
  const cover = { id: 'c1', type: 'whiteout', x: 100, y: 200, width: 80, height: 14, replaceTargets: [{}], replaceBox: { x: 100, y: 200, w: 80, h: 14 } };
  const replacement = { id: 't1', type: 'text', x: 100, y: 200, fontSize: 12, text: 'jauh lebih panjang', replaceCoverId: 'c1' };
  return { page: { annotations: [cover, replacement] }, cover, replacement, measure: () => painted };
}

test('hitTestEditedLine: a tap inside the birth box finds the edit; a far tap finds nothing', () => {
  const { page, cover } = pageWithEdit();
  assert.equal(hitTestEditedLine(page, 140, 207, { measure: () => 0, minHit: MIN_HIT })?.cover, cover);
  assert.equal(hitTestEditedLine(page, 500, 600, { measure: () => 0, minHit: MIN_HIT }), null);
});

// The finger margin is the point of minHit: a 14pt line is a thinner target
// than a fingertip. The test above only taps INSIDE the box, so it stayed green
// with minHit forced to 0 inside hitTestEditedLine. Tap 2pt below the box: a
// hit at MIN_HIT, and (known-negative, proving the tap really is outside the
// line) null at minHit 0.
test('hitTestEditedLine: a tap just outside a thin line but inside the finger margin still finds the edit', () => {
  const { page, cover } = pageWithEdit();
  const below = 200 + 14 + 2;
  assert.equal(hitTestEditedLine(page, 140, below, { measure: () => 0, minHit: 0 }), null,
    'known-negative: the tap is outside the uninflated box');
  assert.equal(hitTestEditedLine(page, 140, below, { measure: () => 0, minHit: MIN_HIT })?.cover, cover,
    'the finger-sized margin must make a near-miss a hit');
});

// RUNG D: a committed paragraph paints as a block (box width, one leading per
// line), so its LATER lines are targets the birth box never covered. Catches
// the block branch being skipped (`if (false)`): the third line goes dead.
test('hitTestEditedLine: a tap on a later line of a committed paragraph block finds the edit', () => {
  const { page, cover, replacement } = pageWithEdit();
  replacement.block = { lines: ['satu', 'dua', 'tiga'], k: 1, leading: 14, width: 200, disp: { x: 100 } };
  // Block extent: x 100..300, y 200..242. Third line centre ~ y 235, x 250:
  // far outside the 100..180 x 200..214 birth box and its finger margin.
  const plain = pageWithEdit();
  assert.equal(hitTestEditedLine(plain.page, 250, 235, { measure: () => 0, minHit: MIN_HIT }), null,
    'known-negative: without the block the third line is not a hit');
  assert.equal(hitTestEditedLine(page, 250, 235, { measure: () => 0, minHit: MIN_HIT })?.cover, cover,
    'the block\'s third line reopens the edit');
});

test('hitTestEditedLine: the painted OVERFLOW of a longer replacement is tappable (field report 2026-08-26)', () => {
  const tapX = 100 + 200; // past the 80pt birth box, inside a 240pt painted replacement
  const narrow = pageWithEdit({ painted: 0 });
  assert.equal(hitTestEditedLine(narrow.page, tapX, 207, { measure: narrow.measure, minHit: MIN_HIT }), null,
    'known-positive: without the painted width the overflow is NOT a hit');
  const wide = pageWithEdit({ painted: 240 });
  assert.equal(hitTestEditedLine(wide.page, tapX, 207, { measure: wide.measure, minHit: MIN_HIT })?.cover, wide.cover);
});

test('editOwningLine: geometric, never inflated: a neighbouring line is not owned', () => {
  const { page, cover } = pageWithEdit();
  assert.equal(editOwningLine(page, { x: 100, y: 200, w: 80, h: 14 })?.cover, cover);
  assert.equal(editOwningLine(page, { x: 100, y: 216, w: 80, h: 14 }), null, 'the line just below was taken for the edit');
});

test('hitTestOcrEdit: anchors to the birth ocrBox and pairs the replacement', () => {
  const cover = { id: 'o1', type: 'whiteout', x: 0, y: 0, width: 1, height: 1, ocrBox: { x: 50, y: 50, w: 100, h: 20 } };
  const text = { id: 't', type: 'text', ocrCoverId: 'o1' };
  const page = { annotations: [cover, text] };
  const hit = hitTestOcrEdit(page, 90, 60, MIN_HIT);
  assert.equal(hit.cover, cover);
  assert.equal(hit.replacement, text);
  assert.equal(hitTestOcrEdit(page, 400, 400, MIN_HIT), null);
});

test('boxToRasterPx / boxFitsRaster: page box to raster pixels, and a box spilling past the edge declines', () => {
  const raster = { scale: 2, width: 200, height: 100 };
  assert.deepEqual(boxToRasterPx(raster, { x: 10, y: 5, w: 20, h: 10 }), { cx: 20, cy: 10, cw: 40, ch: 20 });
  assert.equal(boxFitsRaster(raster, { x: 10, y: 5, w: 20, h: 10 }), true);
  assert.equal(boxFitsRaster(raster, { x: 90, y: 5, w: 20, h: 10 }), false);
});
