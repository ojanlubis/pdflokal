/*
 * A CROPPED PAGE'S ANNOTATIONS LAND WHERE THE USER PUT THEM.
 * ============================================================================
 * The editor's page frame is PDF.js's viewport: the page's CropBox (clipped to
 * the MediaBox), with its top-left at (0,0). Export drew in raw MediaBox space
 * from (0,0), so on any cropped page (Preview/Acrobat crops, scanner margins,
 * pdfcrop) every annotation shifted by the crop origin: a Tip-Ex at the
 * visible top-left landed outside the visible area and covered nothing.
 * And a merge rescale scaled the MediaBox but left a distinct CropBox alone,
 * so the reader showed a shifted, zoomed-in piece of the page.
 * Round-3 hunt, 2026-10-10.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as model from '../../js/core/model.js';
import * as ops from '../../js/core/operations.js';
import { buildPdfBytes } from '../../js/core/export.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports;
};
const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');

async function sourcePdf({ crop, rotate = 0 } = {}) {
  const d = await PDFLib.PDFDocument.create();
  const p = d.addPage([612, 792]);
  if (crop) p.setCropBox(...crop);
  if (rotate) p.setRotation(PDFLib.degrees(rotate));
  return d.save();
}

// The red Tip-Ex's bottom-left corner in PDF space: the `x y cm` right after
// its fill colour (pdf-lib's drawRectangle).
async function redRectOrigin(bytes, pageIndex = 0) {
  const d = await PDFLib.PDFDocument.load(bytes);
  const page = d.getPages()[pageIndex];
  const c = page.node.Contents();
  const refs = c instanceof PDFLib.PDFArray ? c.asArray() : [c];
  const text = refs.map((r) => Buffer.from(PDFLib.decodePDFRawStream(d.context.lookup(r)).decode()).toString('latin1')).join('\n');
  const m = /1 0 0 rg[\s\S]*?1 0 0 1 (-?[\d.]+) (-?[\d.]+) cm/.exec(text);
  assert.ok(m, 'VACUITY GUARD: the red rectangle is in the page content');
  return { x: Number(m[1]), y: Number(m[2]), page };
}

function docWith(bytes, width, height, extra = {}) {
  const doc = model.createDoc();
  const source = ops.addSource(doc, model.createSource({ name: 'c.pdf', bytes, numPages: 1 }));
  const page = model.createPage({ source, sourcePageNum: 0, width, height, ...extra });
  ops.addPages(doc, [page]);
  return { doc, page };
}

const RED = { x: 0, y: 0, width: 100, height: 50, color: '#ff0000' };

test('KNOWN-POSITIVE: an uncropped page puts a top-left Tip-Ex at the MediaBox top-left', async () => {
  const { doc, page } = docWith(await sourcePdf(), 612, 792);
  page.annotations.push(model.createAnnotation('whiteout', RED));
  const r = await redRectOrigin(await buildPdfBytes(doc, { PDFLib, fontkit }));
  assert.deepEqual([r.x, r.y], [0, 792 - 50]);
});

test('a cropped page puts a top-left Tip-Ex at the VISIBLE (crop) top-left', async () => {
  // MediaBox 612x792, CropBox (100,100) 400x600: PDF.js shows a 400x600 page.
  const { doc, page } = docWith(await sourcePdf({ crop: [100, 100, 400, 600] }), 400, 600);
  page.annotations.push(model.createAnnotation('whiteout', RED));
  const r = await redRectOrigin(await buildPdfBytes(doc, { PDFLib, fontkit }));
  assert.deepEqual([r.x, r.y], [100, 700 - 50]);
});

test('a cropped page turned 90 keeps the Tip-Ex inside the crop', async () => {
  const { doc, page } = docWith(await sourcePdf({ crop: [100, 100, 400, 600] }), 400, 600);
  ops.rotatePage(doc, page.id, 90); // displayed 600 wide, 400 tall
  page.annotations.push(model.createAnnotation('whiteout', RED));
  const r = await redRectOrigin(await buildPdfBytes(doc, { PDFLib, fontkit }));
  // Visible top-left of a page turned 90 clockwise is the crop's bottom-left.
  assert.deepEqual([r.x, r.y], [100, 100]);
});

test('a merge rescale scales the CropBox with the page, so the reader sees the whole page', async () => {
  const a = await PDFLib.PDFDocument.create();
  a.addPage([595, 842]);
  const doc = model.createDoc();
  const sA = ops.addSource(doc, model.createSource({ name: 'a.pdf', bytes: await a.save(), numPages: 1 }));
  const sB = ops.addSource(doc, model.createSource({ name: 'b.pdf', bytes: await sourcePdf({ crop: [56, 96, 500, 600] }), numPages: 1 }));
  const pA = model.createPage({ source: sA, sourcePageNum: 0, width: 595, height: 842 });
  const pB = model.createPage({ source: sB, sourcePageNum: 0, width: 500, height: 600 });
  ops.addPages(doc, [pA, pB]);
  ops.normalizePageWidths(doc);
  assert.equal(pB.width, 595, 'VACUITY GUARD: the cropped page really was rescaled');
  pB.annotations.push(model.createAnnotation('whiteout', RED));

  const out = await buildPdfBytes(doc, { PDFLib, fontkit });
  const r = await redRectOrigin(out, 1);
  const crop = r.page.getCropBox();
  const k = 595 / 500;
  assert.ok(Math.abs(crop.width - 595) < 1e-6 && Math.abs(crop.height - pB.height) < 1e-6,
    `visible page ${crop.width}x${crop.height}, model ${pB.width}x${pB.height}`);
  assert.ok(Math.abs(crop.x - 56 * k) < 1e-6 && Math.abs(crop.y - 96 * k) < 1e-6, 'the crop moved with the scaled content');
  // The Tip-Ex was drawn at native scale and then scaled with the page: its
  // origin x/y are pre-scale numbers inside the scale wrapper, so check them
  // in native units: the crop's top-left.
  assert.deepEqual([r.x, r.y], [56, 696 - 50 / k]);
});
