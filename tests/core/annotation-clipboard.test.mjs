/*
 * Headless tests for annotation copy/paste (core/model.js cloneForPaste,
 * core/operations.js duplicateAnnotation). Run: npm run test:core
 *
 * The contract: a pasted annotation is a NEW object (fresh id) built from a
 * per-type WHITELIST of visible fields, so anything bound to the document's own
 * original content (cut targets, OCR boxes, paragraph plans, doc-font handles)
 * can never ride along; kinds that are only that binding are not copyable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createDoc, createSource, createPage, createAnnotation, findAnnotation,
  cloneForPaste, _resetIds,
} from '../../js/core/model.js';
import { addSource, addPages, addAnnotation, duplicateAnnotation } from '../../js/core/operations.js';
import { createHistory, record, undo } from '../../js/core/history.js';

function fixture({ rotation = 0 } = {}) {
  _resetIds();
  const doc = createDoc();
  const src = addSource(doc, createSource({ name: 'a.pdf', bytes: new Uint8Array([1]), numPages: 2 }));
  const pages = [0, 1].map((n) => createPage({ source: src, sourcePageNum: n, width: 600, height: 800, rotation }));
  addPages(doc, pages);
  return { doc, pages };
}

test('text: fresh id, visible fields copied, unknown/bound fields dropped', () => {
  _resetIds();
  const src = createAnnotation('text', {
    text: 'Halo', x: 30, y: 40, fontSize: 20, fontFamily: 'Courier', bold: true, italic: true, color: '#d33131',
    // Document-bound extras a Ganti replacement carries; none may travel.
    replaceCoverId: 'anno_9', ocrCoverId: 'anno_8', docFontFamily: 'DocFont1',
    fontDecision: { path: 'doc', css: 'X' }, styleSource: 'sampled',
  });
  const c = cloneForPaste(src);
  assert.notEqual(c.id, src.id, 'a pasted annotation needs its own id');
  assert.equal(c.type, 'text');
  assert.deepEqual(
    { text: c.text, x: c.x, y: c.y, fontSize: c.fontSize, fontFamily: c.fontFamily, bold: c.bold, italic: c.italic, color: c.color },
    { text: 'Halo', x: 30, y: 40, fontSize: 20, fontFamily: 'Courier', bold: true, italic: true, color: '#d33131' },
  );
  for (const k of ['replaceCoverId', 'ocrCoverId', 'docFontFamily', 'fontDecision', 'styleSource']) {
    assert.ok(!(k in c), `${k} is bound to the original document and must not be copied`);
  }
});

test('text: a paragraph block cannot be reproduced as plain text, so it is not copyable', () => {
  const src = createAnnotation('text', { text: 'a b c', x: 1, y: 1, fontSize: 12, block: { lines: [{ text: 'a b c' }] } });
  assert.equal(cloneForPaste(src), null);
});

test('whiteout: a user-drawn cover copies; a document-bound cover does not', () => {
  const drawn = createAnnotation('whiteout', { x: 5, y: 6, width: 70, height: 20, color: '#eeeeee' });
  const c = cloneForPaste(drawn);
  assert.deepEqual({ x: c.x, y: c.y, width: c.width, height: c.height, color: c.color }, { x: 5, y: 6, width: 70, height: 20, color: '#eeeeee' });
  assert.notEqual(c.id, drawn.id);
  for (const bound of [
    { replaceTargets: [{ x: 1 }], replaceBox: { x: 1, y: 1, w: 1, h: 1 } },
    { ocrBox: { x: 1, y: 1, w: 1, h: 1 } },
    { ocrBox: { x: 1, y: 1, w: 1, h: 1 }, paperImage: 'data:image/png;base64,AA' },
  ]) {
    const cover = createAnnotation('whiteout', { x: 1, y: 1, width: 9, height: 9, ...bound });
    assert.equal(cloneForPaste(cover), null, `a cover bound to the original (${Object.keys(bound)}) is not copyable`);
  }
});

test('signature: the image data URL is shared by reference (immutable string), geometry copied', () => {
  const url = 'data:image/png;base64,iVBOR';
  const src = createAnnotation('signature', { image: url, x: 10, y: 20, width: 150, height: 60 });
  const c = cloneForPaste(src);
  assert.equal(c.image, url);
  assert.deepEqual({ x: c.x, y: c.y, width: c.width, height: c.height }, { x: 10, y: 20, width: 150, height: 60 });
  assert.notEqual(c.id, src.id);
  assert.equal(cloneForPaste(createAnnotation('signature', { x: 1, y: 1, width: 5, height: 5 })), null, 'no image, nothing to paste');
});

test('watermark / pageNumber / unknown kinds are not copyable (unreachable in v2)', () => {
  for (const type of ['watermark', 'pageNumber', 'mystery']) {
    assert.equal(cloneForPaste(createAnnotation(type, { text: 'x', x: 1, y: 1 })), null);
  }
  assert.equal(cloneForPaste(null), null);
});

test('the clone never aliases nested state with the source', () => {
  const src = createAnnotation('text', { text: 't', x: 1, y: 1, fontSize: 10 });
  const c = cloneForPaste(src);
  c.text = 'changed'; c.x = 99;
  assert.equal(src.text, 't');
  assert.equal(src.x, 1);
});

test('duplicateAnnotation: +10n offset, new object on the target page, source untouched', () => {
  const { doc, pages } = fixture();
  const src = addAnnotation(doc, pages[0].id, createAnnotation('whiteout', { x: 100, y: 100, width: 50, height: 30 }));
  const one = duplicateAnnotation(doc, pages[1].id, src, 1);
  assert.equal(one.x, 110);
  assert.equal(one.y, 110);
  assert.equal(findAnnotation(doc, one.id).page.id, pages[1].id, 'lands on the target page');
  assert.equal(src.x, 100);
  const two = duplicateAnnotation(doc, pages[1].id, src, 2);
  assert.deepEqual([two.x, two.y], [120, 120], 'each successive paste steps from the SOURCE');
  assert.equal(pages[1].annotations.length, 2);
});

test('duplicateAnnotation clamps inside the page, in the rotated frame', () => {
  const { doc, pages } = fixture();
  const src = createAnnotation('whiteout', { x: 590, y: 790, width: 40, height: 40 });
  const c = duplicateAnnotation(doc, pages[0].id, src, 1);
  assert.deepEqual([c.x, c.y], [560, 760], 'pinned at page edge minus its own size');
  const r = fixture({ rotation: 90 });
  const swapped = duplicateAnnotation(r.doc, r.pages[0].id, createAnnotation('whiteout', { x: 700, y: 500, width: 40, height: 40 }), 1);
  assert.deepEqual([swapped.x, swapped.y], [710, 510], 'a 90deg page is 800 wide x 600 tall in the view frame');
  const edge = duplicateAnnotation(r.doc, r.pages[0].id, createAnnotation('whiteout', { x: 790, y: 590, width: 40, height: 40 }), 1);
  assert.deepEqual([edge.x, edge.y], [760, 560]);
});

test('duplicateAnnotation returns null for a non-copyable kind and adds nothing', () => {
  const { doc, pages } = fixture();
  const cover = createAnnotation('whiteout', { x: 1, y: 1, width: 9, height: 9, ocrBox: { x: 1, y: 1, w: 9, h: 9 } });
  assert.equal(duplicateAnnotation(doc, pages[0].id, cover, 1), null);
  assert.equal(pages[0].annotations.length, 0);
});

test('a paste is ONE undo step', () => {
  const { doc, pages } = fixture();
  const src = addAnnotation(doc, pages[0].id, createAnnotation('text', { text: 'x', x: 5, y: 5, fontSize: 12 }));
  const h = createHistory();
  record(h, doc);
  duplicateAnnotation(doc, pages[0].id, src, 1);
  assert.equal(pages[0].annotations.length, 2);
  assert.ok(undo(h, doc));
  assert.equal(doc.pages[0].annotations.length, 1);
});
