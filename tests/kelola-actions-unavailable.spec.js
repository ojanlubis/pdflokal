/*
 * Kelola Halaman (v2 #pm-sheet): the bulk actions are visible at zero selection
 * and UNAVAILABLE, not absent and not natively disabled.
 *
 * Measured (rail, 2026-09-02): on 6-20 page documents, sessions that opened this
 * sheet exported at 51% vs 88% for those that never did; the sheet used to hide
 * every verb until a tile was picked. Commit 2748337 made them render. This spec
 * pins the semantics that commit left open:
 *
 *   - aria-disabled="true", never the `disabled` attribute. A native-disabled
 *     button is skipped by Tab and by a screen reader's walk, so the keyboard
 *     user would still never meet the verbs. (Playwright's toBeDisabled honours
 *     aria-disabled, so it cannot tell the two apart: these tests read the
 *     attribute and the focusability directly.)
 *   - an unavailable button that is focused and activated does nothing.
 *   - selecting flips it, deselecting flips it back.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');

const ACTS = ['rotate', 'extract', 'delete'];
const act = (page, name) => page.locator(`#pm-bulk [data-act="${name}"]`);

async function openSheet(page) {
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await expectFirstPage(page);
  await page.click('#btn-pages');
  await expect(page.locator('#pm-sheet')).toBeVisible();
  await expect(page.locator('.pm-tile:not(.pm-add)')).toHaveCount(2);
}

const rotation = (page) => page.evaluate(() => window.v2.getDoc().pages[0].rotation);

test.describe('Kelola Halaman: actions at zero selection', () => {
  test('visible, aria-disabled, and NOT natively disabled', async ({ page }) => {
    await openSheet(page);
    await expect(page.locator('#pm-bulk .pm-count')).toHaveText('0 dipilih');
    for (const name of ACTS) {
      const b = act(page, name);
      await expect(b).toBeVisible();
      await expect(b).toHaveAttribute('aria-disabled', 'true');
      // The native attribute would drop the button from the tab order.
      expect(await b.evaluate((el) => el.hasAttribute('disabled'))).toBe(false);
      // The reason a screen reader reads after "dimmed": the count.
      await expect(b).toHaveAttribute('aria-describedby', 'pm-count');
    }
    // Batal has nothing to cancel at zero.
    await expect(act(page, 'clear')).toBeHidden();
  });

  test('keyboard reaches them, and Enter / Space on one does nothing', async ({ page }) => {
    await openSheet(page);
    for (const name of ACTS) {
      await act(page, name).focus();
      await expect(act(page, name)).toBeFocused();
    }
    // Tab from the add tile walks onto the first action, in order.
    await page.locator('.pm-add').focus();
    await page.keyboard.press('Tab');
    await expect(act(page, 'rotate')).toBeFocused();

    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    expect(await rotation(page)).toBe(0);
    // No history entry was recorded for a no-op.
    await expect(page.locator('#btn-undo')).toBeDisabled();
    // Still in the sheet, still focused: nothing yanked focus away.
    await expect(page.locator('#pm-sheet')).toBeVisible();
    await expect(act(page, 'rotate')).toBeFocused();
  });

  test('selecting enables them; the action then works; deselecting restores', async ({ page }) => {
    await openSheet(page);
    // Keyboard selection path: Enter on a focused tile.
    await page.locator('.pm-tile:not(.pm-add)').first().focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#pm-bulk .pm-count')).toHaveText('1 dipilih');
    for (const name of ACTS) {
      await expect(act(page, name)).not.toHaveAttribute('aria-disabled', 'true');
    }
    await expect(act(page, 'clear')).toBeVisible();

    await act(page, 'rotate').focus();
    await page.keyboard.press('Enter');
    expect(await rotation(page)).toBe(90);

    // Deselect the tile again: back to unavailable.
    await page.locator('.pm-tile:not(.pm-add)').first().focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#pm-bulk .pm-count')).toHaveText('0 dipilih');
    for (const name of ACTS) {
      await expect(act(page, name)).toHaveAttribute('aria-disabled', 'true');
    }
  });

  test('Hapus Halaman is unavailable when every page is selected, and stays inert', async ({ page }) => {
    await openSheet(page);
    await page.locator('.pm-tile:not(.pm-add)').nth(0).click();
    await page.locator('.pm-tile:not(.pm-add)').nth(1).click();
    await expect(page.locator('#pm-bulk .pm-count')).toHaveText('2 dipilih');
    await expect(act(page, 'delete')).toHaveAttribute('aria-disabled', 'true');
    await expect(act(page, 'rotate')).not.toHaveAttribute('aria-disabled', 'true');

    await act(page, 'delete').focus();
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => window.v2.getDoc().pages.length)).toBe(2);
  });

  test('Batal returning to zero hands focus to a tile, not <body>', async ({ page }) => {
    await openSheet(page);
    await page.locator('.pm-tile:not(.pm-add)').first().click();
    await act(page, 'clear').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#pm-bulk .pm-count')).toHaveText('0 dipilih');
    await expect(act(page, 'clear')).toBeHidden();
    const onTile = await page.evaluate(() => document.activeElement?.classList.contains('pm-tile'));
    expect(onTile).toBe(true);
  });

  test('an unavailable action does not light up on hover', async ({ page }) => {
    await openSheet(page);
    const read = () => act(page, 'rotate').evaluate((el) => {
      const cs = getComputedStyle(el);
      return { color: cs.color, border: cs.borderTopColor, cursor: cs.cursor };
    });
    const before = await read();
    await act(page, 'rotate').hover();
    const after = await read();
    expect(after.color).toBe(before.color);
    expect(after.border).toBe(before.border);
    expect(after.cursor).toBe('not-allowed');
    // And it is muted, not the red of a touchable thing (Hapus Halaman included).
    const del = await act(page, 'delete').evaluate((el) => getComputedStyle(el).color);
    expect(del).toBe(before.color);
  });
});
