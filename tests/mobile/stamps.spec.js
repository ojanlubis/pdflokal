/*
 * The stamp language: "cap = pernyataan status" — a stamp asserts document
 * status, never decorates (memory/design-language-2026-07.md). Five moments:
 * BERES (growth-loop.spec) · TAMPILAN BARU · TETAP JALAN · SUDAH OPTIMAL ·
 * BARU (changelog, future). These specs cover the three new ones.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from '../helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'sample-2pages.pdf');

test.describe('stamp moments — mobile', () => {
  test('the stamp is a PERMANENT landing element (founder call Jul 4)', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.ld-stamp')).toBeVisible();
    // Copy ruled 2026-07-29: "Tampilan baru" → "Gratis!" (specs/design-system.md
    // §6). PERMANENCE is what this test guards, not the string — but the string
    // is pinned too, because the stamp is the one closed motif the system owns
    // and a silent edit to it is a brand change nobody reviewed.
    await expect(page.locator('.ld-stamp')).toContainText('Gratis!');
    // One per page. The motif stops meaning anything the moment there are two.
    await expect(page.locator('.ld-stamp')).toHaveCount(1);
    // Permanent means permanent: still there after a reload.
    await page.reload();
    await page.waitForTimeout(1200);
    await expect(page.locator('.ld-stamp')).toBeVisible();
  });

  test('TETAP JALAN when the connection drops mid-session — once', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('#file-input', FIXTURE);
    await expectFirstPage(page);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await expect(page.locator('.v2-stamp', { hasText: 'Tetap jalan' })).toBeAttached();
    await expect(page.locator('#toast')).toContainText('jalan di HP-mu');
    // Second drop in the same session: no repeat theater.
    await page.waitForTimeout(2200);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await page.waitForTimeout(600);
    await expect(page.locator('.v2-stamp')).toHaveCount(0);
  });

  test('SUDAH OPTIMAL when compress finds nothing to save — stamped over the sheet', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('#file-input', FIXTURE);
    await expectFirstPage(page);
    await page.tap('#btn-download');
    // The tiny text-only fixture cannot shrink: the honesty guard returns the
    // original bytes and the segment says so; the stamp gives it a face.
    await page.tap('text=Compress');
    await expect(page.locator('#dl-sheet .v2-stamp', { hasText: 'Sudah optimal' }))
      .toBeAttached({ timeout: 8000 });
    await expect(page.locator('#dl-sheet')).toContainText('file sudah optimal');
  });
});
