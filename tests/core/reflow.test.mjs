/*
 * Rung D2 — reflow.js wrap + alignment engine (headless).
 * Pins the greedy word-wrap + per-line placement math from
 * spec-rung-d-reflow.md §3, against a FAKE measurer (10 units/char) so the
 * tests assert on exact known boundaries rather than real font metrics.
 * No PDFs, no vendor imports — see text-lines.test.mjs / text-walk.test.mjs
 * for the same discipline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrapText, layoutLines, reflow } from '../../js/core/reflow.js';

// Fake measurer: 10 units per character, so widths are trivially
// predictable and boundary cases (exact fit, one unit over) are exact.
const CHAR_W = 10;
const widthOf = (str) => str.length * CHAR_W;

test('1. basic greedy wrap at a known boundary', () => {
  // "aaaaa bbbbb" = 11 chars * 10 = 110, exactly maxWidth -> fits on one
  // line; adding "ccccc" would be 17*10=170 > 110 -> new line.
  const lines = wrapText('aaaaa bbbbb ccccc', { widthOf, maxWidth: 110 });
  assert.deepEqual(lines.map((l) => l.text), ['aaaaa bbbbb', 'ccccc']);
  assert.equal(lines[0].width, 110);
  assert.equal(lines[1].width, 50);
});

test('2. word exactly at maxWidth fits (no phantom overflow)', () => {
  const lines = wrapText('aaaaaaaaaa', { widthOf, maxWidth: 100 }); // 10 chars * 10 = 100
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'aaaaaaaaaa');
  assert.equal(lines[0].width, 100);
});

test('3. word one unit over maxWidth wraps to its own line', () => {
  // "aaaaa bbbbb" = 110, one unit over maxWidth=109 -> splits into two
  // lines, each word alone fitting comfortably.
  const lines = wrapText('aaaaa bbbbb', { widthOf, maxWidth: 109 });
  assert.deepEqual(lines.map((l) => l.text), ['aaaaa', 'bbbbb']);
  assert.equal(lines[0].width, 50);
  assert.equal(lines[1].width, 50);
});

test('4. a single word wider than maxWidth overflows on its own line, unbroken', () => {
  const lines = wrapText('aaaaaaaaaa', { widthOf, maxWidth: 50 }); // width 100 > 50
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'aaaaaaaaaa'); // never broken mid-word
  assert.equal(lines[0].width, 100); // true width kept, never scaled down
});

test('5. \\n hard breaks a line, including double \\n -> empty line entry', () => {
  const lines = wrapText('Baris satu\n\nBaris tiga', { widthOf, maxWidth: 100000 });
  assert.deepEqual(lines.map((l) => l.text), ['Baris satu', '', 'Baris tiga']);
  assert.deepEqual(lines.map((l) => l.hardBreak), [true, true, false]);
  assert.equal(lines[1].width, 0);
});

test('6. whitespace collapse + trim: interior runs collapse, edges trim', () => {
  const lines = wrapText('  Halo   dunia  ', { widthOf, maxWidth: 100000 });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'Halo dunia');
  assert.equal(lines[0].width, widthOf('Halo dunia'));
});

test('7. align left/right/center dx math', () => {
  const wrapped = [{ text: 'abc', width: 30, hardBreak: false }];
  const maxWidth = 100;

  const left = layoutLines(wrapped, { align: 'left', maxWidth, spaceWidthOf: undefined });
  assert.equal(left[0].dx, 0);

  const right = layoutLines(wrapped, { align: 'right', maxWidth, spaceWidthOf: undefined });
  assert.equal(right[0].dx, 70); // maxWidth - width

  const center = layoutLines(wrapped, { align: 'center', maxWidth, spaceWidthOf: undefined });
  assert.equal(center[0].dx, 35); // (maxWidth - width) / 2
});

test('8. justify distributes extra equally across gaps, exempts the last line', () => {
  // Line 0: "aa bb cc dd" -> 3 gaps, width 110 (11 chars * 10). Not last, not
  // hard-break -> gets distributed extra. Line 1 is the layout's LAST line
  // -> exempt (dx 0, extra 0) even though align is justify.
  const wrapped = [
    { text: 'aa bb cc dd', width: 110, hardBreak: false },
    { text: 'ee', width: 20, hardBreak: false },
  ];
  const maxWidth = 140;
  const laid = layoutLines(wrapped, { align: 'justify', maxWidth, spaceWidthOf: undefined });

  assert.equal(laid[0].dx, 0); // justify dx is always 0
  assert.equal(laid[0].wordGapExtra, (140 - 110) / 3);

  assert.equal(laid[1].dx, 0);
  assert.equal(laid[1].wordGapExtra, 0); // last line of the whole layout
});

test('9. justify skips hard-break lines and single-word lines (even with gaps or none)', () => {
  const wrapped = [
    // Multi-word, hard-break-terminated (a typed paragraph break) -> exempt
    // despite having 2 gaps, and it is NOT the last line of the layout.
    { text: 'aa bb cc', width: 80, hardBreak: true },
    // Single word, no gaps at all -> exempt.
    { text: 'dd', width: 20, hardBreak: false },
    // Genuinely justifiable line so the previous two aren't exempt merely
    // because they're "close to the end".
    { text: 'ee ff gg', width: 80, hardBreak: false },
    // Final line of the whole layout -> exempt regardless.
    { text: 'hh', width: 20, hardBreak: false },
  ];
  const maxWidth = 150;
  const laid = layoutLines(wrapped, { align: 'justify', maxWidth, spaceWidthOf: undefined });

  assert.equal(laid[0].wordGapExtra, 0); // hard-break line
  assert.equal(laid[1].wordGapExtra, 0); // zero gaps
  assert.equal(laid[2].wordGapExtra, (150 - 80) / 2); // the one real justify case
  assert.equal(laid[3].wordGapExtra, 0); // last line of layout
});

test('10. gapCount is derived from wrapText\'s post-collapse text', () => {
  // Irregular input spacing collapses to single spaces before layoutLines
  // ever sees it, so gapCount == 2 for three words, not the raw space runs.
  const wrapped = wrapText('a   b     c\nd e', { widthOf, maxWidth: 100000 });
  assert.equal(wrapped[0].text, 'a b c'); // 2 real gaps after collapse
  const laid = layoutLines(wrapped, { align: 'justify', maxWidth: 200, spaceWidthOf: undefined });
  // Line 0 is hard-break-terminated (the \n) -> exempt regardless of gaps;
  // prove the gap count itself by re-running the same line as non-hard-break.
  assert.equal(laid[0].wordGapExtra, 0);
  const nonHardBreak = [{ text: 'a b c', width: widthOf('a b c'), hardBreak: false }, { text: 'd', width: 10, hardBreak: false }];
  const laid2 = layoutLines(nonHardBreak, { align: 'justify', maxWidth: 200, spaceWidthOf: undefined });
  assert.equal(laid2[0].wordGapExtra, (200 - widthOf('a b c')) / 2); // 2 gaps
});

test('11. empty string input -> empty array (no draft at all)', () => {
  assert.deepEqual(wrapText('', { widthOf, maxWidth: 100 }), []);
});

test('12. text of only spaces -> single empty line (documented choice)', () => {
  // Distinguishes "nothing typed" (test 11, [] ) from "typed something that
  // collapses to blank" — consistent with how a blank segment between two
  // '\n's also yields one empty line entry (test 5), rather than vanishing.
  const lines = wrapText('    ', { widthOf, maxWidth: 100 });
  assert.deepEqual(lines, [{ text: '', width: 0, hardBreak: false }]);
});

test('reflow() composes wrapText + layoutLines', () => {
  const laid = reflow('aaaaa bbbbb ccccc', { widthOf, maxWidth: 110, align: 'right' });
  assert.deepEqual(laid.map((l) => l.text), ['aaaaa bbbbb', 'ccccc']);
  assert.equal(laid[0].dx, 0); // 110 - 110
  assert.equal(laid[1].dx, 60); // 110 - 50
  assert.equal(laid[0].wordGapExtra, 0); // align !== justify
});
