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
  /*
   * THE STAMP IS A PERMANENT LANDING ELEMENT — and this test carries the trail
   * of two founder rulings, because a test is a record of a decision and when
   * the decision changes the record has to say so.
   *
   *   2026-07-04  ruled: the stamp is PERMANENT, mobile and desktop, and reads
   *               "Tampilan baru". This test was written for that, and its old
   *               title said so.
   *   2026-07-29  SUPERSEDED, on the text only: "gratis replaces tampilan baru"
   *               (banked in ../decisions.md). The question that produced it was
   *               whether a second stamp-treated element could share the page —
   *               and the answer is the salience budget: ONE stamp per page. The
   *               loud currency gets spent once, so the two candidates had to
   *               become one and "Gratis!" won.
   *
   * ⚠️ WHAT SURVIVED AND WHAT DID NOT. Permanence survived — that is still the
   * Jul 4 ruling and it is still what the first two assertions guard. Only the
   * string changed. Left un-updated, this test would have gone on enforcing a
   * dead instruction and a future reader would find two founder rulings in
   * conflict with no way to tell which way it runs.
   */
  test('the stamp is a PERMANENT landing element (Jul 4, text superseded Jul 29)', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.ld-stamp')).toBeVisible();
    await expect(page.locator('.ld-stamp')).toContainText('Gratis!');
    // The salience budget, asserted: ONE per page. The motif stops meaning
    // anything the moment there are two, which is the reasoning that retired
    // "Tampilan baru" rather than adding to it.
    await expect(page.locator('.ld-stamp')).toHaveCount(1);
    // And the superseded string must be gone from the surface entirely, not
    // merely out-ranked by a second stamp somewhere further down.
    await expect(page.locator('body')).not.toContainText('Tampilan baru');
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
