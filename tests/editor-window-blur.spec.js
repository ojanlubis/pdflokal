/*
 * Switching app or window while typing must not close the inline text editor.
 * ============================================================================
 * The browser fires `blur` on the focused element when its WINDOW deactivates
 * (alt-tab, switching to WhatsApp to copy a NIK), yet focus never left it:
 * document.activeElement stays the editor and focus comes back with the window.
 * The editor used to commit on every blur, so:
 *   - a cleared Edit (Ganti) line was committed empty = DELETED, and the person
 *     came back to no box to paste into;
 *   - plain Teks was committed and left selected, so the Backspace typed after
 *     returning deleted the whole text object instead of one character.
 * The rule lives in js/v2/editor-blur.js (tests/core/editor-blur.test.mjs);
 * this spec proves app.js routes the editor's blur through it.
 *
 * A synthetic FocusEvent('blur') on the editor is exactly what a window
 * deactivation delivers: the event, with activeElement left where it was.
 * Real focus moves (Enter, tap-away, Ctrl+S's dialog) are pinned elsewhere:
 * tests/ganti-empty-delete.spec.js, tests/ganti-teks-fidelity.spec.js,
 * tests/v2-save-shortcut.spec.js.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { armGanti, tapLine } from './helpers/lines.js';
import { expectFirstPage } from './helpers/render.js';
import { LINE, openDoc, annos } from './helpers/original-delete.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');

// What a window deactivation delivers to the focused editor.
const windowBlur = (page) => page.evaluate(() => {
  const ed = document.querySelector('.v2-text-edit');
  ed.dispatchEvent(new FocusEvent('blur'));
  return document.activeElement === ed;
});

test.describe('switching app or window while typing keeps the editor open', () => {
  test('Edit: a cleared line survives the switch, and the retyped words land', async ({ page }) => {
    await openDoc(page);
    await armGanti(page);
    await tapLine(page, { str: LINE, nth: 1 });
    await page.keyboard.press('Backspace'); // the prefill arrives selected
    await expect(page.locator('.v2-text-edit')).toHaveText('');

    expect(await windowBlur(page), 'focus stayed on the editor, as a window switch leaves it').toBe(true);
    await expect(page.locator('.v2-text-edit')).toHaveCount(1);
    await expect(page.locator('.v2-text-edit')).toBeFocused();
    // Not committed: the cover placed when the draft opened, and no deletion
    // or replacement on top of it yet.
    expect((await annos(page)).filter((a) => a.t === 'text')).toEqual([]);

    await page.keyboard.type('Nama Baru');
    await page.keyboard.press('Enter');
    await expect(page.locator('.v2-text-edit')).toHaveCount(0);
    expect((await annos(page)).filter((a) => a.t === 'text').map((a) => a.text)).toEqual(['Nama Baru']);
  });

  test('Teks: Backspace after the switch edits the box, not the whole text object', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('#file-input', FIXTURE);
    await expectFirstPage(page);
    await page.keyboard.press('t');
    await page.click('.pv-page >> nth=0', { position: { x: 200, y: 200 } });
    await page.keyboard.type('abc');

    expect(await windowBlur(page)).toBe(true);
    await expect(page.locator('.v2-text-edit')).toHaveCount(1);
    expect(await page.evaluate(() => window.v2.getDoc().pages[0].annotations.length)).toBe(0);

    await page.keyboard.press('Backspace');
    await page.keyboard.type('d');
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => window.v2.getDoc().pages[0].annotations.map((a) => a.text)))
      .toEqual(['abd']);
  });
});
