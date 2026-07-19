/*
 * Generate tests/fixtures/nasty/undangan-cid.pdf — the SUBSET/CID FONT fixture
 * for Rung B (position-matched removal). Run: `node scripts/gen-fixture-cid.mjs`.
 *
 * WHY this fixture exists: pdf-lib + fontkit embed custom fonts as Type0/
 * Identity-H with SUBSET-REMAPPED glyph ids — the content stream shows
 * <00010002…> hex, never the text. String-match removal (the Rung B lab seed)
 * is provably blind on it; only the interpreter walk (js/core/text-walk.js)
 * can find a run here, by position. The repeated line ("Rapat Anggota…" ×3)
 * additionally pins that POSITION picks the right one — text equality cannot.
 *
 * WHY the odd loader: the vendored UMDs must be evaluated in the CURRENT
 * realm — a `vm` sandbox gives pdf-lib a different Uint8Array class and its
 * type checks reject Node Buffers across realms.
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
// subset:false — vendored fontkit's subset ENCODER RangeErrors on this woff2
// (a fontkit bug; the app never subsets either — see core/export.js). The
// fixture's point survives: embedFont still emits Type0/Identity-H with hex
// GLYPH-ID strings, which is the string-match-proof shape Rung B must handle.
const montserrat = await doc.embedFont(
  new Uint8Array(fs.readFileSync(path.join(root, 'fonts/montserrat-regular.woff2'))),
  { subset: false },
);
// A standard-14 font on the SAME page: the width extractor must cope with a
// simple font and a CID font side by side (Helvetica has no /Widths — its
// advance is unknown to the walk, which is exactly the fallback path).
const helvetica = await doc.embedFont(PDFLib.StandardFonts.Helvetica);

const page = doc.addPage([595, 842]); // A4
const ink = PDFLib.rgb(0.1, 0.1, 0.12);
const draw = (text, x, y, size, font) => page.drawText(text, { x, y, size, font, color: ink });

draw('UNDANGAN RAPAT', 72, 760, 22, montserrat);
draw('Nomor: 045/SEK/VII/2026', 72, 730, 11, montserrat);
// The repeated line — three IDENTICAL strings at different positions. The
// Rung B proof removes exactly one of them.
draw('Rapat Anggota Tahunan 2026', 90, 660, 12, montserrat);
draw('Rapat Anggota Tahunan 2026', 90, 630, 12, montserrat);
draw('Rapat Anggota Tahunan 2026', 90, 600, 12, montserrat);
draw('Tempat: Balai Warga RW 05, Jakarta Selatan', 90, 570, 12, montserrat);
draw('Jakarta, 19 Juli 2026', 72, 500, 12, montserrat);
draw('Diterbitkan oleh Sekretariat', 72, 90, 10, helvetica);

const out = await doc.save();
const dest = path.join(root, 'tests/fixtures/nasty/undangan-cid.pdf');
fs.writeFileSync(dest, out);
console.log(`ok: ${dest} (${out.length} bytes)`);
