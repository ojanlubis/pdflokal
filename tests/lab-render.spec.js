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

    // Exactly one demo annotation (a TEXT, active), stacked ABOVE the page
    // raster inside the overlay — the structural fix for "annotation slides
    // behind another page".
    //
    // ⚠️ THIS USED TO ASSERT THE LITERAL 1000, and that number stopped being
    // the rule on 2026-08-09: Tip-Ex is a GROUND, not a layer (founder
    // ruling), so the selected annotation goes to the top of its OWN band
    // rather than the top of everything — otherwise a held Tip-Ex appears
    // above the text it belongs under and drops behind on release. The
    // invariant this test exists for is unchanged; only its mechanism moved,
    // so the assertion now reads the shared constant instead of a magic
    // number it would otherwise have to re-guess every time the bands change.
    // See core/annotation-order.js and tests/annotation-layering.spec.js.
    const anno = page.locator('.pv-anno');
    await expect(anno).toHaveCount(1);
    const z = await anno.evaluate((el) => Number(getComputedStyle(el).zIndex));
    const expected = await page.evaluate(async () => {
      const { annotationZIndex } = await import('/js/core/annotation-order.js');
      return annotationZIndex({ type: 'text' }, { selected: true });
    });
    expect(z).toBe(expected);
    // The claim behind the number: it really is painted over the raster, and
    // a positive stacking value is what puts it there.
    expect(z).toBeGreaterThan(0);
    const bgZ = await page.locator('.pv-bg').first()
      .evaluate((el) => Number(getComputedStyle(el).zIndex) || 0);
    expect(z).toBeGreaterThan(bgZ);
  });
});
