/*
 * PDFLokal — hold Space and drag to pan the canvas.
 *
 * WHY this exists: a canvas editor's hand. While Space is down the press belongs
 * to the camera: it must scroll the view and must NOT move, select or draw
 * anything (interaction.js's pointerdown is stopped in the capture phase), and
 * Space must stay a plain space inside the text editor. Not run by the
 * foreground gate (nightly CI).
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const scrollPos = (page) => page.evaluate(() => {
  const s = document.getElementById('v2-scroll');
  return { left: s.scrollLeft, top: s.scrollTop };
});

// A document with one text annotation, zoomed in so there is room to pan both ways.
async function zoomedWithText(page) {
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await expectFirstPage(page);
  await page.keyboard.press('t');
  await page.click('.pv-page >> nth=0', { position: { x: 200, y: 200 } });
  await page.keyboard.type('jangan geser');
  await page.keyboard.press('Enter');
  await expect(page.locator('.pv-anno-text')).toHaveText('jangan geser');
  await page.keyboard.press('Escape');
  for (let i = 0; i < 6; i += 1) await page.keyboard.press(`${MOD}+Equal`);
}

test.describe('Space + drag pans', () => {
  test('the drag scrolls the view, and does not move the object it started on', async ({ page }) => {
    await zoomedWithText(page);
    const before = await page.evaluate(() => window.v2.getDoc().pages[0].annotations.map((a) => ({ x: a.x, y: a.y })));
    const box = await page.locator('.pv-anno-text').boundingBox();
    const sx = box.x + box.width / 2;
    const sy = box.y + box.height / 2;
    const s0 = await scrollPos(page);
    await page.mouse.move(sx, sy);
    await page.keyboard.down('Space');
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.pv-anno-text')).cursor)).toBe('grab');
    await page.mouse.down();
    await page.mouse.move(sx - 60, sy - 80, { steps: 5 });
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.pv-page')).cursor)).toBe('grabbing');
    await page.mouse.up();
    await page.keyboard.up('Space');
    const s1 = await scrollPos(page);
    expect(s1.top - s0.top).toBeCloseTo(80, 0);
    expect(s1.left - s0.left).toBeCloseTo(60, 0);
    // Not moved, not selected.
    expect(await page.evaluate(() => window.v2.getDoc().pages[0].annotations.map((a) => ({ x: a.x, y: a.y })))).toEqual(before);
    expect(await page.evaluate(() => window.v2.getDoc().selection.annotationId)).toBeNull();
  });

  test('without Space the same drag moves the object (the capture stop is Space-only)', async ({ page }) => {
    await zoomedWithText(page);
    const box = await page.locator('.pv-anno-text').boundingBox();
    const sx = box.x + box.width / 2;
    const sy = box.y + box.height / 2;
    const s0 = await scrollPos(page);
    const a0 = await page.evaluate(() => ({ ...window.v2.getDoc().pages[0].annotations[0] }));
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + 40, sy + 40, { steps: 5 });
    await page.mouse.up();
    expect(await scrollPos(page)).toEqual(s0);
    const a = await page.evaluate(() => window.v2.getDoc().pages[0].annotations[0]);
    expect(a.x).toBeGreaterThan(a0.x);
    expect(a.y).toBeGreaterThan(a0.y);
    expect(await page.evaluate(() => window.v2.getDoc().selection.annotationId)).not.toBeNull();
  });

  test('releasing Space ends the grab cursor', async ({ page }) => {
    await zoomedWithText(page);
    await page.keyboard.down('Space');
    await expect(page.locator('#v2-scroll')).toHaveClass(/space-pan/);
    await page.keyboard.up('Space');
    await expect(page.locator('#v2-scroll')).not.toHaveClass(/space-pan/);
  });

  test('Space stays a space while typing', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('#file-input', FIXTURE);
    await expectFirstPage(page);
    await page.keyboard.press('t');
    await page.click('.pv-page >> nth=0', { position: { x: 200, y: 200 } });
    await page.keyboard.type('satu dua');
    await expect(page.locator('.v2-text-edit')).toHaveText('satu dua');
    await expect(page.locator('#v2-scroll')).not.toHaveClass(/space-pan/);
  });
});
