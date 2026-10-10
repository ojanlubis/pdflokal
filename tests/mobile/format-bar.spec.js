/*
 * Text format bar (v2) on a phone — text is the #1 in-editor action (~30%).
 * Covers: contextual visibility, styling a selected annotation, sticky
 * defaults for new text, live restyle of the inline draft.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from '../helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'sample-2pages.pdf');

async function openAndPlaceText(page, text) {
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await expectFirstPage(page);
  await page.tap('[data-tool="text"]');
  await page.tap('.pv-page >> nth=0', { position: { x: 120, y: 180 } });
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

test.describe('format bar — mobile', () => {
  test('hidden by default; appears when the Teks tool is armed', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('#file-input', FIXTURE);
    await expectFirstPage(page);
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
    await page.fill('.fb-size', '32');
    await page.press('.fb-size', 'Enter');
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

  // Bug 2026-10-11: the size field, the font select and the custom colour take
  // focus, so reaching for one blurred the empty Teks box. The blur committed
  // nothing: the box closed, Teks disarmed, and the previous text (still
  // selected) took the size meant for the next one. blurCommitsDraft
  // (js/v2/format-bar.js) now keeps an EMPTY draft open for the bar.
  async function emptyDraftAfterSatu(page) {
    await openAndPlaceText(page, 'Satu');
    await page.tap('[data-tool="text"]');
    await page.tap('.pv-page >> nth=0', { position: { x: 100, y: 320 } });
    await expect(page.locator('.v2-text-edit')).toHaveCount(1);
  }
  const annos = (page) => page.evaluate(() => window.v2.getDoc().pages[0].annotations);
  const editorFocused = (page) => page.evaluate(() => !!document.activeElement?.classList.contains('v2-text-edit'));

  test('size typed on an EMPTY new box styles that box, not the previous text', async ({ page }) => {
    await emptyDraftAfterSatu(page);
    await page.fill('.fb-size', '10');
    await page.press('.fb-size', 'Enter');

    expect((await annos(page))[0].fontSize).toBe(18);
    await expect(page.locator('.v2-text-edit')).toHaveCount(1);
    expect(await editorFocused(page)).toBe(true);
    await expect(page.locator('.v2-text-edit')).toHaveCSS('font-size', '10px');

    await page.keyboard.type('Dua');
    await page.keyboard.press('Enter');
    const after = await annos(page);
    expect(after.map((a) => [a.text, a.fontSize])).toEqual([['Satu', 18], ['Dua', 10]]);
  });

  test('font picked on an EMPTY new box styles that box, not the previous text', async ({ page }) => {
    await emptyDraftAfterSatu(page);
    await page.focus('.fb-font');
    await page.selectOption('.fb-font', 'Courier');

    expect((await annos(page))[0].fontFamily).toBe('Helvetica');
    await expect(page.locator('.v2-text-edit')).toHaveCount(1);
    expect(await editorFocused(page)).toBe(true);

    await page.keyboard.type('Dua');
    await page.keyboard.press('Enter');
    const after = await annos(page);
    expect(after.map((a) => [a.text, a.fontFamily])).toEqual([['Satu', 'Helvetica'], ['Dua', 'Courier']]);
  });

  test('tapping the page while the size field holds an empty box moves the box, one editor only', async ({ page }) => {
    await emptyDraftAfterSatu(page);
    await page.fill('.fb-size', '10');
    await page.tap('.pv-page >> nth=0', { position: { x: 180, y: 300 } });

    await expect(page.locator('.v2-text-edit')).toHaveCount(1);
    await page.keyboard.type('Dua');
    await page.keyboard.press('Enter');
    const after = await annos(page);
    expect(after.map((a) => [a.text, a.fontSize])).toEqual([['Satu', 18], ['Dua', 10]]);
  });

  // A window or app switch while the size field holds the empty box: the field
  // gets blur + focusout with no relatedTarget, and focus stays on it. The hold
  // took that for a click-away and closed the box, so the size went to 'Satu'.
  test('a window switch while the size field holds an empty box keeps the box', async ({ page }) => {
    await emptyDraftAfterSatu(page);
    await page.focus('.fb-size');
    await expect(page.locator('.v2-text-edit')).toHaveCount(1);
    const stillOnField = await page.evaluate(() => {
      const f = document.querySelector('.fb-size');
      f.dispatchEvent(new FocusEvent('blur'));
      f.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
      return document.activeElement === f;
    });
    expect(stillOnField).toBe(true);
    await expect(page.locator('.v2-text-edit')).toHaveCount(1);

    await page.fill('.fb-size', '10');
    await page.press('.fb-size', 'Enter');
    await page.keyboard.type('Dua');
    await page.keyboard.press('Enter');
    const after = await annos(page);
    expect(after.map((a) => [a.text, a.fontSize])).toEqual([['Satu', 18], ['Dua', 10]]);
  });

  // Bug 2026-10-11: filling a form, a tap on the next blank while the box was
  // still open (no Enter) left NO box: the first box's late blur commit cleared
  // the new box's state and re-synced the page over it, Teks turned off, and the
  // next Backspace deleted the text just written. app.js closeOpenEditor now
  // closes the open box before the new one opens. Desktop clicks:
  // tests/editor-handoff.spec.js.
  test('tapping blank after blank with a box open: one focused box per tap, Teks stays armed', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('#file-input', FIXTURE);
    await expectFirstPage(page);
    await page.tap('[data-tool="text"]');
    await page.tap('.pv-page >> nth=0', { position: { x: 120, y: 180 } });
    await page.keyboard.type('Satu');

    for (const [y, text] of [[320, 'Dua'], [400, 'Tiga']]) {
      await page.tap('.pv-page >> nth=0', { position: { x: 100, y } });
      await expect(page.locator('.v2-text-edit')).toHaveCount(1);
      expect(await editorFocused(page)).toBe(true);
      await expect(page.locator('[data-tool="text"]')).toHaveAttribute('aria-pressed', 'true');
      await page.keyboard.type(text);
    }
    await page.keyboard.press('Enter');

    expect((await annos(page)).map((a) => a.text)).toEqual(['Satu', 'Dua', 'Tiga']);
  });

  test('styling change is one undo step', async ({ page }) => {
    await openAndPlaceText(page, 'undoable');
    await page.tap('.fb-color[data-color="#1d6fdc"]');
    expect((await page.evaluate(() => window.v2.getDoc().pages[0].annotations[0])).color).toBe('#1d6fdc');
    await page.tap('#btn-undo');
    expect((await page.evaluate(() => window.v2.getDoc().pages[0].annotations[0])).color).toBe('#000000');
  });
});
