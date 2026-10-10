/*
 * A PAGE THE USER REMOVED IS NOT INSIDE THE DOWNLOAD, AND INTERNAL LINKS LAND.
 * ============================================================================
 * buildPdfBytes copies each kept page with pdf-lib's copyPages. Its object
 * copier follows EVERY reference out of the page, and a page reference is just
 * another reference: a TOC link's /Dest, an annotation's /P, a form widget's
 * /Parent -> field /Kids -> sibling widget /P. Each one pulled the target page
 * across as an orphan object, and save() writes every object it holds, linked
 * or not. Extracting 2 of 40 pages of a skripsi with a linked TOC shipped all
 * 40 (81 KB without links, 1.6 MB with; round-1 hunt, 2026-10-11). The same
 * mechanism left every link in a rebuilt file pointing at an orphan copy
 * instead of the output page.
 *
 * Markers live in the page DICTS and are read back through the parser, never
 * by grepping bytes: the output uses object streams, so a grep proves nothing
 * (bank: strings-cannot-read-a-pdf).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import * as model from '../../js/core/model.js';
import * as ops from '../../js/core/operations.js';
import { buildPdfBytes } from '../../js/core/export.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports;
};
const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');
const { PDFName, PDFString, PDFDict, PDFArray, PDFRef } = PDFLib;
const N = 5;
const MARK = PDFName.of('PLMark');

// N pages, each dict carrying its own marker H1..H5; page 5 also carries a
// 100 KB incompressible blob so a leak shows in the size too.
async function source({ links = 'none', annotP = false, form = false } = {}) {
  const s = await PDFLib.PDFDocument.create();
  const pages = [];
  for (let i = 0; i < N; i += 1) {
    const p = s.addPage([595, 842]);
    p.node.set(MARK, PDFString.of(`H${i + 1}`));
    p.drawText(`Halaman ${i + 1}`, { x: 50, y: 700, size: 12 });
    pages.push(p);
  }
  pages[N - 1].node.setXObject(PDFName.of('Blob'), s.context.register(s.context.flateStream(crypto.randomBytes(100_000))));
  const annots = [];
  if (links !== 'none') {
    for (let i = 1; i < N; i += 1) {
      const dest = [pages[i].ref, PDFName.of('XYZ'), 0, 842, 0];
      const link = links === 'dest'
        ? { Type: 'Annot', Subtype: 'Link', Rect: [50, 600 - i * 20, 300, 615 - i * 20], Border: [0, 0, 0], Dest: dest }
        : { Type: 'Annot', Subtype: 'Link', Rect: [50, 600 - i * 20, 300, 615 - i * 20], Border: [0, 0, 0], A: { S: 'GoTo', D: dest } };
      annots.push(s.context.register(s.context.obj(link)));
    }
  }
  if (annotP) {
    annots.push(s.context.register(s.context.obj({ Type: 'Annot', Subtype: 'Square', Rect: [0, 0, 10, 10], P: pages[0].ref })));
  }
  if (annots.length) pages[0].node.set(PDFName.of('Annots'), s.context.obj(annots));
  if (form) {
    const field = s.getForm().createTextField('nama');
    field.setText('Budi Santoso');
    field.addToPage(pages[0], { x: 10, y: 10 });
    field.addToPage(pages[1], { x: 10, y: 10 });
    // Mark the sibling widget on page 2: it must not ship either, since it
    // carries page 2's own appearance of the field.
    const w2 = s.context.lookup(pages[1].node.Annots().get(0));
    w2.set(MARK, PDFString.of('W2'));
  }
  return s.save();
}

function docOf(bytes, order) {
  const doc = model.createDoc();
  const src = ops.addSource(doc, model.createSource({ name: 's.pdf', bytes, numPages: N }));
  ops.addPages(doc, order.map((n) => model.createPage({ source: src, sourcePageNum: n, width: 595, height: 842 })));
  return doc;
}

async function exportOf(bytes, order, edit) {
  const doc = docOf(bytes, order);
  if (edit) edit(doc);
  const out = await buildPdfBytes(doc, { PDFLib, fontkit });
  return { out, d: await PDFLib.PDFDocument.load(out) };
}

// Every marker held by ANY indirect object in the output, reachable or not.
function markers(d) {
  return d.context.enumerateIndirectObjects()
    .map(([, o]) => (o instanceof PDFDict ? o.get(MARK) : null))
    .filter(Boolean)
    .map((m) => m.decodeText())
    .sort();
}

function linkTargets(d) {
  const out = [];
  for (const page of d.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (const ref of annots.asArray()) {
      const a = d.context.lookup(ref, PDFDict);
      if (a.get(PDFName.of('Subtype'))?.toString() !== '/Link') continue;
      const dest = a.lookup(PDFName.of('Dest')) || a.lookup(PDFName.of('A'), PDFDict)?.lookup(PDFName.of('D'));
      out.push(dest instanceof PDFArray ? dest.get(0) : dest);
    }
  }
  return out;
}

for (const kind of ['dest', 'goto']) {
  test(`extracting 2 of 5 pages with a linked TOC (${kind}) ships only those 2 pages`, async () => {
    const bytes = await source({ links: kind });
    const { out, d } = await exportOf(bytes, [0, 1]);
    assert.equal(d.getPageCount(), 2, 'VACUITY GUARD: the two kept pages exported');
    assert.deepEqual(markers(d), ['H1', 'H2'], 'no page the user did not keep is inside the file');
    assert.ok(out.length < bytes.length * 0.6, `source ${bytes.length} B, extract ${out.length} B`);
    // The link to page 2 survives and lands on output page 2; links to the
    // pages that were not kept are gone rather than pointing nowhere.
    const targets = linkTargets(d);
    assert.equal(targets.length, 1, `one surviving link, got ${targets.length}`);
    assert.equal(targets[0].toString(), d.getPages()[1].ref.toString());
  });

  test(`every internal link (${kind}) in a rebuilt, reordered document lands on an output page`, async () => {
    const bytes = await source({ links: kind });
    const order = [4, 3, 2, 1, 0];
    const { d } = await exportOf(bytes, order, (doc) => {
      doc.pages[4].annotations.push(model.createAnnotation('whiteout', { x: 400, y: 10, width: 20, height: 20 }));
    });
    assert.deepEqual(markers(d), ['H1', 'H2', 'H3', 'H4', 'H5'], 'each page exactly once, no orphan copies');
    const outRefs = d.getPages().map((p) => p.ref.toString());
    const targets = linkTargets(d);
    assert.equal(targets.length, N - 1, 'KNOWN-POSITIVE: all four links still present');
    // Source page i (i = 1..4) is at output position order.indexOf(i).
    targets.forEach((t, k) => {
      assert.ok(t instanceof PDFRef, `link ${k} target is a page ref, got ${t}`);
      assert.equal(t.toString(), outRefs[order.indexOf(k + 1)], `link ${k} lands on its page`);
    });
  });
}

test('an annotation /P back to its own page does not copy that page a second time', async () => {
  const bytes = await source({ annotP: true });
  const { d } = await exportOf(bytes, [0]);
  assert.deepEqual(markers(d), ['H1']);
  const sq = d.getPages()[0].node.Annots().asArray().map((r) => d.context.lookup(r, PDFDict))
    .find((a) => a.get(PDFName.of('Subtype'))?.toString() === '/Square');
  assert.ok(sq, 'KNOWN-POSITIVE: the annotation itself still ships');
  assert.equal(sq.get(PDFName.of('P')).toString(), d.getPages()[0].ref.toString(), '/P names the output page');
});

test('a form field shared with a page the user did not keep does not drag that page (or its widget) in', async () => {
  const bytes = await source({ form: true });
  const { d } = await exportOf(bytes, [0]);
  assert.deepEqual(markers(d), ['H1'], 'neither page 2 nor its widget of the shared field is inside the file');
  const widgets = d.getPages()[0].node.Annots().asArray().map((r) => d.context.lookup(r, PDFDict))
    .filter((a) => a.get(PDFName.of('Subtype'))?.toString() === '/Widget');
  assert.equal(widgets.length, 1, 'KNOWN-POSITIVE: the kept page keeps its widget');
  assert.ok(widgets[0].lookup(PDFName.of('AP')), 'and its appearance');
  assert.equal(widgets[0].lookup(PDFName.of('V'))?.decodeText?.(), 'Budi Santoso', 'and the field value it shows');
});

test('a form field whose widgets are all on kept pages keeps its structure', async () => {
  const bytes = await source({ form: true });
  const { d } = await exportOf(bytes, [0, 1]);
  assert.deepEqual(markers(d), ['H1', 'H2', 'W2']);
  const parents = d.getPages().map((p) => {
    const w = p.node.Annots().asArray().map((r) => d.context.lookup(r, PDFDict))
      .find((a) => a.get(PDFName.of('Subtype'))?.toString() === '/Widget');
    return w.get(PDFName.of('Parent'))?.toString();
  });
  assert.ok(parents[0], 'the widget still belongs to its field');
  assert.equal(parents[0], parents[1], 'both widgets still share one field');
});
