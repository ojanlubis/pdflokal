/*
 * EXPORT COPIES A SOURCE'S SHARED RESOURCES ONCE, NOT ONCE PER PAGE.
 * ============================================================================
 * buildPdfBytes called newDoc.copyPages(srcDoc, [n]) per page. Each call is a
 * fresh object copier, so a font or logo shared by every page of a Word PDF was
 * written into the output once PER PAGE: a 20-page letter with one Tip-Ex grew
 * from ~20 KB to ~320 KB. The user asked to cover one word and got a file that
 * no longer fits an upload limit (round-3 hunt, 2026-10-10).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
const N = 20;

async function sharedFontSource() {
  const s = await PDFLib.PDFDocument.create();
  s.registerFontkit(fontkit);
  const font = await s.embedFont(fs.readFileSync(path.join(root, 'fonts/ttf/arimo-regular.ttf')), { subset: false });
  for (let i = 0; i < N; i += 1) s.addPage([595, 842]).drawText(`Halaman ${i + 1}`, { x: 50, y: 700, size: 12, font });
  return s.save();
}

function docOf(bytes, order) {
  const doc = model.createDoc();
  const src = ops.addSource(doc, model.createSource({ name: 's.pdf', bytes, numPages: N }));
  ops.addPages(doc, order.map((n) => model.createPage({ source: src, sourcePageNum: n, width: 595, height: 842 })));
  return doc;
}

async function pageCount(bytes) {
  return (await PDFLib.PDFDocument.load(bytes)).getPages().length;
}

test('one Tip-Ex on a 20-page shared-font PDF does not multiply the file', async () => {
  const bytes = await sharedFontSource();
  const doc = docOf(bytes, [...Array(N).keys()]);
  doc.pages[0].annotations.push(model.createAnnotation('whiteout', { x: 10, y: 10, width: 20, height: 20 }));
  const out = await buildPdfBytes(doc, { PDFLib, fontkit });
  assert.equal(await pageCount(out), N, 'VACUITY GUARD: every page was exported');
  assert.ok(bytes.length > 15_000, 'KNOWN-POSITIVE: the shared font is the bulk of the input');
  assert.ok(out.length < bytes.length * 1.5, `input ${bytes.length} B, output ${out.length} B`);
});

test('reordered and repeated pages still export in plan order, each its own page', async () => {
  const bytes = await sharedFontSource();
  const order = [3, 0, 3, 1];
  const doc = docOf(bytes, order);
  doc.pages[2].annotations.push(model.createAnnotation('whiteout', { x: 10, y: 10, width: 20, height: 20 }));
  const out = await buildPdfBytes(doc, { PDFLib, fontkit });
  const d = await PDFLib.PDFDocument.load(out);
  assert.equal(d.getPages().length, order.length);
  // Each page's text names its source page; read it back through the content.
  const labels = d.getPages().map((p) => {
    const c = p.node.Contents();
    const refs = c instanceof PDFLib.PDFArray ? c.asArray() : [c];
    return refs.map((r) => {
      const st = d.context.lookup(r);
      return Buffer.from(PDFLib.decodePDFRawStream(st).decode()).toString('latin1');
    }).join('\n');
  });
  // A repeated page (3 at positions 0 and 2) must be two distinct page objects:
  // the Tip-Ex (a white fill, `1 1 1 rg`) drawn on the second copy must not
  // appear on the first.
  assert.notEqual(d.getPages()[0].ref.toString(), d.getPages()[2].ref.toString());
  assert.match(labels[2], /1 1 1 rg/, 'KNOWN-POSITIVE: the second copy carries the Tip-Ex');
  assert.doesNotMatch(labels[0], /1 1 1 rg/, 'the first copy of the same source page does not');
  // Plan order: pdf-lib names the glyph run per page; the shown string is the
  // label "Halaman n" in Arimo glyph ids, which differ only in the last digit.
  const lastGlyph = labels.map((t) => /<([0-9A-F]+)> Tj/.exec(t)?.[1].slice(-4));
  assert.equal(lastGlyph.filter(Boolean).length, order.length, 'VACUITY GUARD: every page shows its label');
  assert.equal(lastGlyph[0], lastGlyph[2], 'positions 0 and 2 are the same source page');
  assert.deepEqual(new Set(lastGlyph).size, 3, 'three distinct source pages, in the planned slots');
});
