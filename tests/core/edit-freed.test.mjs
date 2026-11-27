// An Edit the user moves or restyles is FREED (his call 2026-11-27: Edit does
// everything Teks does). Freed = the original's words stay cut, and the new
// text is drawn like Teks where and how the user put it: no stamp at the
// original's place, no line-decided face on screen or in the file.
// SINGLE SOURCE OF TRUTH under test: core/operations.js freesEdit.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDoc, createSource, createPage, createAnnotation, _resetIds } from '../../js/core/model.js';
import { addSource, addPages, addAnnotation, updateAnnotation, moveAnnotation, freesEdit } from '../../js/core/operations.js';
import { planNativeInserts } from '../../js/core/page-surgery.js';

function scene() {
  _resetIds();
  const doc = createDoc();
  const src = addSource(doc, createSource({ name: 'a.pdf', bytes: new Uint8Array([1]), numPages: 1 }));
  addPages(doc, [createPage({ source: src, sourcePageNum: 0, width: 595, height: 842 })]);
  const pageId = doc.pages[0].id;
  const cover = addAnnotation(doc, pageId, createAnnotation('whiteout', {
    x: 50, y: 100, width: 120, height: 14, replaceBox: { x: 50, y: 100, w: 120, h: 14 }, replaceTargets: [{ str: 'Rp 1.000.000' }],
  }));
  const edit = addAnnotation(doc, pageId, createAnnotation('text', {
    x: 50, y: 100, text: 'Rp 1.500.000', fontFamily: 'Helvetica', fontSize: 11, bold: false, italic: false,
    color: '#000000', replaceCoverId: cover.id, fontDecision: { path: 'native', css: 'docfont-1' },
  }));
  const teks = addAnnotation(doc, pageId, createAnnotation('text', { x: 10, y: 10, text: 'Teks', fontFamily: 'Helvetica' }));
  return { doc, cover, edit, teks };
}

test('a face, size or weight frees an edit; colour and alignment do not', () => {
  const { doc, edit } = scene();
  updateAnnotation(doc, edit.id, { color: '#d33131' });
  assert.equal(edit.detached, undefined, 'colour paints through the stamp in the doc font');
  updateAnnotation(doc, edit.id, { align: 'center' });
  assert.equal(edit.detached, undefined);
  updateAnnotation(doc, edit.id, { fontSize: 11 });
  assert.equal(edit.detached, undefined, 'the same size is no change');
  updateAnnotation(doc, edit.id, { fontFamily: 'Montserrat' });
  assert.equal(edit.detached, true);
});

test('each freeing key frees on its own', () => {
  for (const patch of [{ fontFamily: 'Tinos' }, { fontSize: 14 }, { bold: true }, { italic: true }]) {
    const { edit } = scene();
    assert.equal(freesEdit(edit, patch), true, JSON.stringify(patch));
  }
});

test('moving an edit frees it; a plain Teks never carries the flag', () => {
  const { doc, edit, teks } = scene();
  moveAnnotation(doc, edit.id, 0, 0);
  assert.equal(edit.detached, undefined, 'a zero move is no move');
  moveAnnotation(doc, edit.id, 30, 40);
  assert.equal(edit.detached, true);
  moveAnnotation(doc, teks.id, 30, 40);
  updateAnnotation(doc, teks.id, { fontFamily: 'Tinos' });
  assert.equal(teks.detached, undefined);
});

test('a freed edit is not stamped at the original: it is drawn as Teks, the cut stays', async () => {
  const { edit, cover } = scene();
  edit.detached = true;
  const { skipDraw, insertOutcomes } = await planNativeInserts(null, {}, {}, [edit], new Set([cover.id]), new Map());
  assert.equal(skipDraw.has(edit.id), false, 'left for the text drawer, where the user put it');
  assert.equal(insertOutcomes.get(edit.id)?.reason, 'detached');
});

test('freeing an edit changes the bake signature, so a move alone re-bakes', async () => {
  const { editSignature } = await import('../../js/core/page-surgery.js');
  const { doc, edit } = scene();
  const page = doc.pages[0];
  const before = editSignature(page);
  edit.detached = true;
  assert.notEqual(editSignature(page), before);
});
