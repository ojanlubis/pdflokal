/*
 * Zoom sharpening — the focused page re-rasterizes when zoom settles (desktop).
 * ============================================================================
 * THE DEFECT: zoom is one CSS transform on the stage (js/v2/app.js applyZoom) —
 * atomic, GPU composited, no re-render, exact annotation registration. All of
 * that is deliberate and stays. The cost was that a raster baked at RASTER_BASE
 * and stretched by scale(3) shows 6x the page out of 2x the pixels, and the
 * founder could see it: our canvas against the same file open in Chrome.
 *
 * THE FIX, and what this file has to prove about it:
 *   1. zoom itself still renders NOTHING — only the settle timer does;
 *   2. a settled zoom past the threshold sharpens the FOCUSED page, and the
 *      sharpening is real (a bigger PNG), not a bigger number in a field;
 *   3. zooming back RELEASES it — no 6x raster left resident;
 *   4. rapid zoom in/out leaves no orphan render, because core/import.js's
 *      renderSeq guard discards the loser;
 *   5. once settled, AT MOST ONE page is above the baseline. This is the memory
 *      guarantee tests/mobile/bigdoc-stress.spec.js measures, restated as an
 *      invariant this file can sample. Note "settled": a focus handoff at high
 *      zoom has the outgoing downgrade and the incoming upgrade in flight
 *      together, so two can coexist for one render. Every sample below is taken
 *      after a settle, which is the state the bound is claimed for.
 *
 * The arithmetic (thresholds, caps, the pixel budget) is proved headless in
 * tests/core/sharpen-scale.test.mjs. This file proves the WIRING.
 *
 * Runs under the chromium project: Desktop Chrome, devicePixelRatio 1. So
 * `want = zoom` here, and with the trigger at RASTER_BASE * 1.2 = 2.4 the
 * sharpen arms at zoom 2.5 and the max zoom of 3 is comfortably past it.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');

// Enough clicks to drive zoom from either clamp to the other at 0.25 a step
// (0.3 -> 3 needs 11, 3 -> 0.3 needs 11). Overshooting is free because app.js
// clamps, and using one number for both directions makes the thrash test below
// oscillate between exactly 3 and exactly 0.3 rather than drifting.
const CLICKS_TO_MAX = 12;

// ---- readers: everything below reads an ARTIFACT, never a label -------------

// The scale recorded on each page's raster (null = released / never rastered).
const scales = (page) => page.evaluate(() =>
  window.v2.getDoc().pages.map((p) => (p.raster ? p.raster.scale : null)));

// The DECODED width of each on-screen page image. This is the one that cannot
// lie: `raster.scale` is a field we wrote, `naturalWidth` is the PNG.
const imageWidths = (page) => page.evaluate(() =>
  [...document.querySelectorAll('.pv-page')].map((v) => {
    const img = v.querySelector('.pv-bg');
    return img ? img.naturalWidth : null;
  }));

const stats = (page) => page.evaluate(() => window.v2.getSharpenStats());

const liveRasters = (page) => page.locator('.pv-page .pv-bg').count();

// The zoom actually applied, read off the computed transform matrix rather than
// a variable we could get wrong.
const appliedZoom = (page) => page.evaluate(() => {
  const t = getComputedStyle(document.getElementById('v2-stage')).transform;
  if (!t || t === 'none') return 1;
  return Number(t.slice(t.indexOf('(') + 1).split(',')[0]);
});

// Click a zoom button N times in ONE synchronous tick, AND read back the
// evidence in the same tick.
//
// WHY the reads live in here rather than in three follow-up calls: the
// "zoom rendered nothing" assertion is about the window between the zoom and
// the 200ms settle. Three separate CDP round-trips can easily exceed 200ms on a
// loaded machine — this repo has the receipts (see helpers/render.js's header:
// a full gate went red purely on machine load). The sharpen would land between
// the reads and the test would fail while the code was perfectly correct. A
// synchronous evaluate cannot be interleaved by a timer, so the snapshot it
// returns is genuinely mid-zoom, every time, on any machine.
const zoomBurst = (page, id, n) => page.evaluate(([btn, count]) => {
  for (let i = 0; i < count; i += 1) document.getElementById(btn).click();
  const t = getComputedStyle(document.getElementById('v2-stage')).transform;
  const img = document.querySelector('.pv-page .pv-bg');
  return {
    issued: window.v2.getSharpenStats().issued,
    width0: img ? img.naturalWidth : null,
    zoom: !t || t === 'none' ? 1 : Number(t.slice(t.indexOf('(') + 1).split(',')[0]),
  };
}, [id, n]);

const aboveBase = (list, base) => list.filter((s) => s !== null && s > base);

test.describe('editor v2 — zoom sharpening (desktop)', () => {
  test('a settled zoom sharpens the focused page only, and zooming back releases it', async ({ page }) => {
    test.setTimeout(60_000);

    await page.goto('/');
    await page.setInputFiles('#file-input', FIXTURE);
    await expectFirstPage(page);
    await page.waitForTimeout(1200); // let both pages stream in

    const { base } = await stats(page);
    expect(base).toBe(2); // if this changes, every number below moves with it

    // ---- baseline: the whole fleet sits at RASTER_BASE ----------------------
    const scales0 = await scales(page);
    expect(scales0.filter((s) => s !== null).length).toBeGreaterThan(0);
    for (const s of scales0) if (s !== null) expect(s).toBe(base);
    const widths0 = await imageWidths(page);
    expect(widths0[0]).toBeGreaterThan(0);

    // ---- (1) ZOOM ITSELF RENDERS NOTHING -----------------------------------
    // The whole design rests on this: zoom stays a CSS transform. If a future
    // change makes zoom call rasterize directly, the flicker and the lost
    // annotation registration come back with it.
    const before = await stats(page);
    const mid = await zoomBurst(page, 'z-in', CLICKS_TO_MAX);
    expect(mid.issued).toBe(before.issued);      // no render was even ASKED for
    expect(mid.zoom).toBeCloseTo(3, 3);          // clamped at 3 (app.js)
    expect(mid.width0).toBe(widths0[0]);         // same PNG on screen, mid-zoom

    // ---- (2) ON SETTLE, THE FOCUSED PAGE SHARPENS --------------------------
    await expect.poll(async () => (await scales(page))[0], {
      timeout: 20_000, message: 'focused page never re-rastered above the baseline',
    }).toBeGreaterThan(base);

    const sharp = (await scales(page))[0];
    expect(sharp).toBe(3); // dpr 1 x zoom 3, and an A4 is nowhere near the cap

    // The PNG really did get bigger, in proportion. Reading naturalWidth is the
    // point: a bug that updated raster.scale and re-used the old canvas would
    // pass every assertion above and fail this one.
    const widths1 = await imageWidths(page);
    expect(widths1[0]).toBeGreaterThan(widths0[0]);
    expect(widths1[0] / widths0[0]).toBeCloseTo(sharp / base, 1);

    // ---- (3) ONLY the focused page ------------------------------------------
    const scales1 = await scales(page);
    expect(aboveBase(scales1, base)).toHaveLength(1);
    for (let i = 1; i < scales1.length; i += 1) {
      if (scales1[i] !== null) expect(scales1[i]).toBe(base);
    }
    // No page GAINED a raster because of the sharpen — the streaming window
    // decides who is live, and this must not touch that.
    expect(await liveRasters(page)).toBeLessThanOrEqual(scales0.filter((s) => s !== null).length);

    // ---- (4) ZOOMING BACK RELEASES IT ---------------------------------------
    // The part that protects the memory bound: zoom in, zoom out, nothing left.
    await zoomBurst(page, 'z-out', CLICKS_TO_MAX);
    await expect.poll(async () => aboveBase(await scales(page), base).length, {
      timeout: 20_000, message: 'a high-scale raster stayed resident after zooming back out',
    }).toBe(0);

    const widths2 = await imageWidths(page);
    expect(widths2[0]).toBe(widths0[0]); // the same size PNG we started with
    expect((await scales(page))[0]).toBe(base);
  });

  test('rapid zoom in/out leaves no orphan render, and the renderSeq supersede fires', async ({ page }) => {
    test.setTimeout(90_000);

    await page.goto('/');
    await page.setInputFiles('#file-input', FIXTURE);
    await expectFirstPage(page);
    await page.waitForTimeout(1200);
    const { base } = await stats(page);

    // Thrash: cross the threshold and come back, faster than PDF.js can finish
    // a render, several times. The settle debounce is 200ms, so the 260ms dwell
    // guarantees passes actually START and then get overtaken mid-flight.
    const samples = [];
    for (let i = 0; i < 5; i += 1) {
      await zoomBurst(page, 'z-in', CLICKS_TO_MAX);
      await page.waitForTimeout(260);
      samples.push(aboveBase(await scales(page), base).length);
      await zoomBurst(page, 'z-out', CLICKS_TO_MAX);
      await page.waitForTimeout(260);
      samples.push(aboveBase(await scales(page), base).length);
    }

    // ---- INVARIANT, holds no matter how the races landed --------------------
    // Never more than one page above the baseline, at any point in the thrash.
    for (const n of samples) expect(n).toBeLessThanOrEqual(1);

    // ---- The settled state is the one the user asked for --------------------
    // Currently zoomed OUT. Everything must come to rest at the baseline — an
    // orphan render landing late is exactly what would break this.
    await expect.poll(async () => aboveBase(await scales(page), base).length, {
      timeout: 20_000, message: 'an orphan high-scale raster survived the thrash',
    }).toBe(0);
    await page.waitForTimeout(1500); // …and STAYS at rest: nothing lands late
    expect(aboveBase(await scales(page), base)).toHaveLength(0);
    expect(await appliedZoom(page)).toBeCloseTo(0.3, 3); // z-out clamps at 0.3

    const s = await stats(page);

    // Renders were genuinely thrown away rather than all completing — issued
    // must exceed what actually reached the DOM.
    expect(s.issued).toBeGreaterThan(s.applied);

    // ---- ⚠️ RACY ASSERTION — the one to relax if the gate flakes ------------
    // `superseded` counts ONLY the branch where core/import.js's renderSeq
    // discarded our render because a later one for the same page won. That is
    // the mechanism the design leans on, so it is worth asserting directly —
    // but it needs a downgrade to be issued while an upgrade is still in
    // flight, and on a very fast machine a render can finish inside the 260ms
    // dwell and never overlap. If this is the only line that fails, the
    // mechanism is fine and the timing is not: widen the loop, do not delete
    // the assertion. The invariants above are the ones that must never bend.
    expect(s.superseded).toBeGreaterThan(0);
  });
});
