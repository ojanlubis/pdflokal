/*
 * PDFLokal — Ctrl/Cmd+S opens the Unduh sheet, from anywhere.
 *
 * WHY this exists: the shortcut used to live in the main keydown handler, which
 * stands down inside any field, and the inline text editor stops propagation of
 * every keydown. So Ctrl+S worked only when nothing was focused — and while
 * typing, where people actually press it, the browser's own Save Page opened.
 * The listener is now capture-phase. Not run by the foreground gate (nightly CI).
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

// True when a Ctrl+S keydown dispatched at `selector` ends up default-prevented.
const prevented = (page, selector) => page.evaluate((sel) => {
  const ev = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true });
  document.querySelector(sel).dispatchEvent(ev);
  return ev.defaultPrevented;
}, selector);

async function openDoc(page) {
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await expectFirstPage(page);
}

test.describe('Ctrl/Cmd+S opens Unduh', () => {
  test('with nothing focused', async ({ page }) => {
    await openDoc(page);
    await page.keyboard.press(`${MOD}+s`);
    await expect(page.locator('#dl-sheet')).toBeVisible();
  });

  test('while typing in the inline text editor (it stops propagation of keydown)', async ({ page }) => {
    await openDoc(page);
    await page.keyboard.press('t');
    await page.click('.pv-page >> nth=0', { position: { x: 200, y: 200 } });
    await page.keyboard.type('sedang mengetik');
    await expect(page.locator('.v2-text-edit')).toBeFocused();
    await page.keyboard.press(`${MOD}+s`);
    await expect(page.locator('#dl-sheet')).toBeVisible();
    // The half-typed text was committed by the editor's blur, not lost.
    expect(await page.evaluate(() => window.v2.getDoc().pages[0].annotations.map((a) => a.text)))
      .toEqual(['sedang mengetik']);
  });

  test('while focus is in a format-bar field', async ({ page }) => {
    await openDoc(page);
    await page.keyboard.press('t');
    await page.click('.pv-page >> nth=0', { position: { x: 200, y: 200 } });
    await page.keyboard.type('x');
    await page.keyboard.press('Enter');
    const size = page.locator('#format-bar input.fb-size');
    await size.focus();
    expect(await prevented(page, ':focus')).toBe(true);
    await page.keyboard.press(`${MOD}+s`);
    await expect(page.locator('#dl-sheet')).toBeVisible();
  });

  test('with no document open it only prevents the browser default', async ({ page }) => {
    await page.goto('/');
    expect(await prevented(page, 'body')).toBe(true);
    await page.keyboard.press(`${MOD}+s`);
    await expect(page.locator('#dl-sheet')).toBeHidden();
  });
});
