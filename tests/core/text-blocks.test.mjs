/*
 * Rung D1 — text-blocks paragraph detection (headless).
 * Pins the perp-sorted greedy grouping (spec-rung-d-reflow.md §2) that turns
 * text-lines.js's Line[] into paragraph Block[] — the next editing primitive
 * up from the LINE, built for "Ubah Paragraf" (box-bounded reflow). Synthetic
 * Line[] objects only, built directly with pdf geometry (no PDFs, no vendor
 * imports), same discipline as text-lines.test.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupLinesIntoBlocks } from '../../js/core/text-blocks.js';

// Build one synthetic Line (the shape text-lines.js's groupRunsIntoLines
// produces). Horizontal by default (ux=1, uy=0); pass { ux, uy } for other
// directions. Display x/y/w/h mirror the pdf geometry with an identity
// mapping, same convention as text-lines.test.mjs's run() helper — these
// tests assert on `pdf` geometry, align, and editable/reason, never on
// exact display pixel boxes.
function line(str, x0, y0, len, size, opts = {}) {
  const ux = opts.ux ?? 1;
  const uy = opts.uy ?? 0;
  const dx = ux * len;
  const dy = uy * len;
  return {
    str,
    x: Math.min(x0, x0 + dx),
    y: Math.min(y0, y0 + dy),
    w: Math.abs(dx) || size,
    h: Math.abs(dy) || size,
    size,
    fontName: opts.fontName || 'F1',
    fontFamily: opts.fontFamily || '',
    pdf: { x0, y0, ux, uy, len, size },
    runs: [],
  };
}

test('1. blank-line leading jump splits two paragraphs', () => {
  const size = 12;
  const lead = 14; // normal leading, well under MAX_LEADING_FACTOR*size (24)
  const gap = 28; // a blank-line skip: > 2.0*12 -> triggers the absolute gate
  const lines = [
    line('Satu', 72, 700, 200, size),
    line('Dua', 72, 700 - lead, 200, size),
    line('Tiga', 72, 700 - 2 * lead, 200, size),
    line('Empat', 72, 700 - 2 * lead - gap, 200, size),
    line('Lima', 72, 700 - 2 * lead - gap - lead, 200, size),
    line('Enam', 72, 700 - 2 * lead - gap - 2 * lead, 200, size),
  ];
  const blocks = groupLinesIntoBlocks(lines);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].lines.length, 3);
  assert.equal(blocks[1].lines.length, 3);
  assert.equal(blocks[0].text, 'Satu\nDua\nTiga');
  assert.equal(blocks[1].text, 'Empat\nLima\nEnam');
});

test('2. +/-25% leading regularity gate splits even under MAX_LEADING_FACTOR', () => {
  const size = 12;
  const lead = 14;
  const irregularGap = lead * 1.3; // 18.2: < 24 (passes absolute gate) but
  // > 1.25*14=17.5 (fails the regularity gate) -- proves the regularity
  // check does real work, independent of the absolute blank-line gate.
  const lines = [
    line('Satu', 72, 700, 200, size),
    line('Dua', 72, 700 - lead, 200, size),
    line('Tiga', 72, 700 - lead - irregularGap, 200, size),
  ];
  const blocks = groupLinesIntoBlocks(lines);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].lines.length, 2);
  assert.equal(blocks[1].lines.length, 1);
});

test('3. indent split produces two blocks (surat-resmi first-line-indent convention)', () => {
  const size = 12;
  const lead = 14;
  const em = size;
  const lines = [
    line('Paragraf satu baris satu', 72, 700, 200, size),
    line('Paragraf satu baris dua', 72, 700 - lead, 180, size),
    // New paragraph's first line: indented well past 1.2em (14.4) right of
    // the established left edge (72) -- must start a NEW block.
    line('Paragraf dua baris satu', 72 + 1.3 * em, 700 - 2 * lead, 190, size),
    line('Paragraf dua baris dua', 72, 700 - 3 * lead, 185, size),
  ];
  const blocks = groupLinesIntoBlocks(lines);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].lines.length, 2);
  assert.equal(blocks[1].lines.length, 2);
  assert.equal(blocks[0].text, 'Paragraf satu baris satu\nParagraf satu baris dua');
  assert.equal(blocks[1].lines[0].str, 'Paragraf dua baris satu');
});

test('4. centered block ignores the indent-split rule', () => {
  const size = 12;
  const lead = 14;
  // Three lines all centered on along-coordinate 300, wildly different
  // widths/left-starts -- a naive indent check would split at line 2 (a0
  // jumps from 200 to 250, > 1.2em past the running left edge) if it only
  // looked at LEFT edges; the centered escape hatch must keep this as ONE
  // block because the CENTERS agree tightly.
  const lines = [
    line('Judul Tengah', 200, 700, 200, size), // a0=200 a1=400 center=300
    line('Sub', 250, 700 - lead, 100, size), // a0=250 a1=350 center=300
    line('Baris lebih panjang', 150, 700 - 2 * lead, 300, size), // a0=150 a1=450 center=300
  ];
  const blocks = groupLinesIntoBlocks(lines);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].lines.length, 3);
  assert.equal(blocks[0].align, 'center');
  assert.equal(blocks[0].editable, true);
});

test('5. two-column stacks (shared baselines) stay separate blocks', () => {
  const size = 12;
  const lead = 14;
  const ys = [700, 700 - lead, 700 - 2 * lead];
  const lines = [];
  for (const y of ys) {
    lines.push(line('Kolom Kiri', 72, y, 100, size));
    lines.push(line('Kolom Kanan', 330, y, 100, size));
  }
  const blocks = groupLinesIntoBlocks(lines);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].lines.length, 3);
  assert.equal(blocks[1].lines.length, 3);
  // Every line in each resolved block keeps its own column's x0.
  const xsOf = (b) => new Set(b.lines.map((l) => l.pdf.x0));
  assert.deepEqual(xsOf(blocks[0]), new Set([72]));
  assert.deepEqual(xsOf(blocks[1]), new Set([330]));
});

test('6. heading/body separate via the size gate', () => {
  const lead = 20;
  const lines = [
    line('JUDUL BESAR', 72, 760, 200, 16),
    line('Baris tubuh pertama', 72, 760 - lead, 220, 11),
    line('Baris tubuh kedua', 72, 760 - lead - 15, 220, 11),
  ];
  const blocks = groupLinesIntoBlocks(lines);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].lines.length, 1);
  assert.equal(blocks[0].editable, false);
  assert.equal(blocks[0].reason, 'single-line');
  assert.equal(blocks[1].lines.length, 2);
  assert.equal(blocks[1].size, 11);
  assert.equal(blocks[1].editable, true);
});

test('7. alignment: left (left edges agree, right ragged)', () => {
  const size = 12;
  const lead = 14;
  const lines = [
    line('Baris satu agak panjang', 72, 700, 220, size),
    line('Baris dua', 72, 700 - lead, 100, size),
    line('Baris tiga sedang', 72, 700 - 2 * lead, 160, size),
  ];
  const blocks = groupLinesIntoBlocks(lines);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].align, 'left');
  assert.equal(blocks[0].editable, true);
});

test('8. alignment: right (right edges agree, left ragged, monotonic a0)', () => {
  const size = 12;
  const lead = 14;
  // a1 (right edge) constant at 400; a0 strictly decreasing so the indent
  // gate (which only fires on RIGHTWARD jumps past the running left edge)
  // never fires regardless of the centered escape hatch.
  const lines = [
    line('kecil', 320, 700, 80, size), // a0=320 a1=400
    line('sedikit lebih panjang', 300, 700 - lead, 100, size), // a0=300 a1=400
    line('paling panjang di sini', 250, 700 - 2 * lead, 150, size), // a0=250 a1=400
  ];
  const blocks = groupLinesIntoBlocks(lines);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].align, 'right');
  assert.equal(blocks[0].editable, true);
});

test('9. alignment: justify (both edges agree, last line exempt)', () => {
  const size = 11;
  const lead = 15;
  const lines = [
    line('Baris pertama penuh', 72, 700, 328, size),
    line('Baris kedua penuh juga', 72, 700 - lead, 328, size),
    line('Baris ketiga tetap penuh', 72, 700 - 2 * lead, 328, size),
    line('Baris terakhir pendek', 72, 700 - 3 * lead, 180, size), // ragged, exempt
  ];
  const blocks = groupLinesIntoBlocks(lines);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].align, 'justify');
  assert.equal(blocks[0].editable, true);
});

test('10. alignment: unknown -> declines to line mode (reason align-unknown)', () => {
  const size = 12;
  const lead = 14;
  // a0 strictly decreasing (dodges the indent gate, like test 8) but a1
  // varies with no coherent pattern relative to a0 -- left, right, AND
  // center all fail to agree.
  const lines = [
    line('a', 150, 700, 150, size), // a0=150 a1=300
    line('b', 120, 700 - lead, 380, size), // a0=120 a1=500
    line('c', 90, 700 - 2 * lead, 160, size), // a0=90 a1=250
  ];
  const blocks = groupLinesIntoBlocks(lines);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].align, 'unknown');
  assert.equal(blocks[0].editable, false);
  assert.equal(blocks[0].reason, 'align-unknown');
});

test('11. bullet list -> declines to line mode (reason list)', () => {
  const size = 12;
  const lead = 15;
  const lines = [
    line('- Item pertama', 72, 700, 150, size),
    line('- Item kedua', 72, 700 - lead, 150, size),
    line('- Item ketiga', 72, 700 - 2 * lead, 150, size),
  ];
  const blocks = groupLinesIntoBlocks(lines);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].editable, false);
  assert.equal(blocks[0].reason, 'list');
});

test('12. numbered list marker also declines (reason list)', () => {
  const size = 12;
  const lead = 15;
  const lines = [
    line('1. Item pertama', 72, 700, 150, size),
    line('2. Item kedua', 72, 700 - lead, 150, size),
  ];
  const blocks = groupLinesIntoBlocks(lines);
  assert.equal(blocks[0].editable, false);
  assert.equal(blocks[0].reason, 'list');
});

test('13. single line -> declines to line mode (reason single-line)', () => {
  const lines = [line('Hanya satu baris', 72, 700, 200, 12)];
  const blocks = groupLinesIntoBlocks(lines);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].lines.length, 1);
  assert.equal(blocks[0].editable, false);
  assert.equal(blocks[0].reason, 'single-line');
});

test('14. mixed fonts -> declines to line mode (reason mixed-fonts)', () => {
  const size = 12;
  const lead = 14;
  const lines = [
    line('Baris reguler yang lebih panjang', 72, 700, 220, size, { fontName: 'Arial' }),
    line('Baris tebal', 72, 700 - lead, 220, size, { fontName: 'Arial-Bold' }),
  ];
  const blocks = groupLinesIntoBlocks(lines);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].mixedFonts, true);
  assert.equal(blocks[0].editable, false);
  assert.equal(blocks[0].reason, 'mixed-fonts');
});

test('15. order-independence: shuffled input yields the same blocks', () => {
  const size = 12;
  const lead = 14;
  const gap = 28;
  const lines = [
    line('Satu', 72, 700, 200, size),
    line('Dua', 72, 700 - lead, 200, size),
    line('Tiga', 72, 700 - 2 * lead, 200, size),
    line('Empat', 72, 700 - 2 * lead - gap, 200, size),
    line('Lima', 72, 700 - 2 * lead - gap - lead, 200, size),
  ];
  const shuffled = [lines[3], lines[0], lines[4], lines[2], lines[1]];

  const blocksOrdered = groupLinesIntoBlocks(lines);
  const blocksShuffled = groupLinesIntoBlocks(shuffled);

  assert.equal(blocksShuffled.length, blocksOrdered.length);
  const textsOrdered = blocksOrdered.map((b) => b.text);
  const textsShuffled = blocksShuffled.map((b) => b.text);
  assert.deepEqual(textsShuffled, textsOrdered);
});

test('16. rotated paragraph (ux=0, uy=1) groups correctly', () => {
  const size = 12;
  const lead = 14;
  // Baseline direction points "up" the page; leading steps along x instead
  // of y. Geometry is direction-relative, so the same five gates apply.
  const lines = [
    line('Baris rotasi satu', 100, 0, 200, size, { ux: 0, uy: 1 }),
    line('Baris rotasi dua', 100 + lead, 0, 200, size, { ux: 0, uy: 1 }),
    line('Baris rotasi tiga', 100 + 2 * lead, 0, 200, size, { ux: 0, uy: 1 }),
  ];
  const blocks = groupLinesIntoBlocks(lines);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].lines.length, 3);
  assert.equal(blocks[0].box.pdf.ux, 0);
  assert.equal(blocks[0].box.pdf.uy, 1);
  assert.equal(blocks[0].editable, true);
});

test('17. empty input -> []', () => {
  assert.deepEqual(groupLinesIntoBlocks([]), []);
  assert.deepEqual(groupLinesIntoBlocks(undefined), []);
});

test('18. box.pdf along-range spans the widest line; width is the reflow boundary', () => {
  const size = 12;
  const lead = 14;
  const lines = [
    line('Pendek', 72, 700, 100, size),
    line('Baris yang jauh lebih panjang dari yang lain', 72, 700 - lead, 300, size),
  ];
  const blocks = groupLinesIntoBlocks(lines);
  assert.equal(blocks.length, 1);
  const { pdf } = blocks[0].box;
  assert.equal(pdf.a0, 72);
  assert.equal(pdf.a1, 372); // 72 + 300, the longer line's end
  assert.equal(pdf.a1 - pdf.a0, 300);
});
