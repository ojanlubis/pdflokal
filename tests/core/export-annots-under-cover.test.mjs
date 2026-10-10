/*
 * export-annots-under-cover.test.mjs — a Tip-Ex/Teks/TTD placed over a filled
 * form field (or any annotation with an appearance) must cover it in the
 * downloaded file, the way it covers it on screen.
 * ============================================================================
 * WHY THIS CAN DIVERGE. The screen raster is pdf.js with its default
 * annotationMode, which paints every viewable annotation's /AP INTO the page
 * image; the user's objects sit in an overlay above it. The export draws the
 * user's objects into the page CONTENT, and readers paint /Annots AFTER the
 * content, so a field copied across verbatim lands on top of the cover that
 * was meant to hide it. Red before the fix: the widget survived in /Annots and
 * nothing in the content painted it.
 *
 * Both directions are pinned: the edited page's appearance moves into the
 * content BEFORE the cover; a page with no user objects keeps its field live;
 * a /Link (interaction, not paint) and a Hidden annotation (pdf.js does not
 * show it) are left alone on the edited page; a flattened annotation's /Popup
 * leaves with it.
 *
 * SCOPE (review of the first fix, 2026-10-10): only an annotation whose /Rect
 * meets a user object's drawn rect is flattened. One elsewhere on the same
 * page stays live, and an attachment, a sticky note or a media annotation
 * stays live even under the cover: flattening those loses a file or a
 * comment, not just a look. The overlap is computed in the frame the user's
 * objects are drawn in, so a turned and a cropped page are pinned too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as model from '../../js/core/model.js';
import * as ops from '../../js/core/operations.js';
import { buildPdfBytes } from '../../js/core/export.js';
import { readPageContents } from '../../js/core/redact.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports;
};
const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');
globalThis.pdfjsWorker = loadUmd('js/vendor/pdf.worker.min.js');
const pdfjs = loadUmd('js/vendor/pdf.min.js');
const { PDFName, PDFDict, PDFStream, PDFArray, decodePDFRawStream, PDFRawStream } = PDFLib;

const FIELD = { x: 100, y: 692, width: 200, height: 30 }; // PDF space, bottom-left origin
const PAGE = [612, 792];

async function sourceBytes() {
  const src = await PDFLib.PDFDocument.create();
  const form = src.getForm();
  for (let i = 0; i < 2; i++) {
    const p = src.addPage(PAGE);
    const f = form.createTextField(`nama${i}`);
    f.setText('BUDI SALAH TULIS');
    f.addToPage(p, FIELD);
  }
  const p0 = src.getPages()[0];
  const ctx = src.context;
  // Everything below but the far stamp sits UNDER the cover (PDF x 90..310,
  // y 682..732, see exportWithCoverOnPage0).
  // A link: interaction, no paint. Must survive.
  const link = ctx.register(ctx.obj({
    Type: 'Annot', Subtype: 'Link', Rect: [95, 685, 140, 700], Border: [0, 0, 0],
    A: { S: 'URI', URI: PDFLib.PDFString.of('https://example.com') },
  }));
  // A Hidden stamp WITH an appearance: pdf.js does not paint it, so neither may we.
  const hidden = withAp(ctx, 'Stamp', [200, 690, 240, 720], '0 0 1 rg', { F: 2 });
  // A square with its comment window: once the square is paint, the window
  // would point at nothing, so it goes with it.
  const squareAp = ctx.register(ctx.stream('0 1 0 RG 1 w 0.5 0.5 39 39 re S', {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 40, 40],
  }));
  const popupRef = ctx.nextRef();
  const square = ctx.register(ctx.obj({
    Type: 'Annot', Subtype: 'Square', Rect: [250, 690, 290, 720], F: 4, AP: { N: squareAp }, Popup: popupRef,
  }));
  ctx.assign(popupRef, ctx.obj({ Type: 'Annot', Subtype: 'Popup', Rect: [400, 600, 550, 700], Parent: square }));
  // Under the cover too, and still never flattened: an attachment (its file
  // would become unreachable) and a sticky note (its comment would be gone).
  const attach = withAp(ctx, 'FileAttachment', [120, 700, 136, 716], '1 1 0 rg', { F: 4 });
  const note = withAp(ctx, 'Text', [140, 700, 156, 716], '0 1 1 rg', { F: 4, Contents: PDFLib.PDFString.of('cek lagi') });
  // The same kind of stamp the cover would flatten, nowhere near the cover.
  const far = withAp(ctx, 'Stamp', [400, 100, 450, 150], '1 0 1 rg', { F: 4 });
  for (const r of [link, hidden, square, popupRef, attach, note, far]) p0.node.lookup(PDFName.of('Annots'), PDFArray).push(r);
  return src.save();
}

// An annotation whose appearance is one solid fill of `rg` over its whole Rect.
function withAp(ctx, subtype, rect, rg, extra = {}) {
  const [w, h] = [rect[2] - rect[0], rect[3] - rect[1]];
  const ap = ctx.register(ctx.stream(`${rg} 0 0 ${w} ${h} re f`, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, w, h] }));
  return ctx.register(ctx.obj({ Type: 'Annot', Subtype: subtype, Rect: rect, AP: { N: ap }, ...extra }));
}

// One page of `size` carrying the annotations `build(ctx)` returns, with an
// optional crop; exported with `userObjects` on it in a page of `view`.
async function exportOnePage({ size = PAGE, crop, view = size, rotation = 0, build, userObjects }) {
  const src = await PDFLib.PDFDocument.create();
  const p = src.addPage(size);
  if (crop) p.setCropBox(...crop);
  p.node.set(PDFName.of('Annots'), src.context.obj(build(src.context)));
  const bytes = await src.save();
  const doc = model.createDoc();
  const source = ops.addSource(doc, model.createSource({ name: 'one.pdf', bytes, numPages: 1 }));
  const page = model.createPage({ source, sourcePageNum: 0, width: view[0], height: view[1], rotation });
  ops.addPages(doc, [page]);
  for (const [type, props] of userObjects) ops.addAnnotation(doc, page.id, model.createAnnotation(type, props));
  const out = await PDFLib.PDFDocument.load(await buildPdfBytes(doc, { PDFLib, fontkit }));
  return out.getPages()[0];
}
const liveStamps = (page) => annotsOf(page).filter((a) => subtype(a) === 'Stamp')
  .map((a) => numbers(a.lookup(PDFName.of('Rect'), PDFArray)).join(','));

async function exportWithCoverOnPage0() {
  const bytes = await sourceBytes();
  const doc = model.createDoc();
  const source = ops.addSource(doc, model.createSource({ name: 'form.pdf', bytes, numPages: 2 }));
  const pages = [0, 1].map((n) => model.createPage({
    source, sourcePageNum: n, width: PAGE[0], height: PAGE[1], rotation: 0,
  }));
  ops.addPages(doc, pages);
  // View space is top-left origin: the field's top edge is at 792 - 722 = 70.
  ops.addAnnotation(doc, pages[0].id, model.createAnnotation('whiteout', {
    x: 90, y: 60, width: 220, height: 50, color: '#ff0000',
  }));
  const out = await PDFLib.PDFDocument.load(await buildPdfBytes(doc, { PDFLib, fontkit }));
  return { out, src: await PDFLib.PDFDocument.load(bytes) };
}

const annotsOf = (page) => {
  const a = page.node.lookup(PDFName.of('Annots'));
  return a instanceof PDFArray ? a.asArray().map((r) => page.doc.context.lookup(r, PDFDict)) : [];
};
const subtype = (a) => a.get(PDFName.of('Subtype'))?.decodeText();
const hasAp = (a) => a.get(PDFName.of('AP')) !== undefined;
// A page pdf-lib never drew on has no /Contents at all, which is "paints nothing".
const contentOf = (page) => (page.node.Contents() ? readPageContents(page, PDFLib) : '');
const numbers = (arr) => arr.asArray().map((n) => n.asNumber());
const streamText = (s) => {
  const u8 = s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents();
  return Array.from(u8, (b) => String.fromCharCode(b)).join('');
};

test('the edited page: the field appearance is painted into the content BEFORE the cover', async () => {
  const { out, src } = await exportWithCoverOnPage0();
  const page = out.getPages()[0];

  const painted = annotsOf(page).filter((a) => subtype(a) === 'Widget' && hasAp(a));
  assert.equal(painted.length, 0, 'a widget left in /Annots is painted by the reader ON TOP of the cover');

  const content = contentOf(page);
  const m = /([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) cm\s*\/(\S+) Do/.exec(content);
  assert.ok(m, `no appearance is drawn in the content at all:\n${content}`);
  // The red cover is the only red fill on the page.
  const cover = content.indexOf('1 0 0 rg');
  assert.ok(cover > m.index, 'the appearance must come before the cover, or the cover is under it');
  // What is drawn is the field's OWN appearance, not a regenerated one.
  const xobj = page.node.Resources().lookup(PDFName.of('XObject'), PDFDict).lookup(PDFName.of(m[7]), PDFStream);
  const srcWidget = annotsOf(src.getPages()[0]).find((a) => subtype(a) === 'Widget');
  const srcAp = srcWidget.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'), PDFStream);
  assert.equal(streamText(xobj), streamText(srcAp));

  // Placement: the cm carries the appearance's BBox corners onto the field's
  // Rect corners (the source's own numbers, so a 0.5pt border inset counts).
  const [a, b, c, d, e, f] = m.slice(1, 7).map(Number);
  const [bx0, by0, bx1, by1] = numbers(srcAp.dict.lookup(PDFName.of('BBox'), PDFArray));
  const [rx0, ry0, rx1, ry1] = numbers(srcWidget.lookup(PDFName.of('Rect'), PDFArray));
  const near = (x, y) => Math.abs(x - y) < 1e-6;
  assert.ok(b === 0 && c === 0, 'an upright field gets no shear or rotation');
  assert.ok(near(a * bx0 + e, rx0) && near(d * by0 + f, ry0), `BBox origin misses the Rect: ${m[0]}`);
  assert.ok(near(a * bx1 + e, rx1) && near(d * by1 + f, ry1), `BBox far corner misses the Rect: ${m[0]}`);
});

test('the edited page keeps its link, leaves a Hidden annotation, and takes a popup with its parent', async () => {
  const { out } = await exportWithCoverOnPage0();
  const page = out.getPages()[0];
  const kinds = annotsOf(page).map(subtype);
  assert.ok(kinds.includes('Link'), `the link is interaction, not paint: ${kinds}`);
  assert.ok(liveStamps(page).includes('200,690,240,720'), `the Hidden stamp stays an annotation: ${kinds}`);
  assert.ok(!contentOf(page).includes('0 0 1 rg'), 'a Hidden appearance was painted');
  assert.ok(!kinds.includes('Square') && !kinds.includes('Popup'), `the square and its window go together: ${kinds}`);
  assert.equal((contentOf(page).match(/ Do\b/g) || []).length, 2, 'the field and the square are both painted');
});

test('the edited page: only what lies under a user object is flattened, and never an attachment or a note', async () => {
  const { out } = await exportWithCoverOnPage0();
  const page = out.getPages()[0];
  const kinds = annotsOf(page).map(subtype);
  assert.ok(liveStamps(page).includes('400,100,450,150'), `a stamp far from the cover was flattened: ${kinds}`);
  assert.ok(kinds.includes('FileAttachment'), `an attachment under the cover lost its file: ${kinds}`);
  assert.ok(kinds.includes('Text'), `a sticky note under the cover lost its comment: ${kinds}`);
  const content = contentOf(page);
  for (const rg of ['1 0 1 rg', '1 1 0 rg', '0 1 1 rg']) {
    assert.ok(!Object.values(xobjectsDrawn(page)).some((s) => s.includes(rg)), `${rg} was painted into the content:\n${content}`);
  }
});

// The streams the page content draws with Do, by resource name.
function xobjectsDrawn(page) {
  const xo = page.node.Resources().lookup(PDFName.of('XObject'));
  const out = {};
  for (const [, name] of contentOf(page).matchAll(/\/(\S+) Do\b/g)) {
    out[name] = streamText(xo.lookup(PDFName.of(name), PDFStream));
  }
  return out;
}

test('a turned page: the overlap is measured where the user drew, not in the unturned frame', async () => {
  // Displayed 792 wide by 612 tall (turned 90). A Tip-Ex at view (10,10,50,50)
  // lands at PDF x 10..60, y 10..60. Read without the turn it would be at
  // y 732..782, which is where the decoy stamp sits.
  const page = await exportOnePage({
    view: [792, 612], rotation: 90,
    build: (ctx) => [
      withAp(ctx, 'Stamp', [15, 15, 55, 55], '0 1 0 rg', { F: 4 }),
      withAp(ctx, 'Stamp', [15, 737, 55, 777], '1 0 1 rg', { F: 4 }),
    ],
    userObjects: [['whiteout', { x: 10, y: 10, width: 50, height: 50, color: '#ff0000' }]],
  });
  assert.deepEqual(liveStamps(page), ['15,737,55,777']);
});

test('a cropped page: the overlap is measured from the crop origin', async () => {
  // Visible box x 100..512, y 100..692. A Tip-Ex at view (10,10,50,50) lands
  // at PDF x 110..160, y 632..682; measured from (0,0) of the MediaBox it would
  // be at x 10..60, y 732..782, where the decoy sits.
  const page = await exportOnePage({
    crop: [100, 100, 412, 592], view: [412, 592],
    build: (ctx) => [
      withAp(ctx, 'Stamp', [115, 640, 155, 675], '0 1 0 rg', { F: 4 }),
      withAp(ctx, 'Stamp', [15, 740, 55, 775], '1 0 1 rg', { F: 4 }),
    ],
    userObjects: [['whiteout', { x: 10, y: 10, width: 50, height: 50, color: '#ff0000' }]],
  });
  assert.deepEqual(liveStamps(page), ['15,740,55,775']);
});

// A 1x1 PNG, enough for drawSignature to embed.
const DOT = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('Teks and TTD count as user objects, each over its own drawn extent', async () => {
  // Text at view (100,70), 16pt, "BUDI BENAR": about PDF x 100..196,
  // y 703..722. A signature at view (300,300,80,40): PDF x 300..380, y 452..492.
  const page = await exportOnePage({
    build: (ctx) => [
      withAp(ctx, 'Stamp', [120, 705, 160, 715], '0 1 0 rg', { F: 4 }),
      withAp(ctx, 'Stamp', [320, 460, 360, 480], '0 1 0 rg', { F: 4 }),
      withAp(ctx, 'Stamp', [120, 600, 160, 640], '1 0 1 rg', { F: 4 }),
    ],
    userObjects: [
      ['text', { text: 'BUDI BENAR', x: 100, y: 70, fontSize: 16, color: '#000000', fontFamily: 'Helvetica' }],
      ['signature', { image: DOT, x: 300, y: 300, width: 80, height: 40 }],
    ],
  });
  assert.deepEqual(liveStamps(page), ['120,600,160,640']);
});

test('known-positive: a page with no user objects keeps its field as a live annotation', async () => {
  const { out } = await exportWithCoverOnPage0();
  const page = out.getPages()[1];
  const widgets = annotsOf(page).filter((a) => subtype(a) === 'Widget' && hasAp(a));
  assert.equal(widgets.length, 1);
  assert.ok(!/\bDo\b/.test(contentOf(page)), 'an untouched page was flattened');
  const [x0, y0, x1, y1] = numbers(widgets[0].lookup(PDFName.of('Rect'), PDFArray));
  assert.ok(x0 < FIELD.x + 1 && y0 < FIELD.y + 1 && x1 > FIELD.x + FIELD.width - 1 && y1 > FIELD.y + FIELD.height - 1,
    'the field kept its place');
});

// What a reader paints, asked of pdf.js (it shares no code with the pdf-lib
// writer): every fill colour set on the page as 'r,g,b' (0-255), annotations
// included.
async function fillsPainted(page) {
  const bytes = await page.doc.save();
  const pj = await pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, isEvalSupported: false, verbosity: 0 }).promise;
  const ol = await (await pj.getPage(page.doc.getPages().indexOf(page) + 1)).getOperatorList({ annotationMode: pdfjs.AnnotationMode.ENABLE });
  return ol.fnArray.flatMap((fn, i) => (fn === pdfjs.OPS.setFillRGBColor ? [Array.from(ol.argsArray[i]).join(',')] : []));
}

test('an appearance stream without /Subtype /Form still paints once it is page content', async () => {
  // Readers paint an annotation's /AP without asking its /Subtype, so such a
  // stamp shows; a content Do of it does not (pdf.js: "XObject should have a
  // Name subtype"), and the stamp vanished from the file under the first fix.
  const page = await exportOnePage({
    build: (ctx) => {
      const ap = ctx.register(ctx.stream('0 0.5 0 rg 0 0 40 40 re f', { BBox: [0, 0, 40, 40] }));
      return [ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: [100, 600, 140, 640], F: 4, AP: { N: ap } }))];
    },
    userObjects: [['whiteout', { x: 130, y: 160, width: 40, height: 20, color: '#ff0000' }]],
  });
  const fills = await fillsPainted(page);
  assert.ok(fills.includes('0,128,0'), `the stamp's green is gone from the file: ${fills}`);
  assert.ok(fills.indexOf('0,128,0') < fills.indexOf('255,0,0'), `the stamp must be under the cover: ${fills}`);
});

test("a flattened annotation keeps its own opacity (/CA, /ca)", async () => {
  // A reader applies a live annotation's /CA to its appearance; drawn into the
  // content bare, a translucent highlight would turn opaque and hide the text
  // under it. PDF 1.x /CA covers both stroke and fill; PDF 2.0's /ca, when
  // present, is the fill's own.
  const page = await exportOnePage({
    build: (ctx) => [
      withAp(ctx, 'Square', [100, 600, 140, 640], '0 1 0 rg', { F: 4, CA: 0.3 }),
      withAp(ctx, 'Square', [150, 600, 190, 640], '0 1 0 rg', { F: 4, CA: 0.8, ca: 0.4 }),
      withAp(ctx, 'Square', [200, 600, 240, 640], '0 1 0 rg', { F: 4 }),
    ],
    userObjects: [['whiteout', { x: 90, y: 160, width: 160, height: 20, color: '#ff0000' }]],
  });
  assert.equal(annotsOf(page).length, 0, 'all three lie under the cover');
  const content = contentOf(page);
  const states = page.node.Resources().lookup(PDFName.of('ExtGState'));
  const draws = [...content.matchAll(/q\s+((?:\/(\S+) gs\s+)?)[-\d.\s]+cm\s+\/\S+ Do\s+Q/g)];
  assert.equal(draws.length, 3, `three appearances drawn:\n${content}`);
  const alphaOf = (m) => {
    if (!m[2]) return null;
    const gs = states.lookup(PDFName.of(m[2]), PDFDict);
    return ['CA', 'ca'].map((k) => gs.lookup(PDFName.of(k)).asNumber());
  };
  assert.deepEqual(draws.map(alphaOf), [[0.3, 0.3], [0.8, 0.4], null]);
});
