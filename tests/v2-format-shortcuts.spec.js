/*
 * PDFLokal — Ctrl/Cmd+B and Ctrl/Cmd+I equal the format bar's B and I buttons.
 *
 * WHY this exists: the inline editor is a contenteditable, so Ctrl+B used to hit
 * the browser's NATIVE bold — it styled only the selection and was then lost
 * when commit() read the box back with textContent. The buttons style the whole
 * annotation (persisted, exported). The shortcut must be the button, not the
 * browser's lookalike. Not run by the foreground gate (nightly CI).
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const anno0 = (page) => page.evaluate(() => {
  const a = window.v2.getDoc().pages[0].annotations[0];
  return a && { text: a.text, bold: !!a.bold, italic: !!a.italic };
});

async function openAndType(page, text) {
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await expectFirstPage(page);
  await page.keyboard.press('t');
  await page.click('.pv-page >> nth=0', { position: { x: 200, y: 200 } });
  await page.keyboard.type(text);
}

test.describe('Ctrl/Cmd+B / I — same as the format bar', () => {
  test('while typing: bold + italic apply to the WHOLE box and survive commit', async ({ page }) => {
    await openAndType(page, 'Halo dunia');
    await page.keyboard.press(`${MOD}+b`);
    await page.keyboard.press(`${MOD}+i`);
    // The bar's own state moved, the editor restyled live.
    await expect(page.locator('.fb-bold')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.fb-italic')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.v2-text-edit')).toHaveCSS('font-weight', '700');
    await page.keyboard.press('Enter');
    await expect(page.locator('.pv-anno-text')).toHaveText('Halo dunia');
    expect(await anno0(page)).toEqual({ text: 'Halo dunia', bold: true, italic: true });
    await expect(page.locator('.pv-anno-text')).toHaveCSS('font-weight', '700');
    // No native partial markup ever entered the editor's text.
    expect(await page.locator('.pv-anno-text b, .pv-anno-text i, .pv-anno-text strong').count()).toBe(0);
  });

  test('toggles back off, and Ctrl+U does nothing', async ({ page }) => {
    await openAndType(page, 'Satu');
    await page.keyboard.press(`${MOD}+b`);
    await page.keyboard.press(`${MOD}+b`);
    await page.keyboard.press(`${MOD}+u`);
    await page.keyboard.press('Enter');
    expect(await anno0(page)).toEqual({ text: 'Satu', bold: false, italic: false });
    expect(await page.locator('.pv-anno-text u').count()).toBe(0);
  });

  // WHY: authored text stays selected after commit, so a SECOND new text opens
  // while the first is still selected. The bar and Ctrl+B/I must style the draft
  // under the caret, never the committed line above it.
  test('typing a second new text: B and Ctrl+B style the draft, not the selected first text', async ({ page }) => {
    await openAndType(page, 'Satu');
    await page.keyboard.press('Enter');
    await expect(page.locator('.pv-anno-text')).toHaveText('Satu');
    await page.keyboard.press('t');
    await page.click('.pv-page >> nth=0', { position: { x: 200, y: 320 } });
    await page.keyboard.type('Dua');
    await page.click('.fb-bold');
    await expect(page.locator('.v2-text-edit')).toHaveCSS('font-weight', '700');
    await page.keyboard.press(`${MOD}+i`);
    await expect(page.locator('.v2-text-edit')).toHaveCSS('font-style', 'italic');
    const annos = () => page.evaluate(() => window.v2.getDoc().pages[0].annotations.map((a) => ({ text: a.text, bold: !!a.bold, italic: !!a.italic })));
    expect(await annos()).toEqual([{ text: 'Satu', bold: false, italic: false }]);
    await page.keyboard.press('Enter');
    await expect(page.locator('.pv-anno-text')).toHaveCount(2);
    expect(await annos()).toEqual([
      { text: 'Satu', bold: false, italic: false },
      { text: 'Dua', bold: true, italic: true },
    ]);
  });

  test('selected (not editing): toggles the annotation, ONE undo step each', async ({ page }) => {
    await openAndType(page, 'Terpilih');
    await page.keyboard.press('Enter'); // commit; the new text stays selected
    expect(await page.evaluate(() => window.v2.getDoc().selection.annotationId)).not.toBeNull();
    await page.keyboard.press(`${MOD}+b`);
    expect((await anno0(page)).bold).toBe(true);
    await page.keyboard.press(`${MOD}+Shift+i`); // Shift must not defeat the match
    expect((await anno0(page)).italic).toBe(true);
    await page.keyboard.press(`${MOD}+z`);
    expect((await anno0(page)).italic).toBe(false);
    await page.keyboard.press(`${MOD}+z`);
    expect((await anno0(page)).bold).toBe(false);
  });

  test('a selected non-text object is left alone (no preventDefault)', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('#file-input', FIXTURE);
    await expectFirstPage(page);
    const prevented = await page.evaluate(() => {
      const d = window.v2.getDoc();
      const pg = d.pages[0];
      pg.annotations.push({ id: 'w_test', type: 'whiteout', x: 50, y: 50, width: 40, height: 20 });
      d.selection = { pageId: pg.id, annotationId: 'w_test' };
      const ev = new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true });
      document.body.dispatchEvent(ev);
      return ev.defaultPrevented;
    });
    expect(prevented).toBe(false);
  });
});
