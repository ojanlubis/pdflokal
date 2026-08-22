/*
 * A FONTKIT THROW MUST DECLINE THE RUNG, NOT KILL THE EDIT.
 * ============================================================================
 * LIVE BREAKAGE (Sentry JAVASCRIPT-S, 7 events over three days, Aug 2026,
 * real iPhones): `TypeError: undefined is not an object (evaluating
 * 'e.tables')`, thrown from INSIDE vendored fontkit, under
 * glyphPaints → font.hasGlyphForCodePoint.
 *
 * WHY IT ESCAPED: glyphPaints already had a try/catch — and
 * hasGlyphForCodePoint sat one line ABOVE it. The catch covered
 * glyphForCodePoint and the path-command read; the cmap lookup that actually
 * throws was outside the door. fontkit parses lazily, so a font whose tables
 * only fault when a cmap is first consulted throws at exactly the call the
 * guard did not cover.
 *
 * WHAT THE USER SAW, and why this is worse than an export failure: the crash
 * surfaced at js/v2/app.js's commit-time notice prediction (textCoveredBy is
 * imported so the toast can never drift from what export will do). That call
 * is on the blur path of the edit box and is NOT armored, so commit() died —
 * the replacement simply never applied. Not a bad stamp, not a warning: the
 * edit silently did not happen.
 *
 * WHY `false` IS THE CORRECT ANSWER TO A THROW, not a rethrow: textCoveredBy
 * false means "the document's own subset does not cover this text", which
 * makes stamp.js's rung 1 (tryNativeSubset) decline and fall to the clone/twin
 * rungs. That is the designed degrade path and it is already exercised for
 * every ordinary missing-glyph case. A font we cannot interrogate is a font we
 * cannot PROVE is right — and this subsystem's first law is to stamp only with
 * a font it can prove (decisions.md). Declining is the law, not a shortcut.
 *
 * THE FIXTURE MUST DISTINGUISH: a real font cannot be relied on to throw on
 * demand, and a fixture that agrees with both the fixed and the broken code is
 * decoration. So the font here is a stub that throws from the exact method the
 * production stack named. Against the unguarded version these tests throw;
 * against the guarded one they return false.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textCoveredBy } from '../../js/core/stamp.js';

// A fontkit-parsed program that faults the way the wild ones do: the object
// exists, the method exists, and consulting the cmap explodes on a table the
// lazy parser never populated.
function faultingFont() {
  return {
    hasGlyphForCodePoint() { throw new TypeError("undefined is not an object (evaluating 'e.tables')"); },
    glyphForCodePoint() { throw new Error('should never be reached'); },
  };
}

// Instrument check: prove the stub really does throw before believing any
// verdict built on it. An assertion over a font that quietly returns false
// would pass against the broken code too.
test('the faulting-font fixture actually throws', () => {
  assert.throws(() => faultingFont().hasGlyphForCodePoint(65), /e\.tables/);
});

test('textCoveredBy declines instead of throwing when fontkit faults', () => {
  assert.equal(textCoveredBy(faultingFont(), 'Budi'), false);
});

test('a faulting font declines even for the space carve-out', () => {
  // cp 32 is exempt from the CONTOUR check but never from the cmap lookup —
  // so the space path must survive the same fault.
  assert.equal(textCoveredBy(faultingFont(), ' '), false);
});

test('a healthy font is unaffected by the guard', () => {
  const healthy = {
    hasGlyphForCodePoint: () => true,
    glyphForCodePoint: () => ({ id: 7, path: { commands: [{ command: 'moveTo' }] } }),
  };
  assert.equal(textCoveredBy(healthy, 'Budi'), true);
  // and a genuine miss still reads as a miss, not as a fault
  assert.equal(textCoveredBy({ hasGlyphForCodePoint: () => false }, 'Budi'), false);
});
