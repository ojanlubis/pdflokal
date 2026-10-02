/*
 * docx/images.js: which pictures are placed as they are, which are cropped, which are painted through pdf.js,
 * and which are skipped. The scan and the plan are pure (no canvas), so most of this runs anywhere; the paint
 * itself needs a canvas, which node does not have: that test runs when a canvas kit can be found (see
 * scripts/lib/node-canvas-kit.mjs, DOCX_CANVAS) and says so when it cannot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodePng } from '../../js/docx/png.js';
import { scanPaints, planPaint } from '../../js/docx/images.js';
import { loadLibs, makePdf, convertBytes, packageIsClean } from './docx-helpers.mjs';
import { nodeCanvasKit } from '../../scripts/lib/node-canvas-kit.mjs';

const { fflate, pdfjs, PDFLib } = loadLibs();

const swatch = (n = 8) => { const px = new Uint8Array(n * n * 3); for (let i = 0; i < px.length; i += 1) px[i] = (i * 7) % 256; return encodePng(fflate, n, n, 3, px); };

// A circle path (four Bezier arcs) centred at (cx, cy) with radius r, as clip operators.
function circleClip(cx, cy, r) {
  const k = 0.5523 * r;
  const { moveTo, appendBezierCurve, closePath, clip, endPath } = PDFLib;
  return [moveTo(cx + r, cy),
    appendBezierCurve(cx + r, cy + k, cx + k, cy + r, cx, cy + r), appendBezierCurve(cx - k, cy + r, cx - r, cy + k, cx - r, cy),
    appendBezierCurve(cx - r, cy - k, cx - k, cy - r, cx, cy - r), appendBezierCurve(cx + k, cy - r, cx + r, cy - k, cx + r, cy),
    closePath(), clip(), endPath()];
}

async function paintsOf(bytes, pageNo = 1) {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0, isEvalSupported: false }).promise;
  const page = await pdf.getPage(pageNo);
  const vp = page.getViewport({ scale: 1 });
  const ops = await page.getOperatorList();
  const paints = scanPaints(pdfjs, ops, vp);
  await pdf.destroy();
  return { paints, W: vp.width, H: vp.height };
}

test('images: a picture clipped by a curve gets the curve\'s own box (pdf.js reports a point) and is painted, not placed raw', async () => {
  const bytes = await makePdf(async (pages, { doc }) => {
    const img = await doc.embedPng(swatch());
    pages[0].pushOperators(PDFLib.pushGraphicsState(), ...circleClip(300, 400, 50));
    pages[0].drawImage(img, { x: 200, y: 300, width: 200, height: 200 });
    pages[0].pushOperators(PDFLib.popGraphicsState());
  });
  const { paints, W, H } = await paintsOf(bytes);
  assert.equal(paints.length, 1);
  const [p] = paints;
  assert.ok(p.clip && p.clip.x1 - p.clip.x0 > 95 && p.clip.y1 - p.clip.y0 > 95, `the clip is about the circle's 100pt square, not a point: ${JSON.stringify(p.clip)}`);
  assert.equal(p.exact, false, 'a curve is not a rectangle');
  assert.equal(planPaint(p, W, H), 'painted');
});

test('images: an upright rectangular clip that cuts a picture is a crop of the plain picture, not a render', async () => {
  const bytes = await makePdf(async (pages, { doc }) => {
    const img = await doc.embedPng(swatch());
    pages[0].pushOperators(PDFLib.pushGraphicsState(), PDFLib.rectangle(210, 310, 100, 80), PDFLib.clip(), PDFLib.endPath());
    pages[0].drawImage(img, { x: 200, y: 300, width: 200, height: 100 });
    pages[0].pushOperators(PDFLib.popGraphicsState());
  });
  const { paints, W, H } = await paintsOf(bytes);
  assert.equal(paints[0].exact, true);
  assert.equal(planPaint(paints[0], W, H), 'plain');
  const r = await convertBytes(bytes);
  assert.equal(r.stats.imagesPlain, 1);
  assert.equal(r.stats.imagesPainted, 0);
  // the picture is 200 x 100pt, the clip keeps x 210..310 and y 310..390: l = 10/200, r = 90/200, t = 10/100, b = 10/100
  const crop = /<a:srcRect l="(\d+)" t="(\d+)" r="(\d+)" b="(\d+)"\/>/.exec(r.documentXml);
  assert.ok(crop, 'a srcRect is written');
  assert.deepEqual(crop.slice(1).map((n) => Math.round(Number(n) / 1000)), [5, 10, 45, 10]);
  assert.deepEqual(packageIsClean(r.files), []);
});

test('images: a picture inside a soft-mask definition paints nothing (it is the mask), the picture it masks does', () => {
  const { OPS } = pdfjs;
  const ops = {
    fnArray: [OPS.save, OPS.beginGroup, OPS.transform, OPS.paintImageXObject, OPS.endGroup, OPS.transform, OPS.paintImageXObject, OPS.restore],
    argsArray: [null, [{ smask: { subtype: 'Luminosity' } }], [100, 0, 0, -100, 50, 300], ['img_mask', 8, 8], [{ smask: { subtype: 'Luminosity' } }], [100, 0, 0, -100, 50, 300], ['img_photo', 8, 8], null],
  };
  const paints = scanPaints(pdfjs, ops, { transform: [1, 0, 0, -1, 0, 400] });
  assert.equal(paints.length, 2);
  assert.equal(paints[0].inMask, true);
  assert.equal(planPaint(paints[0], 400, 400), 'skip');
  assert.equal(paints[1].inMask, false);
});

test('images: a picture under reduced opacity is painted (the alpha is baked in); one at full opacity is placed as it is', async () => {
  const bytes = await makePdf(async (pages, { doc }) => {
    const img = await doc.embedPng(swatch());
    pages[0].drawImage(img, { x: 50, y: 600, width: 100, height: 100 });
    pages[0].drawImage(img, { x: 250, y: 600, width: 100, height: 100, opacity: 0.4 });
  });
  const { paints, W, H } = await paintsOf(bytes);
  assert.deepEqual(paints.map((p) => planPaint(p, W, H)), ['plain', 'painted']);
});

// ---- the paint itself: needs a canvas ----------------------------------------------------------
const kit = await nodeCanvasKit();
test('images: painted through a canvas, a circle-clipped picture is a transparent-cornered PNG of the circle; the same placement on later pages is not rendered again', { skip: kit ? false : 'no canvas for node (set DOCX_CANVAS to an @napi-rs/canvas package)' }, async () => {
  const bytes = await makePdf(async (pages, { doc }) => {
    const img = await doc.embedPng(swatch());
    for (const p of pages) {
      p.pushOperators(PDFLib.pushGraphicsState(), ...circleClip(300, 400, 50));
      p.drawImage(img, { x: 200, y: 300, width: 200, height: 200 });
      p.pushOperators(PDFLib.popGraphicsState());
    }
  }, { pages: [[595, 842], [595, 842], [595, 842], [595, 842]] });
  const r = await convertBytes(bytes, { options: { canvasKit: kit } });
  assert.equal(r.stats.imagesPainted, 4);
  assert.equal(r.stats.imagesPaintFailed, 0);
  const media = Object.keys(r.files).filter((n) => n.startsWith('word/media/'));
  // pdf.js names an image object per page until it has seen it on a second page, then globally: so at most two renders
  assert.ok(media.length <= 2, `one render per image id, not one per page: ${media.length} media parts for 4 pages`);
  const png = r.files[media[0]];
  assert.equal(png[25], 6, 'PNG colour type 6: it carries alpha');
  const w = (png[16] << 24) | (png[17] << 16) | (png[18] << 8) | png[19];
  assert.ok(w >= 99 && w <= 160, `trimmed to the circle (about 100pt at 1-2.1 px/pt), got ${w}px`);
  // the trimmed square's corner lies outside the circle: transparent
  const px = decodeRgba(png);
  assert.equal(px[3], 0, 'the top-left pixel is transparent');
  assert.equal(px[((w >> 1) * w + (w >> 1)) * 4 + 3], 255, 'the centre pixel is opaque');
  assert.deepEqual(packageIsClean(r.files), []);
});

// the concatenated IDAT payload of a PNG
function pngIdat(png) {
  const parts = [];
  for (let o = 8; o < png.length;) {
    const len = (png[o] << 24 | png[o + 1] << 16 | png[o + 2] << 8 | png[o + 3]) >>> 0;
    const type = String.fromCharCode(png[o + 4], png[o + 5], png[o + 6], png[o + 7]);
    if (type === 'IDAT') parts.push(png.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let k = 0; for (const p of parts) { out.set(p, k); k += p.length; }
  return out;
}

// 8-bit RGBA, non-interlaced PNG -> raw pixels (all five scanline filters)
function decodeRgba(png) {
  const w = (png[16] << 24) | (png[17] << 16) | (png[18] << 8) | png[19];
  const h = (png[20] << 24) | (png[21] << 16) | (png[22] << 8) | png[23];
  const raw = fflate.unzlibSync(pngIdat(png));
  const out = new Uint8Array(w * h * 4);
  const row = w * 4;
  for (let y = 0; y < h; y += 1) {
    const f = raw[y * (row + 1)];
    for (let x = 0; x < row; x += 1) {
      const v = raw[y * (row + 1) + 1 + x];
      const a = x >= 4 ? out[y * row + x - 4] : 0;
      const b = y ? out[(y - 1) * row + x] : 0;
      const c = x >= 4 && y ? out[(y - 1) * row + x - 4] : 0;
      let add = 0;
      if (f === 1) add = a; else if (f === 2) add = b; else if (f === 3) add = (a + b) >> 1; else if (f === 4) { const pp = a + b - c; const pa = Math.abs(pp - a); const pb = Math.abs(pp - b); const pc = Math.abs(pp - c); add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[y * row + x] = (v + add) & 255;
    }
  }
  return out;
}
