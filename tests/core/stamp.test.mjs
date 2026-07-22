/*
 * core/stamp.js — the font-resolve ladder (spec-edit-rebuild-composite.md,
 * founder-ruled Path B, 2026-07-22, increment 1).
 * ============================================================================
 * Pins resolveStampFont's three outcomes directly (not through
 * planNativeInserts, which tests/core/export-parity.test.mjs and
 * tests/core/page-surgery-edited.test.mjs already exercise end-to-end):
 *   1. undangan-cid.pdf's own Montserrat CID subset covers ordinary Latin
 *      text — rung 1 ('native') fires, no fetch ever attempted.
 *   2. tests/fixtures/nasty/carlito-subset.ttf (the SAME true-subset fixture
 *      tests/core/compose.test.mjs pins — pyftsubset, É/Ñ genuinely absent
 *      from its own glyf/cmap) declines rung 1 on 'É', then resolves via
 *      rung 2 ('clone') once font-decide.js routes its /BaseFont
 *      ("Carlito-Regular-<n>") to the bundled Carlito clone — proven against
 *      the REAL bundled woff2 (fetch stubbed to read it off disk, same
 *      pattern compose.test.mjs uses, so this is a genuine embed+coverage
 *      check, not a mocked short-circuit).
 *   3. The SAME rung-2-eligible case, but with no global fetch (the
 *      headless-node shape a server-side caller would present) — a typed
 *      decline, not a throw.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveStampFont, stampText } from '../../js/core/stamp.js';
import { extractFontMetrics, readPageContents } from '../../js/core/redact.js';
import { walkShowOps } from '../../js/core/text-walk.js';

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
