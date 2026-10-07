/*
 * PDFLokal — the editor's own zoom keys and the opening fit.
 *
 * WHY this exists: Ctrl/Cmd + = / - / 0 used to zoom the BROWSER (toolbar and
 * all) while the page stayed put; now they zoom the editor with the same step
 * and clamps as the +/- pill, and 0 refits the page to the width. The read
 * instrument is the --zoom custom property applyZoom() writes on the stage.
 * Not run by the foreground gate (nightly CI).
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const zoomOf = (page) => page.evaluate(() =>
  parseFloat(document.getElementById('v2-stage').style.getPropertyValue('--zoom')));

async function openDoc(page) {
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await expectFirstPage(page);
}

test.describe('zoom keys', () => {
  test('opening a document fits the page to the viewport width (desktop)', async ({ page }) => {
    await openDoc(page);
    const m = await page.evaluate(() => ({
      zoom: parseFloat(document.getElementById('v2-stage').style.getPropertyValue('--zoom')),
      pageW: window.v2.getDoc().pages[0].width,
      viewW: document.getElementById('v2-scroll').clientWidth,
    }));
    // 48px gutter a side (openingZoom). A fixed 1:1 would leave pageW * 1 here.
    expect(m.pageW * m.zoom).toBeCloseTo(m.viewW - 96, 0);
  });

  test('Ctrl/Cmd + = and - step the editor zoom by the pill step, and are defaultPrevented', async ({ page }) => {
    await openDoc(page);
    const z0 = await zoomOf(page);
    await page.keyboard.press(`${MOD}+Equal`);
    expect(await zoomOf(page)).toBeCloseTo(z0 + 0.25, 3);
    await page.keyboard.press(`${MOD}+Minus`);
    await page.keyboard.press(`${MOD}+Minus`);
    expect(await zoomOf(page)).toBeCloseTo(z0 - 0.25, 3);
    const prevented = await page.evaluate(() => {
      const ev = new KeyboardEvent('keydown', { key: '+', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
      document.body.dispatchEvent(ev);
      return ev.defaultPrevented;
    });
    expect(prevented).toBe(true);
  });

  test('clamps at the same limits as the pill (0.3 .. 3)', async ({ page }) => {
    await openDoc(page);
    for (let i = 0; i < 16; i += 1) await page.keyboard.press(`${MOD}+Equal`);
    expect(await zoomOf(page)).toBeCloseTo(3, 3);
    for (let i = 0; i < 20; i += 1) await page.keyboard.press(`${MOD}+Minus`);
    expect(await zoomOf(page)).toBeCloseTo(0.3, 3);
  });

  test('Ctrl/Cmd + 0 refits the width after zooming', async ({ page }) => {
    await openDoc(page);
    const z0 = await zoomOf(page);
    await page.keyboard.press(`${MOD}+Equal`);
    await page.keyboard.press(`${MOD}+Equal`);
    expect(await zoomOf(page)).not.toBeCloseTo(z0, 2);
    await page.keyboard.press(`${MOD}+0`);
    expect(await zoomOf(page)).toBeCloseTo(z0, 2);
  });

  test('works while typing in the inline text editor', async ({ page }) => {
    await openDoc(page);
    const z0 = await zoomOf(page);
    await page.keyboard.press('t');
    await page.click('.pv-page >> nth=0', { position: { x: 200, y: 200 } });
    await page.keyboard.type('abc');
    await page.keyboard.press(`${MOD}+Equal`);
    expect(await zoomOf(page)).toBeCloseTo(z0 + 0.25, 3);
    await expect(page.locator('.v2-text-edit')).toHaveText('abc');
  });

  test('with no document open the browser keeps its zoom keys', async ({ page }) => {
    await page.goto('/');
    const prevented = await page.evaluate(() => {
      const ev = new KeyboardEvent('keydown', { key: '=', ctrlKey: true, bubbles: true, cancelable: true });
      document.body.dispatchEvent(ev);
      return ev.defaultPrevented;
    });
    expect(prevented).toBe(false);
  });
});
