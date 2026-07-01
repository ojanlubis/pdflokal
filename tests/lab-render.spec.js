/*
 * PDFLokal — Phase-1 render-engine preview (/lab.html) smoke test.
 *
 * Guards the new image-backed render path: a PDF flows through the core
 * (import + rasterize) and renders as <img>-backed pages with a single
 * annotation overlay whose active object is top-most. This is the engine the
 * live editor adopts in Phase 1 — if it goes red, the render layer regressed.
 */
import { test, expect } from '@playwright/test';

test.describe('render engine preview (lab)', () => {
  test('renders image-backed pages with the active annotation on top', async ({ page }) => {
    await page.goto('/lab.html');

    // Slots are laid out INSTANTLY (streaming: metadata first, pixels later).
    await page.waitForFunction(
      () => document.querySelectorAll('.pv-page').length === 2,
      null, { timeout: 10_000 });

    // Both sample pages are near the viewport → they stream in as real PNGs.
    await page.waitForFunction(
      () => document.querySelectorAll('.pv-bg').length === 2,
      null, { timeout: 10_000 });
    const bgIsPng = await page.evaluate(() =>
      (document.querySelector('.pv-bg')?.src || '').startsWith('data:image/png'));
    expect(bgIsPng).toBe(true);

    // Exactly one demo annotation, and it is top-most (z-index 1000) —
    // the structural fix for "annotation slides behind another page".
    const anno = page.locator('.pv-anno');
    await expect(anno).toHaveCount(1);
    const z = await anno.evaluate((el) => Number(getComputedStyle(el).zIndex));
    expect(z).toBeGreaterThanOrEqual(1000);
  });
});
