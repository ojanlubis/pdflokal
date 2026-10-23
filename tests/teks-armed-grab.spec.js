/*
 * With Teks armed, dragging the text you just typed moves it.
 * ============================================================================
 * Feedback 100369 and 100463. Teks stays armed while a box is open and after a
 * tap-away opens the next one; a press on the text just written then placed
 * ANOTHER empty box on top of it and the text never moved. Now the press picks
 * the text up: the open box closes, Teks is left, the text follows the pointer.
 * Headless wiring + the red/green proof: tests/core/teks-armed-grab.test.mjs.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');

const annos = (page) => page.evaluate(() => window.v2.getDoc().pages[0].annotations.map((a) => [a.text, a.x, a.y]));

test('Teks armed, click a blank, then drag the first text: it moves, no extra box', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await expectFirstPage(page);
  await page.keyboard.press('t');
  await page.click('.pv-page >> nth=0', { position: { x: 100, y: 100 } });
  await expect(page.locator('.v2-text-edit')).toBeFocused();
  await page.keyboard.type('Satu');
  // The tap-away: Satu commits, a new box opens, Teks is still armed.
  await page.click('.pv-page >> nth=0', { position: { x: 100, y: 400 } });
  await expect(page.locator('.v2-text-edit')).toHaveCount(1);
  await expect(page.locator('[data-tool="text"]')).toHaveAttribute('aria-pressed', 'true');
  const [, x0, y0] = (await annos(page))[0];

  const box = await page.locator('.pv-anno').first().boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 60, cy + 40, { steps: 6 });
  await page.mouse.up();

  await expect(page.locator('.v2-text-edit'), 'a press on the text must not leave or add a box').toHaveCount(0);
  await expect(page.locator('[data-tool="text"]')).toHaveAttribute('aria-pressed', 'false');
  const after = await annos(page);
  expect(after.map((a) => a[0])).toEqual(['Satu']);
  expect(after[0][1]).toBeGreaterThan(x0);
  expect(after[0][2]).toBeGreaterThan(y0);
});
