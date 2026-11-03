/*
 * Feedback 100536 (desktop, 2026-10-27): a bold SERIF heading "MATA PELAJARAN
 * WAJIB" was replaced in a regular SANS (it looked like Arimo). Rail:
 * font_seen {subtype: truetype, embedded, name_informative: true, bold: false,
 * style_source: pdf-name}, font_path twin.
 *
 * What that rail can and cannot be, read off the code (core/font-fingerprint.js
 * resolveFontFingerprint, core/line-font.js faceLadder):
 *   - name_informative + bold:false + pdf-name = an informative /BaseFont that
 *     does not say Bold (the "silent name" rung 1 treated as authoritative
 *     regular), so the program was never read;
 *   - family stayed null, so faceLadder fell to its DEFAULT face, Arimo, which
 *     is the "sans" the user saw. The name was not one the clone table knows
 *     (Times/Cambria would have routed to Tinos/Caladea, serif).
 * So the bold serif had a name outside the clone table that hides its weight:
 * "BookAntiqua", "Georgia", "Garamond", or a regular font drawn bold.
 *
 * Fixtures are built from the format's own parts: a simple TrueType font dict
 * with a REAL embedded FontFile2 (fonts/ttf), any /BaseFont we like, and raw
 * content operators. The decision is read through the same chain the editor
 * runs (dominantLineFont -> resolveFontFingerprint -> lineFontFacts ->
 * faceLadder), never re-derived here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveFontFingerprint, lineFontFacts } from '../../js/core/font-fingerprint.js';
import { faceLadder } from '../../js/core/line-font.js';
import { dominantLineFont, extractFontMetrics, readPageContents } from '../../js/core/redact.js';
import { walkShowOps } from '../../js/core/text-walk.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports;
};
const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');
const TTF = (name) => fs.readFileSync(path.join(root, 'fonts', 'ttf', `${name}.ttf`));
const HEADING = 'MATA PELAJARAN WAJIB';

// One page, one simple TrueType font /F1 embedding `program`, named `baseFont`,
// and the heading drawn with `drawOps` before the show (e.g. '2 Tr 0.5 w').
async function headingPage({ program, baseFont, drawOps = '', flags = 32 }) {
  const { PDFName } = PDFLib;
  const d = await PDFLib.PDFDocument.create();
  const page = d.addPage([595, 842]);
  const ctx = d.context;
  const parsed = fontkit.create(TTF(program));
  const widths = [];
  for (let c = 32; c <= 126; c++) widths.push(Math.round((parsed.glyphForCodePoint(c).advanceWidth * 1000) / parsed.unitsPerEm));
  const file = ctx.register(ctx.flateStream(TTF(program)));
  const fd = ctx.register(ctx.obj({
    Type: 'FontDescriptor', FontName: baseFont, Flags: flags, FontBBox: [-500, -300, 1500, 1000],
    ItalicAngle: 0, Ascent: 900, Descent: -220, CapHeight: 660, StemV: 80, FontFile2: file,
  }));
  const font = ctx.register(ctx.obj({
    Type: 'Font', Subtype: 'TrueType', BaseFont: baseFont, FirstChar: 32, LastChar: 126,
    Widths: widths, Encoding: 'WinAnsiEncoding', FontDescriptor: fd,
  }));
  page.node.setFontDictionary(PDFName.of('F1'), font);
  const content = `BT ${drawOps} /F1 18 Tf 72 700 Td (${HEADING}) Tj ET`;
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(Uint8Array.from(content, (c) => c.charCodeAt(0)))));
  // Round-trip through bytes, as the app reads a source file.
  const loaded = await PDFLib.PDFDocument.load(await d.save());
  return loaded.getPages()[0];
}

// What the editor decides for the heading line: its first bundled face.
function decide(pdfPage) {
  // The line, shaped as js/v2/text-runs.js hands it over: one run's geometry.
  const [rec] = walkShowOps(readPageContents(pdfPage, PDFLib), extractFontMetrics(pdfPage, PDFLib))
    .filter((r) => r.tokens.some((t) => t.t === 'str'));
  const line = { runs: [{ pdf: { x0: rec.x, y0: rec.y, ux: rec.ux, uy: rec.uy, len: rec.len, size: rec.size } }] };
  const { fontName, mixedFonts, syntheticBold } = dominantLineFont(pdfPage, PDFLib, line);
  assert.equal(fontName, 'F1', 'VACUITY GUARD: the line was matched to its font');
  const fp = lineFontFacts(resolveFontFingerprint(pdfPage, PDFLib, fontkit, fontName), { syntheticBold, mixedFonts });
  return { fp, face: faceLadder(fp)[0]?.face };
}

// ---- the reproductions ------------------------------------------------------

test('a bold serif program behind a silent, unknown name ("BookAntiqua") is written bold serif, not regular Arimo', async () => {
  const { fp, face } = await decide(await headingPage({ program: 'tinos-bold', baseFont: 'ABCDEF+BookAntiqua' }));
  assert.equal(fp.family, 'serif', 'the program\'s PANOSE said serif');
  assert.equal(fp.bold, true, 'the program declares itself bold; the name said nothing');
  assert.equal(face, 'Tinos-Bold');
});

test('a regular serif DRAWN bold (fill+stroke, Word\'s synthetic bold) is written bold serif', async () => {
  // Flags 34 = Serif + Nonsymbolic, as Word writes a serif face. The Tinos
  // Regular program ships an all-zero PANOSE, so the flag is the family here.
  const { fp, face } = await decide(await headingPage({ program: 'tinos-regular', baseFont: 'ABCDEF+BookAntiqua', drawOps: '2 Tr 0.55 w', flags: 34 }));
  assert.equal(fp.styleSource, 'drawn');
  assert.equal(face, 'Tinos-Bold');
});

// ---- not changing what was right ----------------------------------------------

test('control: a correctly named regular serif stays regular serif (TimesNewRomanPSMT -> Tinos regular)', async () => {
  const { fp, face } = await decide(await headingPage({ program: 'tinos-regular', baseFont: 'ABCDEF+TimesNewRomanPSMT' }));
  assert.equal(fp.bold, false);
  assert.equal(face, 'Tinos');
});

test('control: a sans stays sans, by name (ArialMT) and by program under an unknown name (Verdana)', async () => {
  assert.equal((await decide(await headingPage({ program: 'arimo-regular', baseFont: 'ABCDEF+ArialMT' }))).face, 'Arimo');
  const unknown = await decide(await headingPage({ program: 'arimo-regular', baseFont: 'ABCDEF+Verdana' }));
  assert.equal(unknown.fp.family, 'sans');
  assert.equal(unknown.face, 'Arimo');
});

test('control: a name that SAYS a style is never overridden by the program', async () => {
  // A regular program under a name that says Bold: the name was explicit.
  const { fp } = await decide(await headingPage({ program: 'tinos-regular', baseFont: 'ABCDEF+BookAntiqua-Bold' }));
  assert.equal(fp.bold, true);
  assert.equal(fp.styleSource, 'pdf-name');
});

test('control: a hairline or thin stroke, or outline-only text, is not a synthetic bold', async () => {
  for (const drawOps of ['2 Tr 0 w', '2 Tr 0.1 w', '1 Tr 0.8 w']) {
    const { fp, face } = await decide(await headingPage({ program: 'tinos-regular', baseFont: 'ABCDEF+BookAntiqua', drawOps, flags: 34 }));
    assert.equal(fp.bold, false, drawOps);
    assert.equal(face, 'Tinos', drawOps);
  }
});

test('family evidence, in order: the program\'s PANOSE, then the descriptor\'s Serif flag, then the default', async () => {
  // A regular serif program with a real PANOSE (Caladea), plain flags: PANOSE says serif.
  assert.equal((await decide(await headingPage({ program: 'caladea-regular', baseFont: 'ABCDEF+Georgia' }))).face, 'Tinos');
  // No PANOSE family, Serif flag set: the flag says serif.
  assert.equal((await decide(await headingPage({ program: 'tinos-regular', baseFont: 'ABCDEF+Georgia', flags: 34 }))).face, 'Tinos');
  // Neither says anything: the default, exactly as before.
  assert.equal((await decide(await headingPage({ program: 'tinos-regular', baseFont: 'ABCDEF+Georgia', flags: 32 }))).face, 'Arimo');
  // A sans program with a serif-less descriptor never becomes serif.
  assert.equal((await decide(await headingPage({ program: 'arimo-regular', baseFont: 'ABCDEF+Verdana', flags: 32 }))).face, 'Arimo');
});
