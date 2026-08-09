/*
 * THE FILE MENU'S THIRD ITEM OPENS THE SAME SHEET, NOT A SECOND ONE.
 * ============================================================================
 * His ruling 2026-08-09 (decisions.md, thread N2): `File ▾` becomes
 * `Tambah File` · `Buka Baru` · `Atur Halaman`, and the third one opens the
 * same Kelola Halaman dialog the toolbar `Halaman` button opens. The toolbar
 * button STAYS (N2 a).
 *
 * ⚠️ WHY THIS DOES NOT JUST ASSERT `#pm-sheet` IS VISIBLE AFTER EACH CLICK.
 * Two separate dialogs could both be `#pm-sheet` at different times, and a
 * duplicated implementation is exactly the failure this test exists to catch —
 * "a sheet appeared" is the label, not the artifact. So the toolbar route
 * stamps a marker property on the live DOM node, and the menu route has to
 * produce a node still carrying that stamp. Same node or the test is red.
 *
 * The structural half of the same claim — that there is ONE opener function in
 * the source — is in tests/core/file-menu.test.mjs, because no browser run can
 * see it.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');

async function openWithFile(page) {
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await expectFirstPage(page);
  await expect(page.locator('#btn-file')).toBeEnabled();
}

test.describe('File menu — three items, one page sheet', () => {
  test('the dropdown is exactly Tambah File / Buka Baru / Atur Halaman', async ({ page }) => {
    await openWithFile(page);
    await page.click('#btn-file');
    await expect(page.locator('#file-menu')).toBeVisible();
    await expect(page.locator('#btn-file')).toHaveAttribute('aria-expanded', 'true');

    const items = page.locator('#file-menu [role="menuitem"]');
    await expect(items).toHaveCount(3);
    // Accessible NAME, in his order. toHaveAccessibleName would also pass on a
    // title= fallback; the labels must come from the visible text.
    await expect(items.nth(0)).toHaveText('Tambah File');
    await expect(items.nth(1)).toHaveText('Buka Baru');
    await expect(items.nth(2)).toHaveText('Atur Halaman');
    await expect(items.nth(0)).toHaveAccessibleName('Tambah File');
    await expect(items.nth(1)).toHaveAccessibleName('Buka Baru');
    await expect(items.nth(2)).toHaveAccessibleName('Atur Halaman');
  });

  test('the grey inline notes are gone and the meaning lives in a tooltip', async ({ page }) => {
    await openWithFile(page);
    await page.click('#btn-file');

    await expect(page.locator('#file-menu .fm-note')).toHaveCount(0);
    await expect(page.locator('#file-menu')).not.toContainText('gabung');
    await expect(page.locator('#file-menu')).not.toContainText('ganti semua');

    // KNOWN AND ACCEPTED (N2 b): `title` is hover-only, so touch users lose
    // this. He was told and ruled anyway. The tooltip must still be REACHABLE —
    // a title is exposed to assistive tech as the element's description.
    await expect(page.locator('#fm-add')).toHaveAttribute('title', /.+/);
    await expect(page.locator('#fm-new')).toHaveAttribute('title', /.+/);
    await expect(page.locator('#fm-pages')).toHaveAttribute('title', /.+/);
    await expect(page.locator('#fm-add')).toHaveAccessibleDescription(/.+/);
    await expect(page.locator('#fm-pages')).toHaveAccessibleDescription(/.+/);
  });

  test('Atur Halaman opens the SAME sheet node the toolbar button opens', async ({ page }) => {
    await openWithFile(page);

    // Route 1: the toolbar button (N2 a — it stays, and it still works).
    await page.click('#btn-pages');
    await expect(page.locator('#pm-sheet')).toBeVisible();
    await expect(page.locator('.pm-tile:not(.pm-add)')).toHaveCount(2);

    // Stamp the live node. A property, not an attribute: a re-render that
    // replaced the dialog would drop it, which is precisely what we want to
    // detect. (An attribute could be copied by a duplicating implementation.)
    await page.evaluate(() => { document.getElementById('pm-sheet').__samePageSheet = 'route-1'; });

    await page.click('#pm-close');
    await expect(page.locator('#pm-sheet')).toBeHidden();

    // Route 2: the File menu.
    await page.click('#btn-file');
    await page.click('#fm-pages');

    // The dropdown closes behind the sheet — two overlapping surfaces is the bug.
    await expect(page.locator('#file-menu')).toBeHidden();
    await expect(page.locator('#btn-file')).toHaveAttribute('aria-expanded', 'false');

    await expect(page.locator('#pm-sheet')).toBeVisible();
    await expect(page.locator('.pm-tile:not(.pm-add)')).toHaveCount(2);

    // THE ASSERTION THIS FILE EXISTS FOR: the visible dialog is the very node
    // route 1 opened, still carrying its stamp.
    const stamp = await page.evaluate(() => document.getElementById('pm-sheet').__samePageSheet);
    expect(stamp).toBe('route-1');

    // And there is only one of it in the document.
    await expect(page.locator('#pm-sheet')).toHaveCount(1);
    await expect(page.locator('dialog[aria-label="Kelola halaman"]')).toHaveCount(1);
  });
});

/*
 * NOT TESTED HERE, DELIBERATELY: that both routes emit the same `pages_open`
 * telemetry. The honest browser version needs the rail's transport intercepted
 * and its batching waited out; the version I could write quickly asserted that
 * a JSON string was truthy, which passes on an empty queue. That is a green
 * that cannot go red, so it is not here. The claim is covered structurally
 * instead — tests/core/file-menu.test.mjs asserts `pages_open` is emitted from
 * exactly ONE place and that both listeners route through it.
 */
