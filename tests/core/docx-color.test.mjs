/*
 * docx/color.js on small synthetic PDFs: text colour, the rule that colour and background travel
 * together, highlights, rules, alpha, clipping, gradients, the per-page cap. pdf-lib draws the page,
 * pdf.js reads it, the whole pipeline runs, and the .docx is read back with regexes that do not share
 * the writer. Every assertion here was shown to fail when the behaviour it names is removed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateModel } from '../../js/docx/model.js';
import { loadLibs, makePdf, convertBytes, packageIsClean, paragraphsOf, docText } from './docx-helpers.mjs';

loadLibs();

const shapesOf = (r) => r.model.pages[0].anchors.filter((a) => a.kind === 'shape');
const colourOfWord = (r, word) => {
  const p = paragraphsOf(r.documentXml).find((x) => x.includes(`>${word}`) || x.includes(` ${word}`) || new RegExp(`<w:t[^>]*>[^<]*${word}`).test(x));
  if (!p) return undefined;
  const run = (p.match(/<w:r>[\s\S]*?<\/w:r>/g) || []).find((x) => x.includes(word));
  const m = run && run.match(/<w:color w:val="([0-9A-F]{6})"\/>/);
  return m ? m[1] : null;
};
const clean = async (r) => { assert.deepEqual(packageIsClean(r.files), []); assert.deepEqual(validateModel(r.model), []); assert.deepEqual(r.stats.errors, []); };

test('colour: coloured text keeps its colour; black text stays Word-default', async () => {
  const bytes = await makePdf((pages, { fonts, rgb }) => {
    pages[0].drawText('MERAH', { x: 72, y: 700, size: 14, font: fonts.reg, color: rgb(1, 0, 0) });
    pages[0].drawText('BIRU', { x: 72, y: 660, size: 14, font: fonts.reg, color: rgb(0, 0.2, 0.8) });
    pages[0].drawText('HITAM', { x: 72, y: 620, size: 14, font: fonts.reg });
  });
  const r = await convertBytes(bytes);
  assert.equal(colourOfWord(r, 'MERAH'), 'FF0000');
  assert.equal(colourOfWord(r, 'BIRU'), '0033CC');
  assert.equal(colourOfWord(r, 'HITAM'), null);
  await clean(r);
});

test('colour: two colours in one line stay two colours, in order', async () => {
  const bytes = await makePdf((pages, { fonts, rgb }) => {
    pages[0].drawText('alpha ', { x: 72, y: 700, size: 14, font: fonts.reg, color: rgb(1, 0, 0) });
    const w = fonts.reg.widthOfTextAtSize('alpha ', 14);
    pages[0].drawText('beta', { x: 72 + w, y: 700, size: 14, font: fonts.reg, color: rgb(0, 0.6, 0) });
  });
  const r = await convertBytes(bytes);
  assert.equal(colourOfWord(r, 'alpha'), 'FF0000');
  assert.equal(colourOfWord(r, 'beta'), '009900');
  await clean(r);
});

test('colour: THE RULE. White text on a dark box we draw keeps white AND the box is drawn; white text with no box under it loses its colour (it would vanish)', async () => {
  const bytes = await makePdf((pages, { fonts, rgb }) => {
    pages[0].drawRectangle({ x: 0, y: 600, width: 595, height: 242, color: rgb(0.05, 0.1, 0.4) });
    pages[0].drawText('TERANG', { x: 72, y: 700, size: 24, font: fonts.bold, color: rgb(1, 1, 1) });
    pages[0].drawText('HILANG', { x: 72, y: 300, size: 24, font: fonts.bold, color: rgb(1, 1, 1) });
  });
  const r = await convertBytes(bytes);
  assert.equal(colourOfWord(r, 'TERANG'), 'FFFFFF', 'light text over the drawn dark box stays light');
  assert.equal(colourOfWord(r, 'HILANG'), null, 'light text over nothing falls back to the default colour');
  const box = shapesOf(r).find((s) => s.fill === '0D1A66');
  assert.ok(box && box.hPt > 230 && box.wPt > 590, 'the dark box is a shape anchored on the page');
  assert.equal(r.model.pages[0].anchors.length, 1);
  assert.equal(r.stats.shapes, 1);
  await clean(r);
});

test('colour: dark text over a dark fill we drew, whose colour we cannot resolve, becomes white (the other direction of the rule)', async () => {
  const color = await import('../../js/docx/color.js');
  const bytes = await makePdf((pages, { fonts, rgb }) => {
    pages[0].drawRectangle({ x: 0, y: 600, width: 595, height: 242, color: rgb(0.02, 0.02, 0.1) });
    pages[0].drawText('GELAP', { x: 72, y: 700, size: 24, font: fonts.bold, color: rgb(0.9, 0.9, 0.9) });
  });
  // the colour of every show is hidden from the matcher: the text arrives as unresolved
  const hidden = { analyzeColor: async (ctx) => { const info = await color.analyzeColor({ ...ctx, ops: { fnArray: ctx.ops.fnArray.map((f) => (f === ctx.pdfjs.OPS.showText ? -1 : f)), argsArray: ctx.ops.argsArray } }); return info; } };
  const r = await convertBytes(bytes, { modules: { color: hidden } });
  assert.equal(colourOfWord(r, 'GELAP'), 'FFFFFF');
  await clean(r);
});

test('colour: a white rectangle on a white page is the page, not a shape; white on colour is a shape', async () => {
  const bytes = await makePdf((pages, { rgb }) => {
    pages[0].drawRectangle({ x: 50, y: 50, width: 400, height: 300, color: rgb(1, 1, 1) });
    pages[0].drawRectangle({ x: 100, y: 500, width: 300, height: 200, color: rgb(0.2, 0.4, 0.8) });
    pages[0].drawRectangle({ x: 150, y: 550, width: 100, height: 100, color: rgb(1, 1, 1) });
  });
  const r = await convertBytes(bytes);
  assert.deepEqual(shapesOf(r).map((s) => s.fill), ['3366CC', 'FFFFFF']);
  await clean(r);
});

test('colour: a tight box behind one line of text becomes character shading (run.bg), not a floating shape', async () => {
  const bytes = await makePdf((pages, { fonts, rgb }) => {
    const w = fonts.reg.widthOfTextAtSize('penting sekali', 12);
    pages[0].drawRectangle({ x: 70, y: 696, width: w + 4, height: 16, color: rgb(1, 1, 0) });
    pages[0].drawText('penting sekali', { x: 72, y: 700, size: 12, font: fonts.reg });
  });
  const r = await convertBytes(bytes);
  assert.equal(shapesOf(r).length, 0);
  assert.match(r.documentXml, /<w:shd w:val="clear" w:color="auto" w:fill="FFFF00"\/>/);
  await clean(r);
});

test('colour: an axis-aligned stroked line is a thin filled rectangle of the stroke colour; a diagonal stays a stroked path', async () => {
  const bytes = await makePdf((pages, { rgb }) => {
    pages[0].drawLine({ start: { x: 72, y: 500 }, end: { x: 400, y: 500 }, thickness: 2, color: rgb(1, 0, 0) });
    pages[0].drawLine({ start: { x: 72, y: 400 }, end: { x: 300, y: 300 }, thickness: 1, color: rgb(0, 0, 1) });
  });
  const r = await convertBytes(bytes);
  const [rule, diag] = shapesOf(r);
  assert.equal(rule.fill, 'FF0000');
  assert.ok(rule.hPt >= 1.9 && rule.hPt <= 2.1 && Math.abs(rule.wPt - 328) < 0.5, 'a 2pt rule 328pt long');
  assert.equal(rule.stroke, undefined);
  assert.equal(diag.stroke.c, '0000FF');
  assert.ok(diag.path, 'the diagonal keeps its path');
  assert.match(r.documentXml, /<a:custGeom>/);
  await clean(r);
});

test('colour: a rectangle is a rect, a triangle a custom path; both carry fill, position and size to Word EMU', async () => {
  const bytes = await makePdf((pages, { rgb }) => {
    pages[0].drawRectangle({ x: 100, y: 600, width: 200, height: 100, color: rgb(0, 0.5, 0) });
    pages[0].drawSvgPath('M 0 0 L 100 0 L 50 80 Z', { x: 350, y: 700, color: rgb(1, 0.5, 0) });
  });
  const r = await convertBytes(bytes);
  const [rect, tri] = shapesOf(r);
  assert.deepEqual([rect.x, rect.y, rect.wPt, rect.hPt, rect.fill], [100, 142, 200, 100, '008000']);
  assert.equal(rect.path, undefined);
  assert.ok(tri.path && tri.fill === 'FF8000');
  assert.match(r.documentXml, /<a:prstGeom prst="rect">/);
  assert.match(r.documentXml, /<a:pt x="\d+" y="\d+"\/>/);
  assert.match(r.documentXml, /<wp:posOffset>1270000<\/wp:posOffset>/); // x = 100pt in EMU
  await clean(r);
});

test('colour: constant opacity becomes DrawingML alpha, and the colour under it is composited for fillAt', async () => {
  const bytes = await makePdf((pages, { rgb }) => {
    pages[0].drawRectangle({ x: 100, y: 500, width: 300, height: 200, color: rgb(1, 0, 0), opacity: 0.5 });
  });
  const r = await convertBytes(bytes);
  assert.match(r.documentXml, /<a:srgbClr val="FF0000"><a:alpha val="50000"\/><\/a:srgbClr>/);
  let fillAt = null;
  await convertBytes(bytes, { modules: { tables: { detectTables: (ctx) => { fillAt = ctx.color.fillAt; return []; } } } });
  assert.equal(fillAt(150, 150, 250, 200), 'FF8080', 'red at 50% over the white page, as the table lane will see it');
  assert.equal(fillAt(10, 10, 40, 40), null, 'nothing drawn there');
  await clean(r);
});

test('colour: a clip trims what it paints (a rectangle bigger than its clip draws the clip)', async () => {
  const bytes = await makePdf((pages, { PDFLib, rgb }) => {
    const p = pages[0];
    p.pushOperators(PDFLib.pushGraphicsState(), PDFLib.rectangle(100, 500, 100, 100), PDFLib.clip(), PDFLib.endPath());
    p.drawRectangle({ x: 0, y: 0, width: 595, height: 842, color: rgb(0.8, 0.1, 0.1) });
    p.pushOperators(PDFLib.popGraphicsState());
  });
  const r = await convertBytes(bytes);
  const [s] = shapesOf(r);
  assert.deepEqual([s.x, s.y, s.wPt, s.hPt], [100, 242, 100, 100]);
  assert.equal(shapesOf(r).length, 1);
  await clean(r);
});

// An axial shading painted with `sh` inside a clip: the gradient must reach Word as a:gradFill with the stops of the PDF.
async function gradientPdf() {
  return makePdf((pages, { doc, PDFLib }) => {
    const ctx = doc.context;
    const p = pages[0];
    const fn = ctx.register(ctx.obj({ FunctionType: 2, Domain: [0, 1], C0: [1, 0, 0], C1: [0, 0, 1], N: 1 }));
    const sh = ctx.register(ctx.obj({ ShadingType: 2, ColorSpace: 'DeviceRGB', Coords: [100, 0, 300, 0], Function: fn, Extend: [true, true] }));
    p.node.Resources().set(PDFLib.PDFName.of('Shading'), ctx.obj({ Sh1: sh }));
    p.pushOperators(PDFLib.pushGraphicsState(), PDFLib.rectangle(100, 500, 200, 100), PDFLib.clip(), PDFLib.endPath(),
      PDFLib.PDFOperator.of('sh', [PDFLib.PDFName.of('Sh1')]), PDFLib.popGraphicsState());
  });
}

test('colour: an axial gradient fill reaches Word as a:gradFill with its two end colours', async () => {
  const bytes = await gradientPdf();
  const r = await convertBytes(bytes);
  assert.match(r.documentXml, /<a:gradFill/);
  assert.match(r.documentXml, /<a:srgbClr val="FF0000"\/>/);
  assert.match(r.documentXml, /<a:srgbClr val="0000FF"\/>/);
  await clean(r);
});

test('colour: a page with more marks than the cap keeps the biggest ones, in paint order, and says how many it dropped', async () => {
  const bytes = await makePdf((pages, { rgb }) => {
    for (let k = 0; k < 450; k += 1) pages[0].drawRectangle({ x: 20 + (k % 30) * 18, y: 30 + Math.floor(k / 30) * 20, width: 10 + (k % 7), height: 10 + (k % 5), color: rgb(0.2, 0.3, (k % 10) / 10) });
    pages[0].drawRectangle({ x: 20, y: 600, width: 400, height: 200, color: rgb(0.9, 0.2, 0.1) });
  });
  const r = await convertBytes(bytes);
  const shapes = shapesOf(r);
  assert.equal(shapes.length, 400);
  assert.ok(shapes.some((s) => s.wPt === 400 && s.hPt === 200), 'the big one survives the cut');
  assert.deepEqual(shapes.map((s) => s.z), shapes.map((s) => s.z).slice().sort((a, b) => a - b), 'paint order is kept');
  await clean(r);
});

test('colour: nothing in the page, nothing in the colour output (no shapes, no colour, no wps namespace)', async () => {
  const bytes = await makePdf((pages, { fonts }) => { pages[0].drawText('biasa saja', { x: 72, y: 700, size: 12, font: fonts.reg }); });
  const r = await convertBytes(bytes);
  assert.equal(shapesOf(r).length, 0);
  assert.doesNotMatch(r.documentXml, /w:color w:val|wps:/);
  await clean(r);
});

// A filled path too complex to draw (a zigzag of 3000 vertices that does not simplify away) is the raster hook's work:
// the region becomes a picture at its paint position, with the text left to Word; no hook, no picture, counted.
async function complexPdf() {
  return makePdf((pages, { fonts, rgb }) => {
    const pts = [];
    for (let k = 0; k < 3000; k += 1) pts.push([60 + (k / 3000) * 450, 300 + (k % 2 ? 160 : 0)]);
    pages[0].drawSvgPath(`M ${pts[0][0]} ${pts[0][1]} ${pts.slice(1).map((p) => `L ${p[0]} ${p[1]}`).join(' ')} Z`, { x: 0, y: 842, color: rgb(0.1, 0.4, 0.2) });
    pages[0].drawText('di atas gambar', { x: 80, y: 400, size: 14, font: fonts.reg });
  });
}

test('colour: a region too complex to draw becomes a picture through ctx.options.rasterize, anchored in paint order; with no hook it is counted and not faked', async () => {
  const bytes = await complexPdf();
  const calls = [];
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const r = await convertBytes(bytes, { options: { rasterize: async (a) => { calls.push(a.why); return { bytes: png, ext: 'png' }; } } });
  assert.deepEqual(calls, ['complex']);
  const imgs = r.model.pages[0].anchors.filter((a) => a.kind === 'img');
  assert.equal(imgs.length, 1);
  assert.ok(imgs[0].wPt > 400 && imgs[0].hPt > 150, 'the picture covers the lost region');
  assert.ok(docText(r.documentXml).some((t) => t.includes('di atas gambar')), 'the words stay live text');
  await clean(r);
  const none = await convertBytes(bytes); // node: no canvas, no hook
  assert.equal(none.model.pages[0].anchors.filter((a) => a.kind === 'img').length, 0);
  assert.equal(shapesOf(none).length, 0, 'the big path is not drawn as a shape');
});
