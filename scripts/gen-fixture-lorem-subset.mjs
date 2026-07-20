/*
 * Generate tests/fixtures/nasty/lorem-subset.pdf — the DECLINE-FOREVER
 * counterpart to lorem-full.pdf, for the font-coverage e2e gate
 * (font-coverage.spec.js). Run: `node scripts/gen-fixture-lorem-subset.mjs`.
 *
 * WHY THIS ISN'T A LITERAL BYTE-SUBSETTED FONT (read before assuming the
 * filename lied): the task this fixture serves wants "a TIGHT SUBSET —
 * only the glyphs its own text uses", the shape a real Word/LibreOffice/
 * pdf-lib `subset:true` embed produces in the wild. That path is NOT
 * available in this repo today — verified independently while building this
 * fixture: pdf-lib's `embedFont(bytes, { subset: true })` against EVERY
 * vendored woff2 font (montserrat-regular, carlito-regular — tried both)
 * throws `RangeError: Index out of range` inside the vendored fontkit's own
 * `TTFSubset.prototype._addGlyph`, UNCONDITIONALLY — reproduces even for a
 * 1-2 character subset ('A', 'Hi'), not just pathological text. Root cause:
 * `_addGlyph`'s composite-glyph branch
 * (`o.writeUInt16BE(componentGlyphID, l.pos)`) chokes on Montserrat's own
 * low glyph IDs (2, 3, 4, …), which are themselves composite glyphs and get
 * pulled into EVERY subset's glyph closure regardless of which characters
 * were requested — confirmed against a real, non-WOFF2 TrueType file
 * (`/System/Library/Fonts/Monaco.ttf`) subsetting FINE through the exact
 * same pdf-lib call, isolating the break to this repo's woff2 assets +
 * vendored fontkit combination, not a general subset:true limitation. This
 * matches (and now independently confirms) the "subset ENCODER RangeErrors"
 * gotcha every other gen-fixture-*.mjs in this repo already notes for
 * subset:false — that workaround exists precisely because true subsetting
 * is broken here, not by choice.
 *
 * THE WORKAROUND, and why it's still an HONEST "tight subset" fixture for
 * what this test actually needs to prove: embed Montserrat's FULL program
 * (subset:false, same as lorem-full.pdf) — but choose the e2e test's
 * INTRODUCED character to be one that font family has ZERO coverage for at
 * ANY weight: U+0416 CYRILLIC CAPITAL LETTER ZHE ('Ж'). Verified via
 * fontkit.hasGlyphForCodePoint(0x0416) === false on this exact program (see
 * this script's own probe below, printed at generation time). This produces
 * the IDENTICAL decision-relevant fact a genuinely tight Latin-only subset
 * would — core/reinsert.js's planNativeInsert sees zero glyph data for the
 * introduced codepoint and declines with 'missing-glyph' — and it is
 * GENUINELY, PERMANENTLY uncoverable in a way a narrow Latin subset would
 * not be: no font-family clone routing helps (Montserrat Bold/Italic/
 * BoldItalic are ALL Latin-only — verified, no weight in this family carries
 * Cyrillic), and no glyph-composition trick helps either (Cyrillic Ж has no
 * NFD decomposition into Latin components — it is not an accented Latin
 * letter in a trenchcoat). That is exactly the "no possible clone, not
 * composable" property the task asked this fixture's absent character to
 * have, so the substitute-toast assertion in font-coverage.spec.js stays a
 * HARD assertion even after the concurrent font-engine work lands.
 *
 * WHY the UMD-loader pattern (`new Function`, never `vm`): the vendored UMDs
 * must run in the CURRENT realm — a `vm` sandbox gives pdf-lib a different
 * Uint8Array class and its own type checks reject cross-realm typed arrays.
 *
 * KNOWN Y-COORDS (pdf.js page-space, origin bottom-left, A4 595x842) —
 * mirrors lorem-full.pdf's shape, different filler text so the two fixtures
 * are never confusable by content alone; every line is its own
 * BT...Tm...Tj...ET block (drawText per call):
 *   heading   "CONTOH DOKUMEN LOREM (SUBSET)"                     y=770 size=20
 *   line A    "Nomor: 002/LOR/2026"              <- EDIT TARGET   y=720 size=12
 *   line B    "Duis aute irure dolor in reprehenderit voluptate."y=690 size=12
 *   line C    "Excepteur sint occaecat cupidatat non proident."  y=660 size=12
 *   line D    "Sunt in culpa qui officia deserunt mollit anim."  y=630 size=12
 *   line E    "Jakarta, 20 Juli 2026"                            y=600 size=12
 *
 * EDIT TARGET line A: the e2e test replaces it with text containing 'Ж'
 * (e.g. "Nomor: Ж02/BARU/2026") — Montserrat has no glyph for it, so
 * planNativeInsert/loadDocFont's commit-time coverage check must decline and
 * the honest "font pengganti" substitute toast must fire.
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

// Probe (printed, not asserted — this is a generator script, not a test):
// confirms the "genuinely uncoverable" claim above against the ACTUAL bytes
// about to be embedded, on every regeneration.
const montserratBytesForProbe = new Uint8Array(
  fs.readFileSync(path.join(root, 'fonts/montserrat-regular.woff2')),
);
const probeFont = fontkit.create(montserratBytesForProbe);
const zheCovered = probeFont.hasGlyphForCodePoint(0x0416);
console.log(`probe: Montserrat hasGlyphForCodePoint(U+0416 'Ж') = ${zheCovered} (expected false)`);
if (zheCovered) {
  throw new Error("fixture assumption broken: Montserrat now covers 'Ж' — pick a different absent glyph");
}

const doc = await PDFLib.PDFDocument.create();
doc.registerFontkit(fontkit);
// subset:false — see module header's long WHY. Same full-program embed as
// lorem-full.pdf; the "subset" behavior this fixture needs comes from the
// e2e test's introduced character, not from the PDF's own font shape.
const montserrat = await doc.embedFont(montserratBytesForProbe, { subset: false });

const page = doc.addPage([595, 842]); // A4
const ink = PDFLib.rgb(0.1, 0.1, 0.12);
const draw = (text, y, size) => page.drawText(text, { x: 72, y, size, font: montserrat, color: ink });

draw('CONTOH DOKUMEN LOREM (SUBSET)', 770, 18);
draw('Nomor: 002/LOR/2026', 720, 12); // EDIT TARGET
draw('Duis aute irure dolor in reprehenderit voluptate.', 690, 12);
draw('Excepteur sint occaecat cupidatat non proident.', 660, 12);
draw('Sunt in culpa qui officia deserunt mollit anim.', 630, 12);
draw('Jakarta, 20 Juli 2026', 600, 12);

const out = await doc.save();
const dest = path.join(root, 'tests/fixtures/nasty/lorem-subset.pdf');
fs.writeFileSync(dest, out);
console.log(`ok: ${dest} (${out.length} bytes)`);
