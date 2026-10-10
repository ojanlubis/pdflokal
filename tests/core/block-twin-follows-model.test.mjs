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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDoc, createSource, createPage, createAnnotation, _resetIds } from '../../js/core/model.js';
import { addSource, addPages, addAnnotation, moveAnnotation, updateAnnotation, rotatePage } from '../../js/core/operations.js';
import { buildPdfBytes } from '../../js/core/export.js';

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

// ---- the file -------------------------------------------------------------------

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global', 'define',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis, undefined);
  return module.exports;
};
const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');
globalThis.pdfjsWorker = loadUmd('js/vendor/pdf.worker.min.js');
const pdfjs = loadUmd('js/vendor/pdf.min.js');

async function blankA4() {
  const d = await PDFLib.PDFDocument.create();
  d.addPage([595, 842]);
  return d.save();
}

// The first line's baseline origin, size and direction in the VIEWPORT a
// reader shows (pdf.js applies /Rotate), i.e. the same frame as the model.
async function firstLineOnScreen(bytes) {
  const pj = await pdfjs.getDocument({ data: bytes, disableFontFace: true, isEvalSupported: false, verbosity: 0 }).promise;
  const pg = await pj.getPage(1);
  const vp = pg.getViewport({ scale: 1 });
  const tc = await pg.getTextContent();
  const item = tc.items.find((i) => i.str.startsWith('Paragraf'));
  assert.ok(item, 'the first painted line is in the file');
  const m = pdfjs.Util.transform(vp.transform, item.transform);
  return { x: m[4], y: m[5], size: Math.hypot(m[2], m[3]), dir: [m[0], m[1]] };
}

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.01, `${msg}: ${a} vs ${b}`);
function assertBaselineAtModel(got, anno, msg) {
  near(got.x, anno.x, `${msg}, x`);
  near(got.y, anno.y + BASELINE_BELOW_TOP, `${msg}, baseline`);
  assert.ok(got.dir[0] > 0 && Math.abs(got.dir[1]) < 1e-6, `${msg}: reads upright, direction ${got.dir}`);
}

test('2. as committed: the file draws the block at its birth baseline (known positive)', async () => {
  const { doc, anno } = declinedBlockDoc(await blankA4());
  const got = await firstLineOnScreen(await buildPdfBytes(doc, { PDFLib, fontkit }));
  assertBaselineAtModel(got, anno, 'unmoved');
  near(got.size, 12, 'unmoved size');
});

test('3. dragged: the file draws the block where the overlay was dropped', async () => {
  const { doc, anno } = declinedBlockDoc(await blankA4());
  moveAnnotation(doc, anno.id, 100, 200);
  const got = await firstLineOnScreen(await buildPdfBytes(doc, { PDFLib, fontkit }));
  assertBaselineAtModel(got, { x: 172, y: 330 }, 'dragged +100,+200');
});

test('4. resized: the file draws the block at the size the overlay paints', async () => {
  const { doc, anno } = declinedBlockDoc(await blankA4());
  updateAnnotation(doc, anno.id, { fontSize: 24 });
  const got = await firstLineOnScreen(await buildPdfBytes(doc, { PDFLib, fontkit }));
  near(got.size, 24, 'resized size');
  near(got.x, anno.x, 'resized x');
});

test('5. page turned: the block follows its spot and reads upright, like plain text does', async () => {
  const { doc, page, anno } = declinedBlockDoc(await blankA4());
  rotatePage(doc, page.id, 90);
  const turned = page.annotations.find((a) => a.id === anno.id);
  const got = await firstLineOnScreen(await buildPdfBytes(doc, { PDFLib, fontkit }));
  assertBaselineAtModel(got, turned, 'turned 90');
  near(got.size, 12, 'turned size');
});
