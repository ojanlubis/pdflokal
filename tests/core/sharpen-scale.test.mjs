/*
 * PDFLokal — headless: the raster-resolution policy (js/render/sharpen.js).
 *
 * The browser spec (tests/zoom-sharpen.spec.js) proves the WIRING — that a
 * settled zoom actually produces a bigger PNG for one page and releases it on
 * the way back down. This file proves the ARITHMETIC, which is where the
 * dangerous mistakes live and where a browser is no help:
 *
 *   - the sharpen CANNOT fire without zoom, on ANY device pixel ratio. That is
 *     the property that keeps tests/mobile/bigdoc-stress.spec.js measuring what
 *     it measured before this module existed — a doc nobody zooms is untouched.
 *   - the scale is capped twice (absolute, and by a page-size-aware pixel
 *     budget), so a poster page cannot ask for a canvas the browser answers
 *     with a blank.
 *   - the function never returns below the fleet baseline.
 *
 * Run: npm run test:core
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  sharpenScale, maxPixelsFor,
  RASTER_BASE, SHARPEN_RATIO, SHARPEN_MAX_SCALE, DPR_CAP, MAX_PIXELS,
} from '../../js/render/sharpen.js';

const A4 = { pageWidth: 595, pageHeight: 842 };          // 0.50 Mpt²
const A0 = { pageWidth: 2384, pageHeight: 3370 };        // 8.03 Mpt² — poster
const CARD = { pageWidth: 252, pageHeight: 144 };        // 0.036 Mpt² — business card
const DESKTOP = MAX_PIXELS.desktop;
const NO_BUDGET = 1e9;                                    // isolate the zoom arithmetic

// Zoom arithmetic only — the pixel budget gets its own tests below, because on
// real budgets it bites an A4 before SHARPEN_MAX_SCALE does and would otherwise
// mask what these are checking.
const at = (o) => sharpenScale({ ...A4, maxPixels: NO_BUDGET, ...o });

// ---- 1. THE SAFETY PROPERTY: zoom 1 never sharpens, on any screen -----------
// If this ever goes red, the big-doc memory measurement is no longer measuring
// the same thing and must be re-run on a real device before shipping.
test('zoom 1 returns the baseline at every plausible device pixel ratio', () => {
  for (const dpr of [1, 1.5, 2, 2.625, 3, 4]) {
    assert.equal(at({ zoom: 1, dpr }), RASTER_BASE, `dpr ${dpr} sharpened at zoom 1`);
  }
});

test('DPR_CAP is what makes that true — it is at most the baseline', () => {
  // want = zoom * min(dpr, DPR_CAP). At zoom 1 that is DPR_CAP at most, and the
  // trigger needs want > RASTER_BASE * SHARPEN_RATIO. Assert the relationship,
  // not the constants, so a future tweak to either one trips this test.
  assert.ok(DPR_CAP <= RASTER_BASE * SHARPEN_RATIO,
    'DPR_CAP > the trigger: zoom-1 loads would start sharpening');
});

test('below the trigger ratio nothing happens; above it, something does', () => {
  const dpr = 1;
  const trigger = RASTER_BASE * SHARPEN_RATIO;          // 2.4 at the shipped values
  assert.equal(at({ zoom: trigger, dpr }), RASTER_BASE); // strictly greater, not >=
  assert.equal(at({ zoom: trigger * 0.99, dpr }), RASTER_BASE);
  assert.ok(at({ zoom: trigger * 1.01, dpr }) > RASTER_BASE);
});

// ---- 2. It tracks what the screen is actually painting -----------------------
test('the scale follows zoom x dpr, quantized up to half-steps', () => {
  assert.equal(at({ zoom: 3, dpr: 1 }), 3);      // desktop, max zoom
  assert.equal(at({ zoom: 1.5, dpr: 2 }), 3);    // retina, half zoom — same demand
  assert.equal(at({ zoom: 3, dpr: 2 }), 6);      // retina at max zoom
  assert.equal(at({ zoom: 1.3, dpr: 2 }), 3);    // 2.6 -> 3.0, rounded UP
  assert.equal(at({ zoom: 1.25, dpr: 2 }), 2.5); // 2.5 lands exactly
});

test('dpr above DPR_CAP buys nothing — zoom is the only lever', () => {
  assert.equal(at({ zoom: 2, dpr: 2.625 }), at({ zoom: 2, dpr: 2 }));
  assert.equal(at({ zoom: 3, dpr: 8 }), at({ zoom: 3, dpr: 2 }));
});

test('quantization stops a pinch re-rendering on every frame', () => {
  // A slow drag from 1.30 to 1.34 at dpr 2 crosses 2.60 -> 2.68 and must ask
  // for the same scale the whole way, or the settle timer fires a new render
  // for each finger twitch.
  const seen = new Set();
  for (let z = 1.30; z <= 1.349; z += 0.002) seen.add(at({ zoom: z, dpr: 2 }));
  assert.equal(seen.size, 1, `pinch churn: asked for ${[...seen].join(', ')}`);
});

// ---- 3. Both caps ------------------------------------------------------------
test('SHARPEN_MAX_SCALE is an absolute ceiling, independent of the budget', () => {
  // A business card never troubles the pixel budget, so this isolates the hard
  // ceiling. Reachable only if someone raises the zoom limit past 3 — exactly
  // the change that would otherwise multiply the raster cost silently.
  const ceil = (o) => sharpenScale({ ...CARD, maxPixels: DESKTOP, ...o });
  assert.equal(ceil({ zoom: 20, dpr: 2 }), SHARPEN_MAX_SCALE);
  assert.equal(ceil({ zoom: 1000, dpr: 4 }), SHARPEN_MAX_SCALE);
});

test('the pixel budget bites before the ceiling does, on real pages and real budgets', () => {
  // Shipped values, worst case: A4, max zoom, retina, desktop budget. 6x would
  // be 595*842*36 = 18.0 MP against a 16.8 MP budget — so it is NOT allowed to
  // ask for 6, and the honest answer is the largest half-step that fits.
  const a4 = sharpenScale({ ...A4, zoom: 3, dpr: 2, maxPixels: DESKTOP });
  assert.ok(a4 < SHARPEN_MAX_SCALE, 'A4 at max zoom was allowed the hard ceiling');
  assert.equal(a4, 5.5);
  assert.ok(A4.pageWidth * A4.pageHeight * a4 * a4 <= DESKTOP);

  // …and a poster page gets less again. This is the "do not let it grow without
  // bound on a huge page" property, read off the artifact rather than a flag.
  const a0 = sharpenScale({ ...A0, zoom: 3, dpr: 2, maxPixels: DESKTOP });
  assert.ok(a0 < a4, 'a poster page was allowed the same scale as an A4');
});

test('a phone budget caps harder than a desktop one for the same page and zoom', () => {
  const phone = sharpenScale({ ...A4, zoom: 3, dpr: 2, maxPixels: MAX_PIXELS.phone });
  const desktop = sharpenScale({ ...A4, zoom: 3, dpr: 2, maxPixels: MAX_PIXELS.desktop });
  assert.ok(phone < desktop, 'the phone budget bought the same scale as desktop');
  assert.ok(phone >= RASTER_BASE);
});

test('the resulting raster never exceeds the budget (unless the BASELINE already does)', () => {
  for (const page of [A4, A0, { pageWidth: 1224, pageHeight: 792 }]) {
    for (const cls of ['phone', 'tablet', 'desktop']) {
      const maxPixels = maxPixelsFor(cls);
      for (const zoom of [1, 1.5, 2, 2.5, 3]) {
        for (const dpr of [1, 2, 3]) {
          const s = sharpenScale({ ...page, zoom, dpr, maxPixels });
          const px = page.pageWidth * page.pageHeight * s * s;
          const basePx = page.pageWidth * page.pageHeight * RASTER_BASE * RASTER_BASE;
          if (basePx > maxPixels) {
            // Page is already over budget at the fleet baseline — not this
            // module's call to shrink it, but it must not make it WORSE.
            assert.equal(s, RASTER_BASE,
              `${cls} z${zoom} d${dpr}: sharpened a page already over budget`);
          } else {
            assert.ok(px <= maxPixels,
              `${cls} z${zoom} d${dpr}: ${(px / 1e6).toFixed(1)}MP > ${(maxPixels / 1e6).toFixed(1)}MP`);
          }
        }
      }
    }
  }
});

test('a phone gets a smaller budget than a desktop, and an unknown class gets the phone one', () => {
  assert.ok(maxPixelsFor('phone') < maxPixelsFor('tablet'));
  assert.ok(maxPixelsFor('tablet') < maxPixelsFor('desktop'));
  assert.equal(maxPixelsFor('watch'), MAX_PIXELS.phone);
  assert.equal(maxPixelsFor(undefined), MAX_PIXELS.phone);
});

// ---- 4. Never below the floor, never NaN -------------------------------------
test('the return is always a finite number >= RASTER_BASE', () => {
  const nasty = [
    {}, { zoom: 0 }, { zoom: -3 }, { zoom: NaN }, { dpr: 0 }, { dpr: NaN },
    { pageWidth: 0, pageHeight: 0, zoom: 3, dpr: 2 },
    { pageWidth: NaN, pageHeight: NaN, zoom: 3, dpr: 2 },
    { maxPixels: 0, zoom: 3, dpr: 2 }, { maxPixels: NaN, zoom: 3, dpr: 2 },
    { pageWidth: 1e9, pageHeight: 1e9, zoom: 3, dpr: 2 },
  ];
  for (const o of nasty) {
    const s = sharpenScale({ ...A4, ...o });
    assert.ok(Number.isFinite(s), `not finite for ${JSON.stringify(o)}`);
    assert.ok(s >= RASTER_BASE, `below baseline (${s}) for ${JSON.stringify(o)}`);
    assert.ok(s <= SHARPEN_MAX_SCALE, `above ceiling (${s}) for ${JSON.stringify(o)}`);
  }
  assert.equal(sharpenScale(), RASTER_BASE); // no args at all
});

// ---- 5. Monotonic — zooming in never asks for LESS ---------------------------
test('scale is non-decreasing in zoom', () => {
  let prev = 0;
  for (let z = 0.3; z <= 3.001; z += 0.05) {
    const s = at({ zoom: z, dpr: 2 });
    assert.ok(s >= prev, `zoom ${z.toFixed(2)} asked for ${s} after ${prev}`);
    prev = s;
  }
});
