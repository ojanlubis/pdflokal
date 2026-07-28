/*
 * Generate tests/fixtures/nasty/formulir-garis.pdf — the DASH-LEADER form-row
 * fixture (founder field report 2026-07-28: a 21+-page consent-gated PDF,
 * "Ganti Teks" on `: Pondok Sapi, ----------------` left the original text in
 * place while stamping the replacement mid-dash-leader — surgery reported
 * `matched:true, reason:'clean'`). Run: `node scripts/gen-fixture-formrow.mjs`.
 *
 * WHY this shape reproduces the defect: an Indonesian form row is typically
 * TWO separate content-stream show-ops sharing one baseline — the
 * label/value text, then a dashed "fill to the margin" leader painted at a
 * DIFFERENT point size (bigger, for visual weight) so the row reads as a
 * filled line. core/text-lines.js's `groupRunsIntoLines` correctly clusters
 * both fragments into ONE Line (same baseline, small perp offset), but picks
 * the LINE's own `pdf.size` from the DOMINANT run — the one with the
 * greatest painted width (`pdf.len`), which is always the dash leader (it
 * spans to the margin). Before this fixture's fix landed, js/v2/app.js fed
 * that ONE blended target (`replaceTargets: [line.pdf]`) into
 * core/text-walk.js's planRunRemoval, whose per-target `sizeOk` gate
 * (rec.size within [0.55, 1.8] x target.size) then REJECTED the label/value
 * text op — its size doesn't match the dash leader's — while accepting the
 * dash op trivially. Only the dash got cut; the label/value text survived;
 * the native re-insert's origin (`first.x/y`, the one op that DID match) sat
 * at the dash's own start — i.e. exactly where the untouched original text
 * ENDS. `matched:true` was reported because A match was found, not because
 * the WHOLE target's painted content was actually removed.
 *
 * WHY hand-built low-level font objects (not pdf-lib's own embedFont): same
 * reason as scripts/gen-fixture-word.mjs — pdf-lib's embedFont() always
 * produces a Type0/Identity-H font. The real defect's telemetry
 * (`font_seen: {subtype:'truetype', flavor:'truetype-simple', embedded:true}`)
 * requires a genuine SIMPLE /Subtype /TrueType font, which only a hand-built
 * font dict (pdf-lib's low-level context API) can produce. This script
 * follows gen-fixture-word.mjs's exact recipe (same carlito-regular.woff2
 * asset, same WinAnsiEncoding width table, zero new licensed assets).
 *
 * KNOWN Y-COORDS (pdf.js page-space, origin bottom-left, A4 595x842):
 *   heading  "FORMULIR PENDAFTARAN"                          x=72  y=770 size=20
 *   line A   "Nama   : Warno Suryanto, "                      x=72  y=720 size=12
 *   line B   "Alamat : Pondok Sapi, "        <- EDIT TARGET   x=72  y=690 size=12
 *            + dash leader "----...----"     <- SAME baseline x=?   y=690 size=20
 *   line C   "Tanggal: 19 Juli 2026"                          x=72  y=660 size=12
 * Line B is TWO show-ops (text, then leader) sharing y=690 — every other
 * line is a single show-op, same "one BT...Tm...Tj...ET per line" shape
 * gen-fixture-word.mjs already established, so untouched-line assertions
 * downstream can keep comparing whole-line survival the same way.
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

// Same WinAnsi overlay table as gen-fixture-word.mjs (kept as a standalone
// local copy per that script's own convention — zero imports from js/core).
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
  return WINANSI_CP1252_OVERLAY_BYTE_TO_UNICODE.get(byte) ?? null;
}

const fontBytes = new Uint8Array(fs.readFileSync(path.join(root, 'fonts/carlito-regular.woff2')));
const font = fontkit.create(fontBytes);
const scale = 1000 / font.unitsPerEm;

const FIRST_CHAR = 32;
const LAST_CHAR = 255;
const widths = [];
for (let byte = FIRST_CHAR; byte <= LAST_CHAR; byte += 1) {
  const cp = winAnsiByteToUnicode(byte);
  const hasGlyph = cp !== null && font.hasGlyphForCodePoint(cp);
  widths.push(hasGlyph ? Math.round(font.glyphForCodePoint(cp).advanceWidth * scale) : 0);
}

// Text-space advance at `size`, thousandths-of-em widths (same math as
// text-walk.js's stringAdvance, Tc/Tw both 0 for this fixture's plain Tj ops)
// — used to place the dash leader immediately after the label/value text,
// exactly where a real form-row generator would continue painting.
function measure(text, size) {
  let sum = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    const w = (code >= FIRST_CHAR && code <= LAST_CHAR) ? widths[code - FIRST_CHAR] : 0;
    sum += (w / 1000) * size;
  }
  return sum;
}

const doc = await PDFLib.PDFDocument.create();
const ctx = doc.context;

const fontFileRef = ctx.register(ctx.flateStream(fontBytes, {}));
const descriptorRef = ctx.register(ctx.obj({
  Type: 'FontDescriptor',
  FontName: 'Carlito',
  Flags: 32,
  FontBBox: [
    Math.round(font.bbox.minX * scale), Math.round(font.bbox.minY * scale),
    Math.round(font.bbox.maxX * scale), Math.round(font.bbox.maxY * scale),
  ],
  ItalicAngle: 0,
  Ascent: Math.round(font.ascent * scale),
  Descent: Math.round(font.descent * scale),
  CapHeight: Math.round(font.capHeight * scale),
  StemV: 80,
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

const LABEL_TEXT = 'Alamat : Pondok Sapi, ';
const LABEL_SIZE = 12;
// LABEL_SIZE / LEADER_SIZE = 0.4, clear of text-walk.js's planRunRemoval
// sizeOk gate (matched records must be within [0.55, 1.8] x the target's
// size) — 12/20 (=0.6) is INSIDE that window and doesn't reproduce the
// defect at all (verified empirically while building this fixture: at 20pt
// the label op still matched fine). 30pt gives real margin below 0.55.
const LEADER_SIZE = 30;
const LEADER_TEXT = '-'.repeat(28);
const LINE_B_Y = 690;
const startX = 72;
const leaderX = startX + measure(LABEL_TEXT, LABEL_SIZE);

const ops = [
  // Untouched heading + sibling lines — same "one BT block per line" shape,
  // so a fix that only touches Line B must leave these byte-identical.
  `BT /F1 20 Tf 1 0 0 1 72 770 Tm (FORMULIR PENDAFTARAN) Tj ET`,
  `BT /F1 12 Tf 1 0 0 1 72 720 Tm (Nama   : Warno Suryanto, ) Tj ET`,
  // Line B — the edit target: TWO show-ops, same baseline, different sizes.
  `BT /F1 ${LABEL_SIZE} Tf 1 0 0 1 ${startX} ${LINE_B_Y} Tm (${LABEL_TEXT}) Tj ET`,
  `BT /F1 ${LEADER_SIZE} Tf 1 0 0 1 ${leaderX} ${LINE_B_Y} Tm (${LEADER_TEXT}) Tj ET`,
  `BT /F1 12 Tf 1 0 0 1 72 660 Tm (Tanggal: 19 Juli 2026) Tj ET`,
];
const content = ops.join('\n');
const contentBytes = Uint8Array.from(content, (ch) => ch.charCodeAt(0));
page.node.set(PDFLib.PDFName.of('Contents'), ctx.register(ctx.flateStream(contentBytes, {})));

const out = await doc.save();
const dest = path.join(root, 'tests/fixtures/nasty/formulir-garis.pdf');
fs.writeFileSync(dest, out);
console.log(`ok: ${dest} (${out.length} bytes) — leaderX=${leaderX.toFixed(3)}`);
