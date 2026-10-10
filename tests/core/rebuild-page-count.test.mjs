/*
 * WHEN THE TWO PARSERS DISAGREE ON THE PAGES, THE REBUILD SAYS SO.
 * ============================================================================
 * PDF.js (the screen) and pdf-lib (the download) each build their own page
 * list from the file. When those lists differ, page N on screen is not page N
 * in pdf-lib, and copyPages hands back a NEIGHBOUR: the download looks fine
 * and carries the wrong page. Measured here with a nested tree whose middle
 * node's /Count lies: PDF.js trusts the /Count and shows "Halo 0", "Halo 2";
 * pdf-lib walks /Kids and lists all three, so the screen's page 2 downloaded
 * as "Halo 1", with no error anywhere.
 *
 * No repair can say which list is right, so every rebuild load compares
 * pdf-lib's page count with PDF.js's (Source.numPages, set by importPdf) and
 * refuses a disagreement through the existing failure path: loud, classified
 * `corrupt`, never a wrong page. A merge meets the same check at import.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as model from '../../js/core/model.js';
import * as ops from '../../js/core/operations.js';
import { buildPdfBytes } from '../../js/core/export.js';
import { importPdf, pdfLibLoadError } from '../../js/core/import.js';
import { failureReason, failureCause } from '../../js/core/failure-reason.js';
import { createEditBake } from '../../js/v2/edit-bake.js';

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
const { PDFName, PDFNumber } = PDFLib;

// Three pages; the first two under a middle /Pages node. `midCount` is that
// node's /Count and `rootCount` the root's: 2 and 3 tell the truth, 1 and 2
// make PDF.js skip the middle node's second leaf.
async function nestedPdf({ midCount, rootCount }) {
  const d = await PDFLib.PDFDocument.create();
  for (let i = 0; i < 3; i += 1) d.addPage([595, 842]).drawText(`Halo ${i}`, { x: 50, y: 700 });
  const rootRef = d.catalog.get(PDFName.of('Pages'));
  const rootNode = d.context.lookup(rootRef);
  const leaves = rootNode.Kids().asArray();
  const midRef = d.context.register(d.context.obj({
    Type: 'Pages', Parent: rootRef, Kids: leaves.slice(0, 2), Count: midCount,
  }));
  for (const leaf of leaves.slice(0, 2)) d.context.lookup(leaf).set(PDFName.of('Parent'), midRef);
  rootNode.set(PDFName.of('Kids'), d.context.obj([midRef, leaves[2]]));
  rootNode.set(PDFName.of('Count'), PDFNumber.of(rootCount));
  return d.save({ useObjectStreams: false });
}
const lyingPdf = () => nestedPdf({ midCount: 1, rootCount: 2 });
const honestPdf = () => nestedPdf({ midCount: 2, rootCount: 3 });

async function pageTexts(bytes) {
  const pj = await pdfjs.getDocument({ data: bytes.slice(), disableFontFace: true, isEvalSupported: false, verbosity: 0 }).promise;
  const out = [];
  for (let i = 1; i <= pj.numPages; i += 1) {
    const tc = await (await pj.getPage(i)).getTextContent();
    out.push(tc.items.map((it) => it.str).join(' '));
  }
  return out;
}

// The doc as importPdf would build it: one Source, numPages and pages from PDF.js.
async function openedDoc(bytes) {
  const numPages = (await pageTexts(bytes)).length;
  const doc = model.createDoc();
  const source = ops.addSource(doc, model.createSource({ name: 'x.pdf', bytes, numPages }));
  const pages = Array.from({ length: numPages }, (_, n) =>
    model.createPage({ source, sourcePageNum: n, width: 595, height: 842, rotation: 0 }));
  ops.addPages(doc, pages);
  ops.addAnnotation(doc, pages[0].id, model.createAnnotation('text', { text: 'Nama Baru', x: 50, y: 50, fontSize: 12 }));
  return doc;
}

test('premise: PDF.js shows two pages of the lying file, pdf-lib lists three', async () => {
  const bytes = await lyingPdf();
  assert.deepEqual(await pageTexts(bytes), ['Halo 0', 'Halo 2']);
  assert.equal((await PDFLib.PDFDocument.load(bytes)).getPageCount(), 3);
});

test('an edited download of a file the parsers disagree on fails loudly, as corrupt, not with a neighbour page', async () => {
  const doc = await openedDoc(await lyingPdf());
  let out = null;
  let err = null;
  try { out = await buildPdfBytes(doc, { PDFLib, fontkit }); } catch (e) { err = e; }
  assert.equal(out && (await pageTexts(out)).join(' | '), null, 'no download that could carry the wrong page');
  assert.ok(err, 'the export threw');
  assert.equal(failureReason(err), 'corrupt', 'the rail reads it as the existing corrupt bucket');
  assert.equal(failureCause(err).hint, 'parse');
});

test('the edit preview refuses the same file, so the bake falls back to the plain page', async () => {
  const doc = await openedDoc(await lyingPdf());
  const bake = createEditBake({
    getDoc: () => doc, getSlots: () => new Map(), getRasterizer: () => null,
    rasterScaleFor: () => 1, tel: () => {}, getSentry: () => null,
  });
  await assert.rejects(bake.getDryRunDoc(PDFLib, doc.sources[0]), (e) => failureReason(e) === 'corrupt');
});

test('no regression: a nested file whose counts tell the truth still downloads every page', async () => {
  const doc = await openedDoc(await honestPdf());
  const texts = await pageTexts(await buildPdfBytes(doc, { PDFLib, fontkit }));
  assert.equal(texts.length, 3);
  assert.match(texts[0], /Nama Baru/);
  assert.deepEqual(texts.slice(1), ['Halo 1', 'Halo 2']);
});

// THE MERGE GUARD. A merge always rebuilds, so a file the parsers disagree on
// is declined while joining (the existing import/corrupt path in v2/app.js),
// not discovered at Unduh. importPdf hands PDF.js's count to the check before
// the Source joins the doc.
test('the merge guard declines a file whose page count PDF.js and pdf-lib disagree on', async () => {
  const bytes = await lyingPdf();
  assert.equal(await pdfLibLoadError(PDFLib, bytes), null, 'VACUITY GUARD: without a count to compare, pdf-lib loads and walks it');
  const err = await pdfLibLoadError(PDFLib, bytes, 2);
  assert.ok(err, 'declined against PDF.js\'s count');
  assert.equal(failureReason(err), 'corrupt');
  assert.equal(await pdfLibLoadError(PDFLib, await honestPdf(), 3), null, 'an agreeing file passes');
});

test('importPdf runs the check with the real PDF.js count, and a refusal joins nothing', async () => {
  globalThis.window = { pdfjsLib: pdfjs };
  const check = (bytes) => (numPages) => pdfLibLoadError(PDFLib, bytes, numPages);

  const lying = await lyingPdf();
  const doc = model.createDoc();
  await assert.rejects(importPdf(doc, { name: 'x.pdf', bytes: lying, rebuildCheck: check(lying) }),
    (e) => failureReason(e) === 'corrupt');
  assert.equal(doc.sources.length, 0);

  const honest = await honestPdf();
  const pages = await importPdf(doc, { name: 'y.pdf', bytes: honest, rebuildCheck: check(honest) });
  assert.equal(pages.length, 3);
  assert.equal(doc.sources.length, 1);
});
