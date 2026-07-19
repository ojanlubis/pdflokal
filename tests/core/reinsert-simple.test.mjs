/*
 * core/reinsert.js — Rung C+ extension: simple /Subtype /TrueType fonts (the
 * WORD SHAPE), not just Type0/Identity-H.
 * ============================================================================
 * Fixture: tests/fixtures/nasty/surat-word.pdf (scripts/gen-fixture-word.mjs)
 * — a real /Subtype /TrueType font (Carlito, embedded via pdf-lib's
 * low-level context API, since embedFont() only ever emits Type0), /Encoding
 * the bare NAME /WinAnsiEncoding, /FirstChar+/Widths computed from the real
 * embedded program. Five lines, one BT...Tm...Tj...ET block each (see the
 * generator's KNOWN Y-COORDS table) — "Nomor: 123/ABC/2026" at x=72,y=720,
 * size=12 is the line every test below edits.
 *
 * Same "load the vendored UMD in the current realm" loader every
 * gen-fixture-*.mjs script and font-style.test.mjs already use.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFontProgram, planNativeInsert, appendNativeText } from '../../js/core/reinsert.js';
import { removeRunsFromPdfPage, readPageContents } from '../../js/core/redact.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports;
};

const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');
const FIXTURE_BYTES = fs.readFileSync(path.join(root, 'tests/fixtures/nasty/surat-word.pdf'));

// A fresh parse per test — pdf-lib dict objects are mutable, and one test
// (the Differences-dict decline) deliberately mutates its font dict, so
// nothing here can share a loaded PDFDocument across tests.
async function loadPage() {
  const doc = await PDFLib.PDFDocument.load(FIXTURE_BYTES);
  return doc.getPages()[0];
}

// The "Nomor: 123/ABC/2026" line's own painted origin (see the generator's
// KNOWN Y-COORDS table) — every test below either reads this run's font via
// this exact insert geometry, or (the end-to-end test) rediscovers it fresh
// via removeRunsFromPdfPage/text-walk.js itself.
const NOMOR_INSERT = {
  fontName: 'F1', fontSize: 12, x: 72, y: 720, ux: 1, uy: 0, size: 12, mixedFonts: false,
};

test('extractFontProgram: simple /Subtype /TrueType font — extracts a real, fontkit-loadable program', async () => {
  const page = await loadPage();
  const extracted = extractFontProgram(page, PDFLib, 'F1');
  assert.equal(extracted.ok, true);
  assert.ok(extracted.bytes.length > 0);

  const font = fontkit.create(extracted.bytes);
  assert.equal(font.hasGlyphForCodePoint('A'.codePointAt(0)), true);
  assert.equal(font.hasGlyphForCodePoint('é'.codePointAt(0)), true);
});

test('planNativeInsert: simple TrueType — parentheses, a non-ASCII WinAnsi char (é), and spaces all encode correctly', async () => {
  const page = await loadPage();
  const plan = planNativeInsert(page, PDFLib, fontkit, {
    insert: NOMOR_INSERT,
    text: 'Info (revisi): café baru',
    color: '#101010',
  });
  assert.equal(plan.ok, true);

  // A literal-string Tj (not a hex-glyph-id TJ run) — this path's whole point.
  assert.match(plan.snippet, /\(Info.*\) Tj/);
  // '(' and ')' are backslash-escaped so they don't prematurely close the
  // literal string.
  assert.ok(plan.snippet.includes('\\(revisi\\)'), 'parentheses must be backslash-escaped');
  // 'é' (U+00E9, WinAnsi byte 0xE9 = 233 decimal = octal 351) is written as
  // the spec's own 1-3 digit octal escape, not a raw multi-byte UTF-8 char.
  assert.ok(plan.snippet.includes('caf\\351'), "'é' must be a \\351 octal escape");
  // Spaces are real 0x20 bytes — no TJ-kern trick on this path (module
  // header) — so plain ASCII words stay separated by literal spaces.
  assert.ok(plan.snippet.includes('caf\\351 baru'), 'spaces must be real bytes, not a kern array');
  assert.equal(typeof plan.width, 'number');
  assert.ok(plan.width > 0);
});

test("planNativeInsert: char outside WinAnsi entirely ('→') declines 'missing-glyph'", async () => {
  const page = await loadPage();
  // '→' (U+2192) has no WinAnsi byte at all (unlike the em dash, which IS in
  // WinAnsi at 0x97) — this must decline before even asking fontkit whether
  // the embedded program has the glyph.
  const plan = planNativeInsert(page, PDFLib, fontkit, {
    insert: NOMOR_INSERT,
    text: 'arah → kanan',
    color: '#000000',
  });
  assert.deepEqual(plan, { ok: false, reason: 'missing-glyph' });
});

test("planNativeInsert: /Encoding as a /Differences dict (not the bare NAME) declines 'unsupported-encoding'", async () => {
  const page = await loadPage();
  const ctx = page.doc.context;
  const resources = page.node.Resources();
  const fontDict = ctx.lookup(resources.get(PDFLib.PDFName.of('Font')));
  const fontObj = ctx.lookup(fontDict.get(PDFLib.PDFName.of('F1')));

  // A synthetic /Differences encoding dict — a real, if unusual, PDF shape:
  // some code(s) remapped away from the base table. This path only trusts
  // the bare NAME /WinAnsiEncoding; anything else (this dict, /MacRomanEncoding,
  // no /Encoding at all) is a byte table we don't know, so it declines rather
  // than guessing the remap doesn't matter.
  const differencesEncoding = ctx.obj({ Type: 'Encoding', Differences: [32, 'space'] });
  fontObj.set(PDFLib.PDFName.of('Encoding'), differencesEncoding);

  const plan = planNativeInsert(page, PDFLib, fontkit, {
    insert: NOMOR_INSERT,
    text: 'Halo',
    color: '#000000',
  });
  assert.deepEqual(plan, { ok: false, reason: 'unsupported-encoding' });
});

test('end-to-end: removeRunsFromPdfPage + appendNativeText — new show op lands, old one is gone', async () => {
  const page = await loadPage();

  // Rediscover the "Nomor: 123/ABC/2026" run the same way the real pipeline
  // does: a target geometry fed to text-walk.js's interpreter walk (via
  // redact.js), not a hand-typed insert. `len` only needs to be a generous
  // upper bound on the run's along-baseline extent — the match is anchored
  // by (x0,y0,ux,uy,size), not by knowing the string's exact painted width.
  const target = {
    x0: 72, y0: 720, ux: 1, uy: 0, size: 12, len: 400,
  };
  const { removed, results } = removeRunsFromPdfPage(page, PDFLib, [target]);
  assert.equal(removed, 1);
  assert.equal(results[0].matched, true);

  const plan = planNativeInsert(page, PDFLib, fontkit, {
    insert: results[0].insert,
    text: 'Nomor: 999/XYZ/2026',
    color: '#000000',
  });
  assert.equal(plan.ok, true);
  appendNativeText(page, PDFLib, plan.snippet);

  const joined = readPageContents(page, PDFLib);
  assert.ok(joined.includes('Nomor: 999/XYZ/2026'), 'new show op must be present');
  assert.ok(!joined.includes('Nomor: 123/ABC/2026'), 'old show op must be gone, not just covered');
  // The untouched lines must survive the surgery on their neighbor.
  assert.ok(joined.includes('Kepada Yth. Bapak/Ibu Warga RT 05'));
  assert.ok(joined.includes('Jakarta, 19 Juli 2026'));
});
