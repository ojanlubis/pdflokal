/*
 * Headless tests for core/raster-key.js — what makes two pages paint the same
 * raster. history.js carries a live raster across undo/redo only on a key match.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rasterKey, rasterFitsShape, rasterIsCurrent } from '../../js/core/raster-key.js';

const base = () => ({
  id: 'p1', sourceId: 's1', sourcePageNum: 0, width: 595, height: 842, baseWidth: 595, baseHeight: 842,
  rotation: 0, isFromImage: false, annotations: [],
});
const ganti = (text = 'baru') => [
  { id: 'c', type: 'whiteout', x: 0, y: 0, width: 10, height: 10, replaceTargets: [{ x0: 1, y0: 2, ux: 1, uy: 0, size: 12, len: 50 }], replaceBox: { x: 0, y: 0, w: 10, h: 10 } },
  { id: 't', type: 'text', text, replaceCoverId: 'c' },
];

test('rasterKey: what the raster shows moves the key', () => {
  const k = rasterKey(base());
  assert.notEqual(rasterKey({ ...base(), rotation: 90 }), k, 'rotation');
  assert.notEqual(rasterKey({ ...base(), width: 1190, height: 1684 }), k, 'merge width factor');
  assert.notEqual(rasterKey({ ...base(), sourcePageNum: 1 }), k, 'which source page');
  assert.notEqual(rasterKey({ ...base(), annotations: ganti() }), k, 'a committed Ganti edit is baked in');
  assert.notEqual(rasterKey({ ...base(), annotations: ganti('lain') }), rasterKey({ ...base(), annotations: ganti() }), 'edit text');
});

test('rasterKey: overlay-only things do not (annotations are DOM, not pixels)', () => {
  const k = rasterKey(base());
  const withText = { ...base(), annotations: [{ id: 'a', type: 'text', x: 1, y: 2, text: 'hi' }, { id: 'w', type: 'whiteout', x: 1, y: 1, width: 5, height: 5 }] };
  assert.equal(rasterKey(withText), k);
  assert.equal(rasterKey({ ...base(), raster: { dataUrl: 'x' }, editApplied: new Set(['c']) }), k);
});

test('shape vs edits: a raster of the same shape but other edits fits but is not current', () => {
  const plain = base();
  const raster = { key: rasterKey(plain) };
  const edited = { ...base(), annotations: ganti() };
  assert.equal(rasterFitsShape(raster, edited), true);
  assert.equal(rasterIsCurrent(raster, edited), false);
  assert.equal(rasterIsCurrent(raster, plain), true);
  assert.equal(rasterFitsShape(raster, { ...base(), rotation: 90 }), false, 'rotated page: wrong grid, never fits');
  assert.equal(rasterFitsShape({}, plain), false, 'no provenance, no trust');
});
