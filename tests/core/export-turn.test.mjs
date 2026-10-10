/*
 * A TURNED PAGE'S TEXT AND SIGNATURES TURN WITH IT IN THE FILE.
 * ============================================================================
 * Founder ruling 2026-10-11 ("semua harus ngikut rotasi"): every object turns
 * with its page, like ink on paper. The model says so with a quarter `turn`
 * on text and signatures (core/annotation-geometry.js turnAnnotation); this
 * file proves the DOWNLOAD agrees.
 *
 * THE ORACLE IS "INK STAYS, PAPER TURNS", not the drawing formula. Export the
 * same object twice: once on an unturned page, once after the page was turned.
 * The only thing allowed to differ is the page's /Rotate. The glyph's (or the
 * image's) matrix in the content stream, read back by the vendored pdf.js,
 * must be identical, because a reader applies /Rotate to the whole page and
 * the ink must not have moved on the paper. Until 2026-10-11 export re-uprighted
 * text and signatures on a turned page, so these matrices differed by a
 * quarter: RED on that code. It is free of sign conventions: a drawer that
 * turned the wrong way, or about the wrong point, changes the matrix.
 *
 * Then one assertion in the frame the user sees (pdf.js's viewport, which
 * applies /Rotate): the text's baseline origin sits at the model's turned
 * origin plus its baseline offset turned the same way, and it reads DOWN the
 * page. That ties the file to the screen's numbers (render/page-view.js draws
 * the same turn as a CSS rotate about x/y).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDoc, createSource, createPage, createAnnotation, _resetIds } from '../../js/core/model.js';
import { addSource, addPages, addAnnotation, rotatePage } from '../../js/core/operations.js';
import { buildPdfBytes } from '../../js/core/export.js';

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

// 1x1 opaque PNG: a real image for drawSignature to embed.
const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function blankA4() {
  const d = await PDFLib.PDFDocument.create();
  d.addPage([595, 842]);
  return d.save();
}

async function docWith(annos, quarters) {
  _resetIds();
  const doc = createDoc();
  const src = addSource(doc, createSource({ name: 'a.pdf', bytes: await blankA4(), numPages: 1 }));
  addPages(doc, [createPage({ source: src, sourcePageNum: 0, width: 595, height: 842 })]);
  const page = doc.pages[0];
  for (const a of annos) addAnnotation(doc, page.id, createAnnotation(a.type, { ...a }));
  for (let i = 0; i < quarters; i += 1) rotatePage(doc, page.id, 90);
  return { doc, page };
}

async function open(bytes) {
  const pj = await pdfjs.getDocument({ data: bytes, disableFontFace: true, isEvalSupported: false, verbosity: 0 }).promise;
  return pj.getPage(1);
}

async function textItem(bytes, prefix) {
  const pg = await open(bytes);
  const tc = await pg.getTextContent();
  const item = tc.items.find((i) => i.str.startsWith(prefix));
  assert.ok(item, `"${prefix}" is in the file`);
  return { raw: item.transform, rotate: pg.rotate, vp: pg.getViewport({ scale: 1 }).transform };
}

// The `cm` in force when the (only) image is painted: the image's unit square
// mapped to PDF user space.
async function imageMatrix(bytes) {
  const pg = await open(bytes);
  const ops = await pg.getOperatorList();
  const { OPS } = pdfjs;
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  for (let i = 0; i < ops.fnArray.length; i += 1) {
    const fn = ops.fnArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = pdfjs.Util.transform(ctm, ops.argsArray[i]);
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
      return { raw: ctm, rotate: pg.rotate, vp: pg.getViewport({ scale: 1 }).transform };
    }
  }
  assert.fail('no image was painted');
  return null;
}

const close = (a, b, msg) => {
  assert.equal(a.length, b.length, msg);
  a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 0.01, `${msg}: [${a.map((n) => n.toFixed(2))}] vs [${b.map((n) => n.toFixed(2))}]`));
};

const TEXT = { type: 'text', text: 'Disetujui', x: 120, y: 640, fontSize: 18, fontFamily: 'Helvetica', color: '#000000' };
const SIG = { type: 'signature', image: PNG_1PX, x: 100, y: 700, width: 150, height: 60 };

for (const q of [1, 2, 3]) {
  test(`text on a page turned ${q * 90}: the glyphs stay where they were on the paper`, async () => {
    const flat = await textItem(await buildPdfBytes((await docWith([TEXT], 0)).doc, { PDFLib, fontkit }), 'Disetujui');
    const turned = await textItem(await buildPdfBytes((await docWith([TEXT], q)).doc, { PDFLib, fontkit }), 'Disetujui');
    assert.equal(turned.rotate, (flat.rotate + 90 * q) % 360, 'VACUITY GUARD: only the paper turned');
    close(turned.raw, flat.raw, 'the text matrix moved on the paper');
  });

  test(`signature on a page turned ${q * 90}: the image stays where it was on the paper`, async () => {
    const flat = await imageMatrix(await buildPdfBytes((await docWith([SIG], 0)).doc, { PDFLib, fontkit }));
    const turned = await imageMatrix(await buildPdfBytes((await docWith([SIG], q)).doc, { PDFLib, fontkit }));
    assert.equal(turned.rotate, (flat.rotate + 90 * q) % 360, 'VACUITY GUARD: only the paper turned');
    close(turned.raw, flat.raw, 'the signature matrix moved on the paper');
  });
}

test('turned 90, the word sits at the screen\'s spot and reads down the page', async () => {
  const { doc, page } = await docWith([TEXT], 1);
  const anno = page.annotations[0];
  assert.equal(anno.turn, 90, 'VACUITY GUARD: the model carries the turn');
  const got = await textItem(await buildPdfBytes(doc, { PDFLib, fontkit }), 'Disetujui');
  const m = pdfjs.Util.transform(got.vp, got.raw);
  // The overlay rotates about (x, y); the baseline is 0.9em below the top in
  // the text's own frame, which a clockwise quarter turns to 0.9em LEFT.
  close([m[4], m[5]], [anno.x - 0.9 * 18, anno.y], 'baseline origin on screen');
  // Viewport is y-down: the reading direction (m[0], m[1]) points down.
  close([m[0], m[1]], [0, 18], 'reading direction');
});

test('turned 90, the signature\'s own top-left is at the model\'s origin and its top edge runs down', async () => {
  const { doc, page } = await docWith([SIG], 1);
  const anno = page.annotations[0];
  const got = await imageMatrix(await buildPdfBytes(doc, { PDFLib, fontkit }));
  const m = pdfjs.Util.transform(got.vp, got.raw);
  // Unit square: (0, 1) is the image's own top-left, (1, 1) its top-right.
  const at = (u, v) => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]];
  close(at(0, 1), [anno.x, anno.y], 'image top-left');
  close(at(1, 1), [anno.x, anno.y + anno.width], 'image top-right (its width now runs down)');
});

test('a glyph the font cannot paint is rastered, and the raster turns with the page too', async () => {
  // drawTextAsImage: the rail's fallback for characters outside WinAnsi.
  const rasterizeText = async () => {
    const b64 = PNG_1PX.split(',')[1];
    return { png: Uint8Array.from(Buffer.from(b64, 'base64')), width: 80, height: 22 };
  };
  const glyph = { ...TEXT, text: 'Panah → kanan' };
  const flat = await imageMatrix(await buildPdfBytes((await docWith([glyph], 0)).doc, { PDFLib, fontkit, rasterizeText }));
  const turned = await imageMatrix(await buildPdfBytes((await docWith([glyph], 1)).doc, { PDFLib, fontkit, rasterizeText }));
  close(turned.raw, flat.raw, 'the rastered text moved on the paper');
});

test('text placed on an ALREADY-turned page is born upright as the user sees it (turn 0)', async () => {
  const { doc, page } = await docWith([], 1);
  const spot = { ...TEXT, y: 400 }; // on the 842x595 page the user now sees
  addAnnotation(doc, page.id, createAnnotation('text', spot));
  const got = await textItem(await buildPdfBytes(doc, { PDFLib, fontkit }), 'Disetujui');
  const m = pdfjs.Util.transform(got.vp, got.raw);
  close([m[0], m[1]], [18, 0], 'reads left to right on the turned page');
  close([m[4], m[5]], [spot.x, spot.y + 0.9 * 18], 'baseline origin on screen');
});

test('a source already carrying /Rotate 90, turned once more: the ink still stays on the paper', async () => {
  // Every case above has base /Rotate 0, where the page's total rotation and
  // the object's turn are equal. This one tells (R - turn) apart from turn
  // alone or R + turn: R is 180, turn is 90.
  const src = await PDFLib.PDFDocument.create();
  src.addPage([595, 842]).setRotation(PDFLib.degrees(90));
  const bytes = await src.save();
  const build = async (quarters) => {
    _resetIds();
    const doc = createDoc();
    const s = addSource(doc, createSource({ name: 'r.pdf', bytes, numPages: 1 }));
    // As core/import.js builds it: width/height from the rotate-honouring
    // viewport (the base turn already baked in), baseRotation off the file.
    const page = createPage({ source: s, sourcePageNum: 0, width: 842, height: 595 });
    page.baseRotation = 90;
    addPages(doc, [page]);
    addAnnotation(doc, page.id, createAnnotation('text', { ...TEXT, x: 120, y: 300 }));
    for (let i = 0; i < quarters; i += 1) rotatePage(doc, page.id, 90);
    return buildPdfBytes(doc, { PDFLib, fontkit });
  };
  const flat = await textItem(await build(0), 'Disetujui');
  const turned = await textItem(await build(1), 'Disetujui');
  assert.deepEqual([flat.rotate, turned.rotate], [90, 180], 'VACUITY GUARD: base 90, then the user\'s quarter');
  close(turned.raw, flat.raw, 'the text matrix moved on the paper');
});
