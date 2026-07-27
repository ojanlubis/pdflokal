/*
 * Generate tests/fixtures/nasty/surat-word.pdf — the SIMPLE-TRUETYPE (Word
 * shape) fixture for the Rung C+ extension (core/reinsert.js). Run:
 * `node scripts/gen-fixture-word.mjs`.
 *
 * WHY this fixture exists: a founder field test on a real Word-made PDF
 * found core/reinsert.js only handles Type0/Identity-H — the shape pdf-lib's
 * OWN embedFont() always produces. Word writes something else entirely: a
 * SIMPLE /Subtype /TrueType font, code-keyed (not CID-keyed), /Encoding the
 * bare NAME /WinAnsiEncoding, /FirstChar+/Widths declaring advances. pdf-lib
 * has no public API that emits that shape — embedFont() only ever emits
 * Type0 — so this script builds the font objects by hand with pdf-lib's
 * LOW-LEVEL context API (context.obj / context.flateStream / context.register),
 * the same objects a real Word/LibreOffice PDF writer would produce.
 *
 * WHY carlito-regular.woff2 as the embedded program: it's a REAL repo asset
 * (already used by core/export.js's Calibri-compatible embed), and Carlito is
 * itself the metric-compatible OPEN substitute for Word's own default body
 * font (Calibri) — an apt choice for a fixture whose whole point is "the
 * shape Word produces". No new licensed asset introduced.
 *
 * WHY the raw bytes go into FontFile2 UNCHANGED (still WOFF2-compressed, not
 * decompressed to a bare sfnt): this is NOT a new shortcut invented for this
 * fixture — scripts/gen-fixture-cid.mjs (already committed, already the RUNG
 * B/C fixture) does the exact same thing via pdf-lib's own embedFont(), and
 * core/reinsert.js's extractFontProgram + fontkit.create() already round-trip
 * that shape correctly (verified against undangan-cid.pdf, see reinsert.js's
 * own comment). The repo carries no raw .ttf/.otf (`fonts/` is woff2-only —
 * checked via `head -c4` magic bytes: 774f4632 'wOF2' on every file, and
 * neither `fonts/` nor `js/vendor/` has a plain sfnt asset), and there is no
 * woff (non-2) decompressor available either — so this fixture follows the
 * SAME precedent the codebase already established, rather than reaching for
 * a new (and licensed) system font.
 *
 * KNOWN Y-COORDS (pdf.js page-space, origin bottom-left, A4 595x842) — pinned
 * here for tests/core/reinsert-simple.test.mjs to reconstruct exact target
 * geometry without re-deriving it:
 *   heading  "SURAT UNDANGAN RESMI"                    x=72  y=770  size=20
 *   line A   "Nomor: 123/ABC/2026"      <- EDIT TARGET  x=72  y=720  size=12
 *   line B   "Kepada Yth. Bapak/Ibu Warga RT 05"        x=72  y=690  size=12
 *   line C   "Dengan hormat, kami mengundang Bapak/Ibu."x=72  y=660  size=12
 *   line D   "Jakarta, 19 Juli 2026"                    x=72  y=630  size=12
 * Every line is its own BT...Tm...Tj...ET block (fresh explicit positioning,
 * no cross-line advance dependency) so a target only needs that line's own
 * (x0,y0,ux=1,uy=0,size) — no string-width math required downstream.
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

// ---- WinAnsiEncoding byte -> unicode (the INVERSE of core/reinsert.js's
// winAnsiByteFor — this script writes the fixture's declared /Widths, that
// file reads them back; a small local duplicate is intentional, matching
// this repo's existing gen-fixture-*.mjs convention of standalone scripts
// with zero imports from js/core).
const WINANSI_CP1252_OVERLAY_BYTE_TO_UNICODE = new Map([
  [0x80, 0x20ac], [0x82, 0x201a], [0x83, 0x0192], [0x84, 0x201e],
  [0x85, 0x2026], [0x86, 0x2020], [0x87, 0x2021], [0x88, 0x02c6],
  [0x89, 0x2030], [0x8a, 0x0160], [0x8b, 0x2039], [0x8c, 0x0152],
  [0x8e, 0x017d], [0x91, 0x2018], [0x92, 0x2019], [0x93, 0x201c],
  [0x94, 0x201d], [0x95, 0x2022], [0x96, 0x2013], [0x97, 0x2014],
  [0x98, 0x02dc], [0x99, 0x2122], [0x9a, 0x0161], [0x9b, 0x203a],
  [0x9c, 0x0153], [0x9e, 0x017e], [0x9f, 0x0178],
]);
function winAnsiByteToUnicode(byte) {
  if (byte >= 0x20 && byte <= 0x7e) return byte;
  if (byte >= 0xa0 && byte <= 0xff) return byte;
  return WINANSI_CP1252_OVERLAY_BYTE_TO_UNICODE.get(byte) ?? null; // undefined slot
}

const fontBytes = new Uint8Array(fs.readFileSync(path.join(root, 'fonts/carlito-regular.woff2')));
const font = fontkit.create(fontBytes);
const scale = 1000 / font.unitsPerEm; // PDF simple-font glyph space is fixed at 1/1000 em

// /FirstChar 32 /LastChar 255 — the full WinAnsi byte range, computed from
// the REAL embedded program's advances (task requirement), not guessed.
// Undefined WinAnsiEncoding slots (0x81/0x8D/0x8F/0x90/0x9D) and any
// codepoint this particular font happens to lack a glyph for both get 0 —
// never exercised in practice (core/reinsert.js's winAnsiByteFor already
// declines those bytes before a width lookup ever happens), but a valid,
// present entry is still required for every code in [FirstChar,LastChar].
const FIRST_CHAR = 32;
const LAST_CHAR = 255;
const widths = [];
for (let byte = FIRST_CHAR; byte <= LAST_CHAR; byte += 1) {
  const cp = winAnsiByteToUnicode(byte);
  const hasGlyph = cp !== null && font.hasGlyphForCodePoint(cp);
  widths.push(hasGlyph ? Math.round(font.glyphForCodePoint(cp).advanceWidth * scale) : 0);
}

const doc = await PDFLib.PDFDocument.create();
const ctx = doc.context;

const fontFileRef = ctx.register(ctx.flateStream(fontBytes, {}));
const descriptorRef = ctx.register(ctx.obj({
  Type: 'FontDescriptor',
  FontName: 'Carlito',
  Flags: 32, // Nonsymbolic (bit 6) only — regular weight, upright, sans-serif
  FontBBox: [
    Math.round(font.bbox.minX * scale), Math.round(font.bbox.minY * scale),
    Math.round(font.bbox.maxX * scale), Math.round(font.bbox.maxY * scale),
  ],
  ItalicAngle: 0,
  Ascent: Math.round(font.ascent * scale),
  Descent: Math.round(font.descent * scale),
  CapHeight: Math.round(font.capHeight * scale),
  StemV: 80, // no fontkit-exposed equivalent; a plain regular-weight placeholder
  FontFile2: fontFileRef,
}));
const fontRef = ctx.register(ctx.obj({
  Type: 'Font',
  Subtype: 'TrueType',
  BaseFont: 'Carlito',
  FirstChar: FIRST_CHAR,
  LastChar: LAST_CHAR,
  Widths: widths,
  FontDescriptor: descriptorRef,
  Encoding: 'WinAnsiEncoding',
}));

const page = doc.addPage([595, 842]); // A4
page.node.Resources().set(PDFLib.PDFName.of('Font'), ctx.obj({ F1: fontRef }));

// One literal string per line, no escaping needed (ASCII-only fixture text,
// no '(', ')' or '\' in any line) — each its own BT...Tm...Tj...ET block, see
// the module header's KNOWN Y-COORDS table.
const lines = [
  { text: 'SURAT UNDANGAN RESMI', y: 770, size: 20 },
  { text: 'Nomor: 123/ABC/2026', y: 720, size: 12 }, // the edit target
  { text: 'Kepada Yth. Bapak/Ibu Warga RT 05', y: 690, size: 12 },
  { text: 'Dengan hormat, kami mengundang Bapak/Ibu.', y: 660, size: 12 },
  { text: 'Jakarta, 19 Juli 2026', y: 630, size: 12 },
];
const content = lines
  .map((l) => `BT /F1 ${l.size} Tf 0.1 0.1 0.12 rg 1 0 0 1 72 ${l.y} Tm (${l.text}) Tj ET`)
  .join('\n');
const contentBytes = Uint8Array.from(content, (ch) => ch.charCodeAt(0));
page.node.set(PDFLib.PDFName.of('Contents'), ctx.register(ctx.flateStream(contentBytes, {})));

const out = await doc.save();
const dest = path.join(root, 'tests/fixtures/nasty/surat-word.pdf');
fs.writeFileSync(dest, out);
console.log(`ok: ${dest} (${out.length} bytes)`);
