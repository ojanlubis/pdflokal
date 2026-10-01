/*
 * The line's font decision travels: annotation → edit signature → stamp →
 * export (edit font design slice 1c/1d).
 * ============================================================================
 * The editor decides ONE font per line (core/line-font.js) and the committed
 * Ganti annotation carries it as `fontDecision`. These tests pin that every
 * module downstream honours that one decision instead of re-deciding:
 *
 *   - editSignature changes when only the decision changes, or a changed
 *     decision would never re-bake (B1);
 *   - the stamp FOLLOWS the decision on a line whose runs use two font
 *     resources — the old `mixed-fonts` refusal sent it to the twin; his
 *     answer 1 (one font for the whole line, the bold word un-bolds) makes
 *     that refusal obsolete for a decided line;
 *   - a decision the document refuses (re-verify fails) falls to the old
 *     ladder and says so (decided_live:false);
 *   - export draws a declined edit in the decided font, not Helvetica.
 *
 * Fixture: built here with pdf-lib from the repo's own TTFs — a bold
 * Montserrat run and a wider regular Carlito run on ONE baseline (the
 * page-surgery-mixedfonts.test.mjs shape, but TTF, so the doc programs pass
 * the stamp's sfnt gate and a native decision is genuinely possible).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as model from '../../js/core/model.js';
import * as ops from '../../js/core/operations.js';
import { applyPageSurgery, editSignature } from '../../js/core/page-surgery.js';
import { buildPdfBytes } from '../../js/core/export.js';
import { extractFontMetrics, readPageContents } from '../../js/core/redact.js';
import { walkShowOps } from '../../js/core/text-walk.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports;
};
const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');

// The stamp fetches bundled faces by URL; serve them off disk (the real bytes).
async function withDiskFetch(fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => new Response(fs.readFileSync(path.join(root, String(url))));
  try { return await fn(); } finally { globalThis.fetch = real; }
}

const SIZE = 12;
const Y = 700;

async function buildMixedLine() {
  const d = await PDFLib.PDFDocument.create();
  d.registerFontkit(fontkit);
  const bold = await d.embedFont(new Uint8Array(fs.readFileSync(path.join(root, 'fonts/ttf/montserrat-bold.ttf'))));
  const regular = await d.embedFont(new Uint8Array(fs.readFileSync(path.join(root, 'fonts/ttf/carlito-regular.ttf'))));
  const page = d.addPage([595, 842]);
  page.drawText('Nama : ', { x: 72, y: Y, size: SIZE, font: bold });
  page.drawText('Budi Santoso dari Bandung', { x: 72 + bold.widthOfTextAtSize('Nama : ', SIZE), y: Y, size: SIZE, font: regular });
  const bytes = await d.save();
  const srcDoc = await PDFLib.PDFDocument.load(bytes);
  const srcPage = srcDoc.getPages()[0];
  const records = walkShowOps(readPageContents(srcPage, PDFLib), extractFontMetrics(srcPage, PDFLib))
    .filter((r) => r.tokens.some((t) => t.t === 'str'));
  assert.equal(records.length, 2, 'two runs on the line');
  assert.notEqual(records[0].fontName, records[1].fontName, 'two different font RESOURCES — the mixed-fonts shape');
  const targets = records.map((r) => ({ x0: r.x, y0: r.y, ux: r.ux, uy: r.uy, len: r.advanceText ?? 0, size: r.size }));
  return { bytes, srcDoc, boldKey: records[0].fontName, regularKey: records[1].fontName, targets };
}

function modelWithEdit(fixture, textProps) {
  const doc = model.createDoc();
  const source = ops.addSource(doc, model.createSource({ name: 'mixed', bytes: fixture.bytes, numPages: 1 }));
  const page = model.createPage({ source, sourcePageNum: 0, width: 595, height: 842, rotation: 0 });
  ops.addPages(doc, [page]);
  const box = { x: 72, y: 842 - Y - SIZE, w: 300, h: 20 };
  const cover = ops.addAnnotation(doc, page.id, model.createAnnotation('whiteout', {
    x: box.x, y: box.y, width: box.w, height: box.h, replaceTargets: fixture.targets, replaceBox: box,
  }));
  const text = ops.addAnnotation(doc, page.id, model.createAnnotation('text', {
    x: box.x, y: box.y, text: 'Nama : Siti Rahayu', fontFamily: 'Helvetica', fontSize: SIZE, color: '#000000',
    replaceCoverId: cover.id, ...textProps,
  }));
  return { doc, page, cover, text };
}

const nativeDecision = (key) => ({
  v: 1, path: 'native', key, css: 'pdflokal-doc-x', uncovered: 0, lineKey: key,
  ladder: [{ path: 'native', key, css: 'pdflokal-doc-x' }, { path: 'clone', face: 'Carlito', evidence: 'name' }],
});

async function surgery(fixture, annotations) {
  const newDoc = await PDFLib.PDFDocument.create();
  newDoc.registerFontkit(fontkit);
  const [copied] = await newDoc.copyPages(fixture.srcDoc, [0]);
  const pdfPage = newDoc.addPage(copied);
  return applyPageSurgery(pdfPage, PDFLib, fontkit, annotations);
}

test('stamp FOLLOWS a native decision on a two-resource line — no mixed-fonts refusal, the dominant run\'s own font', async () => {
  const fx = await buildMixedLine();
  const { page, text } = modelWithEdit(fx, { fontDecision: nativeDecision(fx.regularKey) });
  const r = await surgery(fx, page.annotations);
  assert.equal(r.skipDraw.has(text.id), true, 'the decided line BAKES instead of falling to the twin');
  const out = r.insertOutcomes.get(text.id);
  assert.equal(out.path, 'native');
  assert.equal(out.reason, 'clean');
  assert.equal(out.decision, 'native');
  assert.equal(out.decided_live, true);
});

test('stamp FOLLOWS a clone decision — the bundled face the editor painted, path clone', async () => {
  const fx = await buildMixedLine();
  const decision = { v: 1, path: 'clone', face: 'Carlito', css: 'pdflokal-face-Carlito', uncovered: 0, ladder: [] };
  const { page, text } = modelWithEdit(fx, { fontDecision: decision });
  const r = await withDiskFetch(() => surgery(fx, page.annotations));
  const out = r.insertOutcomes.get(text.id);
  assert.equal(out.path, 'clone');
  assert.equal(out.decision, 'clone');
  assert.equal(out.decided_live, true);
});

test('a decision the document REFUSES falls to the old ladder and says so (decided_live:false)', async () => {
  const fx = await buildMixedLine();
  // A resource that is not on this page: the re-verify cannot load it.
  const { page, text } = modelWithEdit(fx, { fontDecision: nativeDecision('NoSuchFont') });
  const r = await surgery(fx, page.annotations);
  const out = r.insertOutcomes.get(text.id);
  assert.equal(r.skipDraw.has(text.id), false);
  assert.equal(out.path, 'twin');
  assert.equal(out.reason, 'mixed-fonts', 'the old guard applies once the decision is gone');
  assert.equal(out.decided_live, false);
});

test('editSignature: a changed decision with the SAME text is a changed signature (it must re-bake)', async () => {
  const fx = await buildMixedLine();
  const a = modelWithEdit(fx, { fontDecision: nativeDecision(fx.regularKey) });
  const b = modelWithEdit(fx, { fontDecision: { v: 1, path: 'clone', face: 'Carlito', uncovered: 0, ladder: [] } });
  // Same ids are not guaranteed across the two models, so compare each
  // signature with its own decision swapped out.
  const sigA = editSignature(a.page);
  a.text.fontDecision = b.text.fontDecision;
  assert.notEqual(editSignature(a.page), sigA);
  assert.match(sigA, /"fontDecision":\{"v":1,"path":"native"/);
});

test('export: a Ganti edit whose surgery DECLINED is drawn in the decided font, not Helvetica', async () => {
  const fx = await buildMixedLine();
  const decision = { v: 1, path: 'clone', face: 'Carlito', css: 'pdflokal-face-Carlito', uncovered: 0, ladder: [] };
  // Targets that match nothing on the page → surgery no-match → the cover
  // and its text are drawn by export's annotation drawers.
  const fxNoMatch = { ...fx, targets: [{ x0: 400, y0: 100, ux: 1, uy: 0, len: 50, size: 30 }] };
  const { doc } = modelWithEdit(fxNoMatch, { fontDecision: decision });
  const bytes = await withDiskFetch(() => buildPdfBytes(doc, { PDFLib, fontkit }));
  const out = await PDFLib.PDFDocument.load(bytes);
  const outPage = out.getPages()[0];
  const fontDict = outPage.node.Resources().lookup(PDFLib.PDFName.of('Font'));
  const baseFonts = fontDict.keys().map((k) => String(fontDict.lookup(k).lookup(PDFLib.PDFName.of('BaseFont'))));
  assert.equal(baseFonts.some((b) => /Helvetica/.test(b)), false, `no Helvetica: ${baseFonts.join(', ')}`);
  // The source page already carries Carlito (the regular run); the decided
  // face adds ONE more Carlito program, embedded by export.
  const before = (await PDFLib.PDFDocument.load(fx.bytes)).getPages()[0].node.Resources()
    .lookup(PDFLib.PDFName.of('Font')).keys().length;
  assert.equal(fontDict.keys().length, before + 1);
  assert.equal(baseFonts.filter((b) => /Carlito/.test(b)).length, 2);
});
