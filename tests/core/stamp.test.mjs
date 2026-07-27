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

  // style_source/glyphShortfall (spec-edit-fidelity-instrumentation.md
  // Increment B): every return now echoes these through — 'none'/0 here
  // since the structural guards decline before either rung (and the
  // fingerprint ladder) ever runs, and the caller passed no styleSource.
  assert.deepEqual(
    await resolveStampFont(pdfPage, PDFLib, fontkit, { ...insert, mixedFonts: true }, 'Halo', {}),
    { ok: false, reason: 'mixed-fonts', styleSource: 'none', glyphShortfall: 0 },
  );
  assert.deepEqual(
    await resolveStampFont(pdfPage, PDFLib, fontkit, insert, 'Halo\nDunia', {}),
    { ok: false, reason: 'multiline', styleSource: 'none', glyphShortfall: 0 },
  );
  assert.deepEqual(
    await resolveStampFont(pdfPage, PDFLib, fontkit, insert, '', {}),
    { ok: false, reason: 'empty', styleSource: 'none', glyphShortfall: 0 },
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

// ---- ACCEPTANCE CASE: org-structure.pdf's "T & PPGA" -> "testingg" --------
// (spec-edit-fidelity-instrumentation.md Increment A, decisions.md 2026-07-23)
//
// F1's own subset (Arial-BoldMT) carries NO lowercase 's' (verified by this
// builder's Step 0 dump) — "testingg" declines rung 1 with 'missing-glyph',
// shortfall 1. The PDF WRAPPER name is uninformative ('CIDFont+F1'), so
// font-decide.js's cloneFamilyFor can't route on it — but tryClone's fallback
// (Increment A) reads the embedded PROGRAM's own name ("Arial-BoldMT")
// through that SAME exact-match table, routing to the REAL bundled Arimo
// family.

function stubCloneFetch(t) {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url) => {
    const fontBytes = fs.readFileSync(path.join(root, String(url)));
    return { ok: true, arrayBuffer: async () => fontBytes.buffer.slice(fontBytes.byteOffset, fontBytes.byteOffset + fontBytes.byteLength) };
  };
}

async function buildOrgStructurePage() {
  const bytes = fs.readFileSync(NASTY('org-structure.pdf'));
  const srcDoc = await PDFLib.PDFDocument.load(bytes);
  const newDoc = await PDFLib.PDFDocument.create();
  newDoc.registerFontkit(fontkit);
  const [copied] = await newDoc.copyPages(srcDoc, [0]);
  const pdfPage = newDoc.addPage(copied);
  return { newDoc, pdfPage };
}

// Re-parses the ACTUAL embedded program that will paint the pixels — proves
// genuinely bold outlines bake, not just a label on an annotation. Finds the
// newly-added font resource by /BaseFont (F1/F2 from the original document
// mention Arial, never Arimo). pdf-lib embeds a custom font as Type0/
// CIDFontType2 (same shape core/doc-fonts.js's extractFontProgram already
// navigates) — the FontDescriptor sits one level down, on the sole
// DescendantFont, not on the wrapper itself.
async function findNewArimoResource(newDoc) {
  const savedBytes = await newDoc.save();
  const reloaded = await PDFLib.PDFDocument.load(savedBytes);
  const outPage = reloaded.getPages()[0];
  const { PDFName, PDFRef, PDFDict, PDFRawStream, decodePDFRawStream } = PDFLib;
  const ctx = outPage.doc.context;
  const res = (v) => (v instanceof PDFRef ? ctx.lookup(v) : v);
  const fontDict = res(outPage.node.Resources().get(PDFName.of('Font')));
  assert.ok(fontDict instanceof PDFDict);

  let newBaseFont = null;
  let newProgramBytes = null;
  for (const key of fontDict.keys()) {
    const fontObj = res(fontDict.get(key));
    const baseFontRaw = fontObj.get(PDFName.of('BaseFont'));
    const baseFont = baseFontRaw ? res(baseFontRaw).toString() : '';
    if (/Arimo/i.test(baseFont)) {
      newBaseFont = baseFont;
      let fdOwner = fontObj;
      const subtypeRaw = fontObj.get(PDFName.of('Subtype'));
      const subtype = subtypeRaw ? res(subtypeRaw) : null;
      if (subtype instanceof PDFName && subtype.toString() === '/Type0') {
        const descendantsRaw = fontObj.get(PDFName.of('DescendantFonts'));
        const descendants = descendantsRaw ? res(descendantsRaw) : null;
        const desc0 = descendants ? res(descendants.asArray()[0]) : null;
        if (desc0) fdOwner = desc0;
      }
      const fdRaw = fdOwner.get(PDFName.of('FontDescriptor'));
      const fd = fdRaw ? res(fdRaw) : null;
      const streamRaw = fd && (fd.get(PDFName.of('FontFile2')) || fd.get(PDFName.of('FontFile3')));
      const stream = streamRaw ? res(streamRaw) : null;
      if (stream instanceof PDFRawStream) newProgramBytes = decodePDFRawStream(stream).decode();
    }
  }
  return { newBaseFont, newProgramBytes };
}

function assertGenuinelyBold(newBaseFont, newProgramBytes) {
  assert.ok(newBaseFont, 'expected a NEW font resource routed to the real bundled Arimo family');
  assert.match(newBaseFont, /Arimo-Bold/i, 'the BOLD weight file specifically, not plain Arimo');
  assert.ok(newProgramBytes, 'expected the embedded program bytes to be readable back out');
  const reparsed = fontkit.create(newProgramBytes);
  assert.match(reparsed.subfamilyName || reparsed.postscriptName, /Bold/i);
  assert.ok(reparsed['OS/2'].usWeightClass >= 600 || (reparsed['OS/2'].fsSelection && reparsed['OS/2'].fsSelection.bold));
}

// style.bold=true / styleSource='program-name' here is what js/v2/app.js's
// resolveFontFingerprint ladder would have decided BEFORE commit (proven
// separately in font-fingerprint.test.mjs) — this test proves stamp.js
// correctly TRUSTS that fast path (no redundant re-parse) and still bakes
// genuinely bold.
test('resolveStampFont: ACCEPTANCE — org-structure.pdf "T & PPGA"->"testingg" — draft-time styleSource resolved (fast path), rung 2 routes the WRAPPER\'S uninformative name via the PROGRAM\'s own name to real bundled Arimo-Bold', async (t) => {
  stubCloneFetch(t);
  const { newDoc, pdfPage } = await buildOrgStructurePage();

  const insert = { fontName: 'F1', x: 72, y: 400, ux: 1, uy: 0, size: 24, mixedFonts: false };
  const style = { bold: true, italic: false, styleSource: 'program-name' };

  const resolved = await resolveStampFont(pdfPage, PDFLib, fontkit, insert, 'testingg', style);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.path, 'clone', 'native declines (no lowercase "s" in the Bold subset) — clone resolves it');
  assert.equal(resolved.styleSource, 'program-name');
  assert.equal(resolved.glyphShortfall, 1, 'exactly one missing glyph: the "s" in "testingg"');

  stampText(pdfPage, PDFLib, resolved.font, insert, 'testingg', '#000000');
  const { newBaseFont, newProgramBytes } = await findNewArimoResource(newDoc);
  assertGenuinelyBold(newBaseFont, newProgramBytes);
});

// ---- CORRECTNESS FIX (founder-flagged 2026-07-26): the LOST-RACE case -----
// js/v2/app.js's prepareDocFont resolves the style/family ladder ASYNC,
// UNAWAITED, at draft-open time — a slow device or a fast typist can commit
// before it lands, leaving the annotation with NO styleSource at all (the
// exact shape page-surgery.js's planNativeInserts produces via
// `anno.styleSource || 'none'` when draft.styleSource never got set). Before
// this fix, tryClone trusted style.bold/italic BLINDLY — on a lost race that
// meant Arimo-REGULAR, baking the founder's exact "T & PPGA" defect right
// back, just one layer down from where it was first diagnosed. This test
// passes style={} (no bold, no styleSource — the race-lost shape) and proves
// stamp.js is now SELF-SUFFICIENT: it resolves the fingerprint fresh, right
// here against the real document, and still bakes bold — the document is the
// one authority, the draft's prediction was only ever a hint.
test('resolveStampFont: CORRECTNESS — org-structure.pdf "T & PPGA"->"testingg" with NO resolved style (lost draft-time race) still bakes bold — stamp.js resolves the fingerprint itself', async (t) => {
  stubCloneFetch(t);
  const { newDoc, pdfPage } = await buildOrgStructurePage();

  const insert = { fontName: 'F1', x: 72, y: 400, ux: 1, uy: 0, size: 24, mixedFonts: false };
  // The exact shape a lost prepareDocFont race produces: bold/italic never
  // set (format-bar defaults, false), styleSource absent entirely.
  const style = {};

  const resolved = await resolveStampFont(pdfPage, PDFLib, fontkit, insert, 'testingg', style);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.path, 'clone');
  // The AUTHORITATIVE answer, resolved fresh inside tryClone against the real
  // document — NOT 'none' (the caller's hint), proving the fix actually ran.
  assert.equal(resolved.styleSource, 'program-name');

  stampText(pdfPage, PDFLib, resolved.font, insert, 'testingg', '#000000');
  const { newBaseFont, newProgramBytes } = await findNewArimoResource(newDoc);
  assertGenuinelyBold(newBaseFont, newProgramBytes);
});

// Sibling case: the DOC's own font-style rung (getFontStyleInfo) already
// resolves without needing the program fingerprint at all — proves the
// "trust info.styleSource when it's not 'none'" branch inside tryClone's
// fresh-resolve path (as distinct from the fontkit-fingerprint branch the
// test above exercises). Uses surat-word.pdf's fully-embedded, INFORMATIVELY
// named Carlito font (fonts/carlito-regular.woff2, per tests/edit-word-doc.
// spec.js) forced through the clone rung by asking for a char it doesn't
// cover, with an uninformative resource name so cloneFamilyFor can't route by
// name and the measured-family bucket has to fire instead.
test('resolveStampFont: CORRECTNESS — lost race, but rung 1 of the STYLE ladder (informative /BaseFont) resolves without ever touching the program fingerprint', async (t) => {
  stubCloneFetch(t);
  const subsetBytes = new Uint8Array(fs.readFileSync(NASTY('carlito-subset.ttf')));
  const doc = await PDFLib.PDFDocument.create();
  doc.registerFontkit(fontkit);
  const embedded = await doc.embedFont(subsetBytes, { subset: false });
  const page = doc.addPage([595, 842]);
  page.drawText('Kafé Andréa', { x: 72, y: 720, size: 12, font: embedded });
  const loaded = await PDFLib.PDFDocument.load(await doc.save());
  loaded.registerFontkit(fontkit);
  const pdfPage = loaded.getPages()[0];
  const fontName = fontNameOf(pdfPage, PDFLib);

  const insert = { fontName, x: 72, y: 560, ux: 1, uy: 0, size: 28, mixedFonts: false };
  const resolved = await resolveStampFont(pdfPage, PDFLib, fontkit, insert, 'KAFÉ ANDRÉA', {});
  assert.equal(resolved.ok, true);
  assert.equal(resolved.path, 'clone'); // É absent from the true subset -> rung 1 (native) declines
  // Carlito's own name (not the doc wrapper — no wrapper informativeness gap
  // here either way, this fixture's /BaseFont IS "Carlito-Regular-<n>",
  // already informative) resolves 'pdf-name', not 'panose'/'os2' — proves the
  // "info.styleSource !== 'none'" branch fired, never touching fontkit at all
  // for the STYLE verdict (bold correctly false: Carlito-Regular).
  assert.equal(resolved.styleSource, 'pdf-name');
});
