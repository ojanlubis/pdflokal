/*
 * Generate tests/fixtures/nasty/surat-paragraf.pdf — the PARAGRAPH-BLOCK
 * fixture for Rung D1 (core/text-blocks.js). Run: `node scripts/gen-fixture-paragraf.mjs`.
 *
 * WHY this fixture exists: text-blocks.js groups text-lines.js's Line[] into
 * paragraph Block[] by geometry (spec-rung-d-reflow.md §2). This fixture is
 * the real-PDF falsifier check the spec's §8 calls for ("check the nasty
 * corpus + 2-3 real PDFs BEFORE building D3-D5") — every region below is
 * drawn through the SAME Type0/Identity-H hex-glyph-id path as
 * gen-fixture-cid.mjs (subset:false — the vendored fontkit subset ENCODER
 * RangeErrors on this woff2; the app never subsets either, see core/export.js),
 * so detection must work by GEOMETRY alone, never by reading the text.
 *
 * Five clearly separated regions, each >= 60pt from its neighbors (comfortably
 * over MAX_LEADING_FACTOR*size for every size used here, so the leading gate
 * alone keeps regions apart regardless of any other gate):
 *
 *   1. JUSTIFIED paragraph, 11pt, 15pt leading, 4 lines. Lines 1-3 are
 *      manually word-spaced (via drawJustified below) so BOTH edges land on
 *      the same along-range [72, 72+JUSTIFY_WIDTH]; line 4 is drawn at its
 *      natural (shorter, ragged) width — the "last line exempt" case.
 *      y-baselines: 760, 745, 730, 715.
 *   2. Two INDENTED paragraphs, 12pt, 15pt leading, 2 lines each, NO blank
 *      line between them — only the first-line indent (18pt, i.e. > 1.2em
 *      of a 12pt line = 14.4pt) tells them apart.
 *      Paragraph A y-baselines: 650, 635 (line 1 indented to x=90, line 2
 *      flush at x=72). Paragraph B y-baselines: 620, 605 (line 1 indented to
 *      x=90, line 2 flush at x=72) — 620 is only 15pt below A's last line
 *      (635), i.e. the SAME leading as within each paragraph, on purpose.
 *   3. Bullet LIST, 3 items, 12pt, 15pt leading — must decline (reason
 *      'list'), never reflow the markers away.
 *      y-baselines: 540, 525, 510.
 *   4. A 16pt HEADING directly above a 2-line 11pt body block (24pt gap,
 *      still < 2x16=32 so the heading doesn't itself get treated as
 *      "too far" from the body, though it separates via the SIZE gate
 *      regardless of the leading gate).
 *      Heading y=450. Body y-baselines: 426, 411.
 *   5. Two-COLUMN region: two 3-line blocks side by side sharing baselines
 *      at x=72 and x=330, 11pt, 15pt leading.
 *      y-baselines: 340, 325, 310.
 *
 * WHY the odd loader: the vendored UMDs must be evaluated in the CURRENT
 * realm — a `vm` sandbox gives pdf-lib a different Uint8Array class and its
 * type checks reject Node Buffers across realms. (Same loader as
 * gen-fixture-cid.mjs / gen-fixture-fragmen.mjs.)
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
// subset:false — same fontkit-subset-encoder bug noted in gen-fixture-cid.mjs
// and gen-fixture-fragmen.mjs; the point (Type0/Identity-H hex glyph-id
// strings, string-match-proof geometry) survives unsubsetted.
const montserrat = await doc.embedFont(
  new Uint8Array(fs.readFileSync(path.join(root, 'fonts/montserrat-regular.woff2'))),
  { subset: false },
);

const page = doc.addPage([595, 842]); // A4
const ink = PDFLib.rgb(0.1, 0.1, 0.12);

// Draw `words` left-to-right starting at x0, stretching the inter-word gaps
// so the line's total measured width lands exactly on `targetWidth` — the
// manual equivalent of PDF word-spacing (Tw), giving BOTH edges (a0 and
// a0+targetWidth) an exact, provable along-range for the justify test.
function drawJustified(x0, y, size, words, targetWidth) {
  const wordWidths = words.map((w) => montserrat.widthOfTextAtSize(w, size));
  const spaceWidth = montserrat.widthOfTextAtSize(' ', size);
  const gapCount = words.length - 1;
  const naturalTotal = wordWidths.reduce((a, b) => a + b, 0) + spaceWidth * gapCount;
  const extra = targetWidth - naturalTotal;
  const gapWidth = gapCount > 0 ? spaceWidth + extra / gapCount : spaceWidth;
  let x = x0;
  words.forEach((w, i) => {
    page.drawText(w, { x, y, size, font: montserrat, color: ink });
    x += wordWidths[i] + (i < words.length - 1 ? gapWidth : 0);
  });
}

function draw(text, x, y, size) {
  page.drawText(text, { x, y, size, font: montserrat, color: ink });
}

// ---------------------------------------------------------------------------
// Region 1 — justified paragraph, 4 lines, 11pt / 15pt leading.
// ---------------------------------------------------------------------------
draw('Undangan Rapat Anggota Tahunan', 72, 790, 14);

const JUSTIFY_SIZE = 11;
const JUSTIFY_LEAD = 15;
const JUSTIFY_X0 = 72;

const justifiedLines = [
  ['Dengan', 'ini', 'kami', 'sampaikan', 'undangan', 'resmi'],
  ['kepada', 'seluruh', 'anggota', 'untuk', 'hadir', 'dalam'],
  ['rapat', 'tahunan', 'yang', 'akan', 'diselenggarakan', 'besok'],
];

// Pick the target width from the LONGEST line's natural width plus a small
// margin, rather than an arbitrary large number: text-lines.js's own
// column-gutter guard (1.5em) would misread a big justify stretch as a
// column break and split the line in two before block detection ever sees
// it, so every gap's stretch must stay well under 1.5*JUSTIFY_SIZE (16.5pt).
const spaceWidthJ = montserrat.widthOfTextAtSize(' ', JUSTIFY_SIZE);
const naturalWidths = justifiedLines.map((words) => {
  const sum = words.reduce((s, w) => s + montserrat.widthOfTextAtSize(w, JUSTIFY_SIZE), 0);
  return sum + spaceWidthJ * (words.length - 1);
});
const JUSTIFY_WIDTH = Math.max(...naturalWidths) + 12; // the reflow boundary these 3 lines all match

justifiedLines.forEach((words, i) => {
  drawJustified(JUSTIFY_X0, 760 - i * JUSTIFY_LEAD, JUSTIFY_SIZE, words, JUSTIFY_WIDTH);
});
// Last line: ragged, natural width, no stretching — the ONE line the
// justify test must exempt from the right-edge agreement check.
draw('pada pukul sepuluh pagi.', JUSTIFY_X0, 760 - 3 * JUSTIFY_LEAD, JUSTIFY_SIZE);

// ---------------------------------------------------------------------------
// Region 2 — two indented paragraphs, no blank line between them.
// ---------------------------------------------------------------------------
const INDENT_SIZE = 12;
const INDENT_LEAD = 15;
const FLUSH_X = 72;
const INDENT_X = 72 + 18; // 18pt > 1.2em of a 12pt line (14.4pt)

draw('Setiap anggota wajib membawa kartu identitas', INDENT_X, 650, INDENT_SIZE);
draw('dan surat undangan asli saat hadir.', FLUSH_X, 650 - INDENT_LEAD, INDENT_SIZE);
// No blank line before paragraph B — same 15pt leading as within A.
draw('Keterlambatan lebih dari lima belas menit', INDENT_X, 650 - 2 * INDENT_LEAD, INDENT_SIZE);
draw('akan dianggap sebagai ketidakhadiran.', FLUSH_X, 650 - 3 * INDENT_LEAD, INDENT_SIZE);

// ---------------------------------------------------------------------------
// Region 3 — bullet list, 3 items.
// ---------------------------------------------------------------------------
const LIST_SIZE = 12;
const LIST_LEAD = 15;
draw('- Membawa undangan asli', FLUSH_X, 540, LIST_SIZE);
draw('- Mengisi daftar hadir', FLUSH_X, 540 - LIST_LEAD, LIST_SIZE);
draw('- Mematuhi tata tertib rapat', FLUSH_X, 540 - 2 * LIST_LEAD, LIST_SIZE);

// ---------------------------------------------------------------------------
// Region 4 — 16pt heading directly above a 2-line 11pt body block.
// ---------------------------------------------------------------------------
draw('TATA TERTIB RAPAT', FLUSH_X, 450, 16);
draw('Rapat dimulai tepat waktu sesuai jadwal', FLUSH_X, 450 - 24, 11);
draw('yang tercantum pada undangan resmi ini.', FLUSH_X, 450 - 24 - 15, 11);

// ---------------------------------------------------------------------------
// Region 5 — two columns, 3 lines each, sharing baselines.
// ---------------------------------------------------------------------------
const COL_SIZE = 11;
const COL_LEAD = 15;
const COL_LEFT_X = 72;
const COL_RIGHT_X = 330;
const colLeft = ['Kolom kiri baris satu', 'Kolom kiri baris dua', 'Kolom kiri baris tiga'];
const colRight = ['Kolom kanan baris satu', 'Kolom kanan baris dua', 'Kolom kanan baris tiga'];
colLeft.forEach((text, i) => draw(text, COL_LEFT_X, 340 - i * COL_LEAD, COL_SIZE));
colRight.forEach((text, i) => draw(text, COL_RIGHT_X, 340 - i * COL_LEAD, COL_SIZE));

const out = await doc.save();
const dest = path.join(root, 'tests/fixtures/nasty/surat-paragraf.pdf');
fs.writeFileSync(dest, out);
console.log(`ok: ${dest} (${out.length} bytes)`);

// Sanity-check: re-load with the same vendored pdf-lib in-process — a
// corrupt save would throw here rather than silently shipping a broken
// fixture (same check gen-fixture-fragmen.mjs runs).
const reloaded = await PDFLib.PDFDocument.load(out);
if (reloaded.getPageCount() !== 1) {
  throw new Error(`fixture sanity check failed: expected 1 page, got ${reloaded.getPageCount()}`);
}
console.log(`sanity check ok: ${reloaded.getPageCount()} page(s) reloaded`);
