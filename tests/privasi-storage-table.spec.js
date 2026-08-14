/*
 * privasi.html — the Local Storage table must list every key the product
 * actually writes.
 * ============================================================================
 * spec-signature-save.md §6 ("FOUND WHILE SCOPING"): the table listed 2 keys
 * while the code wrote 6. The page introduces the table with "PDFLokal
 * menyimpan beberapa preferensi di browser kamu" and reads as the complete
 * list — under-reporting on the privacy page is exactly the surface that must
 * not be approximately right. Fauzan ratified four of the missing rows'
 * copy 2026-08-14 (STATE.md "RATIFIED 2026-08-14"); this pins his exact
 * words so a future edit can't quietly drop a row back out.
 *
 * `pdflokal_signature` is DELIBERATELY NOT covered here — spec-signature-save.md
 * still marks that feature "scoped, not built" (no #sig-save checkbox, no write
 * site anywhere in js/), so a row claiming the page "menyimpan tanda tangan"
 * would describe a capability the code does not have. See the bench report.
 */
import { test, expect } from '@playwright/test';

test.describe('privasi.html — Local Storage table, ratified rows', () => {
  test('lists the four keys added 2026-08-14, with his exact wording', async ({ page }) => {
    await page.goto('/privasi.html');
    const table = page.locator('.storage-table');
    await expect(table).toBeVisible();

    const rows = [
      ['pdflokal_signature_hint_shown', 'Mengingat bahwa petunjuk tanda tangan sudah pernah ditampilkan'],
      ['pdflokal-ps-voted', 'Mengingat bahwa ajakan uji coba Play Store sudah dijawab'],
      ['pdflokal-ps-last', 'Menyimpan kapan ajakan uji coba Play Store terakhir ditampilkan'],
      ['pdflokal-install-dismissed', 'Mengingat bahwa ajakan pasang aplikasi sudah ditutup'],
    ];
    for (const [key, fungsi] of rows) {
      const row = table.locator('tr', { has: page.locator(`code:text-is("${key}")`) });
      await expect(row).toHaveCount(1);
      await expect(row.locator('td').nth(1)).toHaveText(fungsi);
    }

    // Pre-existing rows are untouched — this change only adds.
    await expect(table.locator('code:text-is("pdflokal_theme")')).toHaveCount(1);
    await expect(table.locator('code:text-is("pdflokal_changelog_last_closed")')).toHaveCount(1);
  });
});
