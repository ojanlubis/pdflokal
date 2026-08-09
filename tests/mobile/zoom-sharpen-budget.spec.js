/*
 * Zoom sharpening vs the fleet raster budget — the "1 juta phones" property.
 * ============================================================================
 * tests/mobile/bigdoc-stress.spec.js proves memory stays bounded on a 120-page
 * document: pages within ~2 screens rasterize, pages beyond ~4 are RELEASED,
 * and the live-raster count tracks the viewport window, not the page count.
 *
 * Focused-page sharpening (js/render/sharpen.js + js/v2/app.js) is the change
 * most able to quietly wreck that, so this file guards it from both sides:
 *
 *   A. AT ZOOM 1, NOTHING SHARPENS — on a device with devicePixelRatio 2.625.
 *      This is a SAFETY property, not a nice-to-have. sharpen.js caps the dpr
 *      term at DPR_CAP = RASTER_BASE, precisely so a document nobody zoomed
 *      renders bit-for-bit as it did before the feature existed — which is what
 *      lets bigdoc-stress keep measuring the thing it was written to measure.
 *      If this test goes red, that heap number must be re-measured on a real
 *      device before anything ships.
 *
 *   B. ZOOMED IN, THE BUDGET STILL HOLDS — at most ONE page above the baseline
 *      at any moment, and the live-raster COUNT still tracks the window.
 *
 * Runs under mobile-chrome (Pixel 7: touch, DPR ~2.625) — the same project and
 * the same fixture as bigdoc-stress, on purpose. A budget guard on a two-page
 * document would prove nothing.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'bigdoc-120.pdf');

const PAGE_COUNT = 120;
const KEEP_SCREENS = 4; // viewport.js keepScreens — mirrors bigdoc-stress

const scales = (page) => page.evaluate(() =>
  window.v2.getDoc().pages.map((p) => (p.raster ? p.raster.scale : null)));
const stats = (page) => page.evaluate(() => window.v2.getSharpenStats());
const liveRasters = (page) => page.locator('.pv-page .pv-bg').count();
const aboveBase = (list, base) => list.filter((s) => s !== null && s > base);

const zoomBurst = (page, id, n) => page.evaluate(([btn, count]) => {
  for (let i = 0; i < count; i += 1) document.getElementById(btn).click();
}, [id, n]);

const scrollTo = (page, top) =>
  page.evaluate((t) => { document.getElementById('v2-scroll').scrollTop = t; }, top);

// Same settle budget bigdoc-stress uses: past the 130ms fling gate, past the
// 200ms sharpen debounce, plus room for PDF.js.
const settle = (page, ms = 1200) => page.waitForTimeout(ms);

test.describe('editor v2 — sharpening keeps the fleet raster budget', () => {
  test('a document nobody zoomed is untouched, and zoomed in the budget still holds', async ({ page }) => {
    test.setTimeout(120_000);

    await page.goto('/');
    await page.setInputFiles('#file-input', FIXTURE);
    await expect(page.locator('.pv-page')).toHaveCount(PAGE_COUNT, { timeout: 15_000 });
    await settle(page);

    const { base } = await stats(page);
    expect(base).toBe(2);

    // Real geometry, so the bound adapts to the emulator instead of a magic
    // number — same derivation as bigdoc-stress.
    const g = await page.evaluate(() => {
      const scroll = document.getElementById('v2-scroll');
      const p = document.querySelectorAll('.pv-page');
      const r0 = p[0].getBoundingClientRect();
      const r1 = p[1].getBoundingClientRect();
      return { viewportH: scroll.clientHeight, scrollH: scroll.scrollHeight, stride: r1.top - r0.top };
    });
    const keepBound = Math.ceil(((2 * KEEP_SCREENS + 1) * g.viewportH) / g.stride) + 2;

    // ---- A. THE SAFETY PROPERTY ---------------------------------------------
    // devicePixelRatio here is ~2.625. If the dpr cap were wrong, EVERY page
    // this device ever focuses would sharpen at zoom 1 — and the bigdoc heap
    // number would be measuring a different app.
    expect(await page.evaluate(() => window.devicePixelRatio)).toBeGreaterThan(2);

    const s0 = await stats(page);
    expect(s0.issued).toBe(0); // not "no page got sharper" — NO RENDER WAS EVEN ASKED FOR

    const scales0 = await scales(page);
    for (const s of scales0) if (s !== null) expect(s).toBe(base);

    const live0 = await liveRasters(page);
    expect(live0).toBeGreaterThan(0);
    expect(live0).toBeLessThanOrEqual(keepBound);

    // Scrolling the whole document must not change that. Zoom is the only lever.
    for (const top of [g.scrollH / 4, g.scrollH / 2, g.scrollH]) {
      await scrollTo(page, top);
      await settle(page);
      expect((await stats(page)).issued).toBe(0);
      const live = await liveRasters(page);
      expect(live).toBeGreaterThan(0);
      expect(live).toBeLessThanOrEqual(keepBound);
    }

    // ---- B. ZOOMED IN, AT MOST ONE PAGE ABOVE THE BASELINE ------------------
    await scrollTo(page, g.scrollH / 2);
    await settle(page);
    // dpr caps at 2, so zoom 1.25 already puts want at 2.5 — past the trigger.
    await zoomBurst(page, 'z-in', 4); // -> zoom 2
    await settle(page);

    await expect.poll(async () => aboveBase(await scales(page), base).length, {
      timeout: 25_000, message: 'zooming in never sharpened anything on mobile',
    }).toBe(1);

    // Scroll around WHILE zoomed. Every sample: at most one page above the
    // baseline, and the live-raster count still inside the streaming bound.
    for (const top of [g.scrollH * 0.55, g.scrollH * 0.6, g.scrollH * 0.3, g.scrollH * 0.9]) {
      await scrollTo(page, top);
      await settle(page);
      const list = await scales(page);
      expect(aboveBase(list, base).length).toBeLessThanOrEqual(1);
      const live = await liveRasters(page);
      expect(live).toBeLessThanOrEqual(keepBound);
    }

    // ---- C. BACK TO ZOOM 1 = BACK TO THE BASELINE ---------------------------
    await zoomBurst(page, 'z-out', 4);
    await expect.poll(async () => aboveBase(await scales(page), base).length, {
      timeout: 25_000, message: 'a high-scale raster survived the return to zoom 1',
    }).toBe(0);

    const sEnd = await stats(page);
    console.log(JSON.stringify({ keepBound, geometry: g, sharpen: sEnd }, null, 2));
  });
});
