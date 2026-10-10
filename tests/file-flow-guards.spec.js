/*
 * file-flow-guards.spec.js — four ways the document changed (or vanished)
 * behind the user's back. Round-3 hunt, 2026-10-10.
 * ============================================================================
 * 1. A CANCELLED Buka Baru stayed armed. `pendingReplace` was cleared only by
 *    the picker's `change`, and a cancelled picker never fires `change`. The next "Tambah file" then wiped the document instead of
 *    merging into it: edits, undo history and the leave guard, no question.
 * 2. Ctrl+Z with the Halaman sheet open undid the model but not the grid, and
 *    in pick mode (Unduh → Pilih halaman, BOTH dialogs open) the guard read the
 *    first open dialog in DOM order (#pm-sheet) and let the undo through behind
 *    Unduh, whose bytes were already built.
 * 3. A file dropped while a sheet was open merged behind it; Unduh then saved
 *    the pre-merge bytes and markClean called the merged doc saved.
 * 4. Buka Baru with a file that fails to open left a blank, chrome-less editor
 *    with the old document already destroyed.
 * 5. Arrow keys nudged the selected annotation behind an open sheet (the nudge
 *    is its own keydown listener, so the main handler's open-sheet guard never
 *    covered it). Unduh then shipped the pre-nudge bytes and markClean called
 *    the moved doc saved.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TWO = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');
const ONE = path.join(__dirname, 'fixtures', 'alt-red-1page.pdf');

const pageCount = (page) => page.evaluate(() => window.v2.getDoc().pages.length);

async function open(page, file = TWO) {
  await page.goto('/');
  await page.setInputFiles('#file-input', file);
  await expectFirstPage(page);
}

test('a CANCELLED Buka Baru does not turn the next Tambah file into a wipe', async ({ page }) => {
  await open(page);
  expect(await pageCount(page)).toBe(2);
  const firstId = await page.evaluate(() => window.v2.getDoc().pages[0].id);

  await page.click('#btn-file');
  await page.click('#fm-new');
  // The picker was dismissed: browsers fire `cancel` on the input, no `change`.
  await page.evaluate(() => document.getElementById('file-input').dispatchEvent(new Event('cancel')));

  await page.click('#btn-file');
  await page.click('#fm-add');
  await page.setInputFiles('#file-input', ONE);

  await expect.poll(() => pageCount(page), { message: 'Tambah file MERGES: 2 + 1 pages' }).toBe(3);
  expect(await page.evaluate(() => window.v2.getDoc().pages[0].id), 'the original pages survived').toBe(firstId);
});

test('KNOWN-POSITIVE: an uncancelled Buka Baru still replaces the document', async ({ page }) => {
  await open(page);
  const firstId = await page.evaluate(() => window.v2.getDoc().pages[0].id);
  await page.click('#btn-file');
  await page.click('#fm-new');
  await page.setInputFiles('#file-input', ONE);
  await expect.poll(() => pageCount(page)).toBe(1);
  expect(await page.evaluate(() => window.v2.getDoc().pages[0].id)).not.toBe(firstId);
});

test('Ctrl+Z inside the Halaman sheet updates the grid, not only the model', async ({ page }) => {
  await open(page);
  await page.click('#btn-pages');
  const tiles = page.locator('#pm-sheet .pm-tile:not(.pm-add)');
  await expect(tiles).toHaveCount(2);
  await tiles.nth(1).click();
  await page.click('#pm-sheet [data-act="delete"]');
  await expect(tiles).toHaveCount(1);
  expect(await pageCount(page)).toBe(1);

  await page.keyboard.press('Control+z');
  expect(await pageCount(page), 'VACUITY GUARD: the undo reached the model').toBe(2);
  await expect(tiles, 'the open grid shows the restored page').toHaveCount(2);
});

test('Ctrl+Z while picking pages for Unduh does not change the document behind it', async ({ page }) => {
  await open(page);
  // One undoable change: delete page 2 in the Halaman sheet.
  await page.click('#btn-pages');
  await page.locator('#pm-sheet .pm-tile:not(.pm-add)').nth(1).click();
  await page.click('#pm-sheet [data-act="delete"]');
  await page.click('#pm-close');
  expect(await pageCount(page)).toBe(1);
  expect(await page.evaluate(() => window.v2.history.undoStack.length), 'VACUITY GUARD: there is something to undo').toBeGreaterThan(0);

  await page.click('#btn-download');
  await expect(page.locator('#dl-sheet')).toHaveJSProperty('open', true);
  await page.click('#ds-pages button:not([data-v="all"])');
  await expect(page.locator('#pm-sheet')).toHaveJSProperty('open', true);

  await page.keyboard.press('Control+z');
  expect(await pageCount(page), 'the doc behind Unduh is untouched').toBe(1);
});

async function dropPdf(page, file) {
  const bytes = [...(await import('fs')).readFileSync(file)];
  await page.evaluate((arr) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(arr)], 'drop.pdf', { type: 'application/pdf' }));
    const target = document.querySelector('dialog[open]') || document.body;
    target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, bytes);
}

test('a file dropped while the Unduh sheet is open is not merged behind it', async ({ page }) => {
  await open(page);
  await page.click('#btn-download');
  await expect(page.locator('#dl-sheet')).toHaveJSProperty('open', true);
  await dropPdf(page, ONE);
  await page.waitForTimeout(1500);
  expect(await pageCount(page)).toBe(2);
});

test('KNOWN-POSITIVE: a file dropped on the open editor still merges', async ({ page }) => {
  await open(page);
  await dropPdf(page, ONE);
  await page.click('#dc-add'); // a drop onto an open doc asks first (drop-choice.spec.js)
  await expect.poll(() => pageCount(page)).toBe(3);
});

test('Buka Baru with a file that cannot open returns to the landing, not a blank editor', async ({ page }) => {
  await open(page);
  await page.click('#btn-file');
  await page.click('#fm-new');
  await page.setInputFiles('#file-input', { name: 'rusak.pdf', mimeType: 'application/pdf', buffer: Buffer.from('not a pdf') });

  await expect(page.locator('body')).toHaveClass(/is-empty/);
  await expect(page.locator('#empty')).toBeVisible();
  await expect(page.locator('#btn-undo')).toBeDisabled();
  expect(await pageCount(page)).toBe(0);
  // And the landing still works: a good file opens.
  await page.setInputFiles('#file-input', ONE);
  await expectFirstPage(page);
  await expect(page.locator('body')).not.toHaveClass(/is-empty/);
});

// The nudge listener is separate from the main keydown handler, so it needs its
// own open-sheet guard (2a82d89 covered undo/Delete/tool keys only).
for (const sheet of [
  { name: 'Unduh', open: '#btn-download', sel: '#dl-sheet' },
  { name: 'Halaman', open: '#btn-pages', sel: '#pm-sheet' },
]) {
  test(`arrow keys do not nudge the selected annotation behind the ${sheet.name} sheet`, async ({ page }) => {
    await open(page);
    await page.keyboard.press('t');
    await page.click('.pv-page >> nth=0', { position: { x: 200, y: 200 } });
    await page.keyboard.type('Geser aku');
    await page.keyboard.press('Enter');
    await expect(page.locator('.pv-anno-text')).toHaveText('Geser aku');
    const x = () => page.evaluate(() => window.v2.getDoc().pages[0].annotations[0].x);
    const x0 = await x();

    // KNOWN-POSITIVE first: with no sheet open the same key does move it, so the
    // equality below cannot pass merely because the selection was lost.
    await page.keyboard.press('ArrowRight');
    expect(await x(), 'VACUITY GUARD: nudge works with no sheet open').toBe(x0 + 1);

    await page.click(sheet.open);
    await expect(page.locator(sheet.sel)).toHaveJSProperty('open', true);
    expect(await page.evaluate(() => window.v2.getDoc().selection.annotationId), 'still selected behind the sheet').not.toBeNull();
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
    expect(await x(), 'the annotation did not move behind the sheet').toBe(x0 + 1);
  });
}
