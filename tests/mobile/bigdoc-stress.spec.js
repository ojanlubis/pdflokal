/*
 * Big-doc stress — the "1 juta phones" survival property (Editor v2).
 * ============================================================================
 * Proves the streaming render engine (js/render/viewport.js, wired in
 * js/v2/app.js) keeps memory BOUNDED on a large document: pages within ~2
 * screens rasterize to <img>, pages beyond ~4 screens are RELEASED. Scroll a
 * 120-page doc top→middle→bottom and the count of live rasters must NOT grow
 * with document size — it tracks the viewport window, not the page count.
 *
 * Runs under the mobile-chrome project (Pixel 7: touch, DPR ~2.6). Fixture is
 * tests/fixtures/bigdoc-120.pdf (see generate-bigdoc.mjs — 120 distinct pages).
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'bigdoc-120.pdf');

const PAGE_COUNT = 120;
const LOAD_SCREENS = 2; // viewport.js loadScreens — rasterize window (each side)
const KEEP_SCREENS = 4; // viewport.js keepScreens — release beyond this (each side)
const HEAP_CEIL = 900 * 1024 * 1024; // generous: catch unbounded growth, not tuning

// Read the streaming-relevant geometry straight from the engine's own frame of
// reference (getBoundingClientRect on #v2-scroll + the page views).
async function geometry(page) {
  return page.evaluate(() => {
    const scroll = document.getElementById('v2-scroll');
    const pages = document.querySelectorAll('.pv-page');
    const r0 = pages[0].getBoundingClientRect();
    const r1 = pages[1].getBoundingClientRect();
    return {
      viewportH: scroll.clientHeight,
      scrollH: scroll.scrollHeight,
      pageH: r0.height,
      stride: r1.top - r0.top, // visual px between consecutive page tops (incl. gap)
      slotCount: pages.length,
    };
  });
}

async function rasterCount(page) {
  return page.locator('.pv-page .pv-bg').count();
}

async function scrollTo(page, top) {
  await page.evaluate((t) => { document.getElementById('v2-scroll').scrollTop = t; }, top);
}

// Let the fling gate lapse (settleMs=130) and give PDF.js a moment to catch up.
async function settle(page, ms = 900) {
  await page.waitForTimeout(ms);
}

async function heap(page) {
  return page.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize : null));
}

test.describe('editor v2 — big-doc streaming (memory stays bounded)', () => {
  test('120-page doc: streaming keeps live rasters bounded, heap flat, edits work', async ({ page }) => {
    test.setTimeout(90_000);

    // ---- (a) slots exist quickly, scrollbar reflects the full document --------
    await page.goto('/editor-v2.html');
    const t0 = Date.now();
    await page.setInputFiles('#file-input', FIXTURE);
    await expect(page.locator('.pv-page')).toHaveCount(PAGE_COUNT, { timeout: 10_000 });
    const slotMs = Date.now() - t0;
    expect(slotMs).toBeLessThan(10_000);

    const g = await geometry(page);
    expect(g.slotCount).toBe(PAGE_COUNT);
    // Document height ≈ 120 × page stride (metadata-only layout, no raster needed).
    const expectedH = g.stride * PAGE_COUNT;
    expect(g.scrollH).toBeGreaterThan(expectedH * 0.9);
    expect(g.scrollH).toBeLessThan(expectedH * 1.2);

    // The honest engine bound: nothing beyond the keep window (KEEP_SCREENS each
    // side + the viewport itself) may hold a raster. Computed from real geometry
    // so it adapts to the emulator's viewport/zoom instead of a magic number.
    const keepWindowScreens = 2 * KEEP_SCREENS + 1;
    const keepBound = Math.ceil((keepWindowScreens * g.viewportH) / g.stride) + 2;
    const loadWindowScreens = 2 * LOAD_SCREENS + 1;
    const loadBound = Math.ceil((loadWindowScreens * g.viewportH) / g.stride) + 2;

    const heapLoad = await heap(page);

    // Wait for the initial (top) window to rasterize so we have a real baseline.
    await settle(page);
    const topCount = await rasterCount(page);
    expect(topCount).toBeGreaterThan(0); // first screens actually rendered
    expect(topCount).toBeLessThanOrEqual(keepBound);
    expect(topCount).toBeLessThan(25);

    // ---- (b) STREAMING BOUND: jump to the middle, count live rasters ----------
    await scrollTo(page, g.scrollH / 2);
    await settle(page);
    const midCount = await rasterCount(page);
    expect(midCount).toBeGreaterThan(0);       // caught up after the fling settled
    expect(midCount).toBeLessThanOrEqual(keepBound);
    expect(midCount).toBeLessThan(25);
    const heapMid = await heap(page);

    // Jump to the bottom — the release path is the actual memory guarantee.
    await scrollTo(page, g.scrollH);
    await settle(page);
    const bottomCount = await rasterCount(page);
    expect(bottomCount).toBeGreaterThan(0);
    expect(bottomCount).toBeLessThanOrEqual(keepBound);
    expect(bottomCount).toBeLessThan(25);
    const heapBottom = await heap(page);

    // Direct proof RELEASE happened: page 1, ~120 screens above the bottom of the
    // doc, must have dropped its raster. If eviction were broken every page the
    // user ever scrolled past would still be an <img> and this would fail.
    await expect(page.locator('.pv-page').nth(0).locator('.pv-bg')).toHaveCount(0);
    // …and a page near the bottom DID rasterize (catch-up works both directions).
    const bottomHasRaster = await page.evaluate(() => {
      const pages = document.querySelectorAll('.pv-page');
      for (let i = pages.length - 1; i >= pages.length - 10; i -= 1) {
        if (pages[i].querySelector('.pv-bg')) return true;
      }
      return false;
    });
    expect(bottomHasRaster).toBe(true);

    // ---- (c) heap sanity: bounded, not growing with pages scrolled -----------
    if (heapLoad !== null) {
      for (const h of [heapLoad, heapMid, heapBottom]) expect(h).toBeLessThan(HEAP_CEIL);
      // Scrolling the whole doc must not balloon the heap: the release window
      // caps live raster memory. Allow generous slack for GC lag / lib caches.
      expect(heapBottom).toBeLessThan(heapLoad + 250 * 1024 * 1024);
    }

    // ---- (d) interactions still work deep in the doc (page ~100) --------------
    const p100 = page.locator('.pv-page').nth(99);
    await p100.scrollIntoViewIfNeeded();
    await settle(page);
    await expect(p100.locator('.pv-bg')).toBeVisible({ timeout: 8_000 });

    await page.tap('[data-tool="text"]');
    await p100.tap({ position: { x: 120, y: 160 } });
    await expect(page.locator('.v2-text-edit')).toBeVisible();
    await page.keyboard.type('Halaman seratus');
    await page.keyboard.press('Enter');

    const annos100 = await page.evaluate(() => window.v2.getDoc().pages[99].annotations);
    expect(annos100.some((a) => a.type === 'text' && a.text === 'Halaman seratus')).toBe(true);
    // The edit landed on page 100 and nowhere else.
    const strayText = await page.evaluate(() =>
      window.v2.getDoc().pages
        .filter((_, i) => i !== 99)
        .some((p) => p.annotations.some((a) => a.type === 'text' && a.text === 'Halaman seratus')));
    expect(strayText).toBe(false);

    // ---- (e) the Unduh sheet builds the whole 120-page PDF and reports a size -
    await page.tap('#btn-download');
    await expect(page.locator('#dl-sheet')).toBeVisible();
    // Base build of 120 pages completes and the CTA shows real bytes (KB/MB).
    await expect(page.locator('#ds-cta-main')).toContainText(/\d+([.,]\d+)?\s*(KB|MB)/, { timeout: 30_000 });

    // Report the observed numbers into the test log for the run summary.
    console.log(JSON.stringify({
      slotMs, geometry: g, keepBound, loadBound,
      rasterCounts: { top: topCount, middle: midCount, bottom: bottomCount },
      heapMB: heapLoad === null ? 'unavailable' : {
        load: +(heapLoad / 1048576).toFixed(1),
        middle: +(heapMid / 1048576).toFixed(1),
        bottom: +(heapBottom / 1048576).toFixed(1),
      },
    }, null, 2));
  });
});
