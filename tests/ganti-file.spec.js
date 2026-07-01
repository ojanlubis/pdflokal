/*
 * PDFLokal — "Ganti File" (replace-all) regression suite.
 *
 * Maps to the Jun 9 2026 production bug: after replacing the loaded document
 * via the File ▸ Ganti File menu, the page count updated to the new file but
 * the main canvas stayed BLANK (or showed the OLD document's pixels). Root
 * cause: PageRenderer._pdfDocCache is keyed by sourceIndex and is a private
 * instance property NOT covered by ueReset()'s getDefaultUeState() wipe — so
 * the stale PDF.js document for sourceIndex 0 survived the reset and the next
 * render pulled the previous file's page.
 *
 * WHY the real filechooser flow (not setInputFiles on #ue-replace-input):
 * the original scripted test bypassed the actual File ▸ Ganti File path and
 * — more importantly — never sampled canvas PIXELS, so it couldn't see a
 * blank/stale render. This suite drives the genuine menu → picker flow and
 * asserts on rendered pixels.
 *
 * Fixture choice: alt-red-1page.pdf is a solid-red A4 page. sample-2pages.pdf
 * is white with black text. So the center pixel cleanly distinguishes the
 * three states: RED = new file rendered (correct); WHITE = blank OR stale
 * (both bug modes).
 */
import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_PDF = path.join(__dirname, 'fixtures', 'sample-2pages.pdf'); // 2pp, white
const ALT_RED_PDF = path.join(__dirname, 'fixtures', 'alt-red-1page.pdf'); // 1pp, solid red

// Open the editor from the homepage dropzone input and wait for the first
// page to actually render (so its PDF.js doc lands in _pdfDocCache — that is
// the cache that must be invalidated on Ganti File).
async function loadViaHomepage(page, file, expectedPages) {
  await page.setInputFiles('#file-input', file);
  await page.waitForFunction(() => document.body.classList.contains('editor-active'));
  await page.waitForFunction(
    (n) => window.ueState?.pages?.length === n,
    expectedPages
  );
  await waitForRendered(page, 0);
}

async function waitForRendered(page, index) {
  await page.waitForFunction(
    (i) => window.ueState?.pageCanvases?.[i]?.rendered === true,
    index,
    { timeout: 10_000 }
  );
}

// Sample the dead-center pixel of a rendered page canvas.
async function centerPixel(page, index) {
  return page.evaluate((i) => {
    const c = window.ueState.pageCanvases[i].canvas;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const { data } = ctx.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1);
    return { r: data[0], g: data[1], b: data[2], a: data[3] };
  }, index);
}

const isRed = (px) => px.r > 180 && px.g < 80 && px.b < 80;

test.describe('Ganti File (real-flow file picker)', () => {
  // Positive control: proves the red fixture renders red on a plain fresh load,
  // isolating any failure below to the Ganti File flow (not the fixture).
  test('positive control: fresh load of the red PDF renders red', async ({ page }) => {
    await page.goto('/');
    await loadViaHomepage(page, ALT_RED_PDF, 1);
    const px = await centerPixel(page, 0);
    expect(isRed(px), `expected red center pixel on fresh load, got ${JSON.stringify(px)}`).toBe(true);
  });

  // The regression: load the white 2-page sample, then replace it via the real
  // File ▸ Ganti File menu → native picker → red 1-page PDF. The main canvas
  // MUST show the new (red) document, not blank/stale.
  test('regression: replacing via Ganti File renders the NEW document', async ({ page }) => {
    await page.goto('/');
    await loadViaHomepage(page, SAMPLE_PDF, 2);

    // Sanity: the sample's first page is NOT red (white bg) — so a red result
    // after replacement can only come from the new file.
    const before = await centerPixel(page, 0);
    expect(isRed(before), `sample page unexpectedly red before replace: ${JSON.stringify(before)}`).toBe(false);

    // Drive the genuine menu → picker flow. ueReplaceFiles() calls input.click()
    // on #ue-replace-input, which Playwright surfaces as a 'filechooser' event.
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.locator('.editor-header-file-btn').click(); // open File menu
    await page
      .locator('#editor-file-dropdown .sidebar-file-menu-item', { hasText: 'Ganti File' })
      .click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(ALT_RED_PDF);

    // New file fully replaced the old one.
    await page.waitForFunction(() => window.ueState?.pages?.length === 1, null, { timeout: 10_000 });
    expect(await page.evaluate(() => window.ueState.sourceFiles.length)).toBe(1);

    await waitForRendered(page, 0);
    const after = await centerPixel(page, 0);
    expect(
      isRed(after),
      `main canvas did not render the new red PDF after Ganti File (stale _pdfDocCache?). Got ${JSON.stringify(after)}`
    ).toBe(true);
  });
});
