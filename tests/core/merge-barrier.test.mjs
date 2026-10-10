/*
 * merge-barrier.test.mjs - a page delete DURING a merge must not cost the merge its undo barrier.
 * ============================================================================
 * The Halaman sheet's [+] tile starts a merge and the sheet stays open, so its
 * Hapus Halaman button is live while the import runs (the "Memproses" overlay
 * sits BEHIND a modal sheet). A delete records a snapshot WITHOUT the pages the
 * import is about to add, then the import lands. The barrier (history.js
 * markChanged) is what makes that snapshot unreachable; it used to be gated on
 * `doc.pages.length > pagesBefore`, which a concurrent delete of as many pages
 * as the file brings turns false. Undo then restored the stale snapshot
 * wholesale and silently dropped the merged pages.
 *
 * The fixture is the scenario itself, run through the REAL history and the
 * REAL operations: one page out mid-merge, one page in. The length check is
 * asserted false in the same test so the fixture provably separates the old
 * gate from the new one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDoc, createSource, createPage, _resetIds } from '../../js/core/model.js';
import { addSource, addPages, removePage } from '../../js/core/operations.js';
import { createHistory, record, undo, canUndo, closeMerge } from '../../js/core/history.js';

function openDoc(n) {
  _resetIds();
  const doc = createDoc();
  const src = addSource(doc, createSource({ name: 'a.pdf', bytes: new Uint8Array([1]), numPages: n }));
  addPages(doc, Array.from({ length: n }, (_, i) => createPage({ source: src, sourcePageNum: i, width: 595, height: 842 })));
  return doc;
}

// What the import adds: a source plus pages, appended at the end like importPdf does.
function importOnePage(doc) {
  const src = addSource(doc, createSource({ name: 'b.pdf', bytes: new Uint8Array([2]), numPages: 1 }));
  return addPages(doc, [createPage({ source: src, sourcePageNum: 0, width: 595, height: 842 })]);
}

test('a page deleted mid-merge: the merge still raises the barrier and undo cannot drop the merged page', () => {
  const doc = openDoc(3);
  const h = createHistory();
  const pagesBefore = doc.pages.length;
  let added = 0;

  // The import is in flight; the user deletes a page behind the overlay.
  record(h, doc);
  removePage(doc, doc.pages[0].id);
  added += importOnePage(doc).length; // ...and the import lands.

  assert.equal(doc.pages.length, pagesBefore, 'precondition: the length did not grow, so the old gate is blind');
  assert.equal(canUndo(h), true, 'known-positive: the delete is a stale undo step before the barrier');

  const merged = closeMerge(h, { firstLoad: false, added });
  assert.equal(merged, true, 'the merge was not recognised');
  assert.equal(canUndo(h), false, 'the stale pre-merge snapshot is still reachable');
  assert.equal(undo(h, doc), false);
  assert.equal(doc.pages.length, 3, 'the merged page is gone');
});

test('an ordinary merge still raises the barrier; a load that added nothing, or the first load, does not', () => {
  const doc = openDoc(2);
  const h = createHistory();
  record(h, doc);
  const added = importOnePage(doc).length;
  assert.equal(closeMerge(h, { firstLoad: false, added }), true);
  assert.equal(canUndo(h), false);

  record(h, doc);
  assert.equal(closeMerge(h, { firstLoad: false, added: 0 }), false, 'every file failed: no barrier');
  assert.equal(canUndo(h), true, 'a failed merge must not cost the user their undo');
  assert.equal(closeMerge(h, { firstLoad: true, added: 3 }), false, 'the opening load is not a merge');
  assert.equal(canUndo(h), true);
});
