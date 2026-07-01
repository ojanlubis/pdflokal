/*
 * PDFLokal — mobile floating-toolbar overlap regression.
 *
 * Jul 1 2026 (Android Chrome): after loading a full-bleed image (no top
 * margin), the top of the first page was hidden behind the floating toolbar.
 * Root cause: on mobile the toolbar is `position: fixed` (out of flow) but the
 * pages container had no compensating top spacing — so the first page's top
 * edge sat under the toolbar. Desktop is unaffected (toolbar is `sticky` there,
 * so it reserves flow space).
 *
 * This asserts the geometric invariant directly: the first page's canvas top
 * must not sit above the toolbar's bottom edge. Uses the solid-red A4 fixture
 * (full-bleed, no top margin) so any overlap is real, not a white margin.
 */
import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ALT_RED_PDF = path.join(__dirname, 'fixtures', 'alt-red-1page.pdf');

const MOBILE = { width: 375, height: 667 }; // matches visual.spec.js mobile

test.describe('mobile floating-toolbar overlap', () => {
  test.use({ viewport: MOBILE });

  test('first page top is not hidden under the fixed toolbar', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('#file-input', ALT_RED_PDF);
    await page.waitForFunction(() => document.body.classList.contains('editor-active'));
    await page.waitForFunction(() => window.ueState?.pages?.length === 1);
    await page.waitForFunction(
      () => window.ueState?.pageCanvases?.[0]?.rendered === true,
      null,
      { timeout: 10_000 }
    );
    // Let selection scroll / layout settle.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

    const geom = await page.evaluate(() => {
      const toolbar = document.querySelector('.floating-toolbar');
      const canvas = document.querySelectorAll('.ue-page-slot canvas')[0];
      const tb = toolbar.getBoundingClientRect();
      const cb = canvas.getBoundingClientRect();
      return { toolbarBottom: tb.bottom, canvasTop: cb.top, canvasHeight: cb.height };
    });

    // The page's visible top edge must clear the toolbar. 1px tolerance for
    // sub-pixel rounding.
    expect(
      geom.canvasTop,
      `page-0 canvas top (${geom.canvasTop}) is under the toolbar bottom (${geom.toolbarBottom}) — content hidden`
    ).toBeGreaterThanOrEqual(geom.toolbarBottom - 1);
  });
});
