/*
 * A toast fired from inside the Halaman sheet must be SEEN, and must not outlive
 * its message in the top layer.
 *
 * dialog.showModal() puts the sheet in the top layer, which no z-index outranks,
 * so #toast (position:fixed; z-index:40) painted under it: Ekstrak looked dead
 * and "Halaman dihapus" never showed. The fix puts #toast in the top layer too
 * (popover="manual", re-raised on every toast) so it enters AFTER the dialog,
 * and takes it out again once the fade is done so it cannot paint above the
 * support/install/maker/vote cards for the rest of the session.
 *
 * WHY NOT elementFromPoint: while #pm-sheet is modal, everything outside the
 * dialog is inert, #toast included, and a hit test skips inert content whatever
 * its pointer-events. So the probe is top-layer MEMBERSHIP (:popover-open), the
 * only thing the browser exposes about it, plus the computed look of the toast.
 * Membership is the right proof: a top-layer element entered after the dialog is
 * above it by definition, and toast() re-enters on every call.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');

const state = (page) => page.evaluate(() => {
  const t = document.getElementById('toast');
  const cs = getComputedStyle(t);
  return {
    topLayer: t.matches(':popover-open'),
    opacity: cs.opacity, visibility: cs.visibility, display: cs.display,
    text: t.textContent,
  };
});

async function openSheetWithTwoPages(page) {
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await expectFirstPage(page);
  await page.click('#btn-pages');
  await expect(page.locator('#pm-sheet')).toBeVisible();
  await expect(page.locator('.pm-tile:not(.pm-add)')).toHaveCount(2);
}

test('known-positive: the probe can tell a top-layer element from a plain fixed one', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(() => {
    const plain = document.createElement('div');
    plain.style.cssText = 'position:fixed;z-index:2147483647;top:0;left:0;width:10px;height:10px';
    document.body.append(plain);
    const pop = document.createElement('div');
    pop.setAttribute('popover', 'manual');
    document.body.append(pop);
    pop.showPopover();
    return { plain: plain.matches(':popover-open'), pop: pop.matches(':popover-open') };
  });
  // A z-index of 2^31-1 is still not the top layer; only a popover/dialog is.
  expect(r).toEqual({ plain: false, pop: true });
});

test('a toast fired while the Halaman sheet is open is in the top layer, visible; then leaves it', async ({ page }) => {
  await openSheetWithTwoPages(page);
  expect(await state(page)).toMatchObject({ topLayer: false }); // idle: not stacking over anything

  await page.locator('.pm-tile:not(.pm-add)').first().click();
  await page.locator('#pm-bulk [data-act="delete"]').click();

  const toast = page.locator('#toast');
  await expect(toast).toHaveClass(/show/);
  await expect(toast).not.toHaveText('');
  // The sheet is modal (so it IS in the top layer) and the toast entered after it.
  expect(await page.evaluate(() => document.getElementById('pm-sheet').matches(':modal'))).toBe(true);
  await expect.poll(async () => (await state(page)).opacity).toBe('1');
  expect(await state(page)).toMatchObject({ topLayer: true, visibility: 'visible' });

  // Still where it always was: horizontally centred, not pushed to mid-screen.
  const box = await toast.boundingBox();
  const vp = page.viewportSize();
  expect(Math.abs(box.x + box.width / 2 - vp.width / 2)).toBeLessThan(2);
  expect(vp.height - (box.y + box.height)).toBeGreaterThan(100);

  // After the message and its fade the toast leaves the top layer again.
  await expect(toast).not.toHaveClass(/show/, { timeout: 10000 });
  await expect.poll(async () => (await state(page)).topLayer, { timeout: 3000 }).toBe(false);
});
