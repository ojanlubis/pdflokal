/*
 * export-passthrough.test.mjs — an UNTOUCHED document must come back as the
 * bytes it went in as.
 * ============================================================================
 * THE HARM. core/export.js rebuilds every document (copyPages into a fresh
 * PDFDocument, then `newDoc.save`) and there is no incremental-update path
 * anywhere in this stack. A file carrying an Indonesian e-meterai or any PAdES
 * digital signature therefore comes out with its seal broken: the digest was
 * taken over byte offsets in the ORIGINAL file, and a rebuild moves every
 * byte. The visible meterai graphic survives as ordinary page content, so the
 * output LOOKS perfectly stamped and fails verification. Nothing warned
 * anyone. `passThroughSource` is the only real fix — do not rewrite a file
 * nobody changed.
 *
 * THIS IS THE EXPORT PATH, so the discipline is the strict one: every claim
 * below has been shown RED against a reverted export.js, and the negative
 * cases carry more weight than the positive one. A pass-through that engaged
 * too eagerly would silently drop the user's Tip-Ex, their page selection or
 * their rotation — losing work is a far worse failure than rebuilding a file
 * that did not need it. So each negative case asserts BOTH that the output is
 * not the source bytes AND that the change actually landed in the file: "not
 * identical" alone would also be satisfied by garbage.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as model from '../../js/core/model.js';
import * as ops from '../../js/core/operations.js';
import { buildPdfBytes, passThroughSource } from '../../js/core/export.js';
import { readPageContents } from '../../js/core/redact.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIX = (rel) => path.join(root, 'tests', 'fixtures', rel);
// One page, carries a signature dictionary (scripts/gen-fixture-bermeterai.mjs).
const SIGNED = 'nasty/bermeterai.pdf';
// Two pages, ordinary — the fixture the reorder/deselect cases need.
const TWOPAGE = 'sample-2pages.pdf';

const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports;
};
const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');

// Build the model the way core/import.js does — width/height from a
// rotate-honouring viewport (so baseRotation is already baked in),
// baseRotation read off the file — but from pdf-lib, which runs headless.
async function buildDoc(fixture) {
  const bytes = new Uint8Array(fs.readFileSync(FIX(fixture)));
  const src = await PDFLib.PDFDocument.load(bytes);
  const doc = model.createDoc();
  const source = ops.addSource(doc, model.createSource({
    name: fixture, bytes, numPages: src.getPageCount(),
  }));
  const pages = src.getPages().map((srcPage, i) => {
    const { width, height } = srcPage.getSize();
    const base = srcPage.getRotation().angle;
    const swap = Math.abs(base) % 180 !== 0;
    const page = model.createPage({
      source, sourcePageNum: i, width: swap ? height : width, height: swap ? width : height,
    });
    page.baseRotation = base;
    return page;
  });
  ops.addPages(doc, pages);
  return { doc, pages, bytes, source };
}

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

test('an UNTOUCHED document exports BYTE-IDENTICAL — the seal survives because nothing was rewritten', async () => {
  const { doc, bytes } = await buildDoc(SIGNED);
  const out = await buildPdfBytes(doc, { PDFLib, fontkit });

  // The claim the user actually makes: the file I keep is the file I brought.
  // Asserted over the WHOLE array, not a length or a header — a rebuild
  // produces a valid PDF of a similar size with the same first bytes, and
  // every cheaper check would pass against it.
  assert.equal(out.length, bytes.length, 'length differs, so the document was rebuilt');
  assert.ok(same(out, bytes), 'output is not byte-identical to the source');

  // And it is a COPY, not a view onto the Source's own buffer: callers cache
  // these bytes for the life of the sheet.
  assert.notEqual(out.buffer, bytes.buffer);

  // The seal itself, spelled out rather than implied by the byte compare: the
  // signature dictionary is still there, in the clear, where its own
  // /ByteRange says it is.
  const latin1 = Buffer.from(out).toString('latin1');
  assert.match(latin1, /\/ByteRange\s*\[/, 'the signature dictionary did not survive');
  assert.match(latin1, /\/Type\s*\/Sig\b/);
});

test('SIDE BENEFIT: an untouched ENCRYPTED PDF now exports instead of being refused', async () => {
  // pdf-lib has no decryption and throws at PDFDocument.load — but we are no
  // longer asking it to load anything. We decrypt nothing and claim to remove
  // nothing: the bytes handed back are the user's own encrypted file. Built
  // through the model directly, because PDFDocument.load would refuse it.
  const bytes = new Uint8Array(fs.readFileSync(FIX('nasty/terkunci.pdf')));
  const doc = model.createDoc();
  const source = ops.addSource(doc, model.createSource({
    name: 'terkunci.pdf', bytes, numPages: 2, encrypted: true,
  }));
  ops.addPages(doc, [0, 1].map((i) => model.createPage({
    source, sourcePageNum: i, width: 595, height: 842,
  })));

  const out = await buildPdfBytes(doc, { PDFLib, fontkit });
  assert.ok(same(out, bytes), 'the encrypted source did not come back verbatim');
  // Still encrypted. We handed the file back, we did not strip its handler.
  assert.match(Buffer.from(out).toString('latin1'), /\/Filter\s*\/Standard/);
});

// ---- the negative half: one broken condition and the rebuild must return ----
//
// Each case ALSO proves the change reached the file. "Not byte-identical" on
// its own would be satisfied by a corrupted export, which is the failure this
// whole feature is trying not to cause.

test('ONE ANNOTATION and the pass-through is off — the Tip-Ex must reach the file', async () => {
  const { doc, pages, bytes } = await buildDoc(SIGNED);
  ops.addAnnotation(doc, pages[0].id, model.createAnnotation('whiteout', {
    x: 60, y: 80, width: 160, height: 40, color: '#ffffff',
  }));

  assert.equal(passThroughSource(doc), null);
  const out = await buildPdfBytes(doc, { PDFLib, fontkit });
  assert.ok(!same(out, bytes), 'an annotated document was handed back unchanged');
  // …and it LANDED. `!same()` alone would also be satisfied by a corrupted
  // export, which is the very failure this feature exists not to cause. So
  // read the output's content stream and find the Tip-Ex: a white fill
  // (`1 1 1 rg` … `f`) at the transformed origin. 722 is the coordinate
  // contract spelled out — top-left y=80, height 40, on an 842pt page:
  // y_pdf = 842 - 80 - 40. Neither op exists in the source.
  const outDoc = await PDFLib.PDFDocument.load(out);
  const painted = readPageContents(outDoc.getPages()[0], PDFLib);
  const srcDoc = await PDFLib.PDFDocument.load(bytes);
  const before = readPageContents(srcDoc.getPages()[0], PDFLib);
  assert.doesNotMatch(before, /1 1 1 rg/, 'the fixture already paints white, so this assertion proves nothing');
  assert.match(painted, /1 1 1 rg/, 'the whiteout was dropped from the rebuilt page');
  assert.match(painted, /1 0 0 1 60 722 cm/, 'the whiteout did not land where the user put it');
});

test('A DESELECTED PAGE and the pass-through is off — the output must really be shorter', async () => {
  const { doc, bytes } = await buildDoc(TWOPAGE);
  assert.equal(doc.pages.length, 2);
  // The download sheet expresses "page 2 unticked" exactly this way: a subset
  // Doc sharing the sources with a filtered pages array.
  const subset = { sources: doc.sources, pages: [doc.pages[0]], selection: { pageId: null, annotationId: null } };

  assert.equal(passThroughSource(subset), null);
  const out = await buildPdfBytes(subset, { PDFLib, fontkit });
  assert.ok(!same(out, bytes));
  assert.equal((await PDFLib.PDFDocument.load(out)).getPageCount(), 1, 'the deselected page is still in the file');
});

test('A ROTATED PAGE and the pass-through is off — the file must actually turn', async () => {
  const { doc, pages, bytes } = await buildDoc(SIGNED);
  pages[0].rotation = 90;

  assert.equal(passThroughSource(doc), null);
  const out = await buildPdfBytes(doc, { PDFLib, fontkit });
  assert.ok(!same(out, bytes));
  assert.equal((await PDFLib.PDFDocument.load(out)).getPages()[0].getRotation().angle, 90);
});

test('A REORDERED document is off — same pages, and still not the same file', async () => {
  const { doc, bytes } = await buildDoc(TWOPAGE);
  const reordered = {
    sources: doc.sources,
    pages: [doc.pages[1], doc.pages[0]],
    selection: { pageId: null, annotationId: null },
  };
  assert.equal(passThroughSource(reordered), null);
  const out = await buildPdfBytes(reordered, { PDFLib, fontkit });
  assert.ok(!same(out, bytes), 'a reordered document was handed back in its original order');
});

test('TWO SOURCES is off — a merge has nothing to pass through', async () => {
  const a = await buildDoc(SIGNED);
  const b = await buildDoc('nasty/surat-resmi.pdf');
  const merged = {
    sources: [...a.doc.sources, ...b.doc.sources],
    pages: [...a.doc.pages, ...b.doc.pages],
    selection: { pageId: null, annotationId: null },
  };
  assert.equal(passThroughSource(merged), null);
  const out = await buildPdfBytes(merged, { PDFLib, fontkit });
  assert.ok(!same(out, a.bytes));
  assert.equal(
    (await PDFLib.PDFDocument.load(out)).getPageCount(),
    a.doc.pages.length + b.doc.pages.length,
  );
});

test('AN IMAGE PAGE is off — an image source is not a PDF to hand back', async () => {
  // Guarded explicitly rather than left inert: a one-image document has one
  // source and one page covering it, so every other test above would pass.
  const doc = model.createDoc();
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // not a PDF at all
  const source = ops.addSource(doc, model.createSource({ name: 'foto.png', bytes, numPages: 1 }));
  ops.addPages(doc, [model.createPage({
    source, sourcePageNum: 0, width: 100, height: 100, isFromImage: true,
  })]);
  assert.equal(passThroughSource(doc), null);
});
