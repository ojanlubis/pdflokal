/*
 * Rung C — text-lines clustering (headless).
 * Pins the two-pass geometry (baseline pass by perp-offset + direction,
 * along pass with the column guard) that turns pdf.js RUNS — painting
 * artifacts, split at kerning/font boundaries by exporters like Word — into
 * the LINE the founder ruled (2026-07-19) is the real editing primitive for
 * "Ganti Teks". Synthetic run arrays only; no PDFs, no vendor imports.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupRunsIntoLines } from '../../js/core/text-lines.js';

// Build one synthetic run. Horizontal by default (ux=1, uy=0); pass
// { ux, uy } for other directions. Display fields mirror the pdf geometry
// with an identity mapping — fine for these tests, which assert on `pdf`
// geometry and `str`, never on exact display pixel boxes.
function run(str, x0, y0, len, size, opts = {}) {
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
  };
}

test('1. kern-fragments on one baseline, ~0 gaps -> ONE line, no extra spaces', () => {
  const runs = [
    run('Kern', 0, 0, 24, 12),
    run('ing', 24, 0, 18, 12),
    run('Test', 42, 0, 24, 12),
  ];
  const lines = groupRunsIntoLines(runs);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].str, 'KerningTest');
});

test('2. 0.3em gap with no boundary whitespace -> joined WITH one space; ' +
  'same gap but prev already ends with a space -> no doubled space', () => {
  const size = 12;
  const gap = 0.3 * size; // 3.6, above the 0.18*size (2.16) space threshold

  const noSpace = [
    run('Perihal:', 0, 0, 48, size),
    run('Undangan', 48 + gap, 0, 48, size),
  ];
  const linesA = groupRunsIntoLines(noSpace);
  assert.equal(linesA.length, 1);
  assert.equal(linesA[0].str, 'Perihal: Undangan');

  const alreadySpaced = [
    run('Perihal: ', 0, 0, 48, size), // prev already ends with a space
    run('Undangan', 48 + gap, 0, 48, size),
  ];
  const linesB = groupRunsIntoLines(alreadySpaced);
  assert.equal(linesB.length, 1);
  assert.equal(linesB[0].str, 'Perihal: Undangan'); // not doubled
});

test('3. column guard: two runs on one baseline, 3em gap -> TWO lines', () => {
  const size = 12;
  const runs = [
    run('Kolom Kiri', 0, 0, 24, size),
    run('Kolom Kanan', 24 + 3 * size, 0, 30, size), // 36pt gutter > 1.5*12=18
  ];
  const lines = groupRunsIntoLines(runs);
  assert.equal(lines.length, 2);
});

test('4. two baselines 1.2em apart (12pt text, 14.4pt leading) -> two lines', () => {
  const size = 12;
  const leading = 1.2 * size; // 14.4, above the 0.35*12=4.2 perp tolerance
  const runs = [
    run('Line one', 0, 0, 48, size),
    run('Line two', 0, -leading, 48, size),
  ];
  const lines = groupRunsIntoLines(runs);
  assert.equal(lines.length, 2);
});

test('5. superscript-ish: documented v1 behavior — merges into the base line', () => {
  // Small run (size 6) sits 0.3*12=3.6 above a 12pt run's baseline, inside
  // its horizontal span. Tolerance is 0.35*max(6,12) = 4.2, which is bigger
  // than the 3.6 offset -> the perp gate lets it join the same baseline
  // group, and the along pass doesn't split it out either (it sits fully
  // inside the big run's a0..a1 span, so the gap is negative). This is
  // accepted v1 behavior, not a bug: distinguishing a superscript from a
  // genuinely separate short line at this offset needs more than geometry
  // (baseline-shift metadata pdf.js doesn't expose here) — pinned so a
  // future tightening of the tolerance is a deliberate choice, not a
  // silent regression.
  const runs = [
    run('Text', 0, 0, 48, 12),
    run('2', 10, 3.6, 6, 6),
  ];
  const lines = groupRunsIntoLines(runs);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].runs.length, 2);
});

test('6. rotated runs group by the same rules; a horizontal run at a similar p ' +
  'does NOT join (direction gate)', () => {
  const runs = [
    run('Up', 0, 0, 24, 12, { ux: 0, uy: 1 }),
    run('Text', 0, 24, 30, 12, { ux: 0, uy: 1 }), // continues the vertical baseline
    run('Side', 5, 0.5, 20, 12), // p ~= 0.5, close to the vertical pair's p=0
  ];
  const lines = groupRunsIntoLines(runs);
  assert.equal(lines.length, 2);
  const vertical = lines.find((l) => l.runs.length === 2);
  const horizontal = lines.find((l) => l.runs.length === 1);
  assert.ok(vertical, 'the two vertical runs should merge into one line');
  assert.ok(horizontal, 'the horizontal run should stay its own line');
  assert.equal(vertical.str, 'UpText');
  assert.equal(horizontal.str, 'Side');
});

test('7. unsorted input (paint order scrambled) -> same result as sorted', () => {
  const size = 12;
  const sorted = [
    run('Kern', 0, 0, 24, size),
    run('ing', 24, 0, 18, size),
    run('Kolom Kanan', 42 + 3 * size, 0, 30, size),
  ];
  const scrambled = [sorted[2], sorted[0], sorted[1]];

  const linesSorted = groupRunsIntoLines(sorted);
  const linesScrambled = groupRunsIntoLines(scrambled);

  assert.equal(linesScrambled.length, linesSorted.length);
  const strsSorted = linesSorted.map((l) => l.str).sort();
  const strsScrambled = linesScrambled.map((l) => l.str).sort();
  assert.deepEqual(strsScrambled, strsSorted);
});

test('8. dominant style: 3-char bold fragment + 40-char regular fragment -> ' +
  'line takes the regular run\'s fontName/size', () => {
  const bold = run('Bld', 0, 0, 18, 14, { fontName: 'Arial-Bold', fontFamily: 'Arial' });
  const regular = run(
    'a'.repeat(40), 18, 0, 240, 11, { fontName: 'Arial', fontFamily: 'Arial' },
  );
  const lines = groupRunsIntoLines([bold, regular]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].fontName, 'Arial');
  assert.equal(lines[0].size, 11);
});

test('9. pdf.len spans first fragment start to last fragment end; ' +
  'pdf.x0/y0 = first fragment start', () => {
  const runs = [
    run('Kern', 0, 5, 24, 12),
    run('ing', 24, 5, 18, 12),
    run('Test', 42, 5, 24, 12),
  ];
  const lines = groupRunsIntoLines(runs);
  assert.equal(lines.length, 1);
  const { pdf } = lines[0];
  assert.equal(pdf.x0, 0);
  assert.equal(pdf.y0, 5);
  assert.equal(pdf.len, 42 + 24); // last run's a0 (42) + its len (24)
});

test('10. empty input -> []', () => {
  assert.deepEqual(groupRunsIntoLines([]), []);
  assert.deepEqual(groupRunsIntoLines(undefined), []);
});
