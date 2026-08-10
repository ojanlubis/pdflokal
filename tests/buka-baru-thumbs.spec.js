/*
 * buka-baru-thumbs.spec.js — the thumbnail cache must not outlive its document
 * (audit 2026-08-09, finding 3).
 * ============================================================================
 * THE DEFECT THIS CLOSES: page ids are module-global monotonic
 * (core/model.js's _seq), so after Buka Baru replaces the doc, the page
 * manager's thumbs Map still held every PREVIOUS document's dataUrls under
 * ids that can never be hit again OR evicted — pure retained garbage,
 * megabytes per cycle on a large document, on exactly the mid-range phones
 * this product targets, in tabs that stay open an hour. resetDoc() cleared
 * every other cache (rasterizer, text runs, pdf-lib docs, FontFaces) and
 * missed this one; undo/redo already called invalidateThumbs(), Buka Baru
 * did not.
 *
 * Observed through the thumbCount() test hook (page-manager.js) — the cache
 * is otherwise invisible, and a leak spec with no way to read the cache would
 * be decoration. RED-ON-REVERT: without the resetDoc() fix, the old doc's
 * entries survive the reset and the post-reset count stays > 0.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NASTY = (name) => path.join(__dirname, 'fixtures', 'nasty', name);

test('Buka Baru clears the page-manager thumbnail cache', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('#file-input', NASTY('undangan-cid.pdf'));
  await expectFirstPage(page);

  // Bake at least one thumb: open the Halaman sheet and wait for the queue.
  await page.click('#btn-pages');
  await expect.poll(() => page.evaluate(() => window.v2.pageManager.thumbCount()),
    { message: 'a thumb should bake once the sheet is open' }).toBeGreaterThan(0);
  await page.click('#pm-close');

  // Buka Baru: File menu → Buka Baru → pick a new file. The picker click on
  // the hidden input is a no-op headless; setInputFiles fires the same
  // change event the real picker would, with pendingReplace armed.
  await page.click('#btn-file');
  await page.click('#fm-new');
  await page.setInputFiles('#file-input', NASTY('lorem-full.pdf'));
  await expectFirstPage(page);

  // The new doc has fresh ids and its sheet has not been opened — a clean
  // cache is EMPTY. Pre-fix, the old doc's unreachable entries survived here.
  expect(await page.evaluate(() => window.v2.pageManager.thumbCount())).toBe(0);

  // And the sheet still works after the flush: thumbs regenerate lazily.
  await page.click('#btn-pages');
  await expect.poll(() => page.evaluate(() => window.v2.pageManager.thumbCount()))
    .toBeGreaterThan(0);
});
