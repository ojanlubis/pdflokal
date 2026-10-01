/*
 * Soft split below the 1.5em column guard (core/text-lines.js, pass 3) — gated
 * by structure (list marker, colon) and vetoed inside a paragraph block.
 * Synthetic runs only. Measured on corpora 2026-10-01
 * (reference/line-split-measure-2026-10-01.md): a plain gap threshold cuts
 * prose 60-70% of the time; the gated rule did not. Each test below pins one
 * leg of that rule, or the property that makes it safe.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { groupRunsIntoLines } from '../../js/core/text-lines.js';
import { ocrLinesToPageLines } from '../../js/core/ocr-lines.js';

const SIZE = 12;

function run(str, x0, y0, len, size = SIZE) {
  return {
    str, x: x0, y: y0, w: len, h: size, size, fontName: 'F1', fontFamily: '',
    pdf: { x0, y0, ux: 1, uy: 0, len, size },
  };
}

// Two runs on one baseline with a gap of `gapEm` ems between them.
function pair(left, right, gapEm, { x = 50, y = 0, leftLen = 30, rightLen = 80 } = {}) {
  return [run(left, x, y, leftLen), run(right, x + leftLen + gapEm * SIZE, y, rightLen)];
}

const strs = (lines) => lines.map((l) => l.str);

// A 5-line justified paragraph, 400 wide, 14.4 leading, last line short. Line
// `at` (0-based) is built from two runs so it carries a wide-ish gap and
// `lead` as its first run text; the other lines are single runs.
function paragraphWith(at, lead, gapEm, rest = 'ini daftar yang dimaksud') {
  const runs = [];
  for (let i = 0; i < 5; i += 1) {
    const y = 700 - i * 14.4;
    const w = i === 4 ? 150 : 400;
    if (i === at) {
      const leadLen = 50;
      runs.push(run(lead, 50, y, leadLen));
      runs.push(run(rest, 50 + leadLen + gapEm * SIZE, y, w - leadLen - gapEm * SIZE));
    } else {
      runs.push(run('baris isi paragraf biasa', 50, y, w));
    }
  }
  return runs;
}

// --- leg (a): list marker -------------------------------------------------

test('1. marker leg: a list marker followed by a 0.8em gap splits off the marker', () => {
  for (const marker of ['a)', '1.', '1.1.', 'iii.', 'IV)', '(b)', '12)', '•', '-', '–']) {
    const lines = groupRunsIntoLines(pair(marker, 'isi butir daftar', 0.8));
    assert.equal(lines.length, 2, `marker ${marker} should split`);
    assert.equal(lines[0].str, marker);
    assert.equal(lines[1].str, 'isi butir daftar');
    assert.ok(lines.every((l) => l.splitReason === 'marker'), 'both pieces name the reason');
  }
});

test('2. marker leg negative: a word (not a marker) before a 0.8em gap does NOT split', () => {
  const lines = groupRunsIntoLines(pair('Nama', 'Budi Santoso', 0.8));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].splitReason, null);
});

test('3. marker leg only opens a row: a short cell mid-row is not a marker', () => {
  // [Kiri] ...3em column gap... [1.] 0.8em [teks]: the right cell "1." is not
  // the leftmost piece of its baseline, so the marker leg does not fire there.
  const runs = [
    run('Kiri', 50, 0, 30),
    run('1.', 50 + 30 + 3 * SIZE, 0, 12),
    run('teks', 50 + 30 + 3 * SIZE + 12 + 0.8 * SIZE, 0, 40),
  ];
  const lines = groupRunsIntoLines(runs);
  assert.equal(lines.length, 2);
  assert.deepEqual(strs(lines), ['Kiri', '1. teks']);
});

// --- leg (b): colon -------------------------------------------------------

test('4. colon leg: left piece ending in ":" splits; right piece starting with ":" splits', () => {
  const a = groupRunsIntoLines(pair('Nama:', 'Budi', 0.8));
  assert.deepEqual(strs(a), ['Nama:', 'Budi']);
  assert.ok(a.every((l) => l.splitReason === 'colon'));
  const b = groupRunsIntoLines(pair('Nama', ': Budi', 0.8));
  assert.deepEqual(strs(b), ['Nama', ': Budi']);
});

test('5. colon leg negative: a colon elsewhere in a piece does not split', () => {
  const lines = groupRunsIntoLines(pair('Nama', 'Budi: Santoso', 0.8));
  assert.equal(lines.length, 1);
});

test('6. threshold: a colon at 0.5em does not split, at 0.7em does; past 1.5em the old column guard splits regardless', () => {
  assert.equal(groupRunsIntoLines(pair('Nama:', 'Budi', 0.5)).length, 1);
  assert.equal(groupRunsIntoLines(pair('Nama:', 'Budi', 0.7)).length, 2);
  // column guard: splits with no colon and no marker, on every setting
  assert.equal(groupRunsIntoLines(pair('Kolom', 'Lain', 1.6)).length, 2);
  assert.equal(groupRunsIntoLines(pair('Kolom', 'Lain', 1.6), { softSplit: false }).length, 2);
});

// --- ungated gap: no evidence, no split -----------------------------------

test('7. a wide-ish gap with no marker and no colon never splits (the measured failure of a plain threshold)', () => {
  const lines = groupRunsIntoLines(pair('kata pertama', 'kata kedua', 1.2));
  assert.equal(lines.length, 1);
});

// --- leg (c): column, implemented but OFF ---------------------------------

// Rows where the left piece fills 70pt so every value starts at the same x.
function alignedRows(n) {
  const runs = [];
  for (let i = 0; i < n; i += 1) {
    runs.push(run('label', 50, 700 - i * 30, 70));
    runs.push(run('nilai', 50 + 70 + 0.8 * SIZE, 700 - i * 30, 20 + i * 11));
  }
  return runs;
}

test('8. column leg is OFF by default: aligned label/value rows with no marker or colon stay whole', () => {
  const lines = groupRunsIntoLines(alignedRows(8));
  assert.equal(lines.length, 8);
  assert.ok(lines.every((l) => l.splitReason === null));
});

test('9. column leg, switched on: >= N rows sharing the column split; fewer than N do not', () => {
  const on = groupRunsIntoLines(alignedRows(8), { softSplit: { column: 6 } });
  assert.equal(on.length, 16);
  assert.ok(on.every((l) => l.splitReason === 'column'));
  const few = groupRunsIntoLines(alignedRows(4), { softSplit: { column: 6 } });
  assert.equal(few.length, 4);
});

// --- the paragraph guard --------------------------------------------------

test('10. A JUSTIFIED PARAGRAPH LINE WITH A COLON IS NOT SPLIT (the guard, with a colon at a wide gap)', () => {
  const lines = groupRunsIntoLines(paragraphWith(2, 'Berikut:', 0.8));
  assert.equal(lines.length, 5, 'one Line per paragraph line');
  assert.ok(lines.every((l) => l.blockId === 0), 'all five are the same block');
  assert.ok(lines.every((l) => l.splitReason === null));
  assert.ok(lines.some((l) => l.str.startsWith('Berikut: ')), 'the colon line is intact');
});

test('11. the same paragraph WITHOUT the guard splits that line: the guard is what holds it together', () => {
  const lines = groupRunsIntoLines(paragraphWith(2, 'Berikut:', 0.8), { softSplit: { guard: false } });
  assert.equal(lines.length, 6);
  assert.ok(lines.some((l) => l.splitReason === 'colon'));
});

test('12. a marker-led line inside a block is not split; without the guard it is', () => {
  const runs = paragraphWith(0, '1.', 0.8);
  const guarded = groupRunsIntoLines(runs);
  assert.equal(guarded.length, 5);
  assert.equal(groupRunsIntoLines(runs, { softSplit: { guard: false } }).length, 6);
});

test('13. the guard vetoes only blocks: label/value rows of unequal widths (no block) still split on the colon', () => {
  const rows = [['Nama:', 'Budi', 90], ['Alamat:', 'Jalan Merdeka No. 1 Jakarta', 70], ['Telepon:', '0812', 60], ['Email:', 'a@b.id', 95]];
  const runs = [];
  rows.forEach(([label, value, w], i) => {
    runs.push(run(label, 50, 700 - i * 30, 40));
    runs.push(run(value, 50 + 40 + 0.8 * SIZE, 700 - i * 30, w));
  });
  const lines = groupRunsIntoLines(runs);
  assert.equal(lines.length, 8);
  assert.ok(lines.every((l) => l.blockId === null));
});

// --- shape: additive only, off-switch is the old behaviour -----------------

test('14. softSplit:false is exactly the pre-split behaviour; the new Line fields are additive', () => {
  const runs = pair('Nama:', 'Budi', 0.8);
  const off = groupRunsIntoLines(runs, { softSplit: false });
  assert.equal(off.length, 1);
  assert.equal(off[0].str, 'Nama: Budi');
  const legacy = Object.keys(off[0]).filter((k) => k !== 'blockId' && k !== 'splitReason').sort();
  assert.deepEqual(legacy, ['fontFamily', 'fontName', 'h', 'pdf', 'runs', 'size', 'str', 'w', 'x', 'y']);
  assert.equal(off[0].blockId, null);
  assert.equal(off[0].splitReason, null);
});

test('15. a piece keeps its own geometry: pdf extent and display box cover only its runs', () => {
  const [a, b] = groupRunsIntoLines(pair('Nama:', 'Budi', 0.8, { leftLen: 30, rightLen: 80 }));
  assert.equal(a.pdf.len, 30);
  assert.equal(b.pdf.len, 80);
  assert.equal(a.pdf.x0, 50);
  assert.equal(b.pdf.x0, 50 + 30 + 0.8 * SIZE);
  assert.ok(a.x + a.w <= b.x);
});

test('16. order-independent: shuffled runs give the same lines', () => {
  const runs = [...pair('Nama:', 'Budi', 0.8), ...pair('a)', 'butir', 0.8, { y: -30 })];
  const fwd = strs(groupRunsIntoLines(runs)).sort();
  const rev = strs(groupRunsIntoLines([...runs].reverse())).sort();
  assert.deepEqual(fwd, rev);
  assert.equal(fwd.length, 4);
});

// --- OCR is not routed through here ---------------------------------------

test('17. OCR lines never go through the soft split: a marker or colon at a wide gap stays one line', () => {
  const page = ocrLinesToPageLines({
    lines: [
      { text: 'a)     isi butir', confidence: 90, bbox: { x0: 100, y0: 100, x1: 400, y1: 130 } },
      { text: 'Nama:      Budi', confidence: 90, bbox: { x0: 100, y0: 150, x1: 400, y1: 180 } },
    ],
  }, 1);
  assert.equal(page.length, 2);
  // word-banded fallback too: wide gaps between words of one row stay one line
  const words = ocrLinesToPageLines({
    words: [
      { text: 'a)', confidence: 90, bbox: { x0: 100, y0: 100, x1: 120, y1: 130 } },
      { text: 'isi', confidence: 90, bbox: { x0: 200, y0: 100, x1: 240, y1: 130 } },
    ],
  }, 1);
  assert.equal(words.length, 1);
  const src = readFileSync(new URL('../../js/core/ocr-lines.js', import.meta.url), 'utf8');
  assert.ok(!/import[^;]*text-lines/.test(src), 'ocr-lines.js must not import text-lines.js');
});

// --- guard boundaries, end to end ------------------------------------------

test('18. a column of one-line list items (aligned gutter, equal widths) is split on every marker', () => {
  const runs = [];
  ['a)', 'b)', 'c)', 'd)'].forEach((m, i) => {
    runs.push(run(m, 50, 700 - i * 14.4, 14));
    runs.push(run('isi butir daftar yang cukup panjang untuk satu baris penuh', 50 + 14 + 0.8 * SIZE, 700 - i * 14.4, 400 - 14 - 0.8 * SIZE));
  });
  const lines = groupRunsIntoLines(runs);
  assert.equal(lines.length, 8);
  assert.ok(lines.every((l) => l.blockId === null));
});

test('19. a short list item under a lead-in sentence is split off; the paragraph above is not touched', () => {
  const runs = [];
  for (let i = 0; i < 4; i += 1) runs.push(run('baris isi paragraf biasa', 50, 700 - i * 14.4, 400));
  runs.push(run('a.', 50, 700 - 4 * 14.4, 14));
  runs.push(run('butir daftar', 50 + 14 + 0.8 * SIZE, 700 - 4 * 14.4, 120));
  const lines = groupRunsIntoLines(runs);
  assert.equal(lines.length, 6);
  assert.equal(lines.filter((l) => l.blockId === 0).length, 4);
  assert.deepEqual(strs(lines.filter((l) => l.splitReason === 'marker')), ['a.', 'butir daftar']);
});
