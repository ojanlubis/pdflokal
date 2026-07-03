/*
 * The landing IS the editor's empty state (draf 3b, Jul 2026): kop-surat
 * header, calm dropzone, top-4 tool cards + accordion, FAQ. Cards boot the
 * editor pre-configured via the intent hook (?buat= for future SEO pages).
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'sample-2pages.pdf');

test.describe('landing — mobile', () => {
  test('shows landing content, hides editor chrome until a file loads', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.ld h1')).toContainText('PDF beres dalam hitungan detik');
    await expect(page.locator('#toolbar')).toBeHidden();
    await expect(page.locator('.ld-card')).toHaveCount(14);
    await expect(page.locator('#ld-more')).toBeHidden(); // 10 behind the accordion

    await page.setInputFiles('#file-input', FIXTURE);
    await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();
    await expect(page.locator('#empty')).toBeHidden();
    await expect(page.locator('#toolbar')).toBeVisible();
  });

  test('"Lihat semua alat" expands the full vocabulary', async ({ page }) => {
    await page.goto('/');
    await page.tap('#ld-lihat');
    await expect(page.locator('#ld-more')).toBeVisible();
    await expect(page.locator('.ld-card', { hasText: 'Hapus Background' })).toBeVisible();
    await expect(page.locator('#ld-lihat')).toContainText('Sembunyikan');
    await page.tap('#ld-lihat');
    await expect(page.locator('#ld-more')).toBeHidden();
  });

  test('Tanda Tangan card boots the signature flow after the file loads', async ({ page }) => {
    await page.goto('/');
    const chooser = page.waitForEvent('filechooser');
    await page.tap('.ld-card[data-intent="ttd"]');
    await (await chooser).setFiles(FIXTURE);
    await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();
    // No stored signature yet → the signature modal opens itself.
    await expect(page.locator('#sig-modal')).toBeVisible();
  });

  test('?buat=kompres pre-configures the Unduh sheet (intent hook for SEO pages)', async ({ page }) => {
    // extensionless on purpose: the dev server's cleanUrls redirect on
    // .html URLs strips query strings (Vercel prod serves .html directly)
    await page.goto('/?buat=kompres');
    await page.setInputFiles('#file-input', FIXTURE);
    await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();
    await expect(page.locator('#dl-sheet')).toBeVisible();
    await expect(page.locator('#ds-size button.on')).toContainText('Compress');
  });

  test('Kelola Halaman card opens the sheet ready for splitting', async ({ page }) => {
    await page.goto('/');
    await page.tap('#ld-lihat'); // Split lives behind the accordion
    const chooser = page.waitForEvent('filechooser');
    await page.tap('.ld-card[data-intent="split"]');
    await (await chooser).setFiles(FIXTURE);
    await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();
    await expect(page.locator('#pm-sheet')).toBeVisible();
  });
});
