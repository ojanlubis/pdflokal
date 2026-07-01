/*
 * UI visual regression suite.
 *
 * Captures screenshots of key UI states across desktop + mobile viewports.
 * Different from tests/golden/ — that suite tests EXPORTED PDF fidelity. This
 * suite tests LIVE UI rendering, which catches a different bug class: modal
 * layout drift, mobile chrome collisions, stale canvases after file replace,
 * empty-state flash, sidebar misalignment.
 *
 * Regenerate baselines:
 *   npx playwright test tests/visual.spec.js --update-snapshots
 *
 * Baselines live in tests/visual.spec.js-snapshots/ and ARE tracked by git.
 * On a mismatch the actual + diff PNGs are dropped into test-results/ and
 * uploaded as an artifact by the e2e workflow (upload-artifact on failure).
 *
 * WHY a separate file from tests/golden/: golden.spec.js renders the exported
 * PDF back through PDF.js and pixel-diffs that — it's catching export-side
 * regressions in glyph placement, fonts, rotation. This file screenshots the
 * editor chrome — it catches what the user SEES, which is what mostly broke
 * during the May/June bug sprints.
 */
import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_PDF = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');

// Desktop viewport mirrors devices['Desktop Chrome']. Mobile mirrors a common
// Android Chrome viewport (Pixel 5-ish). The screenshots are headless
// Chromium — not a substitute for real device QA — but they catch the layout
// regressions which is the highest-leverage tier of mobile bugs.
const DESKTOP = { width: 1280, height: 720 };
const MOBILE = { width: 375, height: 667 };

// WHY a tolerance ratio at all: anti-alias drift across Chromium versions and
// the headless Linux renderer in CI vs macOS dev would otherwise trip exact
// match constantly. 1% absorbs that without missing real shifts (modals move,
// bars overlap, canvases stale).
const SCREENSHOT_OPTS = {
  maxDiffPixelRatio: 0.01,
  animations: 'disabled',
  // Hide caret blink + any in-flight CSS transitions for stability.
  caret: 'hide',
};

// Hide elements whose content changes day-to-day (date stamps, notification
// dots). Stale-by-design content trips pixel diff for no useful reason.
async function hideVolatileChrome(page) {
  await page.addStyleTag({
    content: `
      #changelog-notification { display: none !important; }
      #toast-container { display: none !important; }
      #fullscreen-loading { display: none !important; }
    `,
  });
}

async function loadSamplePdf(page) {
  await page.setInputFiles('#file-input', SAMPLE_PDF);
  await page.waitForFunction(() => document.body.classList.contains('editor-active'));
  await page.waitForFunction(() => window.ueState?.pages?.length === 2);
  await page.waitForSelector('.ue-page-slot canvas');
  // PDF.js render is async — the canvas exists with width:height set BEFORE
  // pixels are drawn. waiting on canvas.width > 0 captures a blank canvas
  // ~10% of the time, which produces flaky baselines forever.
  //
  // Instead: poll canvas ImageData until we see actual non-white pixels in the
  // center sample region. Once PDF page content is painted, this resolves and
  // we trust the next two rAFs to settle paint.
  await page.waitForFunction(() => {
    const canvas = document.querySelector('.ue-page-slot canvas');
    if (!canvas || canvas.width === 0) return false;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return false;
    const cx = Math.floor(canvas.width / 2);
    const cy = Math.floor(canvas.height / 2);
    const sample = ctx.getImageData(cx - 50, cy - 50, 100, 100).data;
    for (let i = 0; i < sample.length; i += 4) {
      // Any non-near-white pixel = real PDF content has rendered.
      if (sample[i] < 240 || sample[i + 1] < 240 || sample[i + 2] < 240) return true;
    }
    return false;
  }, { timeout: 10_000 });
  // Two rAFs for the layout/paint to settle (selection borders, sidebar highlight, etc.)
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

test.describe('UI visual regression — desktop', () => {
  test.use({ viewport: DESKTOP });

  test('homepage empty state', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await hideVolatileChrome(page);
    await expect(page).toHaveScreenshot('homepage-empty-desktop.png', SCREENSHOT_OPTS);
  });

  test('editor with sample PDF loaded', async ({ page }) => {
    await page.goto('/');
    await hideVolatileChrome(page);
    await loadSamplePdf(page);
    // WHY mask canvases: PDF.js render produces subpixel AA noise that
    // exceeds maxDiffPixelRatio across runs. The valuable signal here is the
    // editor CHROME around the canvas (header, toolbar, sidebar layout),
    // not the rasterized PDF pixels — the export-side golden suite in
    // tests/golden/ already catches PDF rendering regressions.
    await expect(page).toHaveScreenshot('editor-loaded-desktop.png', {
      ...SCREENSHOT_OPTS,
      mask: [page.locator('.ue-page-slot canvas, .ue-sidebar-thumb canvas')],
    });
  });

  test('editor file menu open', async ({ page }) => {
    await page.goto('/');
    await hideVolatileChrome(page);
    await loadSamplePdf(page);
    await page.evaluate(() => window.toggleEditorFileMenu?.(new Event('click')));
    await page.waitForSelector('#editor-file-dropdown.open', { timeout: 2000 }).catch(() => {});
    await expect(page).toHaveScreenshot('file-menu-open-desktop.png', {
      ...SCREENSHOT_OPTS,
      mask: [page.locator('.ue-page-slot canvas, .ue-sidebar-thumb canvas')],
    });
  });

  test('floating toolbar more-tools dropdown open', async ({ page }) => {
    await page.goto('/');
    await hideVolatileChrome(page);
    await loadSamplePdf(page);
    await page.evaluate(() => window.toggleFloatingMore?.(new Event('click')));
    await page.waitForSelector('#more-tools-dropdown.active', { timeout: 2000 }).catch(() => {});
    await expect(page).toHaveScreenshot('more-tools-open-desktop.png', {
      ...SCREENSHOT_OPTS,
      mask: [page.locator('.ue-page-slot canvas, .ue-sidebar-thumb canvas')],
    });
  });

  test('kelola halaman modal open', async ({ page }) => {
    await page.goto('/');
    await hideVolatileChrome(page);
    await loadSamplePdf(page);
    await page.evaluate(() => window.uePmOpenModal?.());
    await page.waitForFunction(() => {
      const m = document.getElementById('ue-gabungkan-modal');
      return m && m.classList.contains('active');
    });
    // Modal contents render thumbnails asynchronously — let them settle.
    await page.waitForFunction(() => document.querySelectorAll('#ue-pm-pages .ue-pm-page-item').length > 0);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    // WHY screenshot the modal ELEMENT, not the page: a full-page shot lets the
    // main-canvas mask (drawn last by Playwright) paint over the centered modal,
    // so modal changes never registered. Scope the shot to the dialog itself and
    // mask only its own (content-varying) page thumbnails.
    const modal = page.locator('#ue-gabungkan-modal');
    await expect(modal).toHaveScreenshot('gabungkan-modal-desktop.png', {
      ...SCREENSHOT_OPTS,
      mask: [modal.locator('.ue-pm-page-item canvas')],
    });
  });
});

test.describe('UI visual regression — mobile', () => {
  test.use({ viewport: MOBILE });

  test('homepage empty state', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await hideVolatileChrome(page);
    await expect(page).toHaveScreenshot('homepage-empty-mobile.png', SCREENSHOT_OPTS);
  });

  test('editor with sample PDF loaded', async ({ page }) => {
    await page.goto('/');
    await hideVolatileChrome(page);
    await loadSamplePdf(page);
    await expect(page).toHaveScreenshot('editor-loaded-mobile.png', {
      ...SCREENSHOT_OPTS,
      mask: [page.locator('.ue-page-slot canvas, .ue-sidebar-thumb canvas')],
    });
  });

  test('mobile tools dropdown open', async ({ page }) => {
    await page.goto('/');
    await hideVolatileChrome(page);
    await loadSamplePdf(page);
    await page.evaluate(() => window.toggleMobileTools?.());
    await page.waitForSelector('#mobile-tools-dropdown.active', { timeout: 2000 }).catch(() => {});
    await expect(page).toHaveScreenshot('mobile-tools-open-mobile.png', {
      ...SCREENSHOT_OPTS,
      mask: [page.locator('.ue-page-slot canvas, .ue-sidebar-thumb canvas')],
    });
  });
});
