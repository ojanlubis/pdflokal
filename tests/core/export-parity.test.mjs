/*
 * export-parity.test.mjs — the refactor pin (spec-live-surgery.md §3/§8.1).
 * ============================================================================
 * core/page-surgery.js was extracted OUT of core/export.js (founder ruling
 * 2026-07-20): runSurgery + planNativeInserts moved, unchanged, into a shared
 * module so a second caller (the editor's live re-render, next increment)
 * can run the exact same pipeline export already runs at download. This test
 * is the parity pin the spec calls for — it proves buildPdfBytes' OBSERVABLE
 * behavior through the refactored path is identical to what it was before
 * the extraction: a matched replace target's show-ops are truly cut from the
 * content stream (not just covered), the cover rectangle is skipped, and the
 * replacement lands either as a NATIVE re-insert (same font resource reused,
 * no new /Font key) or a TWIN draw (a new font resource — the honest fallback
 * when the run's own font can't be proven), matching the fixture's own font
 * shape. If this refactor changed behavior, this test — not the golden
 * Playwright suites — should be the first thing to fail.
 *
 * Pinned against the SAME nasty fixtures + geometry the Playwright suites
 * already pin (tests/rung-c-native.spec.js, tests/ganti-teks-export.spec.js):
 *   - undangan-cid.pdf: "Rapat Anggota Tahunan 2026" repeats at PDF y=660/
 *     630/600 (each its own Montserrat CID/Identity-H subset font instance,
 *     full glyph coverage) — the MIDDLE (y=630) is the target, same
 *     addressing as the Playwright suites' `nth: 1`. Native re-insert should
 *     succeed (own font, single line, no mixed fonts).
 *   - surat-fragmen.pdf: "Nomor: 045/SEK/VII/2026" (Line A, ganti-baris.spec.js's
 *     LINE map index 0) is Helvetica standard-14 (Type1, no embedded font
 *     program) — reinsert.js's v1 scope only covers Type0/Identity-H, so this
 *     is a guaranteed 'unsupported-font' decline; the twin path must still
 *     paint it.
 *
 * Doc-model construction mirrors tests/ganti-teks-export.spec.js's
 * buildTextSourceDoc: model.js/operations.js directly (no import.js/pdf.js
 * needed — buildPdfBytes only reads doc.sources[].bytes + pages +
 * annotations), a whiteout `replaceTargets`/`replaceBox` + text
 * `replaceCoverId` pair (the "ganti" shape), self-consistent target geometry
 * DERIVED from the fixture's own content stream via text-walk.js's
 * walkShowOps (same self-consistency discipline as buildTextSourceDoc) rather
 * than hand-computed numbers.
 *
 * pdf-lib bitstability memory: exports are within-session deterministic only
 * — this pins STRUCTURE/CONTENT (op presence/absence, resource-count deltas,
 * decoded string presence), never raw byte equality, same as
 * tests/core/text-walk.test.mjs's assertions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as model from '../../js/core/model.js';
import * as ops from '../../js/core/operations.js';
import { buildPdfBytes } from '../../js/core/export.js';
import { extractFontMetrics, readPageContents } from '../../js/core/redact.js';
import { walkShowOps } from '../../js/core/text-walk.js';
import { tokenizeOps } from '../../js/core/content-stream.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NASTY = (name) => path.join(root, 'tests', 'fixtures', 'nasty', name);

// Same "load the vendored UMD in the current realm" loader as
// tests/core/font-style.test.mjs — proven against the actual pdf-lib/fontkit
// object shapes, not a hand-rolled mock.
const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports;
};

// ---- doc-model construction (mirrors ganti-teks-export.spec.js's buildTextSourceDoc) ----

async function buildDocFromFixture(PDFLib, fixtureName) {
  const bytes = fs.readFileSync(NASTY(fixtureName));
  const srcPdfDoc = await PDFLib.PDFDocument.load(bytes);
  const srcPage = srcPdfDoc.getPages()[0];
  const { width, height } = srcPage.getSize();

  const doc = model.createDoc();
  const source = ops.addSource(doc, model.createSource({ name: fixtureName, bytes, numPages: 1 }));
  const page = model.createPage({ source, sourcePageNum: 0, width, height, rotation: 0 });
  ops.addPages(doc, [page]);
  return { doc, page, srcPage };
}

// Derive a self-consistent replace target from the fixture's OWN content
// stream at `recIndex` (walkShowOps' natural order) — same self-consistency
// discipline as buildTextSourceDoc: the target's x0/y0/ux/uy/size come from
// the run's OWN observed geometry, so the match is provably correct rather
// than hand-computed. `len` only needs to be generous enough that the run's
// own (zero-offset) position falls inside [−0.35·size, len−ε] — the walk
// doesn't require the EXACT advance to define a valid target, only that the
// target's own painted point matches within tolerance (see text-walk.js's
// planRunRemoval `alongOk`/`sizeOk`/`perp` checks).
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
// smartReplace/openTextEditor commit path produces. The cover's own rect ==
// replaceBox here (100% self-overlap) so overlapsBirthBox's 60% threshold is
// trivially satisfied — this test is about the SURGERY/INSERT pipeline, not
// the birth-box guard (already pinned by ganti-teks-export.spec.js).
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

// Resources -> Font key count — the SAME structural proof
// tests/rung-c-native.spec.js uses: a native re-insert reuses an EXISTING
// font key (count unchanged), a twin draw (drawText -> embedFont) always
// grows it by at least one.
function countFontKeys(PDFLib, pdfPage) {
  const { PDFName, PDFRef, PDFDict } = PDFLib;
  const resources = pdfPage.node.Resources();
  if (!resources) return 0;
  const fontDictRaw = resources.get(PDFName.of('Font'));
  if (!fontDictRaw) return 0;
  const fontDict = fontDictRaw instanceof PDFRef ? pdfPage.doc.context.lookup(fontDictRaw) : fontDictRaw;
  if (!(fontDict instanceof PDFDict)) return 0;
  return fontDict.keys().length;
}

// Same 'f' (fill) discriminator as ganti-teks-export.spec.js's
// countFillOpsHelper: pdf-lib's drawRectangle emits a filled PATH (never the
// PDF 're' operator), and these fixtures' own text-only content draws zero
// fills — so a fill-count delta of 0 proves the cover was SKIPPED (surgery
// succeeded), not drawn as a sampled-color rectangle.
function countFillOps(content) {
  return tokenizeOps(content).filter((op) => op.op === 'f').length;
}

test('export-parity: undangan-cid.pdf — middle repeat surgically cut and NATIVELY re-inserted (own font, no new resource)', async () => {
  const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
  const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');

  const { doc, page, srcPage } = await buildDocFromFixture(PDFLib, 'undangan-cid.pdf');
  // records[2..4] are the three "Rapat Anggota Tahunan 2026" repeats at PDF
  // y=660/630/600 (verified against this fixture) — index 3 is the MIDDLE
  // (y=630), same occurrence tests/rung-c-native.spec.js's `nth: 1` targets.
  const { rec, target, content: origContent, records } = deriveTarget(srcPage, PDFLib, 3);
  assert.equal(Math.round(rec.y), 630);
  const untouched = [records[2], records[4]]; // y=660 and y=600 — must survive verbatim

  addGantiPair(doc, page, target, 'Rapat Baru');

  const origFontCount = countFontKeys(PDFLib, srcPage);
  const origFillCount = countFillOps(origContent);

  const outBytes = await buildPdfBytes(doc, { PDFLib, fontkit });
  const outPdfDoc = await PDFLib.PDFDocument.load(outBytes);
  const outPage = outPdfDoc.getPages()[0];
  const outContent = readPageContents(outPage, PDFLib);
  const outFonts = extractFontMetrics(outPage, PDFLib);
  const outRecords = walkShowOps(outContent, outFonts);

  // 1. The cover was SKIPPED — surgery succeeded, no rectangle drawn.
  assert.equal(countFillOps(outContent), origFillCount);

  // 2. The target's OWN show-op is gone: no record at the removed run's exact
  // (x, y, fontName) still carries a string token — either the op vanished
  // entirely (replacementFor emits nothing when the advance is unknown) or it
  // survives only as a position-preserving kern (a 'TJ' with a bare num
  // token, never the original glyph run).
  const stillThere = outRecords.find(
    (r) => Math.round(r.x) === Math.round(rec.x) && Math.round(r.y) === Math.round(rec.y) && r.fontName === rec.fontName,
  );
  assert.equal(stillThere ? stillThere.tokens.some((t) => t.t === 'str') : false, false);

  // 3. The two UNTOUCHED repeats (y=660, y=600) survive verbatim — surgery
  // only cut the tapped occurrence, not the whole family of identical lines.
  for (const u of untouched) {
    assert.ok(outContent.includes(origContent.slice(u.start, u.end)), `expected untouched run at y=${Math.round(u.y)} to survive`);
  }

  // 4. NATIVE re-insert, not a twin draw: no new /Font resource was added —
  assert.equal(countFontKeys(PDFLib, outPage), origFontCount);
  // — and the replacement was written using the REMOVED run's own resource
  // font name with Tf=1 (reinsert.js folds size into Tm instead — see its
  // module header) — a marker only the native path's snippet ever emits.
  assert.ok(outContent.includes(`/${rec.fontName} 1 Tf`));
});

test('export-parity: surat-fragmen.pdf — Line A surgically cut, falls back to TWIN draw (unsupported font)', async () => {
  const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
  const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');

  const { doc, page, srcPage } = await buildDocFromFixture(PDFLib, 'surat-fragmen.pdf');
  // records[0] is "Nomor: 0..." — the first run of Line A (Helvetica
  // standard-14, no FontFile2/3 at all — verified against this fixture).
  const { rec, target, content: origContent } = deriveTarget(srcPage, PDFLib, 0);
  assert.equal(Math.round(rec.y), 760);
  assert.match(rec.fontName, /^Helvetica-/);

  addGantiPair(doc, page, target, 'Nomor Baru');

  const origFontCount = countFontKeys(PDFLib, srcPage);
  const origFillCount = countFillOps(origContent);

  const outBytes = await buildPdfBytes(doc, { PDFLib, fontkit });
  const outPdfDoc = await PDFLib.PDFDocument.load(outBytes);
  const outPage = outPdfDoc.getPages()[0];
  const outContent = readPageContents(outPage, PDFLib);
  const outFonts = extractFontMetrics(outPage, PDFLib);
  const outRecords = walkShowOps(outContent, outFonts);

  // 1. The cover was still SKIPPED — surgery (Rung B) succeeds independently
  // of whether Rung C (native re-insert) can run: cutting the original ops
  // never depends on the replacement's font being provable.
  assert.equal(countFillOps(outContent), origFillCount);

  // 2. The original run's exact text is gone from the output.
  assert.ok(!outContent.includes(origContent.slice(rec.start, rec.end)));

  // 3. TWIN path, not native: a NEW /Font resource WAS added (drawText ->
  // env.getFont -> embedFont) — the honest fallback since Helvetica
  // standard-14 has no embedded program for reinsert.js to prove coverage
  // against (v1 scope is Type0/Identity-H only).
  assert.ok(countFontKeys(PDFLib, outPage) > origFontCount);

  // 4. The replacement text actually landed — content-stream.js's tokenizer
  // already decodes hex-string operands to raw bytes (single-byte WinAnsi ==
  // ASCII for standard-14 Helvetica), so each str token's `.v` IS the painted
  // text directly; confirm "Nomor Baru" appears somewhere in it.
  const paintedStrings = outRecords.flatMap((r) => r.tokens.filter((t) => t.t === 'str').map((t) => t.v));
  assert.ok(paintedStrings.some((s) => s.includes('Nomor Baru')));
});
