/*
 * A toast fired from inside the Halaman sheet must be SEEN.
 *
 * dialog.showModal() puts the sheet in the top layer, which no z-index outranks,
 * so #toast (position:fixed; z-index:40) painted under it: Ekstrak looked dead
 * (the user tapped twice and got two files) and "Halaman dihapus" never showed.
 * The fix puts #toast in the top layer too (popover="manual", re-raised on each
 * toast) so it enters AFTER the dialog.
 *
 * #toast is pointer-events:none, so elementFromPoint skips it. The probe turns
 * pointer events on for one read, which is what makes "who is on top at the
 * toast's centre" answerable.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');

const topAtToastCentre = (page) => page.evaluate(() => {
  const t = document.getElementById('toast');
  const r = t.getBoundingClientRect();
  const prev = t.style.pointerEvents;
  t.style.pointerEvents = 'auto';
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  t.style.pointerEvents = prev;
  return { onToast: hit === t || t.contains(hit), open: t.matches(':popover-open') };
});

test('a toast fired while the Halaman sheet is open paints above the sheet', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await expectFirstPage(page);
  await page.click('#btn-pages');
  await expect(page.locator('#pm-sheet')).toBeVisible();
  await expect(page.locator('.pm-tile:not(.pm-add)')).toHaveCount(2);

  await page.locator('.pm-tile:not(.pm-add)').first().click();
  await page.locator('#pm-bulk [data-act="delete"]').click();

  const toast = page.locator('#toast');
  await expect(toast).toHaveClass(/show/);
  await expect(toast).not.toHaveText('');
  expect(await topAtToastCentre(page)).toEqual({ onToast: true, open: true });
  // Still where it always was: horizontally centred, not pushed to mid-screen.
  const box = await toast.boundingBox();
  const vp = page.viewportSize();
  expect(Math.abs(box.x + box.width / 2 - vp.width / 2)).toBeLessThan(2);
  expect(vp.height - (box.y + box.height)).toBeGreaterThan(100);
});

test('a toast shown BEFORE a sheet opens is re-raised by the next toast', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await expectFirstPage(page);
  // Pin the property directly: two toasts around a modal open, the second wins.
  const onTop = await page.evaluate(() => {
    const t = document.getElementById('toast');
    t.textContent = 'x'; t.classList.add('show'); t.showPopover();
    document.getElementById('pm-sheet').showModal();
    t.hidePopover(); t.showPopover(); // what toast() does on every call
    const r = t.getBoundingClientRect();
    t.style.pointerEvents = 'auto';
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit === t;
  });
  expect(onTop).toBe(true);
});
