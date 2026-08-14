/*
 * Font-fallback witness — the toast text, at both call sites.
 * ============================================================================
 * archive/copy-awaiting-his-words (cherry-picked to main 2026-08-14, commit
 * 5e74841 "feat(export): a silent font substitution now has a witness")
 * added the WITNESS: core/export.js's cacheFallbackFont fires
 * deps.onFontFallback whenever a custom/clone font's woff2 cannot be fetched
 * and Helvetica is substituted in the KEPT file. tests/core/export-font-
 * fallback.test.mjs proves that plumbing headlessly (the callback fires, the
 * export still succeeds). It does NOT touch the user-facing string — that was
 * `TODO(copy): his words` until STATE.md "RATIFIED 2026-08-14".
 *
 * This file is the missing verbatim coverage for the two call sites that
 * turned the witness into words:
 *   - js/v2/download-sheet.js (the Unduh sheet's PDF export — doExport)
 *   - js/v2/app.js (the Kelola Halaman "Ekstrak" bulk action — onExtract)
 *
 * ⚠️ WHY window.fetch IS OVERRIDDEN via addInitScript, NOT page.route.
 * page.route('**\/fonts/carlito-*.woff2', ...) was tried first and NEVER
 * fired — this app is a PWA (sw.js) and core/export.js's `fetch(...)` call
 * resolves a real 200 for the self-hosted font either way, so the fallback
 * path never ran and every assertion below would have passed for the wrong
 * reason (or none at all — this was caught by adding a console probe: zero
 * intercepted requests, and the toast never changed from the arm-tool
 * message). Monkey-patching `window.fetch` in an init script runs at the
 * exact call site export.js uses, before any SW routing decision, and is
 * what actually drives cacheFallbackFont. [[fixture-must-distinguish]]-shaped:
 * a route that never triggers is decoration, not coverage.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';
import { downloadBytes, expectRealPdf } from './helpers/download-bytes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');
const RATIFIED = 'Sebagian teks memakai font pengganti yang mirip di file hasil';

// Fails the Carlito woff2 fetch at the JS call site itself (see header note).
async function failCarlitoFont(page) {
  await page.addInitScript(() => {
    const orig = window.fetch.bind(window);
    window.fetch = (url, opts) => {
      if (String(url).includes('fonts/carlito-')) {
        return Promise.resolve(new Response('forced failure', { status: 500 }));
      }
      return orig(url, opts);
    };
  });
}

async function placeCarlitoText(page, text) {
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await expectFirstPage(page);
  await page.click('[data-tool="text"]');
  await page.click('.pv-page >> nth=0', { position: { x: 120, y: 180 } });
  await page.keyboard.type(text);
  await page.keyboard.press('Enter'); // commits; new text stays selected (format-bar.spec.js)
  await page.selectOption('.fb-font', 'Carlito');
  const family = await page.evaluate(() => window.v2.getDoc().pages[0].annotations[0].fontFamily);
  expect(family, 'setup failed: the annotation is not actually Carlito').toBe('Carlito');
}

test.describe('font-fallback toast — his ratified string, both call sites', () => {
  test('Unduh sheet (download-sheet.js doExport): toast is exactly his string', async ({ page }) => {
    await failCarlitoFont(page);
    await placeCarlitoText(page, 'Uji font Unduh');

    const { buf } = await downloadBytes(page, async () => {
      await page.click('#btn-download');
      await expect(page.locator('#dl-sheet')).toBeVisible();
      await page.click('#ds-cta'); // default format is PDF — the base-build path that carries fontFallback
    });
    // The export still succeeded (a real, usable PDF) — this is a forewarning, not a block.
    // FIXTURE has 2 pages; Unduh's default scope is "Semua".
    await expectRealPdf(page, buf, { pages: 2 });

    await expect(page.locator('#toast')).toHaveText(RATIFIED);
  });

  test('Kelola Halaman "Ekstrak" (app.js onExtract): toast is exactly his string', async ({ page }) => {
    await failCarlitoFont(page);
    await placeCarlitoText(page, 'Uji font Ekstrak');

    await page.click('#btn-pages');
    await expect(page.locator('#pm-sheet')).toBeVisible();
    await page.click('.pm-tile >> nth=0');
    await expect(page.locator('#pm-bulk')).toBeVisible();

    const { buf } = await downloadBytes(page, () => page.click('#pm-bulk [data-act="extract"]'));
    await expectRealPdf(page, buf, { pages: 1 });

    await expect(page.locator('#toast')).toHaveText(RATIFIED);
  });

  test('CONTROL: a standard font (Helvetica) never fires the toast, on either path', async ({ page }) => {
    // No fetch override here — nothing should ever be substituted.
    await page.goto('/');
    await page.setInputFiles('#file-input', FIXTURE);
    await expectFirstPage(page);
    await page.click('[data-tool="text"]');
    await page.click('.pv-page >> nth=0', { position: { x: 120, y: 180 } });
    await page.keyboard.type('Huruf biasa');
    await page.keyboard.press('Enter');

    const { buf } = await downloadBytes(page, async () => {
      await page.click('#btn-download');
      await expect(page.locator('#dl-sheet')).toBeVisible();
      await page.click('#ds-cta');
    });
    await expectRealPdf(page, buf, { pages: 2 });
    await expect(page.locator('#toast')).not.toHaveText(RATIFIED);
  });
});
