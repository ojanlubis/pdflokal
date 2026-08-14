/*
 * Verbatim copy checks — strings Fauzan ratified 2026-08-14, PM STATE.md
 * "RATIFIED 2026-08-14 — the eleven strings are HIS now." He read them from
 * the string list and ruled "ok the strings are good, go ahead." These tests
 * pin his exact words so a refactor can't quietly drift them back to a
 * placeholder — that is the whole point of INCLUDE 7's verbatim-test
 * requirement.
 *
 * Two strings only (the page-sheet default hint + delete button). The
 * `halaman`-intent pmHint override is a separate assertion below because it
 * is set by intent-copy.js, not the markup default.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');

test.describe('ratified copy — page manager sheet (default, no declared intent)', () => {
  test('pm-hint says "Pilih halaman yang mau diambil", not the old drag-hint sentence', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('#file-input', FIXTURE);
    await expectFirstPage(page);
    await page.click('#btn-pages');
    await expect(page.locator('#pm-sheet')).toBeVisible();

    await expect(page.locator('#pm-sheet .pm-hint')).toHaveText('Pilih halaman yang mau diambil');
  });

  test('the page-sheet delete button says "Hapus Halaman" — the toolbar\'s "Hapus" (annotation delete) is untouched', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('#file-input', FIXTURE);
    await expectFirstPage(page);
    await page.click('#btn-pages');
    await expect(page.locator('#pm-sheet')).toBeVisible();

    await expect(page.locator('#pm-bulk [data-act="delete"]')).toHaveText('Hapus Halaman');
    // Control: the toolbar's annotation-delete button keeps its own, shorter word.
    await expect(page.locator('#btn-delete-anno')).toContainText('Hapus');
    await expect(page.locator('#btn-delete-anno')).not.toHaveText('Hapus Halaman');
  });
});

test.describe('ratified copy — Kelola Halaman intent-copy override', () => {
  test('?buat=halaman sets pmHint to "Centang halaman yang mau dibuang", dropping the drag half that armDrag() cannot honour', async ({ page }) => {
    await page.goto('/?buat=halaman');
    await page.setInputFiles('#file-input', FIXTURE);
    await expectFirstPage(page);
    await expect(page.locator('#pm-sheet')).toBeVisible();

    await expect(page.locator('#pm-sheet .pm-hint')).toHaveText('Centang halaman yang mau dibuang');
  });
});
