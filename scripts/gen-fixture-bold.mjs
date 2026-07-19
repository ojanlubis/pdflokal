/*
 * Generate tests/fixtures/nasty/tebal-hitam.pdf — the BOLD/BLACK fixture for
 * the founder's field test (2026-07-19, real Word-made PDF, bold Arial
 * headings, solid black text): Ganti Teks never adopted bold/italic, and the
 * ink-color sampler rendered solid black text back as visible GRAY. Run:
 * `node scripts/gen-fixture-bold.mjs`.
 *
 * WHY montserrat-bold.woff2 specifically: it's a REAL repo asset (also used
 * by core/export.js's Montserrat-Bold embed fallback) whose own PostScript
 * name is 'MontserratThin-Bold' (verified directly against the vendored
 * fontkit) — embedding it unsubset via pdf-lib produces a genuine Type0/
 * Identity-H font whose /BaseFont carries 'Bold', the exact real-world shape
 * a Word-exported bold heading has. No synthetic name override needed.
 *
 * Two lines: a large BOLD black heading (bug 2 + bug 3 target — big enough
 * that its glyph strokes have a real solid-ink core, not just anti-aliased
 * edges) and a small regular black body line underneath (control — proves
 * the bold-only line doesn't turn EVERYTHING bold/dark).
 *
 * WHY the odd loader: the vendored UMDs must be evaluated in the CURRENT
 * realm — a `vm` sandbox gives pdf-lib a different Uint8Array class and its
 * type checks reject Node Buffers across realms. (Same loader as every other
 * gen-fixture-*.mjs script.)
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
// subset:false — same fontkit-subset-encoder RangeError noted in every other
// gen-fixture-*.mjs script; the app never subsets either (see core/export.js).
const bold = await doc.embedFont(
  new Uint8Array(fs.readFileSync(path.join(root, 'fonts/montserrat-bold.woff2'))),
  { subset: false },
);
const regular = await doc.embedFont(
  new Uint8Array(fs.readFileSync(path.join(root, 'fonts/montserrat-regular.woff2'))),
  { subset: false },
);

const page = doc.addPage([595, 842]); // A4
const black = PDFLib.rgb(0, 0, 0);

// Large, bold, solid black — the founder's field bug: real strokes thick
// enough at this size to have a genuine solid-ink core (not only anti-
// aliased edges), on plain white paper.
page.drawText('PENGUMUMAN RESMI', { x: 72, y: 740, size: 32, font: bold, color: black });
// Control line: regular weight, same color — must NOT come back bold.
page.drawText('Diterbitkan oleh sekretariat pada tanggal 19 Juli 2026.', {
  x: 72, y: 690, size: 12, font: regular, color: black,
});

const out = await doc.save();
const dest = path.join(root, 'tests/fixtures/nasty/tebal-hitam.pdf');
fs.writeFileSync(dest, out);
console.log(`ok: ${dest} (${out.length} bytes)`);
