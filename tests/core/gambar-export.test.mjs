/*
 * GAMBAR: THE PICTURE IS IN THE DOWNLOAD EXACTLY WHERE THE SCREEN SHOWS IT
 * ============================================================================
 * A picture is the signature object, placed by core/operations.js placeImage.
 * This file proves the EXPORTED PDF agrees with the model's box.
 *
 * THE ORACLE is the screen's own frame: the vendored pdf.js viewport (which
 * applies the page's /Rotate, as the editor's render does) composed with the
 * `cm` in force when the image is painted maps the image's unit square to the
 * box a reader shows. That box must equal the annotation's displayed box
 * (x, y, width, height), for an upright page and for pages turned 90/180/270.
 * It also reads the embedded XObject's own pixel size, so a downscale or a
 * swapped-axis embed cannot hide behind a matching matrix.
 *
 * RED PROOF (run when this file was written, then reverted): in
 * core/export.js drawSignature, anchoring the image at `objectPoint(anno, 0, 0,
 * frame)` instead of `(0, height, frame)` puts every picture one height too
 * high on the page and the five position cases below fail (size and soft-mask
 * cases are about other things and stay green). Note this pins TTD's absolute
 * placement as a side effect: export-turn.test.mjs only pins that ink does not
 * MOVE when a page turns, never where it sits.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDoc, createSource, createPage, _resetIds } from '../../js/core/model.js';
import { addSource, addPages, placeImage, rotatePage } from '../../js/core/operations.js';
import { buildPdfBytes } from '../../js/core/export.js';
import { pngDataUrl } from '../helpers/png.js';

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

// A4, turned `quarters` times, with one picture tapped at (cx, cy) in the
// DISPLAYED frame AFTER the turn (the user taps what they see).
async function docWithPicture({ px, quarters = 0, tap }) {
  _resetIds();
  const doc = createDoc();
  const src = addSource(doc, createSource({ name: 'a.pdf', bytes: await blankA4(), numPages: 1 }));
  addPages(doc, [createPage({ source: src, sourcePageNum: 0, width: 595, height: 842 })]);
  const page = doc.pages[0];
  for (let i = 0; i < quarters; i += 1) rotatePage(doc, page.id, 90);
  const anno = placeImage(doc, page.id, { image: pngDataUrl(px.w, px.h, { clearLeftColumn: true }), pxWidth: px.w, pxHeight: px.h }, tap.x, tap.y);
  return { doc, anno };
}

// The box the exported file shows for the (only) image: the unit square under
// viewport x cm, plus the XObject's own pixel size.
async function shownBox(bytes) {
  const pj = await pdfjs.getDocument({ data: bytes, disableFontFace: true, isEvalSupported: false, verbosity: 0 }).promise;
  const pg = await pj.getPage(1);
  const ops = await pg.getOperatorList();
  const { OPS } = pdfjs;
  const vp = pg.getViewport({ scale: 1 }).transform;
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  for (let i = 0; i < ops.fnArray.length; i += 1) {
    const fn = ops.fnArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = pdfjs.Util.transform(ctm, ops.argsArray[i]);
    else if (fn === OPS.paintImageXObject) {
      const m = pdfjs.Util.transform(vp, ctm);
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]]);
      const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
      const img = await new Promise((resolve) => pg.objs.get(ops.argsArray[i][0], resolve));
      return {
        x: Math.min(...xs), y: Math.min(...ys),
        w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys),
        px: { w: img.width, h: img.height },
      };
    }
  }
  assert.fail('no image was painted');
  return null;
}

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.05, `${msg}: file ${a.toFixed(2)} vs screen ${b.toFixed(2)}`);

for (const quarters of [0, 1, 2, 3]) {
  test(`a picture tapped on a page turned ${quarters * 90} is in the file at the box the screen shows`, async () => {
    const { doc, anno } = await docWithPicture({ px: { w: 120, h: 60 }, quarters, tap: { x: 200, y: 300 } });
    // VACUITY GUARD: the model really holds a box with a width, a height and a spot.
    assert.ok(anno.width === 120 && anno.height === 60, 'the picture keeps its pixels as points');
    const got = await shownBox(await buildPdfBytes(doc, { PDFLib, fontkit }));
    near(got.x, anno.x, 'left edge');
    near(got.y, anno.y, 'top edge');
    near(got.w, anno.width, 'width');
    near(got.h, anno.height, 'height');
    assert.deepEqual(got.px, { w: 120, h: 60 }, 'the embedded image keeps its own pixels');
  });
}

test('a picture held inside the page by a tap at the corner is inside the page in the file too', async () => {
  const { doc, anno } = await docWithPicture({ px: { w: 300, h: 200 }, tap: { x: 590, y: 838 } });
  const got = await shownBox(await buildPdfBytes(doc, { PDFLib, fontkit }));
  near(got.x, anno.x, 'left'); near(got.y, anno.y, 'top');
  assert.ok(got.x + got.w <= 595 + 0.05 && got.y + got.h <= 842 + 0.05, 'the whole picture is on the paper');
});

test('a shrunk big picture is written at its shrunk size, aspect kept', async () => {
  const { doc, anno } = await docWithPicture({ px: { w: 2000, h: 1000 }, tap: { x: 300, y: 400 } });
  assert.equal(anno.width, 595 * 0.6);
  const got = await shownBox(await buildPdfBytes(doc, { PDFLib, fontkit }));
  near(got.w / got.h, 2, 'aspect');
  near(got.w, 595 * 0.6, 'width');
  assert.deepEqual(got.px, { w: 2000, h: 1000 }, 'every pixel the user brought is still in the file');
});

test('PNG transparency survives into the file (a logo keeps its soft mask)', async () => {
  const { doc } = await docWithPicture({ px: { w: 20, h: 10 }, tap: { x: 300, y: 400 } });
  const out = await PDFLib.PDFDocument.load(await buildPdfBytes(doc, { PDFLib, fontkit }));
  const imgs = [...out.context.enumerateIndirectObjects()].map(([, o]) => o).filter((o) => o.dict && o.dict.get(PDFLib.PDFName.of('Subtype')) === PDFLib.PDFName.of('Image'));
  assert.ok(imgs.some((o) => o.dict.has(PDFLib.PDFName.of('SMask'))), 'an alpha PNG is written with a soft mask');
});
