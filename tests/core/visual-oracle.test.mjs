/*
 * core/visual-oracle.js — the visual oracle (spec-edit-fidelity-
 * instrumentation.md Increment C).
 * ============================================================================
 * Pure ImageData-shaped math, no canvas/DOM/vendor needed — synthetic pixel
 * buffers with a KNOWN ink footprint are exactly what makes this headlessly
 * testable. Each buffer is a flat RGBA Uint8ClampedArray (matches what
 * CanvasRenderingContext2D#getImageData actually returns) built by a small
 * helper that paints a filled rectangle of "ink" (near-black) on a "paper"
 * (near-white) background — a stand-in for a glyph's own stroke footprint,
 * the same shape the builder's Step 0 experiment validated against the real
 * org-structure.pdf fixture (see the acceptance test below, which pins the
 * ACTUAL numbers from that experiment as a regression guard).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeInkRegion, compareRegions } from '../../js/core/visual-oracle.js';
import { ratioBucket } from '../../js/core/telemetry-schema.js';

// Builds a WxH RGBA buffer, "paper" everywhere, with one filled ink
// rectangle at (x,y,w,h) — same ImageData shape (`{width,height,data}`) a
// real canvas#getImageData call returns.
function makeRegion(width, height, inkRect) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = 255; data[i * 4 + 1] = 255; data[i * 4 + 2] = 255; data[i * 4 + 3] = 255;
  }
  if (inkRect) {
    const { x, y, w, h } = inkRect;
    for (let py = y; py < y + h; py += 1) {
      for (let px = x; px < x + w; px += 1) {
        const idx = (py * width + px) * 4;
        data[idx] = 0; data[idx + 1] = 0; data[idx + 2] = 0; data[idx + 3] = 255;
      }
    }
  }
  return { width, height, data };
}

// ---- analyzeInkRegion --------------------------------------------------------

test('analyzeInkRegion: a blank (all-paper) region has no ink to measure -> null', () => {
  const region = makeRegion(20, 20, null);
  assert.equal(analyzeInkRegion(region), null);
});

test('analyzeInkRegion: density is 1.0 for a solid rectangle (ink fills its own bbox exactly)', () => {
  const region = makeRegion(40, 40, { x: 10, y: 10, w: 10, h: 10 });
  const result = analyzeInkRegion(region);
  assert.equal(result.inkCount, 100);
  assert.equal(result.bboxW, 10);
  assert.equal(result.bboxH, 10);
  assert.equal(result.density, 1);
  assert.deepEqual([result.minX, result.maxX, result.minY, result.maxY], [10, 19, 10, 19]);
});

test('analyzeInkRegion: a sparse/hollow shape has density < 1 (ink less than its own bbox area)', () => {
  // A 10x10 bbox but only a 4x4 patch inside it is actually ink — density
  // should read well below 1 (a thin/hollow shape relative to its own span).
  const width = 40; const height = 40;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let py = 10; py < 14; py += 1) {
    for (let px = 10; px < 14; px += 1) {
      const idx = (py * width + px) * 4;
      data[idx] = 0; data[idx + 1] = 0; data[idx + 2] = 0; data[idx + 3] = 255;
    }
  }
  // Two more single ink pixels at the far corners of a 10x10 span so the
  // BBOX is still 10x10, but total ink stays small.
  const corner = (px, py) => { const idx = (py * width + px) * 4; data[idx] = 0; data[idx + 1] = 0; data[idx + 2] = 0; data[idx + 3] = 255; };
  corner(10, 10); corner(19, 19);
  const result = analyzeInkRegion({ width, height, data });
  assert.equal(result.bboxW, 10);
  assert.equal(result.bboxH, 10);
  assert.ok(result.density < 0.3, `expected a sparse density, got ${result.density}`);
});

// ---- the transparent-padding trap (PM-flagged 2026-07-26) -------------------
// A crop that spills past its source raster's own edge gets padded with
// TRANSPARENT BLACK (alpha 0, rgb 0,0,0) by BOTH decode paths this module
// feeds off (createImageBitmap's crop overload per spec; a freshly-created,
// undrawn canvas). Reading luminance alone can't tell that apart from real
// black ink — both are maximally dark. These fixtures paint alpha 0 EXPLICITLY
// (unlike every fixture above, which sets alpha 255 explicitly too — see the
// module docstring's note that none of the tests above were passing "for the
// wrong reason": they never relied on Uint8ClampedArray's zero-initialized
// default, they always set alpha themselves).

test('analyzeInkRegion: a fully TRANSPARENT region (alpha 0, rgb 0,0,0 — the out-of-bounds padding shape) is NOT 100% ink -> null', () => {
  const width = 20; const height = 20;
  const data = new Uint8ClampedArray(width * height * 4); // all zeros: transparent black everywhere
  const result = analyzeInkRegion({ width, height, data });
  assert.equal(result, null, 'transparent padding must never read as a solid ink block');
});

test('analyzeInkRegion: HALF real opaque ink, HALF transparent-black padding — measures only the real ink', () => {
  const width = 40; const height = 20;
  // Left half (x: 0-19): fully transparent black — the out-of-bounds padding.
  // Right half (x: 20-39): opaque white paper with a real 10x10 opaque ink square.
  const data = new Uint8ClampedArray(width * height * 4); // starts all-zero (transparent black)
  for (let y = 0; y < height; y += 1) {
    for (let x = 20; x < width; x += 1) {
      const idx = (y * width + x) * 4;
      data[idx] = 255; data[idx + 1] = 255; data[idx + 2] = 255; data[idx + 3] = 255; // opaque paper
    }
  }
  for (let y = 5; y < 15; y += 1) {
    for (let x = 25; x < 35; x += 1) {
      const idx = (y * width + x) * 4;
      data[idx] = 0; data[idx + 1] = 0; data[idx + 2] = 0; data[idx + 3] = 255; // real opaque ink
    }
  }
  const result = analyzeInkRegion({ width, height, data });
  // Without the alpha check, the ENTIRE left half (transparent black, x 0-19)
  // would also read as ink, blowing bboxW out to ~35 and inkCount to ~500+.
  assert.equal(result.inkCount, 100, 'must count only the real opaque ink pixels, not the transparent padding');
  assert.equal(result.bboxW, 10);
  assert.equal(result.bboxH, 10);
  assert.deepEqual([result.minX, result.maxX], [25, 34]);
  assert.equal(result.density, 1);
});

test('compareRegions: a fully-transparent stamped side declines honestly (null), never a fabricated ratio', () => {
  const pristine = makeRegion(30, 30, { x: 5, y: 5, w: 10, h: 10 });
  const transparentPadding = { width: 30, height: 30, data: new Uint8ClampedArray(30 * 30 * 4) };
  assert.equal(compareRegions(pristine, transparentPadding), null);
});

// ---- compareRegions -----------------------------------------------------------

test('compareRegions: identical regions -> ratios of exactly 1, no overflow', () => {
  const region = makeRegion(50, 50, { x: 10, y: 10, w: 20, h: 8 });
  const result = compareRegions(region, region);
  assert.equal(result.weightRatio, 1);
  assert.equal(result.heightRatio, 1);
  assert.equal(result.overflow, false);
});

test('compareRegions: a THINNER stamp (same bbox, less fill) reads a weight_ratio well below parity', () => {
  const pristine = makeRegion(50, 50, { x: 10, y: 10, w: 20, h: 10 }); // solid, density 1.0
  // Same 20x10 bbox, but only alternating columns filled — same bbox span,
  // roughly half the ink -> density ~0.5, a thin-vs-bold stand-in.
  const width = 50; const height = 50;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let py = 10; py < 20; py += 1) {
    for (let px = 10; px < 30; px += 2) {
      const idx = (py * width + px) * 4;
      data[idx] = 0; data[idx + 1] = 0; data[idx + 2] = 0; data[idx + 3] = 255;
    }
  }
  const thinStamp = { width, height, data };
  const result = compareRegions(pristine, thinStamp);
  assert.ok(result.weightRatio < 0.6, `expected a clearly-thin ratio, got ${result.weightRatio}`);
  assert.equal(ratioBucket(result.weightRatio), 'much-lower');
});

test('compareRegions: a taller stamp (font-size mismatch) reads a height_ratio away from parity', () => {
  const pristine = makeRegion(50, 60, { x: 10, y: 20, w: 15, h: 10 });
  const stamped = makeRegion(50, 60, { x: 10, y: 10, w: 15, h: 30 }); // 3x the glyph-band height
  const result = compareRegions(pristine, stamped);
  assert.equal(result.heightRatio, 3);
  assert.equal(ratioBucket(result.heightRatio), 'much-higher');
});

test('compareRegions: ink touching the crop edge reads overflow=true (the too-long-line case)', () => {
  const pristine = makeRegion(50, 50, { x: 10, y: 10, w: 20, h: 10 });
  const overflowing = makeRegion(50, 50, { x: 10, y: 10, w: 40, h: 10 }); // reaches width-1
  const result = compareRegions(pristine, overflowing);
  assert.equal(result.overflow, true);
});

test('compareRegions: ink safely inside the crop reads overflow=false', () => {
  const pristine = makeRegion(50, 50, { x: 10, y: 10, w: 20, h: 10 });
  const stamped = makeRegion(50, 50, { x: 10, y: 10, w: 22, h: 10 });
  const result = compareRegions(pristine, stamped);
  assert.equal(result.overflow, false);
});

test('compareRegions: a blank pristine side declines honestly (null) — never a divide-by-zero ratio', () => {
  const blank = makeRegion(30, 30, null);
  const stamped = makeRegion(30, 30, { x: 5, y: 5, w: 10, h: 10 });
  assert.equal(compareRegions(blank, stamped), null);
});

test('compareRegions: a blank stamped side declines honestly (null) — a pure deletion has nothing to compare', () => {
  const pristine = makeRegion(30, 30, { x: 5, y: 5, w: 10, h: 10 });
  const blank = makeRegion(30, 30, null);
  assert.equal(compareRegions(pristine, blank), null);
});

test('compareRegions: mismatched region dimensions decline (caller bug guard) rather than compare apples to oranges', () => {
  const a = makeRegion(30, 30, { x: 5, y: 5, w: 10, h: 10 });
  const b = makeRegion(40, 30, { x: 5, y: 5, w: 10, h: 10 });
  assert.equal(compareRegions(a, b), null);
});

test('compareRegions: never throws on garbage input', () => {
  assert.equal(compareRegions(null, null), null);
  assert.equal(compareRegions(undefined, undefined), null);
  assert.equal(compareRegions({ width: 10, height: 10 }, { width: 10, height: 10 }), null);
});

// ---- ratioBucket (telemetry-schema.js) ---------------------------------------

test('ratioBucket: the 5 cuts, and non-finite inputs collapse to the directional extreme', () => {
  assert.equal(ratioBucket(0.3), 'much-lower');
  assert.equal(ratioBucket(0.7), 'lower');
  assert.equal(ratioBucket(1.0), 'near-parity');
  assert.equal(ratioBucket(1.4), 'higher');
  assert.equal(ratioBucket(2.0), 'much-higher');
  assert.equal(ratioBucket(Infinity), 'much-higher');
  assert.equal(ratioBucket(NaN), 'much-lower');
  assert.equal(ratioBucket(-Infinity), 'much-lower');
});

// ---- ACCEPTANCE: the builder's Step 0 numbers, pinned as a regression guard --
// org-structure.pdf's "T & PPGA" box (Arial-BoldMT, the founder's real
// defect), rasterized via fontkit's own glyph outlines (a pure-JS scanline
// fill — no PDF renderer needed, see the spec-edit-fidelity-instrumentation.md
// Increment C builder notes for why): a correct BOLD "testingg" stamp reads
// weight_ratio 'near-parity' against the real pristine glyphs, while a
// deliberately-forced THIN stamp of the SAME text reads 'lower' — the exact
// separation the founder's bug needs to be legible as telemetry. These are
// the ACTUAL measured densities from that experiment (not idealized), kept
// here as floats so a future change to the bucket cuts or the density
// formula has to consciously re-decide this acceptance case rather than
// silently drifting.
test('ACCEPTANCE (Step 0 numbers): bold-correct buckets differently from thin-wrong against the real fixture', () => {
  const pristineDensity = 0.3983; // real "IT & PPGA" (Arial-BoldMT), measured
  const boldDensity = 0.3520; // "testingg" in Arimo-Bold (what the fixed ladder bakes)
  const thinDensity = 0.2745; // "testingg" in Arimo-Regular (the pre-fix bug, forced)

  const boldRatio = boldDensity / pristineDensity;
  const thinRatio = thinDensity / pristineDensity;
  assert.ok(Math.abs(boldRatio - 0.884) < 0.001);
  assert.ok(Math.abs(thinRatio - 0.689) < 0.001);

  assert.equal(ratioBucket(boldRatio), 'near-parity');
  assert.equal(ratioBucket(thinRatio), 'lower');
  assert.notEqual(ratioBucket(boldRatio), ratioBucket(thinRatio));
});
