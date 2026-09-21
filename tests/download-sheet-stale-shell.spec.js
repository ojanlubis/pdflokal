/*
 * THE UNDUH SHEET ON A SHELL OLDER THAN ITS OWN MODULE.
 * ============================================================================
 * Sentry JAVASCRIPT-10 / JAVASCRIPT-13 (63 events, 2026-09-09 → 09-21, Android
 * Chrome and iOS Safari alike): render() in js/v2/download-sheet.js set
 * `.hidden` on `#ds-signed` and found null. Production HTML carried the element
 * the whole time; the users did not. The seal note landed on 2026-09-09 as ONE
 * element in index.html plus the module that fills it, and a browser that
 * served the shell from the service worker's cache (a navigation fetch that
 * failed on a cold PWA launch, then a fresh module fetch seconds later) had
 * the new module addressing an element its old shell never had. One replay
 * shows the same phone succeeding at 01:37 and dying at 01:42 after a reload.
 *
 * The module owns its element now: if the shell has no `#ds-signed`, render()
 * mounts one where the shell would have put it. This spec manufactures the
 * skew by deleting the element before the sheet opens, and asserts the
 * BEHAVIOUR that mattered to those 63 taps — the sheet still opens, a real
 * size still lands on the button, and the seal note still says its piece.
 * tests/pdf-bermeterai.spec.js covers the same note on a whole shell.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NASTY = (n) => path.join(__dirname, 'fixtures', 'nasty', n);
const SIGNED = 'bermeterai.pdf';

// VERBATIM by ruling (2026-09-09), same as tests/pdf-bermeterai.spec.js: if this
// fails, ask him — never tidy the expectation.
const SEAL_NOTE = 'Dokumen ini punya meterai atau tanda tangan digital. Kalau disimpan dari sini, segelnya rusak dan dokumen bisa gagal diverifikasi. File aslimu nggak berubah.';

test('a shell without #ds-signed still opens the sheet, prices the file, and warns about the seal', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');

  // THE SKEW, manufactured: this shell predates the note; the module does not.
  await page.evaluate(() => document.getElementById('ds-signed').remove());
  expect(await page.locator('#ds-signed').count()).toBe(0);

  await page.setInputFiles('#file-input', NASTY(SIGNED));
  await expectFirstPage(page);

  // One real edit, so this download genuinely rebuilds the file and the note
  // has something true to say (the untouched path is silent by design).
  await page.click('[data-tool="whiteout"]');
  const box = await page.locator('.pv-page').first().boundingBox();
  await page.mouse.move(box.x + 60, box.y + 80);
  await page.mouse.down();
  await page.mouse.move(box.x + 220, box.y + 130, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => page.evaluate(
    () => window.v2.getDoc().pages[0].annotations.length,
  )).toBeGreaterThan(0);

  await page.click('#btn-download');
  await expect(page.locator('#dl-sheet')).toBeVisible();

  // The sheet is ALIVE: the build ran and a true size landed on the button.
  await expect(page.locator('#ds-cta-main')).toContainText(/\d+ KB|\d+,\d MB/, { timeout: 15000 });
  await expect(page.locator('#ds-cta')).toBeEnabled();

  // And the note is back, inside the sheet, saying exactly what he ruled.
  const note = page.locator('#dl-sheet #ds-signed');
  await expect(note).toHaveCount(1);
  await expect(note).toBeVisible();
  await expect(note).toHaveText(SEAL_NOTE);

  expect(errors).toEqual([]);
});
