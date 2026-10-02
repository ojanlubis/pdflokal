/*
 * Integration of the images lane and the colour lane: a behind-text PICTURE that a LATER shape overlaps is written as a
 * picture-filled shape (Img.asShape), because LibreOffice draws pictures above shapes whatever relativeHeight says.
 * MEASURED 2026-10-02 (LibreOffice 26.2, a blue picture and a grey rectangle drawn after it): relativeHeight 241/242 ->
 * picture on top; swapping the XML order, small or huge relativeHeight values, mc:AlternateContent: the picture still on
 * top; the same picture as a wps:wsp with a:blipFill: the grey rectangle on top. The gate's n016 callouts were the case.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodePng } from '../../js/docx/png.js';
import { loadLibs, makePdf, convertBytes, packageIsClean } from './docx-helpers.mjs';
import { structureProblems } from '../../scripts/lib/docx-validate.mjs';

const { fflate } = loadLibs();
const swatch = () => { const px = new Uint8Array(40 * 40 * 3); for (let i = 0; i < 40 * 40; i += 1) { px[i * 3] = 60; px[i * 3 + 1] = 120; px[i * 3 + 2] = 200; } return encodePng(fflate, 40, 40, 3, px); };

const count = (s, re) => (s.match(re) || []).length;

test('stacking: a picture with a rectangle drawn AFTER it is written as a picture-filled shape; the package stays valid', async () => {
  const bytes = await makePdf(async (pages, { doc, rgb }) => {
    const img = await doc.embedPng(swatch());
    pages[0].drawImage(img, { x: 100, y: 400, width: 300, height: 200 });
    pages[0].drawRectangle({ x: 150, y: 450, width: 100, height: 60, color: rgb(0.75, 0.75, 0.75) });
  });
  const r = await convertBytes(bytes);
  assert.equal(count(r.documentXml, /<pic:pic>/g), 0, 'no pic:pic: the picture is a shape');
  assert.equal(count(r.documentXml, /<a:blipFill>/g), 1);
  assert.equal(count(r.documentXml, /<wps:wsp>/g), 2, 'the picture-shape and the rectangle');
  // the picture-shape is written before the rectangle, so it stacks below it
  assert.ok(r.documentXml.indexOf('<a:blipFill>') < r.documentXml.indexOf('<a:srgbClr val="BFBFBF"/>'));
  assert.deepEqual(packageIsClean(r.files), []);
  assert.deepEqual(structureProblems(r.files).problems, []);
});

test('stacking: a picture with nothing drawn over it stays a real picture (pic:pic)', async () => {
  const bytes = await makePdf(async (pages, { doc, rgb }) => {
    const img = await doc.embedPng(swatch());
    pages[0].drawRectangle({ x: 150, y: 450, width: 100, height: 60, color: rgb(0.75, 0.75, 0.75) }); // BELOW the picture, apart from it
    pages[0].drawImage(img, { x: 100, y: 400, width: 300, height: 200 });
  });
  const r = await convertBytes(bytes);
  assert.equal(count(r.documentXml, /<pic:pic>/g), 1);
  assert.equal(count(r.documentXml, /<a:blipFill>/g), 0, 'no picture-filled shape');
});

test('stacking: a cropped picture under a shape keeps its crop as a negative fillRect (LibreOffice ignores srcRect in a shape fill, honours this)', async () => {
  const bytes = await makePdf(async (pages, { doc, rgb }) => {
    const img = await doc.embedPng(swatch());
    pages[0].drawImage(img, { x: -60, y: 400, width: 300, height: 200 }); // spills off the page by 60 of 300 pt: the engine crops 20% off the left
    pages[0].drawRectangle({ x: 20, y: 450, width: 100, height: 60, color: rgb(0.75, 0.75, 0.75) });
  });
  const r = await convertBytes(bytes);
  assert.equal(count(r.documentXml, /<pic:pic>/g), 0);
  assert.doesNotMatch(r.documentXml, /<a:srcRect /);
  const m = r.documentXml.match(/<a:fillRect l="(-?\d+)" t="0" r="0" b="0"\/>/);
  assert.ok(m, 'a fillRect that reaches past the shape on the left');
  assert.ok(Math.abs(Number(m[1]) + 25000) < 200, `20% cropped of 300 = visible 240: the picture extends 60/240 = 25% past the left edge (got ${m[1]})`);
  assert.deepEqual(structureProblems(r.files).problems, []);
});

// ---- table cell shading is in the text layer: anchors drawn ON a shaded cell go in front ---------------------------
import { stackAnchors, filledCells, ruleIsBorder, boxIsCellOutline } from '../../js/docx/stack.js';

const claim = {
  x0: 10, y0: 20, x1: 210, y1: 70, lines: [],
  block: { kind: 'tbl', colsPt: [100, 100], rowsH: [30, 20], rows: [[{ fill: 'FFFF00', blocks: [] }, { blocks: [] }], [{ blocks: [], span: 2 }]] },
};
const pic = (x, y, w, h, z) => ({ kind: 'img', anchor: { x, y }, wPt: w, hPt: h, bytes: new Uint8Array([1]), ext: 'png', z });
const shp = (x, y, w, h, z, extra = {}) => ({ kind: 'shape', x, y, wPt: w, hPt: h, z, ...extra });

test('stacking: filledCells gives the page rectangle of each shaded cell (merged cells run down)', () => {
  assert.deepEqual(filledCells(claim), [{ x0: 10, x1: 110, y0: 20, y1: 50 }]);
});

test('stacking: a logo on a shaded cell is written in front of the text; one off the shading, or a background, is not', () => {
  const logo = pic(20, 25, 40, 15, 5);
  const off = pic(130, 25, 40, 15, 6);
  const bg = shp(0, 0, 595, 842, 1, { fill: 'EEEEEE' });
  const out = stackAnchors([[bg, off], [logo]], { claims: [claim], lines: [] });
  assert.equal(logo.inFront, true);
  assert.equal(off.inFront, undefined);
  assert.equal(bg.inFront, undefined);
  assert.equal(out.length, 3);
});

test('stacking: in front only where it cannot hide words: a stroke-only box always, a filled shape or a picture not over text', () => {
  const words = { x: 30, y: 28, w: 50, h: 9 };
  const box = shp(25, 24, 60, 18, 3, { stroke: { c: '000000', wPt: 0.5 } });
  const filled = shp(25, 24, 60, 18, 4, { fill: 'FF0000' });
  const logo = pic(25, 24, 60, 18, 5);
  stackAnchors([[box, filled], [logo]], { claims: [claim], lines: [words] });
  assert.equal(box.inFront, true, 'an outline hides nothing');
  assert.equal(filled.inFront, undefined, 'it would cover the words');
  assert.equal(logo.inFront, undefined, 'it would cover the words');
});

test('stacking: the writer puts an inFront anchor at behindDoc=0, a shape and a picture alike', async () => {
  const { buildDocx } = await import('../../js/docx/writer.js');
  const page = { widthPt: 595, heightPt: 842, kind: 'text', segments: [{ cols: 1, space: 0, marginPt: { top: 36, right: 36, bottom: 18, left: 36 }, blocks: [] }], anchors: [pic(20, 25, 40, 15, 5), shp(30, 30, 10, 10, 6, { fill: '00FF00' })] };
  page.anchors[0].inFront = true; page.anchors[1].inFront = true;
  const r = await buildDocx({ pages: [page] }, { fflate });
  const xml = fflate.strFromU8(fflate.unzipSync(r)['word/document.xml']);
  assert.equal((xml.match(/behindDoc="0"/g) || []).length, 2);
  assert.equal((xml.match(/behindDoc="1"/g) || []).length, 0);
});

test('stacking: a rule is a table border only on a grid line; a box only when it outlines cells (a form\'s character boxes are neither)', () => {
  assert.equal(ruleIsBorder(claim, [10, 20, 210, 20.5]), true, 'the top edge');
  assert.equal(ruleIsBorder(claim, [110, 20, 110.5, 70]), true, 'the middle vertical');
  assert.equal(ruleIsBorder(claim, [60, 33, 60.5, 41]), false, 'a divider inside a cell');
  assert.equal(ruleIsBorder(claim, [100, 40, 120, 40.5]), false, 'a horizontal divider inside a cell, centred on a column line');
  assert.equal(boxIsCellOutline(claim, [10, 20, 110, 50]), true);
  assert.equal(boxIsCellOutline(claim, [30, 24, 40, 34]), false, 'a character box');
});
