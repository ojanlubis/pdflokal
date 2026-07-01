/*
 * PDFLokal — "Kelola Halaman" (page manager) modal redesign.
 *
 * Verifies the reworked interaction: correct naming, always-visible touch
 * controls, reference-based multi-select with a contextual bulk-action bar
 * (replacing the old hidden "Split mode"), and add-page tiles.
 */
import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_PDF = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');

async function loadSampleAndOpen(page) {
  await page.goto('/');
  await page.setInputFiles('#file-input', SAMPLE_PDF);
  await page.waitForFunction(() => window.ueState?.pages?.length === 2);
  await page.evaluate(() => window.uePmOpenModal());
  await page.waitForFunction(() => document.querySelectorAll('#ue-pm-pages .ue-pm-page-item').length === 2);
}

const rotationOf = (page, i) => page.evaluate((idx) => window.ueState.pages[idx].rotation, i);

test.describe('Kelola Halaman modal', () => {
  test('correct naming + structure (title, count, add-tiles, hint)', async ({ page }) => {
    await loadSampleAndOpen(page);

    await expect(page.locator('#ue-gabungkan-modal h3')).toHaveText('Kelola Halaman');
    await expect(page.locator('#ue-gabungkan-modal')).toHaveAttribute('aria-label', 'Kelola Halaman');
    await expect(page.locator('#ue-pm-page-count')).toHaveText('2 halaman');

    // Two add-tiles (PDF + Gambar) after the two page tiles.
    await expect(page.locator('#ue-pm-pages .ue-pm-add-tile')).toHaveCount(2);
    await expect(page.locator('#ue-pm-pages .ue-pm-add-tile').first()).toContainText('PDF');
    await expect(page.locator('#ue-pm-pages .ue-pm-add-tile').last()).toContainText('Gambar');

    // Hint visible, bulk-action bar hidden at rest.
    await expect(page.locator('#ue-pm-hint')).toBeVisible();
    await expect(page.locator('#ue-pm-selection-actions')).toBeHidden();

    // Controls are always in the DOM (not gated behind a mode).
    await expect(page.locator('.ue-pm-page-item[data-index="0"] .ue-pm-page-checkbox')).toBeVisible();
    await expect(page.locator('.ue-pm-page-item[data-index="0"] .ue-pm-page-action-btn')).toHaveCount(2);
  });

  test('selecting a page swaps hint → bulk-action bar', async ({ page }) => {
    await loadSampleAndOpen(page);

    await page.click('.ue-pm-page-item[data-index="0"] .ue-pm-page-checkbox');
    await expect(page.locator('#ue-pm-selection-actions')).toBeVisible();
    await expect(page.locator('#ue-pm-hint')).toBeHidden();
    await expect(page.locator('#ue-pm-selection-count')).toHaveText('1 dipilih');
    await expect(page.locator('.ue-pm-page-item[data-index="0"]')).toHaveClass(/selected/);

    // Batal clears selection and restores the hint.
    await page.click('#ue-pm-selection-actions .btn-ghost');
    await expect(page.locator('#ue-pm-hint')).toBeVisible();
    await expect(page.locator('#ue-pm-selection-actions')).toBeHidden();
  });

  test('bulk rotate applies to selected pages only', async ({ page }) => {
    await loadSampleAndOpen(page);
    expect(await rotationOf(page, 0)).toBe(0);
    expect(await rotationOf(page, 1)).toBe(0);

    await page.click('.ue-pm-page-item[data-index="0"] .ue-pm-page-checkbox');
    await page.click('#ue-pm-selection-actions button:has-text("Putar")');

    expect(await rotationOf(page, 0)).toBe(90);
    expect(await rotationOf(page, 1)).toBe(0);
  });

  test('bulk delete removes selected pages (blocks deleting all)', async ({ page }) => {
    await loadSampleAndOpen(page);
    page.on('dialog', (d) => d.accept()); // confirm()

    // Select all → deleting all is blocked (needs ≥1 page left).
    await page.click('#ue-pm-hint .ue-pm-selectall-link');
    await expect(page.locator('#ue-pm-selection-count')).toHaveText('2 dipilih');
    await page.click('#ue-pm-selection-actions button:has-text("Hapus")');
    expect(await page.evaluate(() => window.ueState.pages.length)).toBe(2); // blocked

    // Deselect one, then delete the remaining selected page → 1 left.
    await page.click('.ue-pm-page-item[data-index="1"] .ue-pm-page-checkbox'); // unselect page 2
    await expect(page.locator('#ue-pm-selection-count')).toHaveText('1 dipilih');
    await page.click('#ue-pm-selection-actions button:has-text("Hapus")');
    expect(await page.evaluate(() => window.ueState.pages.length)).toBe(1);
  });

  test('per-tile rotate button rotates that page', async ({ page }) => {
    await loadSampleAndOpen(page);
    // First action button in a tile is rotate.
    await page.click('.ue-pm-page-item[data-index="1"] .ue-pm-page-action-btn >> nth=0');
    expect(await rotationOf(page, 1)).toBe(90);
    expect(await rotationOf(page, 0)).toBe(0);
  });

  test('selection survives reorder (tracked by reference)', async ({ page }) => {
    await loadSampleAndOpen(page);
    // Select page at index 0, then move it to the end via the SSOT reorder.
    await page.click('.ue-pm-page-item[data-index="0"] .ue-pm-page-checkbox');
    await page.evaluate(() => { window.ueReorderPages(0, 2); window.uePmRenderPages(); });
    // The same page is now at index 1 and still selected.
    await expect(page.locator('#ue-pm-selection-count')).toHaveText('1 dipilih');
    await expect(page.locator('.ue-pm-page-item[data-index="1"]')).toHaveClass(/selected/);
  });
});
