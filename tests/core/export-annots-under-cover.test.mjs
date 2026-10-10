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
  // A link: interaction, no paint. Must survive.
  const link = ctx.register(ctx.obj({
    Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 60, 30], Border: [0, 0, 0],
    A: { S: 'URI', URI: PDFLib.PDFString.of('https://example.com') },
  }));
  // A Hidden stamp WITH an appearance: pdf.js does not paint it, so neither may we.
  const hiddenAp = ctx.register(ctx.stream('0 0 1 rg 0 0 50 50 re f', {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 50, 50],
  }));
  const hidden = ctx.register(ctx.obj({
    Type: 'Annot', Subtype: 'Stamp', Rect: [400, 100, 450, 150], F: 2, AP: { N: hiddenAp },
  }));
  // A square with its comment window: once the square is paint, the window
  // would point at nothing, so it goes with it.
  const squareAp = ctx.register(ctx.stream('0 1 0 RG 1 w 0.5 0.5 39 39 re S', {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 40, 40],
  }));
  const popupRef = ctx.nextRef();
  const square = ctx.register(ctx.obj({
    Type: 'Annot', Subtype: 'Square', Rect: [200, 300, 240, 340], AP: { N: squareAp }, Popup: popupRef,
  }));
  ctx.assign(popupRef, ctx.obj({ Type: 'Annot', Subtype: 'Popup', Rect: [250, 300, 400, 400], Parent: square }));
  for (const r of [link, hidden, square, popupRef]) p0.node.lookup(PDFName.of('Annots'), PDFArray).push(r);
  return src.save();
}

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
  assert.ok(kinds.includes('Stamp'), `the Hidden stamp stays an annotation: ${kinds}`);
  assert.ok(!contentOf(page).includes('0 0 1 rg'), 'a Hidden appearance was painted');
  assert.ok(!kinds.includes('Square') && !kinds.includes('Popup'), `the square and its window go together: ${kinds}`);
  assert.equal((contentOf(page).match(/ Do\b/g) || []).length, 2, 'the field and the square are both painted');
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
