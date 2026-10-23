/*
 * PDFLokal — the custom colour picker is ONE undo step per drag.
 *
 * WHY this exists: the native colour input fires `input` on every tick while the
 * user drags inside the OS picker, and each tick used to record an undo step, so
 * one drag left a dozen and Ctrl+Z walked back through shades nobody chose.
 * Instrument: undo ONCE after a multi-tick drag; the colour must be the one the
 * text had BEFORE the picker opened (with the bug it lands on an intermediate
 * shade). Not run by the foreground gate (nightly CI).
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const colorOf = (page) => page.evaluate(() => window.v2.getDoc().pages[0].annotations[0]?.color);
const picker = (page, steps) => page.evaluate((list) => {
  const el = document.querySelector('#format-bar input.fb-color-custom');
  for (const [type, value] of list) {
    if (value) el.value = value;
    el.dispatchEvent(new Event(type, { bubbles: true }));
  }
}, steps);

// A committed text annotation, left selected so the format bar targets it.
async function withSelectedText(page) {
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await expectFirstPage(page);
  await page.keyboard.press('t');
  await page.click('.pv-page >> nth=0', { position: { x: 200, y: 200 } });
  await page.keyboard.type('warna');
  await page.keyboard.press('Enter');
  await expect(page.locator('.pv-anno-text')).toHaveText('warna');
  expect(await colorOf(page)).toBe('#000000');
}

test.describe('custom colour picker undo', () => {
  test('a multi-tick drag is ONE undo step, back to the colour before the drag', async ({ page }) => {
    await withSelectedText(page);
    await picker(page, [
      ['input', '#101010'], ['input', '#204060'], ['input', '#306090'],
      ['input', '#4080c0'], ['input', '#50a0f0'], ['change', null],
    ]);
    expect(await colorOf(page)).toBe('#50a0f0'); // live preview landed on the model
    await page.keyboard.press(`${MOD}+z`);
    expect(await colorOf(page)).toBe('#000000');
    expect(await page.locator('.pv-anno-text').count()).toBe(1); // only the colour was undone
    await page.keyboard.press(`${MOD}+Shift+z`);
    expect(await colorOf(page)).toBe('#50a0f0'); // and redo restores the final shade
  });

  test('a single pick (one input + one change) is exactly one step', async ({ page }) => {
    await withSelectedText(page);
    await picker(page, [['input', '#ff8800'], ['change', null]]);
    expect(await colorOf(page)).toBe('#ff8800');
    await page.keyboard.press(`${MOD}+z`);
    expect(await colorOf(page)).toBe('#000000');
  });

  test('a browser that fires only `change` still records one step', async ({ page }) => {
    await withSelectedText(page);
    await picker(page, [['change', '#00aa55']]);
    expect(await colorOf(page)).toBe('#00aa55');
    await page.keyboard.press(`${MOD}+z`);
    expect(await colorOf(page)).toBe('#000000');
  });

  test('two separate drags are two steps (the first does not swallow the second)', async ({ page }) => {
    await withSelectedText(page);
    await picker(page, [['input', '#111111'], ['input', '#222222'], ['change', null]]);
    await picker(page, [['input', '#333333'], ['input', '#444444'], ['change', null]]);
    expect(await colorOf(page)).toBe('#444444');
    await page.keyboard.press(`${MOD}+z`);
    expect(await colorOf(page)).toBe('#222222');
    await page.keyboard.press(`${MOD}+z`);
    expect(await colorOf(page)).toBe('#000000');
  });
});
