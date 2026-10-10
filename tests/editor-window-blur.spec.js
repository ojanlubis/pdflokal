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
 * Held open, the editor still counts as unsaved work for the leave prompt, and
 * the page going hidden (an Android app switch) commits a typed draft; see
 * js/v2/editor-blur.js holdEditor and tests/core/editor-blur.test.mjs.
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

// What an Android app switch delivers: the page goes hidden (and may be killed).
const goHidden = (page) => page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
});

async function openTeks(page) {
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await expectFirstPage(page);
  await page.keyboard.press('t');
  await page.click('.pv-page >> nth=0', { position: { x: 200, y: 200 } });
  await expect(page.locator('.v2-text-edit')).toBeFocused();
}

// Records the dialogs a reload raises and accepts them (leaving). Never clicks
// first: a click would move focus off the editor and commit it, and the prompt
// would then come from the history for the wrong reason. Typing and the click
// that placed the editor are the user activation Chromium asks for.
async function reloadAsks(page) {
  const seen = [];
  page.on('dialog', (d) => { seen.push(d.type()); d.accept(); });
  await page.reload();
  return seen;
}

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

  test('leave prompt: typed text in the held editor asks on a clean document', async ({ page }) => {
    await openTeks(page);
    await page.keyboard.type('Halo');
    expect(await windowBlur(page)).toBe(true);
    expect(await page.evaluate(() => window.v2.history.current === window.v2.history.cleanId),
      'no history step for the open editor').toBe(true);
    expect(await reloadAsks(page)).toEqual(['beforeunload']);
  });

  test('leave prompt: an open editor with nothing typed does not ask', async ({ page }) => {
    await openTeks(page);
    expect(await windowBlur(page)).toBe(true);
    expect(await reloadAsks(page)).toEqual([]);
  });

  test('page hidden (Android app switch): a typed draft is committed', async ({ page }) => {
    await openTeks(page);
    await page.keyboard.type('abc');
    expect(await windowBlur(page)).toBe(true);
    await goHidden(page);
    await expect(page.locator('.v2-text-edit')).toHaveCount(0);
    expect(await page.evaluate(() => window.v2.getDoc().pages[0].annotations.map((a) => a.text)))
      .toEqual(['abc']);
  });

  // A held editor and a file load (the person went to Finder to drag a file
  // in). The load empties the stage; the editor used to go with it, never
  // committed. app.js loadFilesInner closes it first (closeOpenEditor). The
  // loads below run without moving focus, as a drop onto an inactive window
  // does, so the editor is still held when they start.
  test('file added while the editor is held: the typed text lands, once', async ({ page }) => {
    await openTeks(page);
    await page.keyboard.type('Halo');
    expect(await windowBlur(page)).toBe(true);

    await page.setInputFiles('#file-input', FIXTURE); // Tambah: append to the open doc
    await expect.poll(() => page.evaluate(() => window.v2.getDoc().pages.length)).toBe(4);
    await expect(page.locator('.v2-text-edit')).toHaveCount(0);
    expect(await page.evaluate(() => window.v2.getDoc().pages[0].annotations.map((a) => a.text)))
      .toEqual(['Halo']);

    // The closed editor no longer listens: going hidden adds nothing.
    const steps = await page.evaluate(() => window.v2.history.undoStack.length);
    await goHidden(page);
    expect(await page.evaluate(() => window.v2.history.undoStack.length)).toBe(steps);
    expect(await page.evaluate(() => window.v2.getDoc().pages[0].annotations.map((a) => a.text)))
      .toEqual(['Halo']);
  });

  test('document replaced while the editor is held: no late commit into the new one', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openTeks(page);
    await page.keyboard.type('Halo');
    expect(await windowBlur(page)).toBe(true);

    await page.evaluate(async () => {
      const buf = await (await fetch('/tests/fixtures/sample-2pages.pdf')).arrayBuffer();
      await window.v2.loadFiles([new File([buf], 'baru.pdf', { type: 'application/pdf' })], { replace: true });
    });
    await expect.poll(() => page.evaluate(() => window.v2.getDoc().sources.length)).toBe(1);
    await expect(page.locator('.v2-text-edit')).toHaveCount(0);

    await goHidden(page);
    expect(await page.evaluate(() => window.v2.getDoc().pages.flatMap((p) => p.annotations))).toEqual([]);
    expect(await page.evaluate(() => window.v2.history.undoStack.length)).toBe(0);
    await expect(page.locator('#btn-undo')).toBeDisabled();
    expect(errors).toEqual([]);
  });

  test('page hidden: a cleared Edit line stays open to paste into', async ({ page }) => {
    await openDoc(page);
    await armGanti(page);
    await tapLine(page, { str: LINE, nth: 1 });
    await page.keyboard.press('Backspace');
    await expect(page.locator('.v2-text-edit')).toHaveText('');
    await goHidden(page);
    await expect(page.locator('.v2-text-edit')).toHaveCount(1);
    expect((await annos(page)).filter((a) => a.t === 'text')).toEqual([]);
  });
});
