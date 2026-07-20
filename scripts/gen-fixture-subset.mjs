/*
 * Generate tests/fixtures/nasty/nota-subset.pdf — the TRUE-SUBSET fixture for
 * font-fidelity tier 2 (glyph composition). Run: `node scripts/gen-fixture-subset.mjs`.
 *
 * WHY this fixture exists: every other nasty fixture embeds a FULL font
 * (pdf-lib's subset:true hits a vendored-fontkit encoder bug — see
 * gen-fixture-cid.mjs), so no fixture could ever exercise the missing-glyph
 * path against a real subset. This one embeds tests/fixtures/nasty/
 * carlito-subset.ttf — a genuine pyftsubset cut (GSUB/GPOS stripped, the
 * worst-case Word shape) whose pinned facts the compose suite relies on:
 * é present as a composite, É ABSENT, the acute outline reachable ONLY as an
 * un-cmapped glyf component. Editing "Kafé Andréa…" to "KAFÉ ANDRÉA" on this
 * document is the real-world composition case end to end.
 *
 * The subset TTF itself is a committed artifact (cut with fonttools —
 * scripts-side tooling, not available in-repo; same committed-output pattern
 * as every gen-fixture PDF). The embed here is a real sfnt in FontFile2, so
 * pdf.js renders it everywhere — unlike the woff2-carrying fixtures.
 *
 * KNOWN LINES (pdf.js page-space, origin bottom-left, A4 595x842):
 *   'FORMULIR PESANAN'                                x=72 y=760 size=20
 *   'Kafé Andréa, Jakarta Selatan'    <- EDIT TARGET  x=72 y=720 size=12
 *   'Kepada Bapak Dimas Rahman: Edisi Juli 2026'      x=72 y=690 size=12
 *   'pesanan kopi susu gula aren, total Rp 48.500,-'  x=72 y=660 size=12
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

const subsetBytes = new Uint8Array(
  fs.readFileSync(path.join(root, 'tests/fixtures/nasty/carlito-subset.ttf')),
);

const doc = await PDFLib.PDFDocument.create();
doc.registerFontkit(fontkit);
// subset:false — the program IS already a subset; pdf-lib must embed it as-is
const carlito = await doc.embedFont(subsetBytes, { subset: false });

const page = doc.addPage([595, 842]); // A4
const ink = PDFLib.rgb(0.1, 0.1, 0.12);
const draw = (text, x, y, size) => page.drawText(text, { x, y, size, font: carlito, color: ink });

draw('FORMULIR PESANAN', 72, 760, 20);
draw('Kafé Andréa, Jakarta Selatan', 72, 720, 12);
draw('Kepada Bapak Dimas Rahman: Edisi Juli 2026', 72, 690, 12);
draw('pesanan kopi susu gula aren, total Rp 48.500,-', 72, 660, 12);

const out = await doc.save();
const dest = path.join(root, 'tests/fixtures/nasty/nota-subset.pdf');
fs.writeFileSync(dest, out);
console.log(`ok: ${dest} (${out.length} bytes)`);
