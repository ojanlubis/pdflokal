/*
 * PDFLokal — headless core tests (node --test, NO browser, NO DOM).
 *
 * These prove the invariant that the old six-parallel-map architecture could
 * never hold: reorder / delete a page and annotations + selection stay correct
 * with ZERO re-keying, because annotations ride on the page object and
 * selection points at stable ids. If this file is green, the "state drift /
 * slides-behind / stale selection" bug class is structurally impossible in the
 * core.
 *
 * Run: npm run test:core   (or: node --test tests/core/)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createDoc, createSource, createPage, createAnnotation,
  getPage, findAnnotation, selectedAnnotation, selectedPage, _resetIds,
} from '../../js/core/model.js';
import {
  addSource, addPages, removePage, reorderPage, rotatePage,
  addAnnotation, updateAnnotation, removeAnnotation,
  selectPage, selectAnnotation, buildExportPlan,
} from '../../js/core/operations.js';

// Build a 3-page doc; page 2 carries a text annotation.
function fixture() {
  _resetIds();
  const doc = createDoc();
  const src = addSource(doc, createSource({ name: 'a.pdf', bytes: new Uint8Array([1]), numPages: 3 }));
  const pages = [0, 1, 2].map((n) =>
    createPage({ source: src, sourcePageNum: n, width: 595, height: 842 }));
  addPages(doc, pages);
  const note = addAnnotation(doc, pages[2].id,
    createAnnotation('text', { text: 'hi', x: 10, y: 20 }));
  return { doc, src, pages, note };
}

test('a page owns its annotations — no parallel map', () => {
  const { doc, pages, note } = fixture();
  assert.equal(pages[2].annotations.length, 1);
  assert.equal(pages[2].annotations[0], note);
  assert.equal(pages[0].annotations.length, 0);
});

test('REORDER: annotations follow their page with zero re-keying', () => {
  const { doc, pages, note } = fixture();
  // Move page 2 (the annotated one) to the front.
  reorderPage(doc, pages[2].id, 0);
  assert.equal(doc.pages[0].id, pages[2].id, 'annotated page moved to front');
  // The SAME annotation object is still on the SAME page object. Nothing re-keyed.
  assert.equal(doc.pages[0].annotations[0], note);
  assert.equal(findAnnotation(doc, note.id).page.id, pages[2].id);
});

test('DELETE: removing an unrelated page leaves annotations intact', () => {
  const { doc, pages, note } = fixture();
  removePage(doc, pages[0].id);
  assert.equal(doc.pages.length, 2);
  // note still resolves, still on its page — no index arithmetic needed.
  assert.equal(findAnnotation(doc, note.id).annotation, note);
});

test('selection is by id and cannot dangle', () => {
  const { doc, pages, note } = fixture();
  selectAnnotation(doc, note.id);
  assert.equal(selectedAnnotation(doc), note);
  assert.equal(selectedPage(doc).id, pages[2].id);

  // Reorder — selection still resolves to the same objects.
  reorderPage(doc, pages[2].id, 0);
  assert.equal(selectedAnnotation(doc), note);

  // Delete the selected annotation's page — selection clears, no crash.
  removePage(doc, pages[2].id);
  assert.equal(selectedAnnotation(doc), null);
  assert.equal(selectedPage(doc), null);
});

test('annotation update/remove operate by id', () => {
  const { doc, note } = fixture();
  updateAnnotation(doc, note.id, { text: 'bye', x: 99 });
  assert.equal(findAnnotation(doc, note.id).annotation.text, 'bye');
  assert.equal(note.x, 99);

  removeAnnotation(doc, note.id);
  assert.equal(findAnnotation(doc, note.id), null);
});

test('rotatePage normalizes into [0,360)', () => {
  const { doc, pages } = fixture();
  rotatePage(doc, pages[0].id, 90);
  rotatePage(doc, pages[0].id, 90);
  assert.equal(getPage(doc, pages[0].id).rotation, 180);
  rotatePage(doc, pages[0].id, 270); // 180 + 270 = 450 → 90
  assert.equal(getPage(doc, pages[0].id).rotation, 90);
});

test('buildExportPlan pairs each page with its source bytes (headless)', () => {
  const { doc, src, pages } = fixture();
  const plan = buildExportPlan(doc);
  assert.equal(plan.length, 3);
  assert.equal(plan[0].source, src);
  assert.equal(plan[2].annotations.length, 1);
  // Reorder changes plan order without touching annotations — export stays correct.
  reorderPage(doc, pages[2].id, 0);
  assert.equal(buildExportPlan(doc)[0].annotations.length, 1);
});
