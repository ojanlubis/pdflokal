/*
 * The landing IS the editor's empty state (draf 3b, Jul 2026): kop-surat
 * header, calm dropzone, top-4 tool cards + accordion, FAQ. Cards boot the
 * editor pre-configured via the intent hook (?buat= for future SEO pages).
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from '../helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'sample-2pages.pdf');

test.describe('landing — mobile', () => {
  test('shows landing content, hides editor chrome until a file loads', async ({ page }) => {
    await page.goto('/');
    // H1 ruled 2026-07-29: "Buat ngurus PDF." The subhead that used to sit under
    // it was CUT, not reworded, so `.ld-sub` must not exist on the landing —
    // asserting its absence is what stops it drifting back in. It still exists,
    // deliberately, on the 12 generated tool pages.
    await expect(page.locator('.ld h1')).toContainText('Buat ngurus PDF.');
    await expect(page.locator('.ld-sub')).toHaveCount(0);
    await expect(page.locator('#toolbar')).toBeHidden();
    await expect(page.locator('.ld-card')).toHaveCount(14);
    await expect(page.locator('#ld-more')).toBeHidden(); // 10 behind the accordion

    await page.setInputFiles('#file-input', FIXTURE);
    await expectFirstPage(page);
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
    await expectFirstPage(page);
    // No stored signature yet → the signature modal opens itself.
    await expect(page.locator('#sig-modal')).toBeVisible();
  });

  test('?buat=kompres pre-configures the Unduh sheet (intent hook for SEO pages)', async ({ page }) => {
    // extensionless on purpose: the dev server's cleanUrls redirect on
    // .html URLs strips query strings (Vercel prod serves .html directly)
    await page.goto('/?buat=kompres');
    await page.setInputFiles('#file-input', FIXTURE);
    await expectFirstPage(page);
    await expect(page.locator('#dl-sheet')).toBeVisible();
    await expect(page.locator('#ds-size button.on')).toContainText('Compress');
  });

  test('Kelola Halaman card opens the sheet ready for splitting', async ({ page }) => {
    await page.goto('/');
    await page.tap('#ld-lihat'); // Split lives behind the accordion
    const chooser = page.waitForEvent('filechooser');
    await page.tap('.ld-card[data-intent="split"]');
    await (await chooser).setFiles(FIXTURE);
    await expectFirstPage(page);
    await expect(page.locator('#pm-sheet')).toBeVisible();
  });
});
