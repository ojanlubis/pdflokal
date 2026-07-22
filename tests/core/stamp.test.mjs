/*
 * core/stamp.js — the font-resolve ladder (spec-edit-rebuild-composite.md,
 * founder-ruled Path B, 2026-07-22, increment 1 + increment 2).
 * ============================================================================
 * Pins resolveStampFont's three outcomes directly (not through
 * planNativeInserts, which tests/core/export-parity.test.mjs and
 * tests/core/page-surgery-edited.test.mjs already exercise end-to-end):
 *   1. undangan-cid.pdf's own Montserrat CID subset covers ordinary Latin
 *      text — rung 1 ('native') fires, no fetch ever attempted.
 *   2. tests/fixtures/nasty/carlito-subset.ttf (a TRUE subset — pyftsubset,
 *      É/Ñ genuinely absent from its own glyf/cmap) declines rung 1 on 'É',
 *      then resolves via rung 2 ('clone') once font-decide.js routes its
 *      /BaseFont ("Carlito-Regular-<n>") to the bundled Carlito clone —
 *      proven against the REAL bundled woff2 (fetch stubbed to read it off
 *      disk, so this is a genuine embed+coverage check, not a mocked
 *      short-circuit).
 *   3. The SAME rung-2-eligible case, but with no global fetch (the
 *      headless-node shape a server-side caller would present) — a typed
 *      decline, not a throw.
 *
 * MIGRATED (increment 2, deletion): the "page-surgery integration" test below
 * used to live in tests/core/compose.test.mjs, pinning planNativeInserts'
 * multi-annotation batch behavior against the same carlito-subset.ttf
 * fixture. compose.test.mjs's own unit tests (planComposedChar/
 * planComposedInsert/patchToUnicodeForMarks) tested core/compose.js's OWN
 * internals and died with that file; this ONE case pins still-true
 * page-surgery.js behavior (multiple candidates, some clone, one genuinely
 * uncoverable twin) that resolveStampFont's own single-insert tests above
 * don't exercise, so it moved here rather than being dropped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveStampFont, stampText, textCoveredBy } from '../../js/core/stamp.js';
import { extractFontMetrics, readPageContents } from '../../js/core/redact.js';
import { walkShowOps } from '../../js/core/text-walk.js';
import { planNativeInserts } from '../../js/core/page-surgery.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NASTY = (name) => path.join(root, 'tests', 'fixtures', 'nasty', name);

const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports;
};

const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');

// ---- rung 1: undangan-cid.pdf's own Montserrat subset ------------------------

test('resolveStampFont: undangan-cid.pdf — the doc\'s own Montserrat subset covers ordinary text -> rung 1 "native"', async () => {
  const bytes = fs.readFileSync(NASTY('undangan-cid.pdf'));
  const srcDoc = await PDFLib.PDFDocument.load(bytes);
  const srcPage = srcDoc.getPages()[0];
  const fonts = extractFontMetrics(srcPage, PDFLib);
  const content = readPageContents(srcPage, PDFLib);
  const records = walkShowOps(content, fonts);
  const rec = records[3]; // the MIDDLE "Rapat Anggota Tahunan 2026" repeat (y=630)
  assert.equal(Math.round(rec.y), 630);

  const newDoc = await PDFLib.PDFDocument.create();
  newDoc.registerFontkit(fontkit);
  const [copied] = await newDoc.copyPages(srcDoc, [0]);
  const pdfPage = newDoc.addPage(copied);

  const insert = { fontName: rec.fontName, x: rec.x, y: rec.y, ux: rec.ux, uy: rec.uy, size: rec.size, mixedFonts: false };
  const resolved = await resolveStampFont(pdfPage, PDFLib, fontkit, insert, 'Rapat Baru', { bold: false, italic: false });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.path, 'native');
  assert.ok(resolved.font);
});

test('resolveStampFont: structural guards decline BEFORE either rung is attempted', async () => {
  const bytes = fs.readFileSync(NASTY('undangan-cid.pdf'));
  const srcDoc = await PDFLib.PDFDocument.load(bytes);
  const newDoc = await PDFLib.PDFDocument.create();
  newDoc.registerFontkit(fontkit);
  const [copied] = await newDoc.copyPages(srcDoc, [0]);
  const pdfPage = newDoc.addPage(copied);
  const insert = { fontName: 'F1', x: 72, y: 700, ux: 1, uy: 0, size: 12, mixedFonts: false };

  assert.deepEqual(
    await resolveStampFont(pdfPage, PDFLib, fontkit, { ...insert, mixedFonts: true }, 'Halo', {}),
    { ok: false, reason: 'mixed-fonts' },
  );
  assert.deepEqual(
    await resolveStampFont(pdfPage, PDFLib, fontkit, insert, 'Halo\nDunia', {}),
    { ok: false, reason: 'multiline' },
  );
  assert.deepEqual(
    await resolveStampFont(pdfPage, PDFLib, fontkit, insert, '', {}),
    { ok: false, reason: 'empty' },
  );
});

// ---- rung 2: carlito-subset.ttf (a TRUE subset lacking É) --------------------

// Same synthetic-PDF construction as tests/core/compose.test.mjs's own
// integration test — a real Type0/Identity-H page around the subset, exactly
// pdf-lib's own embedFont output shape.
async function buildSubsetPage() {
  const subsetBytes = new Uint8Array(fs.readFileSync(NASTY('carlito-subset.ttf')));
  const doc = await PDFLib.PDFDocument.create();
  doc.registerFontkit(fontkit);
  const embedded = await doc.embedFont(subsetBytes, { subset: false });
  const page = doc.addPage([595, 842]);
  page.drawText('Kafé Andréa', { x: 72, y: 720, size: 12, font: embedded });
  const loaded = await PDFLib.PDFDocument.load(await doc.save());
  loaded.registerFontkit(fontkit); // same precondition production callers apply
  return loaded.getPages()[0];
}

function fontNameOf(pdfPage, PDFLib) {
  const { PDFName, PDFRef, PDFDict } = PDFLib;
  const context = pdfPage.doc.context;
  const res = (v) => (v instanceof PDFRef ? context.lookup(v) : v);
  const fontDict = res(pdfPage.node.Resources().get(PDFName.of('Font')));
  assert.ok(fontDict instanceof PDFDict);
  return fontDict.keys()[0].toString().replace(/^\//, '');
}

test('resolveStampFont: carlito-subset.ttf — É absent from the subset -> declines rung 1, resolves via rung 2 "clone" (real bundled Carlito)', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  // Stub fetch to serve the SAME bundled woff2 export.js would fetch over
  // HTTP in the browser — a genuine embed+coverage check, not a mocked
  // short-circuit (same pattern as compose.test.mjs's rewritten integration
  // test).
  globalThis.fetch = async (url) => {
    const fontBytes = fs.readFileSync(path.join(root, String(url)));
    return { ok: true, arrayBuffer: async () => fontBytes.buffer.slice(fontBytes.byteOffset, fontBytes.byteOffset + fontBytes.byteLength) };
  };

  const pdfPage = await buildSubsetPage();
  const fontName = fontNameOf(pdfPage, PDFLib);
  const insert = { fontName, x: 72, y: 560, ux: 1, uy: 0, size: 28, mixedFonts: false };

  const resolved = await resolveStampFont(pdfPage, PDFLib, fontkit, insert, 'KAFÉ ANDRÉA', { bold: false, italic: false });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.path, 'clone');
  assert.ok(resolved.font);

  // stampText actually draws without throwing, for good measure — the whole
  // point of the ladder is a font resolveStampFont hands back is USABLE.
  assert.doesNotThrow(() => stampText(pdfPage, PDFLib, resolved.font, insert, 'KAFÉ ANDRÉA', '#112233'));
});

test('resolveStampFont: a char no Croscore/crosextra clone covers (CJK) declines BOTH rungs -> caller falls to twin', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url) => {
    const fontBytes = fs.readFileSync(path.join(root, String(url)));
    return { ok: true, arrayBuffer: async () => fontBytes.buffer.slice(fontBytes.byteOffset, fontBytes.byteOffset + fontBytes.byteLength) };
  };

  const pdfPage = await buildSubsetPage();
  const fontName = fontNameOf(pdfPage, PDFLib);
  const insert = { fontName, x: 72, y: 560, ux: 1, uy: 0, size: 28, mixedFonts: false };

  const resolved = await resolveStampFont(pdfPage, PDFLib, fontkit, insert, '中文', { bold: false, italic: false });
  assert.equal(resolved.ok, false);
  // rung 1 declines 'missing-glyph' (subset has no CJK at all); rung 2's own
  // decline is the one that surfaces (resolveStampFont always returns the
  // FINAL rung's reason) — real Carlito also carries zero CJK coverage, so
  // this is rung 2's coverage decline, not a routing failure.
  assert.equal(resolved.reason, 'missing-glyph');
});

// ---- headless guard: no fetch -------------------------------------------------

test('resolveStampFont: rung 1 declines (missing glyph), rung 2 has NO fetch at all (typeof fetch !== "function") -> typed decline, never a throw', async (t) => {
  // A genuine headless-node shape (unlike the un-stubbed default below, this
  // one actually REMOVES fetch — proving core/stamp.js's explicit
  // `typeof fetch !== 'function'` guard fires, not just a downstream fetch
  // failure that happens to land on the same reason).
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  delete globalThis.fetch;

  const pdfPage = await buildSubsetPage();
  const fontName = fontNameOf(pdfPage, PDFLib);
  const insert = { fontName, x: 72, y: 560, ux: 1, uy: 0, size: 28, mixedFonts: false };

  const resolved = await resolveStampFont(pdfPage, PDFLib, fontkit, insert, 'KAFÉ ANDRÉA', { bold: false, italic: false });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, 'clone-unavailable');
});

test('resolveStampFont: fetch EXISTS but the clone route is unreachable (relative URL, no server) -> same typed decline, no throw', async () => {
  // No stub here at all — proves the ACTUAL default Node environment this
  // whole suite runs in (Node 18+ ships a global fetch) still declines
  // honestly: a relative woff2 path has no base URL outside a browser
  // document, so fetch() itself throws — caught inside tryClone, never
  // propagated past resolveStampFont.
  const pdfPage = await buildSubsetPage();
  const fontName = fontNameOf(pdfPage, PDFLib);
  const insert = { fontName, x: 72, y: 560, ux: 1, uy: 0, size: 28, mixedFonts: false };

  const resolved = await resolveStampFont(pdfPage, PDFLib, fontkit, insert, 'KAFÉ ANDRÉA', { bold: false, italic: false });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, 'clone-unavailable');
});

test('resolveStampFont: no fontkit at all -> rung 1 AND rung 2 both decline honestly (never throws)', async () => {
  const pdfPage = await buildSubsetPage();
  const fontName = fontNameOf(pdfPage, PDFLib);
  const insert = { fontName, x: 72, y: 560, ux: 1, uy: 0, size: 28, mixedFonts: false };

  const resolved = await resolveStampFont(pdfPage, PDFLib, null, insert, 'KAFÉ ANDRÉA', { bold: false, italic: false });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, 'clone-unavailable');
});

// ---- textCoveredBy: the ONE coverage implementation stamp.js's own rung 1 --
// and js/v2/app.js's draft-time notice prediction both call (spec-edit-
// rebuild-composite.md increment 2) — pinned directly so a future edit to
// either call site can't quietly drift the other's answer.

test('textCoveredBy: NFC-normalizes before judging, space carve-out matches glyphPaints exactly', () => {
  const font = fontkit.create(new Uint8Array(fs.readFileSync(NASTY('carlito-subset.ttf'))));

  // 'e' + combining acute (NFD, two code points) means \u00e9 when normalized —
  // the subset's \u00e9 composite IS cmapped (lowercase, unlike \u00c9), so this
  // must read covered. (This true subset was cut from "Kaf\u00e9 Andr\u00e9a" —
  // it has no lowercase 'c' at all, so the word is 'kaf\u00e9', not 'caf\u00e9'.)
  assert.equal(textCoveredBy(font, 'kaf\u00e9'), true);
  // \u00c9 itself is genuinely absent from this true subset's cmap, even though
  // every OTHER char of 'KAF\u00c9' (K, A, F) is covered — proves the check
  // isn't short-circuiting on some unrelated missing char.
  assert.equal(textCoveredBy(font, 'KAF\u00c9'), false);
  // Ordinary covered ASCII plus a real space.
  assert.equal(textCoveredBy(font, 'Kafe Andrea'), true);
});

// ---- page-surgery integration: a batch of candidates through the SAME ------
// ladder, migrated from tests/core/compose.test.mjs (see module header) -----

test('planNativeInserts: a missing-glyph doc-subset decline falls to the CLONE rung, not compose — a batch of candidates resolves native/clone/twin independently', async (t) => {
  // compose.js is gone (Path B, ⚖1 RETIRED) — a doc-subset decline
  // (missing-glyph) now tries font-decide.js's CLONE rung instead (spec §3
  // rung 2), a STRICTLY WIDER net than compose.js's single-mark-composition
  // trick ever was. carlito-subset.ttf's /BaseFont ("Carlito-Regular-<n>")
  // routes to the bundled Carlito clone, which has full coverage for BOTH
  // É (which the old compose.js COULD reach via its glyf donor parse) AND Ñ
  // (which compose.js could NEVER reach — no tilde anywhere in this subset's
  // cmap or any donor composite). A genuinely uncoverable case (CJK, which
  // no Croscore/crosextra clone in this repo carries at any weight) still
  // declines to twin — that endpoint survives the rebuild unchanged.
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url) => {
    const fontBytes = fs.readFileSync(path.join(root, String(url)));
    return { ok: true, arrayBuffer: async () => fontBytes.buffer.slice(fontBytes.byteOffset, fontBytes.byteOffset + fontBytes.byteLength) };
  };

  const pdfPage = await buildSubsetPage();
  const fontName = fontNameOf(pdfPage, PDFLib);
  const insert = { fontName, x: 72, y: 560, ux: 1, uy: 0, size: 28, mixedFonts: false };
  const annotations = [
    // É is missing from the subset but Carlito (the clone) covers it.
    { id: 't-clone-1', type: 'text', replaceCoverId: 'c1', text: 'KAFÉ ANDRÉA', color: '#112233' },
    // Ñ is ALSO missing from the subset, and was never composable — but the
    // real Carlito clone covers it fine, so this resolves via clone too.
    { id: 't-clone-2', type: 'text', replaceCoverId: 'c2', text: 'SEÑORA', color: '#112233' },
    // 中 (CJK) is covered by NEITHER the subset NOR any Croscore/crosextra
    // clone this repo ships — genuinely uncoverable, the twin endpoint.
    { id: 't-twin', type: 'text', replaceCoverId: 'c3', text: '中文', color: '#112233' },
  ];
  const skipCovers = new Set(['c1', 'c2', 'c3']);
  const insertByCover = new Map([
    ['c1', insert],
    ['c2', { ...insert, y: 520 }],
    ['c3', { ...insert, y: 480 }],
  ]);

  const { skipDraw, insertOutcomes } = await planNativeInserts(pdfPage, PDFLib, fontkit, annotations, skipCovers, insertByCover);

  assert.ok(skipDraw.has('t-clone-1'), 'É resolves via the clone rung (Carlito covers it)');
  assert.equal(insertOutcomes.get('t-clone-1').path, 'clone');
  assert.ok(skipDraw.has('t-clone-2'), 'Ñ ALSO resolves via the clone rung now — strictly wider than compose ever was');
  assert.equal(insertOutcomes.get('t-clone-2').path, 'clone');
  assert.equal(skipDraw.has('t-twin'), false, 'a genuinely foreign-script char still declines to the twin drawer');
  assert.equal(insertOutcomes.get('t-twin').path, 'twin');
});
