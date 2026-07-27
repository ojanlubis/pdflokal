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
