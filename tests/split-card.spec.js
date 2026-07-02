/*
 * PDFLokal — "Split PDF" homepage card flow.
 *
 * REGRESSION: the Kelola Halaman redesign (#73) removed uePmToggleExtractMode(),
 * but init-ui.js's split-card handler still called editor.uePmToggleExtractMode()
 * — a TypeError that broke the "Split PDF" card entirely. The redesigned modal has
 * no "Split mode"; the card now opens the modal and selects all pages so the
 * "Split jadi PDF" action bar is immediately visible (user deselects what they
 * don't want). This test drives the genuine card → filechooser → modal flow.
 */
import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_PDF = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');

test.describe('Split PDF card', () => {
  test('opens Kelola Halaman with all pages selected + Split action visible', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('/alat-gambar.html');

    // Clicking the card lazily creates #split-pdf-input and calls input.click(),
    // which Playwright surfaces as a 'filechooser' event.
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.click('.tool-card[data-tool="split-pdf"]');
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(SAMPLE_PDF);

    // Editor opens, PDF loads, modal appears.
    await page.waitForFunction(() => window.ueState?.pages?.length === 2, null, { timeout: 10_000 });
    await page.waitForFunction(() =>
      document.getElementById('ue-gabungkan-modal')?.classList.contains('active'));

    // select-all fired (100ms setTimeout) → bulk-action bar shows the Split button.
    await expect(page.locator('#ue-pm-selection-count')).toHaveText('2 dipilih');
    await expect(page.locator('#ue-pm-selection-actions')).toBeVisible();
    await expect(
      page.locator('#ue-pm-selection-actions button:has-text("Split jadi PDF")')
    ).toBeVisible();

    // No uncaught TypeError from the removed uePmToggleExtractMode().
    expect(errors, `unexpected page errors: ${errors.join(' | ')}`).toEqual([]);
  });
});
