/*
 * PDF -> Images (old wing, js/pdf-tools/standalone-tools.js): a partial
 * failure must say so, not toast success over an incomplete result.
 * ============================================================================
 * archive/copy-awaiting-his-words (cherry-picked to main 2026-08-14, commit
 * cb8ec56 "fix(tools): PDF-to-images counts skipped pages instead of
 * toasting success"): a null canvas.toBlob (canvas too large / OOM on a weak
 * phone) used to skip that page's download SILENTLY while the loop still
 * toasted "Semua halaman berhasil dikonversi!" (maintenance audit
 * 2026-08-09, finding 7). The fix counts the misses; STATE.md
 * "RATIFIED 2026-08-14" supplies the exact words for the count > 0 branch:
 * "{N} halaman gagal dikonversi, sisanya berhasil diunduh" (N interpolated).
 * The placeholder this cherry-pick shipped with already matched that string
 * verbatim (`${failed} halaman gagal dikonversi, sisanya berhasil diunduh`)
 * — nothing to change there but the stale TODO(copy) marker — so this file
 * is the missing coverage: no test anywhere drove the fail>0 branch at all,
 * let alone with a REAL count, before this commit.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');

test.describe('PDF -> Images — old wing, honest partial-failure close-out', () => {
  test('one page fails to blob (of two) -> "1 halaman gagal dikonversi, sisanya berhasil diunduh"', async ({ page }) => {
    // Force exactly the SECOND canvas.toBlob call (the export loop's, not the
    // thumbnail-render pass, which never calls toBlob at all) to report a
    // null blob — the OOM/canvas-too-large shape the fix exists for.
    await page.addInitScript(() => {
      let calls = 0;
      const orig = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function toBlobPatched(cb, ...rest) {
        calls += 1;
        if (calls === 2) { cb(null); return; }
        return orig.call(this, cb, ...rest);
      };
    });

    await page.goto('/alat-gambar.html');
    await page.click('[data-tool="pdf-to-img"]');
    await page.setInputFiles('#pdf-img-input', FIXTURE);
    await expect(page.locator('#pdf-img-pages .page-item')).toHaveCount(2);
    await expect(page.locator('#pdf-img-btn')).toBeEnabled();

    const downloadPromise = page.waitForEvent('download'); // page 1 still succeeds and downloads
    await page.click('#pdf-img-btn');
    await downloadPromise;

    await expect(page.locator('.toast span').last()).toHaveText('1 halaman gagal dikonversi, sisanya berhasil diunduh');
  });

  test('CONTROL: no failures -> the old success message, unchanged', async ({ page }) => {
    await page.goto('/alat-gambar.html');
    await page.click('[data-tool="pdf-to-img"]');
    await page.setInputFiles('#pdf-img-input', FIXTURE);
    await expect(page.locator('#pdf-img-pages .page-item')).toHaveCount(2);
    await expect(page.locator('#pdf-img-btn')).toBeEnabled();

    const downloadPromise = page.waitForEvent('download');
    await page.click('#pdf-img-btn');
    await downloadPromise;

    await expect(page.locator('.toast span').last()).toHaveText('Semua halaman berhasil dikonversi!');
    await expect(page.locator('.toast span').last()).not.toContainText(/gagal dikonversi/);
  });
});
