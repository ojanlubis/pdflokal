/*
 * page-surgery-edited.test.mjs — the editor's per-page pipeline
 * (spec-live-surgery.md §3/§4, increment 2 of /goal).
 * ============================================================================
 * export-parity.test.mjs already pins buildPdfBytes' WHOLE-document behavior
 * through core/page-surgery.js's extracted runSurgery/planNativeInserts. This
 * suite pins the SECOND caller increment 2 adds: buildEditedPageBytes, which
 * builds exactly ONE page's edited bytes (the editor's live re-render at
 * commit time) instead of a whole document, and editSignature, the memo key
 * the rasterizer's edited-page cache (core/import.js) uses to know whether a
 * page's edit set actually changed.
 *
 * Same nasty fixture + geometry export-parity.test.mjs already pins:
 * undangan-cid.pdf's "Rapat Anggota Tahunan 2026" repeats at PDF y=660/630/
 * 600 (each its own Montserrat CID/Identity-H subset font instance) — the
 * MIDDLE (y=630, walkShowOps record index 3) is the target, native re-insert
 * should succeed (own font, single line, no mixed fonts).
 *
 * Doc-model construction mirrors export-parity.test.mjs's
 * buildDocFromFixture/deriveTarget/addGantiPair: model.js/operations.js
 * directly (no import.js/pdf.js needed), self-consistent target geometry
 * DERIVED from the fixture's own content stream via text-walk.js's
 * walkShowOps rather than hand-computed numbers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as model from '../../js/core/model.js';
import * as ops from '../../js/core/operations.js';
import { buildEditedPageBytes, editSignature } from '../../js/core/page-surgery.js';
import { extractFontMetrics, readPageContents } from '../../js/core/redact.js';
import { walkShowOps } from '../../js/core/text-walk.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NASTY = (name) => path.join(root, 'tests', 'fixtures', 'nasty', name);
const FIXTURE = 'undangan-cid.pdf';

// Same "load the vendored UMD in the current realm" loader as
// tests/core/export-parity.test.mjs / tests/core/font-style.test.mjs.
const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports;
};

async function buildDocFromFixture(PDFLib, fixtureName) {
  const bytes = fs.readFileSync(NASTY(fixtureName));
  const srcPdfDoc = await PDFLib.PDFDocument.load(bytes);
  const srcPage = srcPdfDoc.getPages()[0];
  const { width, height } = srcPage.getSize();

  const doc = model.createDoc();
  const source = ops.addSource(doc, model.createSource({ name: fixtureName, bytes, numPages: 1 }));
  const page = model.createPage({ source, sourcePageNum: 0, width, height, rotation: 0 });
  ops.addPages(doc, [page]);
  return { doc, page, srcPage, bytes };
}

// Same self-consistency discipline as export-parity.test.mjs's deriveTarget:
// the target's x0/y0/ux/uy/size come from the run's OWN observed geometry.
function deriveTarget(srcPage, PDFLib, recIndex) {
  const fonts = extractFontMetrics(srcPage, PDFLib);
  const content = readPageContents(srcPage, PDFLib);
  const records = walkShowOps(content, fonts);
  const rec = records[recIndex];
  const target = { x0: rec.x, y0: rec.y, ux: rec.ux, uy: rec.uy, size: rec.size, len: 300 };
  return { rec, target, content, records };
}

// The "ganti" pair: a whiteout cover carrying replaceTargets/replaceBox + a
// text annotation carrying replaceCoverId — the exact shape js/v2/app.js's
// smartReplace/openTextEditor commit path produces, and the exact input
// shape buildEditedPageBytes expects via `page.annotations`.
function addGantiPair(doc, page, target, replacementText) {
  const rect = { x: 0, y: 0, width: 10, height: 10 };
  const cover = model.createAnnotation('whiteout', {
    x: rect.x, y: rect.y, width: rect.width, height: rect.height,
    replaceTargets: [target],
    replaceBox: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
  });
  ops.addAnnotation(doc, page.id, cover);
  const text = model.createAnnotation('text', {
    x: 0, y: 0, width: 200, height: 20,
    text: replacementText, fontFamily: 'Helvetica', fontSize: 12, color: '#000000',
    replaceCoverId: cover.id,
  });
  ops.addAnnotation(doc, page.id, text);
  return { cover, text };
}

test('buildEditedPageBytes: undangan-cid.pdf — target line surgically cut + natively re-inserted; applied/declined sets correct', async () => {
  const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
  const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');

  const { doc, page, srcPage, bytes } = await buildDocFromFixture(PDFLib, FIXTURE);
  // records[3] is the MIDDLE "Rapat Anggota Tahunan 2026" repeat (y=630) —
  // same occurrence export-parity.test.mjs pins and rung-c-native.spec.js's
  // `nth: 1` targets.
  const { rec, target, content: origContent, records } = deriveTarget(srcPage, PDFLib, 3);
  assert.equal(Math.round(rec.y), 630);
  const untouched = [records[2], records[4]]; // y=660 and y=600 — must survive verbatim

  const { cover, text } = addGantiPair(doc, page, target, 'Rapat Baru');
  assert.notEqual(editSignature(page), ''); // a page carrying a committed edit has a non-empty signature

  const srcDoc = await PDFLib.PDFDocument.load(bytes);
  const result = await buildEditedPageBytes(srcDoc, page, page.annotations, { PDFLib, fontkit });

  assert.ok(result.bytes, 'expected edited bytes when the edit applied');
  assert.deepEqual(result.declined, []);
  assert.ok(result.applied.has(cover.id), 'surgery should have succeeded for the cover');
  assert.ok(result.applied.has(text.id), 'the replacement should have been written natively');

  // Telemetry outcomes contract (spec-telemetry.md §3): one per candidate edit,
  // carrying the surgery + insert reasons app.js fires the events from.
  assert.equal(result.outcomes.length, 1);
  assert.deepEqual(result.outcomes[0].surgery, { matched: true, reason: 'clean' });
  assert.deepEqual(result.outcomes[0].insert, { path: 'native', reason: 'clean' });

  const outPdfDoc = await PDFLib.PDFDocument.load(result.bytes);
  assert.equal(outPdfDoc.getPageCount(), 1); // a single-page doc, not the whole document
  const outPage = outPdfDoc.getPages()[0];
  const outContent = readPageContents(outPage, PDFLib);
  const outFonts = extractFontMetrics(outPage, PDFLib);
  const outRecords = walkShowOps(outContent, outFonts);

  // The target line's own show-op is truly gone (no string token survives at
  // the removed run's exact x/y/fontName).
  const stillThere = outRecords.find(
    (r) => Math.round(r.x) === Math.round(rec.x) && Math.round(r.y) === Math.round(rec.y) && r.fontName === rec.fontName,
  );
  assert.equal(stillThere ? stillThere.tokens.some((tok) => tok.t === 'str') : false, false);

  // The native insert landed with the removed run's own resource font.
  assert.ok(outContent.includes(`/${rec.fontName} 1 Tf`));

  // The two untouched repeats survive verbatim — surgery only cut the one
  // tapped occurrence.
  for (const u of untouched) {
    assert.ok(outContent.includes(origContent.slice(u.start, u.end)), `expected untouched run at y=${Math.round(u.y)} to survive`);
  }
});

test('buildEditedPageBytes: a target that matches nothing declines — declined carries the cover, bytes null when nothing else applied', async () => {
  const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
  const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');

  const { doc, page, bytes } = await buildDocFromFixture(PDFLib, FIXTURE);
  const emptyTarget = { x0: 10, y0: 10, ux: 1, uy: 0, len: 50, size: 12 };
  const { cover } = addGantiPair(doc, page, emptyTarget, 'Ganti Gagal');

  const srcDoc = await PDFLib.PDFDocument.load(bytes);
  const result = await buildEditedPageBytes(srcDoc, page, page.annotations, { PDFLib, fontkit });

  assert.equal(result.bytes, null);
  assert.deepEqual(result.declined, [cover.id]);
  assert.equal(result.applied.size, 0);

  // Telemetry outcomes exist EVEN when nothing applied (bytes null) — a
  // fully-declined edit is exactly the signal worth capturing. Surgery found
  // no match; the native insert was never attempted, so insert is null.
  assert.equal(result.outcomes.length, 1);
  assert.deepEqual(result.outcomes[0].surgery, { matched: false, reason: 'no-match' });
  assert.equal(result.outcomes[0].insert, null);
});

test('editSignature: empty with no edits, stable across identical edits, changes when the replacement text changes', async () => {
  const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');

  const { doc, page } = await buildDocFromFixture(PDFLib, FIXTURE);
  assert.equal(editSignature(page), ''); // no committed edits yet

  const target = { x0: 100, y0: 100, ux: 1, uy: 0, len: 50, size: 12 };
  addGantiPair(doc, page, target, 'Halo');

  const sig1 = editSignature(page);
  assert.notEqual(sig1, '');
  const sig1Again = editSignature(page);
  assert.equal(sig1, sig1Again); // same edits, same string

  const { doc: doc2, page: page2 } = await buildDocFromFixture(PDFLib, FIXTURE);
  addGantiPair(doc2, page2, target, 'Beda'); // same target geometry, different replacement text
  const sig2 = editSignature(page2);
  assert.notEqual(sig2, sig1);
});
