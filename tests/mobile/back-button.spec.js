/*
 * Android back button: closes the open sheet, never leaves the editor.
 * (Every dialog open pushes a history entry; back pops it → dialog closes;
 * UI-initiated closes consume their own entry without side effects.)
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'sample-2pages.pdf');

async function openDoc(page) {
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();
}

test.describe('back button — mobile', () => {
  test('back closes Kelola Halaman instead of leaving the page', async ({ page }) => {
    await openDoc(page);
    await page.tap('#btn-pages');
    await expect(page.locator('#pm-sheet')).toBeVisible();
    await page.goBack();
    await expect(page.locator('#pm-sheet')).toBeHidden();
    expect(new URL(page.url()).pathname).toBe('/'); // still here, not navigated away
    await expect(page.locator('.pv-page').first()).toBeVisible();
  });

  test('nested sheets: back peels one layer at a time', async ({ page }) => {
    await openDoc(page);
    await page.tap('#btn-download');
    await expect(page.locator('#dl-sheet')).toBeVisible();
    await page.tap('#ds-pages [data-v="some"]'); // Kelola Halaman on top
    await expect(page.locator('#pm-sheet')).toBeVisible();

    await page.goBack();
    await expect(page.locator('#pm-sheet')).toBeHidden();
    await expect(page.locator('#dl-sheet')).toBeVisible(); // still one layer left
    await page.waitForTimeout(250); // let traversal #1 fully settle (see rapid test below)

    await page.goBack();
    await expect(page.locator('#dl-sheet')).toBeHidden();
    expect(new URL(page.url()).pathname).toBe('/');
  });

  test('RAPID double-back (coalesced traversal) still closes everything, stays on page', async ({ page }) => {
    await openDoc(page);
    await page.tap('#btn-download');
    await page.tap('#ds-pages [data-v="some"]');
    await expect(page.locator('#pm-sheet')).toBeVisible();

    // Two backs as fast as the harness can fire them — the browser may
    // coalesce them into a single popstate. Outcome must be the same.
    await Promise.all([page.goBack(), page.goBack()]).catch(() => {});
    await expect(page.locator('#pm-sheet')).toBeHidden();
    await expect(page.locator('#dl-sheet')).toBeHidden();
    expect(new URL(page.url()).pathname).toBe('/');
    await expect(page.locator('.pv-page').first()).toBeVisible();
  });

  test('UI close (✕) leaves history clean: back after it does not reopen or exit oddly', async ({ page }) => {
    await openDoc(page);
    await page.tap('#btn-download');
    await expect(page.locator('#dl-sheet')).toBeVisible();
    await page.tap('#ds-close');
    await expect(page.locator('#dl-sheet')).toBeHidden();
    // The dialog's history entry was consumed — nothing dialog-ish left to pop.
    // (history.back() is async — poll.)
    await expect.poll(async () => page.evaluate(() => window.history.state?.v2dlg || null)).toBe(null);
  });
});
