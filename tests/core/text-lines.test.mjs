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
import { groupRunsIntoLines, resolveTap } from '../../js/core/text-lines.js';

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

test('3. REGRESSION GUARD: a real multi-word line with 5 similarly-sized ' +
  'word gaps (varying per-run size) -> every gap still gets its space', () => {
  // Exact numbers from perpres-letterhead.pdf's real line "sebagaimana
  // dimaksud pada ayat (1) paling sedikit" (6 runs / 5 genuine word gaps,
  // sizes 13.5/15/16/16.5/15.5/13.5 — this fixture varies font size per run
  // even on ordinary body text). WHY this test exists: while investigating
  // BUG 2 (PRESIDEN extracting as "PRES IDEN" — see SPACE_GAP_FACTOR's
  // comment in text-lines.js), a "gap must be a statistical outlier above
  // the line's own median gap" fix was tried and, when run against this
  // REAL line (not just the PRESIDEN repro), silently deleted every one of
  // its 5 spaces — median([5.72,5.52,5.04,5.04,4.73])=5.04, 1.6x that is
  // 8.06, bigger than every individual gap, so NONE cleared the bar. That
  // fix was reverted specifically because of this line. This test pins the
  // correct behavior going forward: the flat per-gap SPACE_GAP_FACTOR
  // threshold alone, with no line-wide statistics muting it.
  const runs = [
    run('sebagaimana', 0, 0, 81.041, 13.5),         // a0=0, a1=81.041
    run('dimaksud pada', 86.760, 0, 102.120, 15),   // gap=5.719, a1=188.880
    run('ayat', 194.400, 0, 30.240, 16),            // gap=5.520, a1=224.640
    run('(1)', 229.680, 0, 20.163, 16.5),           // gap=5.040, a1=249.843
    run('paling', 254.880, 0, 41.354, 15.5),        // gap=5.037, a1=296.234
    run('sedikit', 300.960, 0, 38.259, 13.5),       // gap=4.726
  ];
  const lines = groupRunsIntoLines(runs);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].str, 'sebagaimana dimaksud pada ayat (1) paling sedikit');
});

test('4. DOCUMENTED RESIDUAL: uniform letter-tracking split into 4+ ' +
  'fragments still produces spurious spaces (no safe geometric fix found)', () => {
  // Generalizes the PRESIDEN bug ("PRES"+"IDEN", one 4.09pt gap on 10pt
  // text) to more fragments: "P","R","E","S" each separated by a uniform
  // 3pt tracking gap, followed by a genuinely separate word "book" with a
  // real 12pt gap. A median/outlier-based fix COULD suppress the 3 uniform
  // tracking gaps here in isolation — but test 3 above proves that same
  // mechanism deletes real spaces on actual documents, so it was rejected
  // project-wide (see text-lines.js's SPACE_GAP_FACTOR comment for the
  // concrete counter-evidence). This test pins the resulting, still-present
  // limitation: every gap here also clears the flat 0.18*10=1.8pt
  // threshold, so ALL of them (including the 3 spurious ones) get a space.
  // Accepted residual, same class as PRESIDEN -> "PRES IDEN".
  const size = 10;
  const runs = [
    run('P', 0, 0, 6, size),
    run('R', 6 + 3, 0, 6, size),
    run('E', 6 + 3 + 6 + 3, 0, 6, size),
    run('S', 6 + 3 + 6 + 3 + 6 + 3, 0, 6, size),
    run('book', 6 + 3 + 6 + 3 + 6 + 3 + 6 + 12, 0, 24, size),
  ];
  const lines = groupRunsIntoLines(runs);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].str, 'P R E S book');
});

test('5. column guard: two runs on one baseline, 3em gap -> TWO lines', () => {
  const size = 12;
  const runs = [
    run('Kolom Kiri', 0, 0, 24, size),
    run('Kolom Kanan', 24 + 3 * size, 0, 30, size), // 36pt gutter > 1.5*12=18
  ];
  const lines = groupRunsIntoLines(runs);
  assert.equal(lines.length, 2);
});

test('6. two baselines 1.2em apart (12pt text, 14.4pt leading) -> two lines', () => {
  const size = 12;
  const leading = 1.2 * size; // 14.4, above the 0.35*12=4.2 perp tolerance
  const runs = [
    run('Line one', 0, 0, 48, size),
    run('Line two', 0, -leading, 48, size),
  ];
  const lines = groupRunsIntoLines(runs);
  assert.equal(lines.length, 2);
});

test('7. heading swallow guard: a 72pt heading 25.2pt above a 10.45pt body ' +
  'run stays its OWN line (perp tolerance scales by the SMALLER run)', () => {
  // Regression pin for the exact numbers in the founder field report
  // 2026-07-21 (lorem-testing.pdf): a 72pt "TESTING" heading sat 25.2pt
  // above a 10.45pt body paragraph's baseline. Under the OLD max()-based
  // tolerance, 0.35*max(72,10.45) = 25.2 — exactly equal to the offset, so
  // the (<=) perp gate let them merge into one Line ("Lorem
  // ipsumTESTINGdolor..."). Scaling by the SMALLER run instead —
  // 0.35*min(72,10.45) = 3.6575 — is far below the 25.2pt offset, so they
  // now split into two lines as they visually are.
  const bodySize = 10.45;
  const headingSize = 72;
  const diff = 25.2; // exactly the old tolerance boundary at max(72,10.45)
  const runs = [
    run('Lorem ipsum dolor sit amet', 0, 0, 150, bodySize),
    run('TESTING', 0, diff, 90, headingSize),
  ];
  const lines = groupRunsIntoLines(runs);
  assert.equal(lines.length, 2);
  const body = lines.find((l) => l.str.startsWith('Lorem'));
  const heading = lines.find((l) => l.str === 'TESTING');
  assert.ok(body, 'body paragraph keeps its own line');
  assert.ok(heading, 'heading resolves to its OWN line, not merged with body');
});

test('8. superscript-ish: v2 behavior — splits into its own line ' +
  '(perp tolerance now scales by the SMALLER run, not the larger)', () => {
  // Small run (size 6) sits 0.3*12=3.6 above a 12pt run's baseline, inside
  // its horizontal span. Under the OLD max()-based tolerance
  // (0.35*max(6,12)=4.2, bigger than the 3.6 offset) this merged into one
  // line — accepted as v1 behavior at the time. WHY this changed
  // (founder field report 2026-07-21, lorem-testing.pdf): that same
  // max()-based formula let a 72pt heading's size license a 25.2pt band
  // that reached all the way down into an unrelated 10.45pt body line and
  // swallowed it whole ("Lorem ipsumTESTINGdolor..."). Scaling by the
  // SMALLER participant instead (0.35*min(6,12)=2.1, smaller than 3.6) fixes
  // that heading/body bug and, as a side effect, also stops treating this
  // superscript as automatically "close enough" — it now clears its own
  // small line instead. A stray tiny fragment splitting out is far less
  // harmful than a heading eating a whole paragraph, so this is accepted as
  // the more correct v2 behavior, not a regression.
  const runs = [
    run('Text', 0, 0, 48, 12),
    run('2', 10, 3.6, 6, 6),
  ];
  const lines = groupRunsIntoLines(runs);
  assert.equal(lines.length, 2);
  const base = lines.find((l) => l.str === 'Text');
  const sup = lines.find((l) => l.str === '2');
  assert.ok(base, 'base run keeps its own line');
  assert.ok(sup, 'superscript run splits into its own line');
});

test('9. rotated runs group by the same rules; a horizontal run at a similar p ' +
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

test('10. unsorted input (paint order scrambled) -> same result as sorted', () => {
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

test('11. dominant style: 3-char bold fragment + 40-char regular fragment -> ' +
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

test('12. pdf.len spans first fragment start to last fragment end; ' +
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

test('13. empty input -> []', () => {
  assert.deepEqual(groupRunsIntoLines([]), []);
  assert.deepEqual(groupRunsIntoLines(undefined), []);
});

// ============================================================================
// resolveTap — tap-point -> line, with per-side clamped inflation. Founder
// field report 2026-07-19: on a dense single-spaced tax letter, every line's
// hit box inflated toward MIN_HIT regardless of neighbors, so on tight
// spacing the inflated boxes overlapped and a fat-finger tap resolved by
// nearest-CENTER — deterministic but often the wrong line. resolveTap only
// reads x/y/w/h off each line, so these build plain boxes directly; no pdf
// geometry needed.
// ============================================================================
function box(x, y, w, h) {
  return { x, y, w, h };
}

// Distance from a 1-D point to a 1-D range — 0 when inside it. Used by the
// tests below to independently predict which line's real box is nearer,
// so the assertions aren't just re-deriving resolveTap's own arithmetic.
function distToRange(v, start, end) {
  if (v < start) return start - v;
  if (v > end) return v - end;
  return 0;
}

test('14. sparse: an isolated line keeps FULL growth (no neighbor to clamp against)', () => {
  const minHit = 22;
  const line = box(0, 0, 40, 8); // 8px tall, no other lines on the page at all
  const growY = (minHit - 8) / 2; // 7 — full desired growth, nothing clamps it

  // A tap just inside the top growth still resolves to the line...
  assert.equal(resolveTap([line], 20, -growY + 0.5, minHit), line);
  // ...but one just past the (unclamped) growth boundary does not.
  assert.equal(resolveTap([line], 20, -growY - 0.5, minHit), null);
});

test('15. dense stack: a tap just above line 2\'s top resolves to line 2, not line 1', () => {
  const minHit = 22;
  // Three 12px lines, identical x-range (0..100), 4px vertical gaps.
  const line1 = box(0, 0, 100, 12);  // 0..12
  const line2 = box(0, 16, 100, 12); // 16..28
  const line3 = box(0, 32, 100, 12); // 32..44
  const lines = [line1, line2, line3];

  // Old nearest-CENTER logic inflated every line's box by the full 5px
  // (minHit 22, h 12 -> growY 5) on every side, so line1's box reached down
  // to y=17 and line2's reached up to y=11 — they overlapped, and a tap at
  // y=15 could resolve either way depending on which center was closer. The
  // clamp caps each facing side at half the 4px gap (2px), so the boxes
  // meet exactly at y=14 with no overlap: y=15 is unambiguously line2's.
  assert.equal(resolveTap(lines, 50, 15, minHit), line2);

  // Dead center of each line resolves to that line.
  assert.equal(resolveTap(lines, 50, 6, minHit), line1);
  assert.equal(resolveTap(lines, 50, 22, minHit), line2);
  assert.equal(resolveTap(lines, 50, 38, minHit), line3);

  // A tap in a gap resolves to whichever line is nearer.
  assert.equal(resolveTap(lines, 50, 13, minHit), line1); // 1px from line1, 3 from line2
  assert.equal(resolveTap(lines, 50, 15, minHit), line2); // 3px from line1, 1 from line2
});

test('16. dense stack: clamp keeps inflated boxes from overlapping across the whole gap', () => {
  const minHit = 22;
  const line1 = box(0, 0, 100, 12);  // 0..12
  const line2 = box(0, 16, 100, 12); // 16..28
  const lines = [line1, line2];

  // Sample a grid of points across the gap (and a bit into each line). For
  // every sample, resolveTap must pick whichever line's UNINFLATED box is
  // actually nearer — never the farther one, which is what unclamped
  // inflation (both boxes reaching into the same overlap zone) used to
  // allow.
  for (let y = 10; y <= 18; y += 0.5) {
    const distTo1 = distToRange(y, 0, 12);
    const distTo2 = distToRange(y, 16, 28);
    const nearer = distTo1 <= distTo2 ? line1 : line2;
    const got = resolveTap(lines, 50, y, minHit);
    if (got !== null) assert.equal(got, nearer, `y=${y}`);
  }

  // The isolated side (line1's top — no neighbor above) keeps the FULL 5px
  // growth: a tap 4px above line1's top still hits it.
  assert.equal(resolveTap(lines, 50, -4, minHit), line1);

  // The clamped side (line1's bottom, 4px gap to line2) is capped at 2px —
  // a point that WOULD be inside an unclamped 5px growth (y=15.5, since
  // 12+5=17) but is outside the clamped 2px growth (12+2=14) must resolve
  // to line2 instead, never line1.
  assert.equal(resolveTap(lines, 50, 15.5, minHit), line2);
});

test('17. long line: box-distance beats a closer CENTER on a short neighbor', () => {
  const minHit = 22;
  const longLine = box(0, 0, 500, 12); // far-left edge at x=0
  const shortLine = box(5, 3, 6, 6);   // small box, sits near the tap
  const lines = [longLine, shortLine];

  // Tap 2px above longLine's far-left corner. Box-distance: longLine's
  // uninflated box is 2px away (nearest point is (0,0)); shortLine's is
  // ~7.07px away. Center-distance (the OLD resolution rule): longLine's
  // center (250, 6) is ~250px away; shortLine's center (8, 6) is only
  // ~11.3px away — a center-based resolver would wrongly prefer shortLine.
  // box-distance must win for the long line.
  assert.equal(resolveTap(lines, 0, -2, minHit), longLine);
});

test('18. column neighbors: horizontal growth clamps at the gap midpoint; a tap in the gap resolves to the nearer column', () => {
  const minHit = 22;
  const lineA = box(0, 0, 10, 12);  // x: 0..10
  const lineB = box(16, 0, 10, 12); // x: 16..26 -- 6px horizontal gap, same baseline
  const lines = [lineA, lineB];

  // Desired growX = (22-10)/2 = 6 each, but the 6px gap only allows 3px
  // each before the boxes would touch — clamp caps it there. The boxes
  // meet exactly at x=13 (10+3 == 16-3).
  assert.equal(resolveTap(lines, 12.9, 6, minHit), lineA); // just inside lineA's clamped box
  assert.equal(resolveTap(lines, 13.1, 6, minHit), lineB); // just inside lineB's clamped box

  // A tap in the gap resolves to the nearer column.
  assert.equal(resolveTap(lines, 11, 6, minHit), lineA); // 1px from lineA, 5 from lineB
  assert.equal(resolveTap(lines, 15, 6, minHit), lineB); // 1px from lineB, 5 from lineA
});

test('19. empty lines array -> null; tap far from every line -> null', () => {
  const minHit = 22;
  assert.equal(resolveTap([], 0, 0, minHit), null);
  assert.equal(resolveTap(undefined, 0, 0, minHit), null);

  const line = box(0, 0, 40, 12);
  assert.equal(resolveTap([line], 5000, 5000, minHit), null);
});
