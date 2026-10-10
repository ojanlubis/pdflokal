/*
 * A PDF WHOSE PAGE TREE FORGOT ITS /Type STILL DOWNLOADS WITH THE EDIT IN IT.
 * ============================================================================
 * Some producers write the page-tree nodes without `/Type /Pages` or
 * `/Type /Page`. PDF.js walks the tree by /Kids and does not care, so the file
 * opens, renders and edits normally. pdf-lib decides a node's CLASS from /Type
 * at parse time, so the same file loads "fine" with zero pages, and every
 * rebuild then dies in copyPages ("Cannot read properties of undefined
 * (reading 'node')"). The user does all their work and Unduh can never
 * succeed. Round-1 hunt, 2026-10-11 (rank 15).
 *
 * The fixtures are real pdf-lib files with the /Type entries blanked to
 * spaces, so every xref offset stays valid; only the type is missing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as model from '../../js/core/model.js';
import * as ops from '../../js/core/operations.js';
import { buildPdfBytes } from '../../js/core/export.js';
import { pdfLibLoadError } from '../../js/core/import.js';
import { loadForRebuild, retypePageTree } from '../../js/core/pdflib-load.js';
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

const INHERITED = [500, 700];

// N pages reading "Halo 0", "Halo 1", … . `nested` moves pages 1.. under an
// intermediate /Pages node, so the walk has to tell a tree node from a leaf
// by /Kids, not by position.
async function sourcePdf(n, { nested = false } = {}) {
  const d = await PDFLib.PDFDocument.create();
  for (let i = 0; i < n; i += 1) d.addPage([595, 842]).drawText(`Halo ${i}`, { x: 50, y: 700 });
  if (nested) {
    const rootRef = d.catalog.get(PDFName.of('Pages'));
    const rootNode = d.context.lookup(rootRef);
    const leaves = rootNode.Kids().asArray();
    const midRef = d.context.register(d.context.obj({
      Type: 'Pages', Parent: rootRef, Kids: leaves.slice(1), Count: leaves.length - 1,
    }));
    for (const leaf of leaves.slice(1)) d.context.lookup(leaf).set(PDFName.of('Parent'), midRef);
    rootNode.set(PDFName.of('Kids'), d.context.obj([leaves[0], midRef]));
    rootNode.set(PDFName.of('Count'), PDFNumber.of(n));
    // The page size lives only on the root, so the copy must inherit it up a
    // /Parent chain made of retyped nodes. A walk that misses the tree nodes
    // and only fixes leaves would export the wrong size.
    for (const leaf of leaves) d.context.lookup(leaf).delete(PDFName.of('MediaBox'));
    rootNode.set(PDFName.of('MediaBox'), d.context.obj([0, 0, ...INHERITED]));
  }
  return d.save({ useObjectStreams: false });
}

// Blank `/Type /Pages` (every tree node) and/or `/Type /Page` (every leaf) to
// spaces of the same length. Asserts it actually blanked something, so a
// change in pdf-lib's writer cannot quietly turn this into a well-typed file.
function untype(bytes, { trees, leaves }) {
  let s = Buffer.from(bytes).toString('latin1');
  const blank = (re) => {
    const before = s;
    s = s.replace(re, (m) => ' '.repeat(m.length));
    assert.notEqual(s, before, `VACUITY GUARD: the fixture had ${re} to remove`);
  };
  if (trees) blank(/\/Type \/Pages\b/g);
  if (leaves) blank(/\/Type \/Page\b(?!s)/g);
  return Uint8Array.from(Buffer.from(s, 'latin1'));
}

function docOf(bytes, numPages, [width, height]) {
  const doc = model.createDoc();
  const source = ops.addSource(doc, model.createSource({ name: 'x.pdf', bytes, numPages }));
  const pages = Array.from({ length: numPages }, (_, n) =>
    model.createPage({ source, sourcePageNum: n, width, height, rotation: 0 }));
  ops.addPages(doc, pages);
  return { doc, pages };
}

async function pageTexts(bytes) {
  const pj = await pdfjs.getDocument({ data: bytes.slice(), disableFontFace: true, isEvalSupported: false, verbosity: 0 }).promise;
  const out = [];
  for (let i = 1; i <= pj.numPages; i += 1) {
    const tc = await (await pj.getPage(i)).getTextContent();
    out.push(tc.items.map((it) => it.str).join(' '));
  }
  return out;
}

const CASES = [
  { name: 'tree nodes untyped', n: 2, trees: true, leaves: false },
  { name: 'leaves untyped', n: 2, trees: false, leaves: true },
  { name: 'every node untyped, nested tree', n: 3, trees: true, leaves: true, nested: true },
];

for (const c of CASES) {
  test(`${c.name}: an edited copy downloads with every page, in order, and the edit in it`, async () => {
    const bytes = untype(await sourcePdf(c.n, { nested: c.nested }), c);
    // The premise: PDF.js (the screen) sees every page, so the user can edit it.
    assert.deepEqual(await pageTexts(bytes), Array.from({ length: c.n }, (_, i) => `Halo ${i}`),
      'PDF.js opens the untyped fixture with all its pages');

    const { doc, pages } = docOf(bytes, c.n, c.nested ? INHERITED : [595, 842]);
    ops.addAnnotation(doc, pages[0].id, model.createAnnotation('text', { text: 'Nama Baru', x: 50, y: 50, fontSize: 12 }));
    const out = await buildPdfBytes(doc, { PDFLib, fontkit });

    const texts = await pageTexts(out);
    assert.equal(texts.length, c.n, 'the download has every page');
    assert.match(texts[0], /Nama Baru/, 'the edit is in the download');
    assert.match(texts[0], /Halo 0/, 'page 1 kept its own content');
    for (let i = 1; i < c.n; i += 1) assert.equal(texts[i], `Halo ${i}`, `page ${i + 1} is the source page ${i + 1}`);
    if (c.nested) {
      const pj = await pdfjs.getDocument({ data: out.slice(), verbosity: 0 }).promise;
      for (let i = 1; i <= c.n; i += 1) {
        assert.deepEqual((await pj.getPage(i)).view, [0, 0, ...INHERITED], `page ${i} kept the size it inherited`);
      }
    }
  });

  test(`${c.name}: the rebuild load sees every page, and the merge guard agrees`, async () => {
    const bytes = untype(await sourcePdf(c.n, { nested: c.nested }), c);
    const d = await loadForRebuild(PDFLib, bytes);
    assert.equal(d.getPageCount(), c.n);
    assert.equal(await pdfLibLoadError(PDFLib, bytes), null);
  });
}

test('a well-typed file is left alone: the repair touches nothing', async () => {
  const d = await PDFLib.PDFDocument.load(await sourcePdf(3, { nested: true }));
  const before = d.getPages().map((p) => p.node);
  assert.equal(retypePageTree(PDFLib, d), 0, 'no node needed retyping');
  assert.deepEqual(d.getPages().map((p) => p.node), before, 'the same page objects as before');
});

test('the repair writes /Type back, so the rebuilt file is well-formed', async () => {
  const bytes = untype(await sourcePdf(3, { nested: true }), { trees: true, leaves: true });
  const d = await PDFLib.PDFDocument.load(bytes);
  assert.ok(!(d.catalog.Pages() instanceof PDFLib.PDFPageTree), 'VACUITY GUARD: raw pdf-lib cannot walk this tree');
  assert.equal(retypePageTree(PDFLib, d), 5, 'two tree nodes and three leaves retyped');
  assert.equal(d.catalog.Pages().get(PDFName.of('Type')), PDFName.of('Pages'));
  assert.equal(d.getPageCount(), 3);
  for (const p of d.getPages()) assert.equal(p.node.get(PDFName.of('Type')), PDFName.of('Page'));
});

test('a repair after pdf-lib already counted the pages is not hidden by its page cache', async () => {
  const bytes = untype(await sourcePdf(3, { nested: true }), { trees: false, leaves: true });
  const d = await PDFLib.PDFDocument.load(bytes);
  assert.equal(d.getPageCount(), 0, 'VACUITY GUARD: raw pdf-lib counts no pages, and caches that');
  assert.equal(retypePageTree(PDFLib, d), 3);
  assert.equal(d.getPageCount(), 3);
  assert.equal(d.getPages().length, 3);
});

// The guard runs the rebuild's own load AND walks the tree, so a page tree the
// repair cannot save is declined at import, not discovered at Unduh.
test('the merge guard declines a page tree pdf-lib still cannot walk', async () => {
  let s = Buffer.from(await sourcePdf(2)).toString('latin1');
  assert.ok(s.includes('/Kids'), 'VACUITY GUARD: the fixture has /Kids to break');
  s = s.replace('/Kids', '/Kidz'); // same length: every xref offset stays valid
  const bytes = Uint8Array.from(Buffer.from(s, 'latin1'));
  assert.notEqual(await pdfLibLoadError(PDFLib, bytes), null);
});

// The edit preview bakes from its OWN pdf-lib load (v2/edit-bake.js
// getDryRunDoc), not the exporter's. If that load skipped the repair, the
// screen would bake an untyped file's edit over nothing while Unduh worked.
// Driven through the real createEditBake, so reverting its call site to a raw
// PDFDocument.load goes red here.
test('the edit preview loads through the same repair as the export', async () => {
  const bytes = untype(await sourcePdf(3, { nested: true }), { trees: true, leaves: true });
  const { doc } = docOf(bytes, 3, INHERITED);
  const bake = createEditBake({
    getDoc: () => doc, getSlots: () => new Map(), getRasterizer: () => null,
    rasterScaleFor: () => 1, tel: () => {}, getSentry: () => null,
  });
  const dry = await bake.getDryRunDoc(PDFLib, doc.sources[0]);
  assert.equal(dry.getPageCount(), 3, 'the preview sees every page');
});

// A /Kids entry that is the page dict ITSELF rather than a reference to it.
// The spec says kids are indirect; some producers inline one anyway. PDF.js
// walks it like any other kid, so the screen shows every page. pdf-lib's
// page list either skips it (untyped: every later page shifts down one, and
// the download silently carries the WRONG page) or throws (typed: PDFPage
// needs a ref). Measured by the round-1 review: pages [0,1] of an all-untyped
// 3-page file downloaded as "Halo 0", "Halo 2".
async function directKidPdf({ keepType }) {
  const d = await PDFLib.PDFDocument.create();
  for (let i = 0; i < 3; i += 1) d.addPage([595, 842]).drawText(`Halo ${i}`, { x: 50, y: 700 });
  const rootNode = d.context.lookup(d.catalog.get(PDFName.of('Pages')));
  const kids = rootNode.Kids().asArray();
  const inlined = d.context.obj({});
  for (const [k, v] of d.context.lookup(kids[1]).entries()) inlined.set(k, v);
  if (!keepType) inlined.delete(PDFName.of('Type'));
  rootNode.set(PDFName.of('Kids'), d.context.obj([kids[0], inlined, kids[2]]));
  return d.save({ useObjectStreams: false });
}

const DIRECT_CASES = [
  { name: 'every leaf untyped, the middle one inlined', make: async () => untype(await directKidPdf({ keepType: true }), { trees: false, leaves: true }) },
  { name: 'only the inlined middle leaf untyped', make: () => directKidPdf({ keepType: false }) },
  { name: 'the inlined middle leaf typed', make: () => directKidPdf({ keepType: true }) },
];

for (const c of DIRECT_CASES) {
  test(`${c.name}: the download carries the pages the screen showed, not their neighbours`, async () => {
    const bytes = await c.make();
    assert.deepEqual(await pageTexts(bytes), ['Halo 0', 'Halo 1', 'Halo 2'], 'PDF.js opens it with all three pages');

    const { doc, pages } = docOf(bytes, 3, [595, 842]);
    ops.removePage(doc, pages[2].id);
    ops.addAnnotation(doc, pages[0].id, model.createAnnotation('text', { text: 'Nama Baru', x: 50, y: 50, fontSize: 12 }));
    const texts = await pageTexts(await buildPdfBytes(doc, { PDFLib, fontkit }));
    assert.equal(texts.length, 2);
    assert.match(texts[0], /Halo 0/);
    assert.match(texts[0], /Nama Baru/);
    assert.equal(texts[1], 'Halo 1', 'page 2 is source page 2, not source page 3');

    assert.equal((await loadForRebuild(PDFLib, bytes)).getPageCount(), 3, 'pdf-lib sees the same three pages');
  });
}
