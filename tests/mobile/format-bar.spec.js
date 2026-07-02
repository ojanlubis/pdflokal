/*
 * Text format bar (v2) on a phone — text is the #1 in-editor action (~30%).
 * Covers: contextual visibility, styling a selected annotation, sticky
 * defaults for new text, live restyle of the inline draft.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'sample-2pages.pdf');

async function openAndPlaceText(page, text) {
  await page.goto('/editor-v2.html');
  await page.setInputFiles('#file-input', FIXTURE);
  await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();
  await page.tap('[data-tool="text"]');
  await page.tap('.pv-page >> nth=0', { position: { x: 120, y: 180 } });
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

test.describe('format bar — mobile', () => {
  test('hidden by default; appears when the Teks tool is armed', async ({ page }) => {
    await page.goto('/editor-v2.html');
    await page.setInputFiles('#file-input', FIXTURE);
    await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();
    await expect(page.locator('#format-bar')).toBeHidden();
    await page.tap('[data-tool="text"]');
    await expect(page.locator('#format-bar')).toBeVisible();
  });

  test('new text stays selected after commit; bold applies to it', async ({ page }) => {
    await openAndPlaceText(page, 'format aku');
    // Committed text is still the selection → bar targets it.
    await expect(page.locator('#format-bar')).toBeVisible();
    const sel = await page.evaluate(() => window.v2.getDoc().selection.annotationId);
    expect(sel).toBeTruthy();

    await page.tap('.fb-bold');
    const anno = await page.evaluate(() => window.v2.getDoc().pages[0].annotations[0]);
    expect(anno.bold).toBe(true);
    await expect(page.locator('.pv-anno-text')).toHaveCSS('font-weight', '700');
  });

  test('font family + color + size flow into the model and the DOM', async ({ page }) => {
    await openAndPlaceText(page, 'gaya');
    await page.selectOption('.fb-font', 'Montserrat');
    await page.selectOption('.fb-size', '32');
    await page.tap('.fb-color[data-color="#d33131"]');

    const anno = await page.evaluate(() => window.v2.getDoc().pages[0].annotations[0]);
    expect(anno.fontFamily).toBe('Montserrat');
    expect(anno.fontSize).toBe(32);
    expect(anno.color).toBe('#d33131');
    await expect(page.locator('.pv-anno-text')).toHaveCSS('font-size', '32px');
  });

  test('styles are sticky: the NEXT text inherits them', async ({ page }) => {
    await openAndPlaceText(page, 'pertama');
    await page.tap('.fb-bold'); // also updates sticky defaults
    // Place a second text somewhere else.
    await page.tap('[data-tool="text"]');
    await page.tap('.pv-page >> nth=0', { position: { x: 100, y: 320 } });
    await page.keyboard.type('kedua');
    await page.keyboard.press('Enter');

    const annos = await page.evaluate(() => window.v2.getDoc().pages[0].annotations);
    expect(annos).toHaveLength(2);
    expect(annos[1].bold).toBe(true);
  });

  test('styling change is one undo step', async ({ page }) => {
    await openAndPlaceText(page, 'undoable');
    await page.tap('.fb-color[data-color="#1d6fdc"]');
    expect((await page.evaluate(() => window.v2.getDoc().pages[0].annotations[0])).color).toBe('#1d6fdc');
    await page.tap('#btn-undo');
    expect((await page.evaluate(() => window.v2.getDoc().pages[0].annotations[0])).color).toBe('#000000');
  });
});
