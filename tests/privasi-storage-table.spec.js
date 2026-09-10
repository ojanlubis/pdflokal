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
 * `pdflokal_signature` joined them 2026-08-17, when the opt-in device save was
 * built (`#sig-save` → js/v2/signature-modal.js). Its Fungsi string is his too,
 * ratified in the same eleven — spec-signature-save.md §5. The row and the
 * feature ship and revert together: a row without the write site documents a key
 * nothing writes, and a write site without the row under-reports storage on the
 * one page that must not be approximately right.
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

  test('pdflokal_signature carries his ratified wording, character for character', async ({ page }) => {
    await page.goto('/privasi.html');
    const table = page.locator('.storage-table');
    await expect(table).toBeVisible();

    // `text-is` on the <code> is exact, so it cannot match the longer
    // `pdflokal_signature_hint_shown` key sitting in the next row.
    const row = table.locator('tr', { has: page.locator('code:text-is("pdflokal_signature")') });
    await expect(row).toHaveCount(1);
    await expect(row.locator('td').nth(1))
      .toHaveText('Menyimpan tanda tangan di perangkat ini agar tidak perlu digambar ulang');
  });

  // pdflokal_visitor_id (2026-09-10, seat decisions.md same date) — DRAFT
  // wording, put to him, NOT YET RATIFIED. Unlike the block above this test
  // does not pin the copy character for character: doing that before he has
  // ruled would misrepresent a draft as his words, the exact thing this
  // file's own header exists to prevent in the other direction. Once he
  // rules, replace this with an exact-text pin the same shape as the other
  // two tests here and cite the date.
  test('lists pdflokal_visitor_id, the one key that is not a pure local preference', async ({ page }) => {
    await page.goto('/privasi.html');
    const table = page.locator('.storage-table');
    await expect(table).toBeVisible();

    const row = table.locator('tr', { has: page.locator('code:text-is("pdflokal_visitor_id")') });
    await expect(row).toHaveCount(1);
    const fungsi = await row.locator('td').nth(1).innerText();
    // Structural checks only, because the wording itself is unruled. The ROW
    // must say this key leaves the browser for pdflokal's own server — that is
    // the fact a reader skimming only the table has to come away with.
    expect(fungsi).toMatch(/keluar dari browsermu/);
    expect(fungsi).toMatch(/server saya sendiri/);

    // ⚠️ THE THREE NAMED NON-DESTINATIONS MOVED, AND THIS GUARD MOVED WITH THEM
    // (2026-09-10 later, the /privasi consolidation). They used to be crammed
    // into the table cell AND repeated in a paragraph under the table AND
    // implied in Telemetri Produk — three tellings of one fact, which is the
    // sediment that pass was written to remove. They now live once, in
    // Telemetri Produk, where the id's whole story is told. What must not be
    // lost is the CLAIM, so it is asserted here at its new address: the
    // section that says "no cookie, no cross-visit id" has to name this key as
    // its one exception and say which services never receive it. Elsewhere on
    // the page an identical "no cross-visit id" line is scoped to Mixpanel
    // only; this is the paragraph that keeps the two from reading as a
    // contradiction.
    // ⚠️ BY ITS HEADING, NOT BY hasText. `hasText: 'Telemetri Produk'` matched TWO
    // sections the moment the Perekaman Sesi section gained a cross-reference to
    // this one ("ID pengunjung yang saya ceritakan di Telemetri Produk…"), which
    // is copy the consolidation deliberately added. A locator that a legitimate
    // sentence can break is the wrong locator.
    const telemetrySection = page
      .locator('.privacy-section')
      .filter({ has: page.getByRole('heading', { name: 'Telemetri Produk' }) });
    await expect(telemetrySection.getByText('pdflokal_visitor_id')).toHaveCount(1);
    const telemetryText = await telemetrySection.innerText();
    expect(telemetryText).toMatch(/Mixpanel/);
    expect(telemetryText).toMatch(/GA4/);
    expect(telemetryText).toMatch(/Sentry/);
  });
});
