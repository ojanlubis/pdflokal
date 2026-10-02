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
