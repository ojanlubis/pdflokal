/*
 * A DECLINED PARAGRAPH EDIT LANDS IN THE FILE WHERE THE SCREEN SHOWS IT.
 * ============================================================================
 * Rung D: a whole-paragraph edit whose surgery or stamp declined stays an
 * overlay (render/page-view.js renderBlockRows), placed at the annotation's
 * x/y, painted at its fontSize, upright on a turned page. The user can still
 * drag it, resize it, or turn the page under it. The file used to draw it at
 * the block's BIRTH spot in source PDF units (block.origin, block.size, no
 * rotate), so all three were lost on download.
 *
 * The block's display anchor `block.disp` is its first baseline in the
 * displayed frame (core/annotation-geometry.js). Every geometry change has to
 * carry it: a turn and a merge rescale already did, a move did not.
 *
 * Expected positions are derived from the annotation's own x/y plus the
 * baseline offset it was born with, never read back from block.disp: a disp
 * nobody moves and an export that reads it would agree with each other while
 * the bug is live.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDoc, createSource, createPage, createAnnotation, _resetIds } from '../../js/core/model.js';
import { addSource, addPages, addAnnotation, moveAnnotation } from '../../js/core/operations.js';

// A consistent birth on an unrotated A4 at k=1: origin (72, 700) in PDF user
// space is display (72, 842 - 700). The overlay's top sits 12 above it.
const BASELINE_BELOW_TOP = 12;
function blockOf() {
  return {
    v: 1, align: 'left', indent: 0, width: 400, leading: 14.4, size: 12, origin: { x: 72, y: 700 }, k: 1,
    disp: { x: 72, y: 142 }, srcLines: 2, srcWords: [3, 2], below: null, reflowed: false,
    lines: [{ text: 'Paragraf baru satu', brk: ' ', hard: false }, { text: 'baris dua', brk: '', hard: false }],
  };
}
function declinedBlockDoc(bytes = new Uint8Array([1])) {
  _resetIds();
  const doc = createDoc();
  const src = addSource(doc, createSource({ name: 'a.pdf', bytes, numPages: 1 }));
  addPages(doc, [createPage({ source: src, sourcePageNum: 0, width: 595, height: 842 })]);
  const page = doc.pages[0];
  const anno = addAnnotation(doc, page.id, createAnnotation('text', {
    text: 'Paragraf baru satu baris dua', x: 72, y: 142 - BASELINE_BELOW_TOP, fontSize: 12,
    fontFamily: 'Helvetica', color: '#000000', replaceCoverId: 'cover-that-declined', block: blockOf(),
  }));
  return { doc, page, anno };
}

test('1. a move carries the block\'s display anchor by the delta the clamp applied, without mutating the shared block', () => {
  const { doc, anno } = declinedBlockDoc();
  const before = anno.block;
  moveAnnotation(doc, anno.id, 100, 200);
  assert.deepEqual([anno.block.disp.x - anno.x, anno.block.disp.y - anno.y], [0, BASELINE_BELOW_TOP],
    'disp keeps its offset from the annotation after a drag');
  assert.deepEqual(before.disp, { x: 72, y: 142 }, 'the block a history snapshot holds was not mutated');

  // Clamped: a drag far past the right edge stops at the edge, and the anchor
  // moves by what was applied, not by what was asked.
  moveAnnotation(doc, anno.id, 10000, 0);
  assert.equal(anno.block.disp.x - anno.x, 0, 'disp follows the clamped move');
});
