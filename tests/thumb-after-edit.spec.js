/*
 * THE HALAMAN THUMBNAIL SHOWS THE PAGE AS IT IS NOW, EDITS INCLUDED.
 * ============================================================================
 * Thumbs are rendered through the edited-page provider, so a thumb drawn after
 * an Edit shows it. But the cache was keyed by page id alone and only cleared
 * on rotate/delete/undo/redo/new doc, so a page thumbed BEFORE an edit kept
 * its pre-edit picture in the sheet. Asserts the tile's pixels source, not the
 * cache's size.
 */
import { test, expect } from '@playwright/test';
import { armGanti, tapLine } from './helpers/lines.js';
import { LINE, openDoc } from './helpers/original-delete.js';

const tileImage = (page) => page.locator('.pm-thumb >> nth=0').evaluate((el) => el.style.backgroundImage);

test('a page thumbed before an Edit is re-thumbed after it', async ({ page }) => {
  test.setTimeout(60000);
  await openDoc(page);
  await page.click('#btn-pages');
  await expect.poll(() => tileImage(page), { timeout: 15000 }).toMatch(/^url\(/);
  const before = await tileImage(page);
  await page.click('#pm-close');

  await armGanti(page);
  await tapLine(page, { str: LINE, nth: 1 });
  await page.keyboard.type('Rapat Baru');
  await page.keyboard.press('Enter');
  await expect(page.locator('.v2-text-edit')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => !!window.v2.getDoc().pages[0].editApplied), { timeout: 15000 }).toBe(true);

  await page.click('#btn-pages');
  await expect.poll(async () => {
    const now = await tileImage(page);
    return now && now !== before;
  }, { timeout: 15000, message: 'the sheet still shows the pre-edit thumbnail' }).toBe(true);
});
