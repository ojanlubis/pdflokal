/*
 * Paragraph detector (core/paragraph-detect.js) — headless, synthetic lines.
 * Pins the property the soft split relies on: a line inside running prose
 * (>= 3 consecutive lines, same size, regular leading, one shared edge,
 * similar or justified widths, last line free to be short) is marked, and
 * anything that merely looks column-like or list-like is not. The detector
 * reads geometry only; the non-Latin and shuffled-order cases prove it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectParagraphs, blocksFromLines, PARAGRAPH_MIN_LINES } from '../../js/core/paragraph-detect.js';

// One synthetic Line. `a` = along-start, `p` = perpendicular (y for horizontal
// text, PDF y-up), `len` = along extent. dir is horizontal unless given.
function line(a, p, len, size = 12, opts = {}) {
  const ux = opts.ux ?? 1;
  const uy = opts.uy ?? 0;
  // x0,y0 such that along = a and perp = p for the given direction.
  const x0 = a * ux - p * uy;
  const y0 = a * uy + p * ux;
  return {
    str: opts.str ?? 'x',
    x: Math.min(x0, x0 + ux * len),
    y: Math.min(y0, y0 + uy * len),
    w: Math.abs(ux * len) || size,
    h: Math.abs(uy * len) || size,
    size,
    pdf: { x0, y0, ux, uy, len, size },
  };
}

// A justified paragraph: n lines, left edge `a`, full width W, leading L,
// first baseline at p0 (descending), last line short.
function paragraph(n, { a = 50, p0 = 700, W = 400, L = 14.4, size = 12, last = 150, ...o } = {}) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(line(a, p0 - i * L, i === n - 1 ? last : W, size, o));
  return out;
}

test('1. a justified paragraph (short last line) is ONE block covering every line', () => {
  const lines = paragraph(5);
  const { blocks, blockOf } = detectParagraphs(lines);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blockOf, [0, 0, 0, 0, 0]);
  assert.deepEqual(blocks[0].lineIdx, [0, 1, 2, 3, 4]);
  assert.equal(blocks[0].align, 'left');
  // bbox spans the lines' own boxes
  assert.equal(blocks[0].bbox.x, 50);
  assert.equal(blocks[0].bbox.w, 400);
  assert.ok(blocks[0].bbox.h > 4 * 14.4);
});

test('2. fewer than 3 consecutive lines is not a block', () => {
  assert.equal(PARAGRAPH_MIN_LINES, 3);
  const { blocks, blockOf } = detectParagraphs(paragraph(2));
  assert.equal(blocks.length, 0);
  assert.deepEqual(blockOf, [-1, -1]);
  assert.deepEqual(detectParagraphs([]).blocks, []);
  assert.deepEqual(detectParagraphs(undefined).blockOf, []);
});

test('3. a short MIDDLE line breaks "similar widths" (a list or form column, not prose)', () => {
  const lines = [line(50, 700, 400), line(50, 685.6, 120), line(50, 671.2, 400), line(50, 656.8, 100)];
  const { blocks } = detectParagraphs(lines);
  assert.equal(blocks.length, 0);
});

test('4. font size: within +/-5% stays one block, a 10% step does not', () => {
  const within = [line(50, 700, 400, 12), line(50, 685.6, 400, 12.4), line(50, 671.2, 150, 12.2)];
  assert.equal(detectParagraphs(within).blocks.length, 1);
  const stepped = [line(50, 700, 400, 12), line(50, 685.6, 400, 13.4), line(50, 671.2, 150, 13.4)];
  assert.equal(detectParagraphs(stepped).blocks.length, 0, 'only two same-size lines remain');
});

test('5. a blank line between two paragraphs cuts them into two blocks', () => {
  const a = paragraph(4, { p0: 700 });
  const b = paragraph(4, { p0: 700 - 3 * 14.4 - 28.8 });
  const { blocks, blockOf } = detectParagraphs([...a, ...b]);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blockOf, [0, 0, 0, 0, 1, 1, 1, 1]);
});

test('6. irregular leading (gap drifting past +/-20% of the median) is not one block', () => {
  const lines = [line(50, 700, 400), line(50, 685.6, 400), line(50, 671.2, 400), line(50, 640, 400), line(50, 618, 150)];
  const { blockOf } = detectParagraphs(lines);
  assert.deepEqual(blockOf.slice(0, 3), [0, 0, 0]);
  assert.equal(blockOf[3], -1);
  assert.equal(blockOf[4], -1);
});

test('7. a ragged left edge is not a block', () => {
  const lines = [line(50, 700, 400), line(70, 685.6, 400), line(55, 671.2, 400), line(80, 656.8, 150)];
  assert.equal(detectParagraphs(lines).blocks.length, 0);
});

test('8. two columns sharing baselines make two blocks and never braid', () => {
  const left = paragraph(4, { a: 50, W: 200 });
  const right = paragraph(4, { a: 320, W: 200 });
  const interleaved = [];
  for (let i = 0; i < 4; i += 1) interleaved.push(left[i], right[i]);
  const { blocks, blockOf } = detectParagraphs(interleaved);
  assert.equal(blocks.length, 2);
  assert.notEqual(blockOf[0], blockOf[1]);
  assert.equal(blockOf[0], blockOf[2]);
  assert.equal(blockOf[1], blockOf[3]);
  assert.equal(blocks[0].lineIdx.length, 4);
  assert.equal(blocks[1].lineIdx.length, 4);
});

test('9. a rotated (vertical) paragraph is detected by the same arithmetic', () => {
  const lines = paragraph(4, { ux: 0, uy: 1 });
  const { blocks } = detectParagraphs(lines);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].lineIdx.length, 4);
});

test('10. right-flush prose (ragged left, short last line on the left) is a block, align right', () => {
  // right edge at 450; lines run leftward to varying starts, last one short.
  const lines = [line(60, 700, 390), line(40, 685.6, 410), line(75, 671.2, 375), line(300, 656.8, 150)];
  const { blocks } = detectParagraphs(lines);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].align, 'right');
});

test('10b. a justified list is NOT right-flush prose: marker line at the margin, wrapped lines under the text', () => {
  // right edge flush at 450 on every line, but 2 of 3 lines share the hanging left edge
  const lines = [line(50, 700, 400), line(75, 685.6, 375), line(75, 671.2, 375)];
  assert.equal(detectParagraphs(lines).blocks.length, 0);
});

test('11. a first-line indent still belongs to the block', () => {
  const lines = [line(80, 700, 370), line(50, 685.6, 400), line(50, 671.2, 400), line(50, 656.8, 130)];
  const { blocks } = detectParagraphs(lines);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].lineIdx.length, 4);
});

test('12. the detector never reads text: non-Latin and empty strings give the same blocks', () => {
  const latin = paragraph(4);
  const mixed = paragraph(4).map((l, i) => ({ ...l, str: ['日本語のテキスト', 'نص عربي طويل', '', 'Ünïcödé ✓'][i] }));
  assert.deepEqual(detectParagraphs(mixed).blockOf, detectParagraphs(latin).blockOf);
  assert.equal(detectParagraphs(mixed).blocks.length, 1);
});

test('13. order-independent: shuffling the input changes which index is where, not the membership', () => {
  const lines = paragraph(5);
  const shuffled = [lines[3], lines[0], lines[4], lines[2], lines[1]];
  const { blockOf } = detectParagraphs(shuffled);
  assert.deepEqual(blockOf, [0, 0, 0, 0, 0]);
});

test('14. blocksFromLines regroups stamped lines into blocks with a bbox, in reading order', () => {
  const lines = paragraph(4).map((l) => ({ ...l, blockId: 0 }));
  const loose = { ...line(300, 500, 40), blockId: null };
  const [blk] = blocksFromLines([loose, lines[2], lines[0], lines[3], lines[1]]);
  assert.equal(blk.id, 0);
  assert.equal(blk.lines.length, 4);
  assert.equal(blk.lines[0], lines[0], 'top line first');
  assert.equal(blk.bbox.x, 50);
  assert.equal(blk.bbox.w, 400);
  assert.deepEqual(blocksFromLines([loose]), []);
});

// --- what must NOT be called prose: gutters, list tails, hanging items -----

// Give a synthetic line real runs: pieces = [[along-start, len], ...].
function withRuns(l, pieces) {
  const { ux, uy, size } = l.pdf;
  const p = -l.pdf.x0 * uy + l.pdf.y0 * ux;
  return {
    ...l,
    runs: pieces.map(([a, len]) => ({
      str: 'x',
      pdf: { x0: a * ux - p * uy, y0: a * uy + p * ux, ux, uy, len, size },
    })),
  };
}

test('15. aligned gutter: one-line list items whose gap ends at the same x are a list, not a block', () => {
  // marker 50..70, gap 0.8em (9.6), text from 79.6 to 450, on four items
  const items = [0, 1, 2, 3].map((i) => withRuns(line(50, 700 - i * 14.4, 400), [[50, 20], [79.6, 370.4]]));
  assert.equal(detectParagraphs(items).blocks.length, 0);
  // the same four lines with NO wide gap (plain prose runs) are a block
  const prose = [0, 1, 2, 3].map((i) => withRuns(line(50, 700 - i * 14.4, i === 3 ? 150 : 400), [[50, 100], [150.5, i === 3 ? 50 : 300]]));
  assert.equal(detectParagraphs(prose).blocks.length, 1);
});

test('16. one wide gap in one justified line is NOT a gutter: the paragraph stays a block', () => {
  const lines = paragraph(5).map((l, i) => (i === 2 ? withRuns(l, [[50, 60], [119.6, 330.4]]) : withRuns(l, [[50, l.pdf.len]])));
  assert.equal(detectParagraphs(lines).blocks.length, 1);
});

test('17. a short last line that carries a wide gap (a list item under a lead-in) is trimmed off the block', () => {
  const body = [0, 1, 2, 3].map((i) => withRuns(line(50, 700 - i * 14.4, 400), [[50, 400]]));
  const item = withRuns(line(50, 700 - 4 * 14.4, 150), [[50, 20], [79.6, 120.4]]);
  const { blocks, blockOf } = detectParagraphs([...body, item]);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blockOf, [0, 0, 0, 0, -1]);
  // the same short tail WITHOUT a wide gap is the paragraph's own last line
  const tail = withRuns(line(50, 700 - 4 * 14.4, 150), [[50, 150]]);
  assert.deepEqual(detectParagraphs([...body, tail]).blockOf, [0, 0, 0, 0, 0]);
});

test('18. a justified list: markers at the margin around a wrapped paragraph keep only the paragraph', () => {
  // right edge flush at 450; "1." and "2." lines start at 36, wrapped lines at 65
  const lines = [
    line(36, 700, 414), line(65, 685.6, 385), line(65, 671.2, 385), line(65, 656.8, 385), line(36, 642.4, 414),
  ];
  const { blocks, blockOf } = detectParagraphs(lines);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blockOf, [-1, 0, 0, 0, -1]);
});
