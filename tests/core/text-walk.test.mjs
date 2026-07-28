/*
 * Rung B production — text-walk interpreter (headless).
 * Pins the graphics/text-state math (CTM, Tm/Tlm, Tc/Tw/Th/TL/Ts, q/Q) that
 * position-matched removal depends on, plus the planRunRemoval matcher and
 * its splice-and-replace behavior. A wrong sign or matrix order here means
 * removal either eats the wrong glyphs or drifts everything after it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walkShowOps, planRunRemoval } from '../../js/core/text-walk.js';

const approx = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `expected ${a} ≈ ${b}`);

// widths in glyph-space thousandths (500 = half an em at size 1)
function fontsWith(widths, opts = {}) {
  const m = new Map();
  for (const [name, w] of Object.entries(widths)) {
    m.set(name, { bytesPerCode: opts.bytesPerCode ?? 1, widths: w, defaultWidth: opts.defaultWidth ?? 500 });
  }
  return m;
}

test('1. basic Tj: position, size, and advance from Td + Tf', () => {
  const widths = new Map([[65, 500], [66, 500]]); // A, B
  const fonts = fontsWith({ F1: widths });
  const src = 'BT /F1 12 Tf 72 700 Td (AB) Tj ET';
  const [rec] = walkShowOps(src, fonts);
  assert.equal(rec.x, 72);
  assert.equal(rec.y, 700);
  assert.equal(rec.size, 12);
  assert.equal(rec.exact, true);
  approx(rec.advanceText, 12); // A+B: (500/1000*12)*2 codes = 6+6
});

test('2. TJ kern math: string + kern + string sums correctly', () => {
  const widths = new Map([[65, 500], [66, 500]]); // A=500, B=500 -> 6 each at size 12
  const fonts = fontsWith({ F1: widths });
  const src = 'BT /F1 12 Tf 72 700 Td [(A) -100 (B)] TJ ET';
  const [rec] = walkShowOps(src, fonts);
  // A: 500/1000*12 = 6; kern -100: (-(-100)/1000)*12 = 1.2; B: 6 -> 6+1.2+6=13.2
  approx(rec.advanceText, 13.2);
});

test('3. consecutive Tj with known widths: second op x = first x + advance, exact', () => {
  const widths = new Map([[65, 500]]);
  const fonts = fontsWith({ F1: widths }, { defaultWidth: 500 });
  const src = 'BT /F1 12 Tf 72 700 Td (A) Tj (A) Tj ET';
  const [r1, r2] = walkShowOps(src, fonts);
  assert.equal(r1.exact, true);
  assert.equal(r2.exact, true);
  approx(r2.x, r1.x + r1.advanceText);
  assert.equal(r2.y, r1.y);
});

test('4. unknown font: second Tj is inexact; a following Td restores exactness', () => {
  const fonts = new Map(); // F1 not registered -> widths unknown
  const src = 'BT /F1 12 Tf 72 700 Td (A) Tj (A) Tj 0 -14 Td (A) Tj ET';
  const [r1, r2, r3] = walkShowOps(src, fonts);
  assert.equal(r1.advanceText, null);
  assert.equal(r1.exact, true);   // Td just ran, still trustworthy for THIS op
  assert.equal(r2.exact, false);  // r1's unknown advance poisoned position tracking
  assert.equal(r3.exact, true);   // Td restores it
});

test('5. cm scales size and position; q/Q restores prior CTM', () => {
  const widths = new Map([[65, 500]]);
  const fonts = fontsWith({ F1: widths });
  const src = 'q 2 0 0 2 0 0 cm BT /F1 12 Tf 10 10 Td (A) Tj ET Q BT /F1 12 Tf 10 10 Td (A) Tj ET';
  const [scaled, normal] = walkShowOps(src, fonts);
  approx(scaled.size, 24);
  approx(scaled.x, 20);
  approx(scaled.y, 20);
  approx(normal.size, 12);
  approx(normal.x, 10);
  approx(normal.y, 10);
});

test("6. ' and \" honor TL line-stepping and \" sets Tw/Tc", () => {
  const widths = new Map([[65, 500]]);
  const fonts = fontsWith({ F1: widths });
  const src = "BT /F1 12 Tf 20 700 Td 14 TL (A) Tj (B) ' 1 2 (C) \" ET";
  const [tj, quote, dquote] = walkShowOps(src, fonts);
  assert.equal(tj.y, 700);
  approx(quote.y, 686);       // T* stepped down by TL before the show
  approx(dquote.y, 672);      // another T* step
  assert.equal(dquote.th, 1); // Th unaffected
  // Tw/Tc were applied before computing dquote's advance: 500/1000*12 + Tc(2) = 8, *Th(1)=8
  approx(dquote.advanceText, 8);
});

test('7. 2-byte CID string: <00410042> widths 65:600,66:600 -> advance 14.4 @ size 12', () => {
  const widths = new Map([[65, 600], [66, 600]]);
  const fonts = fontsWith({ F1: widths }, { bytesPerCode: 2 });
  const src = 'BT /F1 12 Tf 0 0 Td <00410042> Tj ET';
  const [rec] = walkShowOps(src, fonts);
  approx(rec.advanceText, 14.4); // (600/1000*12)*2 = 7.2*2 = 14.4
});

test('8. rotated text via Tm: unit baseline direction matches the rotation', () => {
  const widths = new Map([[65, 500]]);
  const fonts = fontsWith({ F1: widths });
  const src = 'BT /F1 12 Tf 0.866 0.5 -0.5 0.866 100 100 Tm (A) Tj ET';
  const [rec] = walkShowOps(src, fonts);
  approx(rec.ux, 0.866, 1e-3);
  approx(rec.uy, 0.5, 1e-3);
  approx(rec.x, 100);
  approx(rec.y, 100);
});

test('9. planRunRemoval matches by geometry, not text — identical text at different y', () => {
  const widths = new Map([[65, 500], [66, 500], [67, 500]]);
  const fonts = fontsWith({ F1: widths });
  const src = 'BT /F1 12 Tf 72 720 Td (ABC) Tj ET BT /F1 12 Tf 72 700 Td (ABC) Tj ET BT /F1 12 Tf 72 680 Td (ABC) Tj ET';
  const before = walkShowOps(src, fonts);
  const middle = before[1];
  const target = { x0: middle.x, y0: middle.y, ux: middle.ux, uy: middle.uy, len: middle.advanceText, size: middle.size };
  const { content, removed, results } = planRunRemoval(src, fonts, [target]);
  assert.equal(removed, 1);
  assert.equal(results[0].matched, true);
  // The middle op is REPLACED (positioning-only TJ), not deleted — it still
  // walks as a record (at the same spot) but carries no string tokens.
  const after = walkShowOps(content, fonts);
  assert.equal(after.length, 3);
  assert.equal(after[1].tokens.some((t) => t.t === 'str'), false);
  approx(after[0].x, before[0].x); approx(after[0].y, before[0].y);
  approx(after[2].x, before[2].x); approx(after[2].y, before[2].y);
});

test('10. splice preserves downstream: removing the first of two Tj keeps the second\'s position', () => {
  const widths = new Map([[65, 500], [66, 500]]);
  const fonts = fontsWith({ F1: widths });
  const src = 'BT /F1 12 Tf 72 700 Td (A) Tj (B) Tj ET';
  const before = walkShowOps(src, fonts);
  const first = before[0];
  const target = { x0: first.x, y0: first.y, ux: first.ux, uy: first.uy, len: first.advanceText, size: first.size };
  const { content, removed } = planRunRemoval(src, fonts, [target]);
  assert.equal(removed, 1);
  // First op becomes a positioning-only TJ (still a record, no string tokens);
  // the second op's walked position must be IDENTICAL to before the splice.
  const after = walkShowOps(content, fonts);
  assert.equal(after.length, 2);
  assert.equal(after[0].tokens.some((t) => t.t === 'str'), false);
  approx(after[1].x, before[1].x);
  approx(after[1].y, before[1].y);
});

test('11. decline: unknown-width font declines the target, content untouched', () => {
  const fonts = new Map(); // F1 unregistered
  const src = 'BT /F1 12 Tf 72 700 Td (A) Tj (B) Tj ET';
  const before = walkShowOps(src, fonts);
  const first = before[0];
  // first op is exact (Td just ran) so it CAN be geometrically matched, but its
  // own advanceText is null -> its btIndex lands in badBts -> target declined.
  const target = { x0: first.x, y0: first.y, ux: first.ux, uy: first.uy, len: 12, size: first.size };
  const { content, removed, results } = planRunRemoval(src, fonts, [target]);
  assert.equal(results[0].matched, false);
  assert.equal(removed, 0);
  assert.equal(content, src);
});

test('12. adjacent-run guard: target geometry for the first run does not eat the second', () => {
  const widths = new Map([[65, 500], [66, 500]]);
  const fonts = fontsWith({ F1: widths });
  const src = 'BT /F1 12 Tf 0 0 Td (A) Tj (B) Tj ET';
  const before = walkShowOps(src, fonts);
  const first = before[0];
  const target = { x0: first.x, y0: first.y, ux: first.ux, uy: first.uy, len: first.advanceText, size: first.size };
  const { removed, results, content } = planRunRemoval(src, fonts, [target]);
  assert.equal(removed, 1);
  assert.equal(results[0].matched, true);
  const after = walkShowOps(content, fonts);
  assert.equal(after.length, 2); // phantom (positioning-only) + B, which survives
  assert.equal(after[1].tokens.some((t) => t.t === 'str'), true);
  approx(after[1].x, before[1].x);
});

test('planRunRemoval reports the removed text\'s paint info for re-insert (Rung C)', () => {
  const fonts = new Map([['F1', { bytesPerCode: 1, widths: new Map([[65, 500], [66, 500]]), defaultWidth: 0 }]]);
  const src = 'BT /F1 12 Tf 72 700 Td (AB) Tj ET';
  const { results } = planRunRemoval(src, fonts, [
    { x0: 72, y0: 700, ux: 1, uy: 0, len: 12, size: 12 },
  ]);
  assert.equal(results[0].matched, true);
  // The insert block carries the RESOURCE font name + exact painted geometry —
  // pdf.js never exposes the resource name, so the walk must.
  assert.equal(results[0].insert.fontName, 'F1');
  assert.equal(results[0].insert.fontSize, 12);
  assert.equal(results[0].insert.x, 72);
  assert.equal(results[0].insert.y, 700);
  assert.equal(results[0].insert.size, 12);
  assert.equal(results[0].insert.mixedFonts, false);
});

// ---------------------------------------------------------------------------
// RESIDUAL — the honesty signal. Founder field report 2026-07-28 (the dash-
// leader form row): a target can MATCH one op and silently leave another op,
// sitting inside the very span it was asked to clear, completely untouched.
// The planner already knows this happened — the rejected record passed both
// POSITIONAL tests and failed only `sizeOk` — and used to throw that knowledge
// away, so page-surgery.js reported `reason:'clean'` for a cut that removed
// half a line. `residual` is that discarded knowledge, kept.
//
// This is the miniature of the production defect: two ops on ONE baseline at
// materially different point sizes, and a single blended target whose `size`
// came from the larger (dominant) one.
// ---------------------------------------------------------------------------

test('residual: a target that matches one op and leaves another INSIDE its own span reports it', () => {
  const fonts = fontsWith({ F1: new Map([[65, 500], [66, 500], [67, 500], [68, 500]]) });
  //  (AB) painted at 5pt from x=72  ->  advance 5, ends at x=77
  //  (CD) painted at 12pt from x=77 ->  advance 12, ends at x=89
  const src = 'BT /F1 5 Tf 72 700 Td (AB) Tj 5 0 Td /F1 12 Tf (CD) Tj ET';
  // ONE blended target spanning the whole line, taking its size from the
  // dominant run — exactly what text-lines.js's assembleLine produces and what
  // js/v2/app.js used to hand over before 39e0b9f.
  const blended = { x0: 72, y0: 700, ux: 1, uy: 0, len: 17, size: 12 };

  const { results, content } = planRunRemoval(src, fonts, [blended]);

  // It really did match — this is not a no-match case, which is precisely why
  // it was able to lie.
  assert.equal(results[0].matched, true);
  assert.equal(results[0].ops, 1);

  // The 5pt run is still painted: sizeOk ([0.55, 1.8] x 12 = [6.6, 21.6])
  // rejected it, though it sits on the same baseline inside the target's span.
  const survivors = walkShowOps(content, fonts).filter((r) => r.tokens.some((t) => t.t === 'str'));
  assert.equal(survivors.length, 1);
  assert.equal(survivors[0].tokens.find((t) => t.t === 'str').v, 'AB');

  // THE ASSERTION THAT MAKES THE INSTRUMENT HONEST: one painted run remains
  // inside the span we were told to clear, and the result says so.
  assert.equal(results[0].residual, 1);
});

test('residual: the ordinary single-run cut reports 0 — no false alarm', () => {
  const fonts = fontsWith({ F1: new Map([[65, 500], [66, 500]]) });
  const src = 'BT /F1 12 Tf 72 700 Td (AB) Tj ET';
  const { results } = planRunRemoval(src, fonts, [
    { x0: 72, y0: 700, ux: 1, uy: 0, len: 12, size: 12 },
  ]);
  assert.equal(results[0].matched, true);
  assert.equal(results[0].residual, 0);
});

test('residual: an adjacent run OUTSIDE the target span is not counted (test 12 must not start crying wolf)', () => {
  const fonts = fontsWith({ F1: new Map([[65, 500], [66, 500]]) });
  const src = 'BT /F1 12 Tf 0 0 Td (A) Tj (B) Tj ET';
  const before = walkShowOps(src, fonts);
  const first = before[0];
  const target = { x0: first.x, y0: first.y, ux: first.ux, uy: first.uy, len: first.advanceText, size: first.size };
  const { results } = planRunRemoval(src, fonts, [target]);
  assert.equal(results[0].matched, true);
  // B survives, but it lies BEYOND the target's own length — it was never part
  // of what we claimed to clear, so counting it would be a false positive and
  // would make `residual` useless by firing on every ordinary line.
  assert.equal(results[0].residual, 0);
});

test('residual: per-run targets (the 39e0b9f shape) clear the whole line and report 0', () => {
  const fonts = fontsWith({ F1: new Map([[65, 500], [66, 500], [67, 500], [68, 500]]) });
  const src = 'BT /F1 5 Tf 72 700 Td (AB) Tj 5 0 Td /F1 12 Tf (CD) Tj ET';
  // One target PER constituent run — each keeps its OWN size, so each op is
  // matched by its own target and nothing is left behind.
  const { results, content } = planRunRemoval(src, fonts, [
    { x0: 72, y0: 700, ux: 1, uy: 0, len: 5, size: 5 },
    { x0: 77, y0: 700, ux: 1, uy: 0, len: 12, size: 12 },
  ]);
  assert.equal(results[0].matched, true);
  assert.equal(results[1].matched, true);
  assert.equal(results[0].residual, 0);
  assert.equal(results[1].residual, 0);
  const survivors = walkShowOps(content, fonts).filter((r) => r.tokens.some((t) => t.t === 'str'));
  assert.equal(survivors.length, 0);
});
