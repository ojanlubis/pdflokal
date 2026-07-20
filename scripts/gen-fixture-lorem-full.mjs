/*
 * Generate tests/fixtures/nasty/lorem-full.pdf — the FULL-GLYPH-SET fixture
 * for the font-coverage e2e gate (font-coverage.spec.js). Run:
 * `node scripts/gen-fixture-lorem-full.mjs`.
 *
 * WHY this fixture exists: core/reinsert.js's planNativeInsert + the editor's
 * live doc-font preview (js/v2/app.js's prepareDocFont/loadDocFont) are today
 * only ever driven through headless fontkit unit tests (tests/core/
 * rung-c-native.spec.js) — never through the REAL editor UI end to end. This
 * fixture is the "everything is covered" endpoint of that behavior: the
 * embedded font program carries its FULL glyph set (subset:false — see note
 * below), so editing the target line to ANY reasonable new text — including
 * a character absent from the ORIGINAL line's own words — must still resolve
 * to the document's own font (native re-insert), never the substitute twin.
 *
 * WHY subset:false (same gotcha every other gen-fixture-*.mjs in this repo
 * already documents): the vendored fontkit's subset ENCODER unconditionally
 * RangeErrors ("Index out of range") when re-encoding ANY subset of this
 * repo's woff2 fonts — verified independently while building this fixture,
 * reproduces even for a 1-2 character subset. Root cause traced to
 * TTFSubset.prototype._addGlyph's composite-glyph branch
 * (`o.writeUInt16BE(componentGlyphID, l.pos)`): Montserrat's low glyph IDs
 * (2, 3, 4, …) are themselves composite glyphs, and they get pulled into
 * EVERY subset closure regardless of which characters are requested, so the
 * crash is unconditional — not a "this text hit an edge case" bug. subset:
 * false sidesteps it entirely by embedding the whole program, which is
 * exactly the shape THIS fixture wants anyway (full coverage, by construction).
 *
 * WHY the UMD-loader pattern (`new Function`, never `vm`): the vendored UMDs
 * must run in the CURRENT realm — a `vm` sandbox gives pdf-lib a different
 * Uint8Array class and its own type checks reject cross-realm typed arrays.
 *
 * KNOWN Y-COORDS (pdf.js page-space, origin bottom-left, A4 595x842) — pinned
 * here so font-coverage.spec.js's line lookups never have to re-derive
 * geometry; every line is its own BT...Tm...Tj...ET block (drawText per
 * call), no cross-line advance dependency:
 *   heading   "CONTOH DOKUMEN LOREM"                              y=770 size=20
 *   line A    "Nomor: 001/LOR/2026"              <- EDIT TARGET    y=720 size=12
 *   line B    "Lorem ipsum dolor sit amet, konsektetur adisipsing."y=690 size=12
 *   line C    "Sed do eiusmod tempor incididunt ut labore dolore."y=660 size=12
 *   line D    "Ut enim ad minim veniam quis nostrud exercitation."y=630 size=12
 *   line E    "Jakarta, 20 Juli 2026"                             y=600 size=12
 *
 * EDIT TARGET line A is the "clearly editable" line the spec drives: its
 * replacement text in the e2e test deliberately includes an em dash ('—')
 * — a character the ORIGINAL line A never used — to prove coverage is
 * checked against the FINAL typed text, not just the prefill. Montserrat's
 * full program covers it (verified: fontkit.hasGlyphForCodePoint(0x2014)
 * === true on this exact font file), so the native path must fire.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports;
};

const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');

const doc = await PDFLib.PDFDocument.create();
doc.registerFontkit(fontkit);
// subset:false — see module header. Embeds the WHOLE Montserrat program, so
// every glyph the family ships with (Latin + Latin Extended + common
// punctuation/symbols — 320 glyphs, verified via fontkit.numGlyphs) is
// present in this PDF's font resource, not just the glyphs this page's own
// text happens to use.
const montserrat = await doc.embedFont(
  new Uint8Array(fs.readFileSync(path.join(root, 'fonts/montserrat-regular.woff2'))),
  { subset: false },
);

const page = doc.addPage([595, 842]); // A4
const ink = PDFLib.rgb(0.1, 0.1, 0.12);
const draw = (text, y, size) => page.drawText(text, { x: 72, y, size, font: montserrat, color: ink });

draw('CONTOH DOKUMEN LOREM', 770, 20);
draw('Nomor: 001/LOR/2026', 720, 12); // EDIT TARGET
draw('Lorem ipsum dolor sit amet, konsektetur adisipsing.', 690, 12);
draw('Sed do eiusmod tempor incididunt ut labore dolore.', 660, 12);
draw('Ut enim ad minim veniam quis nostrud exercitation.', 630, 12);
draw('Jakarta, 20 Juli 2026', 600, 12);

const out = await doc.save();
const dest = path.join(root, 'tests/fixtures/nasty/lorem-full.pdf');
fs.writeFileSync(dest, out);
console.log(`ok: ${dest} (${out.length} bytes)`);
