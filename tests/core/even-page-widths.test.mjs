/*
 * "Samakan lebar" — the core ops (core/operations.js evenPageWidths,
 * restorePageWidths, pageWidthsState). Founder rulings 2026-11-03:
 *   - the anchor is page 1's width; every page scales to it uniformly, ratio
 *     kept, in both directions, landscape included;
 *   - a single file is never changed unasked (normalizePageWidths still bails),
 *     only through these explicit ops;
 *   - "Kembalikan" restores the sizes each source measured (baseWidth);
 *   - each change is ONE undo step.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as model from '../../js/core/model.js';
import * as ops from '../../js/core/operations.js';
import { createHistory, record, undo, redo } from '../../js/core/history.js';
import { serializeDoc, deserializeDoc } from '../../js/core/saved-docs.js';

const A5 = [420, 595];
const A4 = [595, 842];
const A4_LANDSCAPE = [842, 595];

// One file (one source) with the given page sizes, each page carrying one
// text annotation so its geometry can be watched.
function singleFile(sizes, name = 'campur.pdf') {
  model._resetIds();
  const doc = model.createDoc();
  const src = ops.addSource(doc, model.createSource({ name, bytes: new Uint8Array([1]), numPages: sizes.length }));
  ops.addPages(doc, sizes.map(([width, height], i) => model.createPage({ source: src, sourcePageNum: i, width, height })));
  for (const page of doc.pages) {
    ops.addAnnotation(doc, page.id, model.createAnnotation('text', { x: 100, y: 200, width: 80, height: 20, text: 'Budi', fontSize: 12 }));
    page.raster = { dataUrl: 'data:x', width: 1, height: 1 };
  }
  return doc;
}
const widths = (doc) => doc.pages.map((p) => Math.round(p.width * 1000) / 1000);
const heights = (doc) => doc.pages.map((p) => Math.round(p.height * 1000) / 1000);

test('a single file is still never evened by the merge path', () => {
  const doc = singleFile([A5, A4, A4]);
  assert.deepEqual(ops.normalizePageWidths(doc), []);
  assert.deepEqual(widths(doc), [420, 595, 595]);
  assert.equal(ops.pageWidthsState(doc), 'mixed');
});

test('evening anchors on page 1: wider pages shrink to it, ratio kept, annotations with them', () => {
  const doc = singleFile([A5, A4, A4]);
  const moved = ops.evenPageWidths(doc);
  assert.equal(moved.length, 2, 'page 1 is the anchor and does not move');
  assert.deepEqual(widths(doc), [420, 420, 420]);
  const k = 420 / 595;
  assert.deepEqual(heights(doc), [595, Math.round(842 * k * 1000) / 1000, Math.round(842 * k * 1000) / 1000]);
  const a = doc.pages[1].annotations[0];
  assert.ok(Math.abs(a.x - 100 * k) < 1e-9 && Math.abs(a.fontSize - 12 * k) < 1e-9, 'the annotation scaled with its page');
  assert.equal(doc.pages[0].annotations[0].x, 100, 'the anchor page\'s annotation did not move');
  assert.equal(doc.pages[1].raster, null, 'a moved page drops its raster');
  assert.ok(doc.pages[0].raster, 'the anchor keeps its raster');
  assert.equal(ops.pageWidthsState(doc), 'evened');
});

test('evening grows narrower pages too, and a landscape page counts by the width it shows', () => {
  const doc = singleFile([A4, A5, A4_LANDSCAPE]);
  ops.evenPageWidths(doc);
  assert.deepEqual(widths(doc), [595, 595, 595], 'the A5 grows to the A4, the landscape page shrinks to it');
  assert.ok(doc.pages[1].height > 595 * 1.4, 'the grown A5 kept its ratio');
});

test('a quarter-turned page is evened by its displayed width (its height)', () => {
  const doc = singleFile([A4, A4]);
  ops.rotatePage(doc, doc.pages[1].id, 90); // displayed 842 wide now
  assert.equal(ops.pageWidthsState(doc), 'mixed');
  ops.evenPageWidths(doc);
  assert.equal(Math.round(doc.pages[1].height), 595, 'its displayed width (height, turned) matches page 1');
  assert.equal(ops.pageWidthsState(doc), 'evened');
});

test('Kembalikan restores every page exactly to the size its source measured', () => {
  const doc = singleFile([A5, A4, A4]);
  ops.evenPageWidths(doc);
  const moved = ops.restorePageWidths(doc);
  assert.equal(moved.length, 2);
  assert.deepEqual(doc.pages.map((p) => [p.width, p.height]), [A5, A4, A4], 'exact, not float drift');
  assert.ok(Math.abs(doc.pages[1].annotations[0].x - 100) < 1e-9, 'annotations went back with their pages');
  assert.equal(ops.pageWidthsState(doc), 'mixed');
  assert.deepEqual(ops.restorePageWidths(doc), [], 'nothing left to restore');
});

test('a uniform document needs nothing: state even, evening moves no page', () => {
  const doc = singleFile([A4, A4, A4]);
  assert.equal(ops.pageWidthsState(doc), 'even');
  assert.deepEqual(ops.evenPageWidths(doc), []);
  // Two programs writing "A4" a fraction of a point apart are one width.
  assert.equal(ops.pageWidthsState(singleFile([[595, 842], [595.28, 841.89]])), 'even');
  // A4 next to US Letter is not.
  assert.equal(ops.pageWidthsState(singleFile([[595, 842], [612, 792]])), 'mixed');
});

test('evening is ONE undo step, and redo puts it back', () => {
  const doc = singleFile([A5, A4, A4]);
  const h = createHistory();
  record(h, doc);
  ops.evenPageWidths(doc);
  assert.deepEqual(widths(doc), [420, 420, 420]);
  assert.equal(undo(h, doc), true);
  assert.deepEqual(widths(doc), [420, 595, 595]);
  assert.equal(redo(h, doc), true);
  assert.deepEqual(widths(doc), [420, 420, 420]);
});

test('a merge still evens by itself, exactly as before, and Kembalikan undoes it', () => {
  model._resetIds();
  const doc = model.createDoc();
  const a = ops.addSource(doc, model.createSource({ name: 'a.pdf', bytes: new Uint8Array([1]), numPages: 1 }));
  const b = ops.addSource(doc, model.createSource({ name: 'b.pdf', bytes: new Uint8Array([2]), numPages: 1 }));
  ops.addPages(doc, [model.createPage({ source: a, sourcePageNum: 0, width: 595, height: 842 })]);
  ops.addPages(doc, [model.createPage({ source: b, sourcePageNum: 0, width: 420, height: 595 })]);
  assert.equal(ops.normalizePageWidths(doc).length, 1);
  assert.deepEqual(widths(doc), [595, 595]);
  assert.equal(ops.pageWidthsState(doc), 'evened', 'the Halaman row offers Kembalikan after a merge');
  ops.restorePageWidths(doc);
  assert.deepEqual(doc.pages.map((p) => [p.width, p.height]), [A4, A5]);
});

test('an evened document survives Simpan editan: sizes and the way back are both kept', () => {
  const doc = singleFile([A5, A4, A4]);
  ops.evenPageWidths(doc);
  const { state, blobs } = serializeDoc(doc, { name: 'campur' });
  const { doc: back } = deserializeDoc(state, new Map(blobs.map((b) => [b.sourceId, b.bytes])));
  assert.deepEqual(widths(back), [420, 420, 420]);
  assert.equal(ops.pageWidthsState(back), 'evened');
  ops.restorePageWidths(back);
  assert.deepEqual(back.pages.map((p) => [p.width, p.height]), [A5, A4, A4]);
});
