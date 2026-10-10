/*
 * Filling a form blank after blank: with Teks armed, clicking the next spot
 * while the box is still open must give ONE focused box there, with the first
 * box's text committed and Teks still armed.
 * ============================================================================
 * Before: the new editor claimed the shared editing state and took focus, and
 * only then did the first editor's blur commit it. That commit cleared the
 * state the new editor had claimed and re-synced the page, which emptied the
 * overlay with the new box in it. No box was left, Teks was off, the first text
 * was selected, and the next Backspace deleted it. On another page the new box
 * survived without being the editing target, so Ctrl+B bolded the FIRST text.
 * The fix is app.js closeOpenEditor, called by openTextEditor before it claims
 * the state (wiring pin: tests/core/editor-handoff.test.mjs). The phone version
 * (taps) is in tests/mobile/format-bar.spec.js.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');

const texts = (page, n = 0) => page.evaluate((i) => window.v2.getDoc().pages[i].annotations.map((a) => a.text), n);

async function openTeksAndType(page, text) {
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await expectFirstPage(page);
  await page.keyboard.press('t');
  await page.click('.pv-page >> nth=0', { position: { x: 100, y: 100 } });
  await expect(page.locator('.v2-text-edit')).toBeFocused();
  if (text) await page.keyboard.type(text);
}

async function expectOneFocusedBoxTeksArmed(page) {
  await expect(page.locator('.v2-text-edit')).toHaveCount(1);
  await expect(page.locator('.v2-text-edit')).toBeFocused();
  await expect(page.locator('[data-tool="text"]')).toHaveAttribute('aria-pressed', 'true');
}

test.describe('Teks: the next click while a box is open opens the next box', () => {
  test('blank after blank: one focused box per click, every text committed', async ({ page }) => {
    await openTeksAndType(page, 'Satu');
    await page.click('.pv-page >> nth=0', { position: { x: 100, y: 300 } });
    await expectOneFocusedBoxTeksArmed(page);
    expect(await texts(page)).toEqual(['Satu']);

    // Before the fix nothing had focus here and 'Satu' was selected, so this
    // Backspace deleted it.
    await page.keyboard.press('Backspace');
    expect(await texts(page)).toEqual(['Satu']);

    await page.keyboard.type('Dua');
    // A third blank, without pressing t again: Teks is still armed.
    await page.click('.pv-page >> nth=0', { position: { x: 100, y: 420 } });
    await expectOneFocusedBoxTeksArmed(page);
    await page.keyboard.type('Tiga');
    await page.keyboard.press('Enter');

    await expect(page.locator('.v2-text-edit')).toHaveCount(0);
    expect(await texts(page)).toEqual(['Satu', 'Dua', 'Tiga']);
  });

  test('an empty box moves to the next click, one box only', async ({ page }) => {
    await openTeksAndType(page, '');
    await page.click('.pv-page >> nth=0', { position: { x: 100, y: 300 } });
    await expectOneFocusedBoxTeksArmed(page);
    await page.keyboard.type('Dua');
    await page.keyboard.press('Enter');
    expect(await texts(page)).toEqual(['Dua']);
  });

  test('the next box on the other page is the one Ctrl+B styles', async ({ page }) => {
    await openTeksAndType(page, 'Satu');
    await page.click('.pv-page >> nth=1', { position: { x: 100, y: 100 } });
    await expectOneFocusedBoxTeksArmed(page);

    await page.keyboard.press('Control+b');
    expect(await page.evaluate(() => window.v2.getDoc().pages[0].annotations[0].bold),
      'Ctrl+B in the new box restyled the first text').toBe(false);
    await page.keyboard.type('Dua');
    await page.keyboard.press('Enter');

    const second = await page.evaluate(() => window.v2.getDoc().pages[1].annotations.map((a) => [a.text, a.bold]));
    expect(second).toEqual([['Dua', true]]);
    expect(await texts(page)).toEqual(['Satu']);
  });

  test('one undo step per box', async ({ page }) => {
    await openTeksAndType(page, 'Satu');
    await page.click('.pv-page >> nth=0', { position: { x: 100, y: 300 } });
    await page.keyboard.type('Dua');
    await page.keyboard.press('Enter');
    expect(await texts(page)).toEqual(['Satu', 'Dua']);

    await page.click('#btn-undo');
    expect(await texts(page)).toEqual(['Satu']);
    await page.click('#btn-undo');
    expect(await texts(page)).toEqual([]);
    await page.click('#btn-redo');
    expect(await texts(page)).toEqual(['Satu']);
  });
});
