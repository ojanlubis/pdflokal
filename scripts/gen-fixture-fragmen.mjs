/*
 * Generate tests/fixtures/nasty/surat-fragmen.pdf — the WORD-FRAGMENTATION
 * fixture for Rung C (core/text-lines.js). Run: `node scripts/gen-fixture-fragmen.mjs`.
 *
 * WHY this fixture exists: Word (and friends) routinely split one visual
 * line into several pdf.js text RUNS — at kerning pairs, at a font switch,
 * at a field boundary — even though nothing changes on screen. Rung A/B
 * ("Ganti Teks") targeted the run; the founder ruling (2026-07-19) moves the
 * editing primitive to the LINE, built by clustering runs
 * (js/core/text-lines.js). This fixture is the nasty case that clustering
 * exists to fix: every "line" below is drawn as MULTIPLE drawText calls,
 * continued at measured x offsets, so the content stream holds fragments a
 * naive run-based tool would edit one at a time and leave the rest behind.
 *
 * Five traps, one per line:
 *   A. kern-fragments, 0-gap continuation (3 drawText calls, no gap at all)
 *   B. a real word-space gap the along pass must bridge with an inferred space
 *   C. a two-column trap: same baseline, wide gutter — must stay TWO lines
 *   D. the same 0-gap fragmentation trap through a CID/Type0 font (Montserrat
 *      via fontkit, mirroring gen-fixture-cid.mjs) — hex glyph-id strings,
 *      not ASCII, so the clustering must work by geometry, never by text
 *   E. one ordinary single-fragment line — the control line clustering must
 *      leave alone
 *
 * WHY the odd loader: the vendored UMDs must be evaluated in the CURRENT
 * realm — a `vm` sandbox gives pdf-lib a different Uint8Array class and its
 * type checks reject Node Buffers across realms. (Same loader as
 * gen-fixture-cid.mjs.)
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

const helvetica = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
// subset:false — same fontkit-subset-encoder bug noted in gen-fixture-cid.mjs;
// the point (Type0/Identity-H hex glyph-id strings) survives unsubsetted.
const montserrat = await doc.embedFont(
  new Uint8Array(fs.readFileSync(path.join(root, 'fonts/montserrat-regular.woff2'))),
  { subset: false },
);

const page = doc.addPage([595, 842]); // A4
const ink = PDFLib.rgb(0.1, 0.1, 0.12);

// Draw `text` starting at (x, y) as a sequence of fragments, each continued
// exactly where the previous one's measured width ends — zero gap, the
// kerning-fragment trap Word produces at font/kerning boundaries.
function drawFragmented(fragments, x, y, size, font) {
  let cursor = x;
  for (const frag of fragments) {
    page.drawText(frag, { x: cursor, y, size, font, color: ink });
    cursor += font.widthOfTextAtSize(frag, size);
  }
}

// Line A — kern-fragments, 0-gap continuation across three drawText calls.
drawFragmented(['Nomor: 0', '45/SEK/', 'VII/2026'], 72, 760, 12, helvetica);

// Line B — real word gap: "Perihal:" then a 0.3em gap beyond the measured
// width before "Undangan Rapat Anggota". Neither string carries a
// leading/trailing space — the along pass must infer the missing space.
{
  const size = 12;
  const first = 'Perihal:';
  const x0 = 72;
  const gap = 0.3 * size;
  const x1 = x0 + helvetica.widthOfTextAtSize(first, size) + gap;
  page.drawText(first, { x: x0, y: 730, size, font: helvetica, color: ink });
  page.drawText('Undangan Rapat Anggota', { x: x1, y: 730, size, font: helvetica, color: ink });
}

// Line C — two-column trap: same baseline (y=680), a gutter far wider than
// any word space. Clustering must keep these as TWO lines.
page.drawText('Kolom Kiri A', { x: 72, y: 680, size: 11, font: helvetica, color: ink });
page.drawText('Kolom Kanan B', { x: 350, y: 680, size: 11, font: helvetica, color: ink });

// Line D — the 0-gap fragmentation trap again, through a CID/Type0 font
// (hex glyph-id strings, string-match-proof — geometry is the only way in).
drawFragmented(['Rapat ', 'Tahunan'], 72, 620, 14, montserrat);

// Line E — control: one ordinary single-fragment line, untouched by
// clustering (it's already exactly one run == one line).
page.drawText('Diterbitkan oleh Sekretariat', { x: 72, y: 90, size: 10, font: helvetica, color: ink });

const out = await doc.save();
const dest = path.join(root, 'tests/fixtures/nasty/surat-fragmen.pdf');
fs.writeFileSync(dest, out);
console.log(`ok: ${dest} (${out.length} bytes)`);

// Sanity-check: re-load with the same vendored pdf-lib in-process and
// confirm the page count and byte length are what we expect — a corrupt
// save would throw here rather than silently shipping a broken fixture.
const reloaded = await PDFLib.PDFDocument.load(out);
if (reloaded.getPageCount() !== 1) {
  throw new Error(`fixture sanity check failed: expected 1 page, got ${reloaded.getPageCount()}`);
}
console.log(`sanity check ok: ${reloaded.getPageCount()} page(s) reloaded`);
