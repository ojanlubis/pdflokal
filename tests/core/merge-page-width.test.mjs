/*
 * merge-page-width.test.mjs — every page takes the width of the first page.
 * ============================================================================
 * Founder note, 6 Aug 2026: merging files produced ragged pages. His rule, as
 * ruled by the seat on 2026-08-09: on merge, EVERY page takes the width of the
 * first page, image or PDF, each scaled to keep its own aspect ratio. Merge
 * only (2+ contributing sources); a lone document is never reflowed.
 *
 * WHY THIS TEST EXISTS AT ALL, given how obvious the change looks: the export
 * half is not obvious. pdf-lib's scaleContent wraps the page's content in
 * `q <cm> … Q` and keeps writing into that same stream, so the natural
 * "scale the page, then draw the annotations" doubles every annotation
 * coordinate — and a double-scale is exactly the kind of defect that looks
 * fine on the one sample you happen to open. `annotation geometry` below is
 * the guard for that, and it fails in BOTH directions: red if the page is not
 * scaled (pre-change behaviour) and red if an annotation is scaled twice.
 *
 * The two `export:` tests deliberately build their page dims BY HAND rather
 * than calling the normalizer, so they load and run against pre-change code
 * and fail on BEHAVIOUR (wrong page box, annotation in the wrong place) —
 * not on a missing import. `ops` is a namespace import for the same reason:
 * a missing `normalizePageWidths` fails one test loudly instead of taking the
 * file down before anything has been measured.
 *
 * pdf-lib bitstability memory: this pins STRUCTURE and GEOMETRY (page boxes,
 * composed transforms, content-stream identity against the SOURCE page),
 * never raw byte equality of a whole document — same discipline as
 * tests/core/export-parity.test.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as model from '../../js/core/model.js';
import * as ops from '../../js/core/operations.js';
import { buildPdfBytes } from '../../js/core/export.js';
import { readPageContents } from '../../js/core/redact.js';
import { tokenizeOps } from '../../js/core/content-stream.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NASTY = (name) => path.join(root, 'tests', 'fixtures', 'nasty', name);

// Same "load the vendored UMD in the current realm" loader every other core
// test uses — proven against the real pdf-lib/fontkit object shapes.
const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports;
};

// ---- a real PNG, built here ---------------------------------------------------
// There are no image fixtures in tests/fixtures/ and adding binaries to the
// watched tree is discouraged (the gate re-hashes it), so the image sources
// these tests need are synthesised. A solid-colour PNG is enough: every
// assertion here is about the page BOX, never the pixels.
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 0);
  return Buffer.concat([head, data, crc]);
}
function makePng(w, h, [r, g, b] = [200, 60, 60]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: truecolour
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x += 1) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

// ---- content-stream geometry --------------------------------------------------
// Compose the CTM the way a PDF consumer does (q/Q stack + `cm`), so a filled
// path can be read in FINAL page coordinates. This is the only instrument that
// can tell "scaled once" from "scaled twice": both leave the same numbers in
// the stream, and differ only in how many transforms sit above them.
const mul = (m, c) => [
  m[0] * c[0] + m[1] * c[2],
  m[0] * c[1] + m[1] * c[3],
  m[2] * c[0] + m[3] * c[2],
  m[2] * c[1] + m[3] * c[3],
  m[4] * c[0] + m[5] * c[2] + c[4],
  m[4] * c[1] + m[5] * c[3] + c[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

// Device-space bounding boxes of every FILLED path in `content`.
function filledPathBoxes(content) {
  const boxes = [];
  const stack = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  let pts = [];
  const flush = () => {
    if (pts.length) {
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      boxes.push({
        x: Math.min(...xs), y: Math.min(...ys),
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
      });
    }
    pts = [];
  };
  for (const rec of tokenizeOps(content)) {
    const n = rec.tokens.filter((t) => t.t === 'num').map((t) => t.v);
    switch (rec.op) {
      case 'q': stack.push(ctm); break;
      case 'Q': ctm = stack.pop() || [1, 0, 0, 1, 0, 0]; break;
      case 'cm': if (n.length === 6) ctm = mul(n, ctm); break;
      case 'm': case 'l': if (n.length === 2) pts.push(apply(ctm, n[0], n[1])); break;
      case 're': if (n.length === 4) {
        pts.push(apply(ctm, n[0], n[1]), apply(ctm, n[0] + n[2], n[1] + n[3]));
      } break;
      case 'f': case 'F': case 'f*': case 'b': case 'b*': case 'B': case 'B*': flush(); break;
      case 'n': pts = []; break;
      default: break;
    }
  }
  return boxes;
}

// The page's size AS SEEN, i.e. with /Rotate applied — the frame the founder's
// rule is stated in. Fixtures here carry no /Rotate, but reading it rather
// than assuming it is the whole point of the rule.
function displayedSize(pdfPage) {
  const { width, height } = pdfPage.getSize();
  return (pdfPage.getRotation().angle % 180 !== 0) ? { width: height, height: width } : { width, height };
}

const near = (actual, expected, tol, what) =>
  assert.ok(Math.abs(actual - expected) < tol, `${what}: expected ≈${expected}, got ${actual}`);

// ---- doc builders ---------------------------------------------------------------

function pdfSource(doc, name, bytes, numPages = 1) {
  return ops.addSource(doc, model.createSource({ name, bytes, numPages }));
}

// ---- the normalizer ------------------------------------------------------------

test('normalize: DESCENDING PRIORITY — an image first does NOT set the width, the first PDF does', () => {
  // Founder ruling 2026-08-09, verbatim: "no, make it descending priority.
  // width is determined by the first non-image file. then image"
  //
  // This is the case the FIRST implementation got wrong: it anchored on page 1,
  // so a phone photo in front of an A4 contract dragged the contract up to
  // 3024pt (~107cm) wide. The photo must come DOWN to the A4 instead.
  const doc = model.createDoc();
  const photoSrc = pdfSource(doc, 'photo.png', new Uint8Array([1]));
  const pdfSrc = pdfSource(doc, 'kontrak.pdf', new Uint8Array([2]));
  const photo = model.createPage({ source: photoSrc, sourcePageNum: 0, width: 3024, height: 4032, isFromImage: true });
  const a4 = model.createPage({ source: pdfSrc, sourcePageNum: 0, width: 595, height: 842 });
  ops.addPages(doc, [photo, a4]);

  assert.equal(ops.anchorPage(doc.pages).id, a4.id, 'the PDF page is the anchor, not the image in front of it');
  ops.normalizePageWidths(doc);

  // LITERALS FROM THE RULING. 3024 x 4032 is exactly 3:4, so at 595 wide the
  // photo is 595 * 4/3 = 793.333… tall. Not read back from the document.
  near(photo.width, 595, 1e-9, 'the photo comes DOWN to the PDF width');
  near(photo.height, 793.3333333333334, 1e-6, 'photo ratio kept while shrinking');
  near(a4.width, 595, 1e-9, 'the anchor PDF page is untouched');
  near(a4.height, 842, 1e-9, 'the anchor PDF page is untouched');
  near(photo.baseWidth, 3024, 1e-9, 'baseWidth still records what the artifact measured');
});

test('normalize: with NO PDF page at all, the first image sets the width', () => {
  const doc = model.createDoc();
  const a = pdfSource(doc, 'wide.png', new Uint8Array([1]));
  const b = pdfSource(doc, 'tall.png', new Uint8Array([2]));
  const p0 = model.createPage({ source: a, sourcePageNum: 0, width: 1600, height: 400, isFromImage: true });
  const p1 = model.createPage({ source: b, sourcePageNum: 0, width: 400, height: 1600, isFromImage: true });
  ops.addPages(doc, [p0, p1]);

  assert.equal(ops.anchorPage(doc.pages).id, p0.id);
  ops.normalizePageWidths(doc);
  near(p0.width, 1600, 1e-9, 'first image anchors when nothing else can');
  near(p1.width, 1600, 1e-9, 'second image follows it');
  near(p1.height, 6400, 1e-9, '400x1600 at width 1600 is 6400 tall');
});

test('normalize: every page takes the ANCHOR page\'s width, ratio kept, across image and PDF alike', () => {
  const doc = model.createDoc();
  const a = pdfSource(doc, 'a.pdf', new Uint8Array([1]));
  const b = pdfSource(doc, 'wide.png', new Uint8Array([2]));
  const c = pdfSource(doc, 'tall.png', new Uint8Array([3]));
  const p0 = model.createPage({ source: a, sourcePageNum: 0, width: 595, height: 842 });
  const p1 = model.createPage({ source: b, sourcePageNum: 0, width: 1600, height: 400, isFromImage: true });
  const p2 = model.createPage({ source: c, sourcePageNum: 0, width: 400, height: 1600, isFromImage: true });
  ops.addPages(doc, [p0, p1, p2]);
  // Pretend the render layer already drew them — a scaled page must lose its
  // stale raster, an untouched one must keep it.
  for (const p of doc.pages) p.raster = { dataUrl: 'x', width: 1, height: 1, scale: 2 };

  const changed = ops.normalizePageWidths(doc);

  near(p0.width, 595, 1e-9, 'anchor width');
  near(p0.height, 842, 1e-9, 'anchor height');
  for (const p of doc.pages) near(p.width, 595, 1e-9, 'normalised width');
  // Ratio kept: 1600×400 at width 595 is 148.75 tall; 400×1600 is 2380 tall.
  near(p1.height, 148.75, 1e-9, 'wide image height');
  near(p2.height, 2380, 1e-9, 'tall image height');
  // baseWidth/baseHeight are the record of what the artifact measured and must
  // never move — export and the rasterizer recover the scale factor from them.
  near(p1.baseWidth, 1600, 1e-9, 'baseWidth untouched');
  near(p1.baseHeight, 400, 1e-9, 'baseHeight untouched');
  assert.deepEqual(changed.map((p) => p.id), [p1.id, p2.id]);
  assert.notEqual(p0.raster, null, 'the anchor page did not move — its raster is still valid');
  assert.equal(p1.raster, null, 'a scaled page must drop its stale raster');
});

test('normalize: a SINGLE-source document is never reflowed, however ragged it is', () => {
  const doc = model.createDoc();
  const only = pdfSource(doc, 'report.pdf', new Uint8Array([1]), 2);
  const p0 = model.createPage({ source: only, sourcePageNum: 0, width: 595, height: 842 });
  const p1 = model.createPage({ source: only, sourcePageNum: 1, width: 842, height: 595 });
  ops.addPages(doc, [p0, p1]);

  assert.deepEqual(ops.normalizePageWidths(doc), []);
  near(p1.width, 842, 1e-9, 'the landscape page inside one file keeps its own width');
});

test('normalize: the anchor is the DISPLAYED width, so a rotated first page anchors on what is seen', () => {
  const doc = model.createDoc();
  const a = pdfSource(doc, 'a.pdf', new Uint8Array([1]));
  const b = pdfSource(doc, 'b.pdf', new Uint8Array([2]));
  const p0 = model.createPage({ source: a, sourcePageNum: 0, width: 595, height: 842, rotation: 90 });
  const p1 = model.createPage({ source: b, sourcePageNum: 0, width: 595, height: 842 });
  ops.addPages(doc, [p0, p1]);

  ops.normalizePageWidths(doc);
  // Page 0 is displayed 842 wide (rotated), so 842 is the anchor — page 1 must
  // grow to 842 wide, not shrink to 595.
  near(p1.width, 842, 1e-9, 'anchored on the rotated first page\'s displayed width');
  near(p1.height, 842 * (842 / 595), 1e-6, 'ratio kept while growing');
});

// ---- export ----------------------------------------------------------------------

test('export: a copied PDF page carries the NORMALISED box, not its source MediaBox', async () => {
  const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
  const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');
  const bytes = new Uint8Array(fs.readFileSync(NASTY('surat-fragmen.pdf')));
  const probe = await PDFLib.PDFDocument.load(bytes);
  const { width: nativeW, height: nativeH } = probe.getPages()[0].getSize();

  const doc = model.createDoc();
  const src = pdfSource(doc, 'surat-fragmen.pdf', bytes);
  const page = model.createPage({ source: src, sourcePageNum: 0, width: nativeW, height: nativeH });
  ops.addPages(doc, [page]);
  // Hand-set, NOT via the normalizer: this test must run against pre-change
  // code and fail because the exported box is wrong, not because a function
  // is missing.
  page.width = nativeW * 2;
  page.height = nativeH * 2;

  const out = await PDFLib.PDFDocument.load(await buildPdfBytes(doc, { PDFLib, fontkit }));
  const size = displayedSize(out.getPages()[0]);
  near(size.width, nativeW * 2, 0.01, 'exported page width follows the model');
  near(size.height, nativeH * 2, 0.01, 'exported page height follows the model');
});

test('export: annotation geometry on a scaled page is scaled EXACTLY ONCE', async () => {
  const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
  const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');
  const bytes = new Uint8Array(fs.readFileSync(NASTY('surat-fragmen.pdf')));
  const probe = await PDFLib.PDFDocument.load(bytes);
  const { width: nativeW, height: nativeH } = probe.getPages()[0].getSize();
  // This fixture's own content draws ZERO fills (established by
  // tests/core/export-parity.test.mjs's countFillOps discriminator), so the
  // single filled path in the output can only be the whiteout below.
  assert.equal(filledPathBoxes(readPageContents(probe.getPages()[0], PDFLib)).length, 0);

  const doc = model.createDoc();
  const src = pdfSource(doc, 'surat-fragmen.pdf', bytes);
  const page = model.createPage({ source: src, sourcePageNum: 0, width: nativeW, height: nativeH });
  ops.addPages(doc, [page]);
  page.width = nativeW * 2;
  page.height = nativeH * 2;

  // Annotation coordinates live in the page's DISPLAY frame, top-left origin —
  // i.e. the normalised frame, because that is what the editor laid out on.
  const RECT = { x: 100, y: 120, width: 200, height: 50 };
  ops.addAnnotation(doc, page.id, model.createAnnotation('whiteout', { ...RECT }));

  const out = await PDFLib.PDFDocument.load(await buildPdfBytes(doc, { PDFLib, fontkit }));
  const outPage = out.getPages()[0];
  const boxes = filledPathBoxes(readPageContents(outPage, PDFLib));
  assert.equal(boxes.length, 1, 'exactly one filled path — the whiteout');

  const [box] = boxes;
  // ⚠️ EXPECTED HEIGHT IS THE INTENDED ONE (nativeH * 2), never outPage's own.
  // Deriving it from the output makes the assertion self-adjusting: an
  // unscaled page reports the unscaled height and the sum comes out "right",
  // which is exactly how this test passed against pre-change code on its
  // first run. A verifier must not share a parent with the verified.
  const expectedPageH = nativeH * 2;
  // Bottom-left origin: y_pdf = pageHeight - y_top - height, in the SAME
  // normalised units the annotation was authored in.
  near(box.x, RECT.x, 0.05, 'whiteout x');
  near(box.y, expectedPageH - RECT.y - RECT.height, 0.05, 'whiteout y');
  near(box.width, RECT.width, 0.05, 'whiteout width');
  near(box.height, RECT.height, 0.05, 'whiteout height');
});

test('export: an IMAGE page arrives normalised with no rescaling of its own', async () => {
  const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
  const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');

  const doc = model.createDoc();
  const src = pdfSource(doc, 'wide.png', makePng(1600, 400));
  const page = model.createPage({
    source: src, sourcePageNum: 0, width: 1600, height: 400, isFromImage: true,
  });
  ops.addPages(doc, [page]);
  page.width = 595;
  page.height = 148.75;

  const out = await PDFLib.PDFDocument.load(await buildPdfBytes(doc, { PDFLib, fontkit }));
  const size = displayedSize(out.getPages()[0]);
  near(size.width, 595, 0.01, 'image page box width');
  near(size.height, 148.75, 0.01, 'image page box height');
});

test('export: END TO END, a photo in front of an A4 produces an A4-WIDE document, not a metre-wide one', async () => {
  const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
  const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');
  const pdfBytes = new Uint8Array(fs.readFileSync(NASTY('surat-fragmen.pdf')));

  const doc = model.createDoc();
  const photoSrc = pdfSource(doc, 'photo.png', makePng(302, 403)); // 3:4, a phone photo's shape
  const docSrc = pdfSource(doc, 'surat-fragmen.pdf', pdfBytes);
  ops.addPages(doc, [
    model.createPage({ source: photoSrc, sourcePageNum: 0, width: 3024, height: 4032, isFromImage: true }),
    model.createPage({ source: docSrc, sourcePageNum: 0, width: 595, height: 842 }),
  ]);
  ops.normalizePageWidths(doc);

  const out = await PDFLib.PDFDocument.load(await buildPdfBytes(doc, { PDFLib, fontkit }));
  const sizes = out.getPages().map(displayedSize);
  // 595pt is 21.0cm. The pre-ruling behaviour made this document 3024pt
  // (~107cm) wide, which is the whole reason the anchor rule changed.
  near(sizes[0].width, 595, 0.01, 'the photo page exports at A4 width');
  near(sizes[0].height, 793.3333333333334, 0.01, 'photo ratio kept');
  near(sizes[1].width, 595, 0.01, 'the A4 page is untouched');
  near(sizes[1].height, 842, 0.01, 'the A4 page is untouched');
});

test('export: a page at factor 1 is not touched — no wrapper, source content stream verbatim', async () => {
  const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
  const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');
  const bytes = new Uint8Array(fs.readFileSync(NASTY('surat-fragmen.pdf')));
  const probe = await PDFLib.PDFDocument.load(bytes);
  const srcPage = probe.getPages()[0];
  const { width: nativeW, height: nativeH } = srcPage.getSize();

  const doc = model.createDoc();
  const src = pdfSource(doc, 'surat-fragmen.pdf', bytes);
  ops.addPages(doc, [model.createPage({ source: src, sourcePageNum: 0, width: nativeW, height: nativeH })]);

  const out = await PDFLib.PDFDocument.load(await buildPdfBytes(doc, { PDFLib, fontkit }));
  const outPage = out.getPages()[0];
  near(outPage.getSize().width, nativeW, 1e-9, 'box unchanged');
  near(outPage.getSize().height, nativeH, 1e-9, 'box unchanged');
  // The strongest available statement of "this page took the old path": its
  // content stream is the SOURCE page's, character for character. A scale
  // wrapper (`q <cm> … Q`) could not hide from this.
  assert.equal(readPageContents(outPage, PDFLib), readPageContents(srcPage, PDFLib));
});
