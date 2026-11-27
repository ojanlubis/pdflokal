/*
 * RATA KIRI / TENGAH / KANAN LANDS IN THE FILE (his ask 2026-11-12).
 * ============================================================================
 * Two paths carry alignment to the download:
 *  - a typed Teks object (`anno.align`): each line sits inside the box its
 *    widest line makes, the way the overlay's text-align paints it
 *    (core/export.js drawText, core/reflow.js alignOffset);
 *  - an Edit paragraph (`anno.block.align`, now also 'center'): its lines sit
 *    inside the paragraph's own box (core/block-edit.js placeBlockLines →
 *    core/reflow.js layoutLines). Exercised here through the declined-stamp
 *    path, which draws through the same placement function the stamp uses.
 *
 * Expected positions come from the file's own measured widths (pdf.js text
 * items), never from our layout code: an export and a test that both call
 * alignOffset would agree with each other while both are wrong.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDoc, createSource, createPage, createAnnotation, _resetIds } from '../../js/core/model.js';
import { addSource, addPages, addAnnotation } from '../../js/core/operations.js';
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

async function blankA4() {
  const d = await PDFLib.PDFDocument.create();
  d.addPage([595, 842]);
  return d.save();
}

function docWith(bytes, props) {
  _resetIds();
  const doc = createDoc();
  const src = addSource(doc, createSource({ name: 'a.pdf', bytes, numPages: 1 }));
  addPages(doc, [createPage({ source: src, sourcePageNum: 0, width: 595, height: 842 })]);
  addAnnotation(doc, doc.pages[0].id, createAnnotation('text', props));
  return doc;
}

// Every painted run, left edge and width in the viewport (same frame as the model).
async function runs(bytes) {
  const pj = await pdfjs.getDocument({ data: bytes, disableFontFace: true, isEvalSupported: false, verbosity: 0 }).promise;
  const pg = await pj.getPage(1);
  const vp = pg.getViewport({ scale: 1 });
  const tc = await pg.getTextContent();
  return tc.items.filter((i) => i.str.trim()).map((i) => {
    const m = pdfjs.Util.transform(vp.transform, i.transform);
    return { str: i.str, x: m[4], y: m[5], w: i.width };
  });
}
// One point of slack: pdf-lib measures a standard font WITH its kerning pairs
// while the drawn run is unkerned, so pdf.js reads a line up to ~0.8pt wider
// (measured: "Pendek" at 12pt). Alignment itself moves lines by tens of points.
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1, `${msg}: ${a} vs ${b}`);

const LONG = 'Baris yang jauh lebih panjang';
const SHORT = 'Pendek';
const teks = (align) => ({
  text: `${LONG}\n${SHORT}`, x: 100, y: 100, fontSize: 18, fontFamily: 'Helvetica', color: '#000000',
  ...(align ? { align } : {}),
});
async function teksLines(align) {
  const r = await runs(await buildPdfBytes(docWith(await blankA4(), teks(align)), { PDFLib, fontkit }));
  const long = r.find((i) => i.str === LONG);
  const short = r.find((i) => i.str === SHORT);
  assert.ok(long && short, 'both lines are in the file');
  assert.ok(long.w > short.w + 50, 'VACUITY GUARD: the lines differ enough in width for alignment to show');
  return { long, short };
}

test('Teks, no align (every text before 2026-11-12): both lines start at the left edge', async () => {
  const { long, short } = await teksLines(undefined);
  near(long.x, 100, 'long line x');
  near(short.x, 100, 'short line x');
});

test('Teks, rata tengah: the short line is centred under the long one', async () => {
  const { long, short } = await teksLines('center');
  near(long.x, 100, 'the widest line keeps the box edge');
  near(short.x + short.w / 2, long.x + long.w / 2, 'centres agree');
});

test('Teks, rata kanan: the right edges agree', async () => {
  const { long, short } = await teksLines('right');
  near(long.x, 100, 'the widest line keeps the box edge');
  near(short.x + short.w, long.x + long.w, 'right edges agree');
});

// A declined Edit paragraph: two lines in a 400-wide box at x = 72.
function blockAnno(align) {
  return {
    text: `${LONG} ${SHORT}`, x: 72, y: 130, fontSize: 12, fontFamily: 'Helvetica', color: '#000000',
    replaceCoverId: 'cover-that-declined',
    block: {
      v: 1, align, indent: 20, width: 400, leading: 14.4, size: 12, origin: { x: 72, y: 700 }, k: 1,
      disp: { x: 72, y: 142 }, srcLines: 2, srcWords: [5, 1], below: null, reflowed: false,
      lines: [{ text: LONG, brk: ' ', hard: false }, { text: SHORT, brk: '', hard: false }],
    },
  };
}
async function blockLines(align) {
  const r = await runs(await buildPdfBytes(docWith(await blankA4(), blockAnno(align)), { PDFLib, fontkit }));
  const long = r.find((i) => i.str === LONG);
  const short = r.find((i) => i.str === SHORT);
  assert.ok(long && short, 'both paragraph lines are in the file');
  return { long, short };
}

test('Edit paragraph, rata kiri (known positive): the indent applies, the second line starts at the box', async () => {
  const { long, short } = await blockLines('left');
  near(long.x, 72 + 20, 'first line indented');
  near(short.x, 72, 'second line at the box edge');
});

test('Edit paragraph, rata tengah: every line centred in the paragraph box, no indent', async () => {
  const { long, short } = await blockLines('center');
  near(long.x + long.w / 2, 72 + 200, 'first line centred');
  near(short.x + short.w / 2, 72 + 200, 'second line centred');
});

test('Edit paragraph, rata kanan: every line flush with the box right edge', async () => {
  const { long, short } = await blockLines('right');
  near(long.x + long.w, 472, 'first line flush right');
  near(short.x + short.w, 472, 'second line flush right');
});
