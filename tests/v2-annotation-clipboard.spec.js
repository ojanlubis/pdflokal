/*
 * PDFLokal — Ctrl/Cmd+C, X, V, D on annotations (the app's own in-memory
 * clipboard; the system clipboard is never touched). The pure rules (what
 * copies, the +10 step, the clamp) are in tests/core/annotation-clipboard.test.mjs;
 * this proves the keyboard wiring, the single undo step, and that a pasted
 * annotation really reaches the exported file. Not run by the foreground gate
 * (nightly CI).
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';
import { downloadBytes, expectRealPdf } from './helpers/download-bytes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const annos = (page, pageIdx = 0) => page.evaluate((i) =>
  window.v2.getDoc().pages[i].annotations.map((a) => ({ type: a.type, text: a.text, x: a.x, y: a.y })), pageIdx);

// Open the sample, place one text annotation and leave it selected (not editing).
async function withSelectedText(page, text = 'Salin aku') {
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await expectFirstPage(page);
  await page.keyboard.press('t');
  await page.click('.pv-page >> nth=0', { position: { x: 200, y: 200 } });
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  await expect(page.locator('.pv-anno-text')).toHaveText(text);
  expect(await page.evaluate(() => window.v2.getDoc().selection.annotationId)).not.toBeNull();
}

test.describe('annotation clipboard — desktop', () => {
  test('C then V pastes a copy +10px, selected, as ONE undo step; V again steps +20', async ({ page }) => {
    await withSelectedText(page);
    const [orig] = await annos(page);
    await page.keyboard.press(`${MOD}+c`);
    await page.keyboard.press(`${MOD}+v`);
    let a = await annos(page);
    expect(a).toHaveLength(2);
    expect(a[1]).toMatchObject({ type: 'text', text: 'Salin aku', x: orig.x + 10, y: orig.y + 10 });
    const sel = await page.evaluate(() => {
      const d = window.v2.getDoc();
      return d.pages[0].annotations.findIndex((x) => x.id === d.selection.annotationId);
    });
    expect(sel, 'the pasted copy is the selected one').toBe(1);
    await page.keyboard.press(`${MOD}+v`);
    a = await annos(page);
    expect(a[2]).toMatchObject({ x: orig.x + 20, y: orig.y + 20 });
    await page.keyboard.press(`${MOD}+z`);
    expect(await annos(page)).toHaveLength(2); // one paste = one undo step
  });

  test('V with an empty app clipboard does nothing and does not preventDefault', async ({ page }) => {
    await withSelectedText(page);
    const r = await page.evaluate(() => {
      const ev = new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true, cancelable: true });
      document.body.dispatchEvent(ev);
      return { prevented: ev.defaultPrevented, n: window.v2.getDoc().pages[0].annotations.length };
    });
    expect(r).toEqual({ prevented: false, n: 1 });
  });

  test('X removes the original (undoable) and V brings it back as a new object', async ({ page }) => {
    await withSelectedText(page);
    await page.keyboard.press(`${MOD}+x`);
    expect(await annos(page)).toHaveLength(0);
    await page.keyboard.press(`${MOD}+v`);
    expect(await annos(page)).toHaveLength(1);
    await page.keyboard.press(`${MOD}+z`); // undo the paste
    expect(await annos(page)).toHaveLength(0);
    await page.keyboard.press(`${MOD}+z`); // undo the cut
    expect(await annos(page)).toHaveLength(1);
  });

  test('D duplicates in place +10 and leaves the clipboard alone; the copy cascades', async ({ page }) => {
    await withSelectedText(page);
    const [orig] = await annos(page);
    const prevented = await page.evaluate(() => {
      const ev = new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true, cancelable: true });
      document.body.dispatchEvent(ev);
      return ev.defaultPrevented;
    });
    expect(prevented).toBe(true);
    let a = await annos(page);
    expect(a[1]).toMatchObject({ x: orig.x + 10, y: orig.y + 10 });
    await page.keyboard.press(`${MOD}+d`);
    a = await annos(page);
    expect(a[2]).toMatchObject({ x: orig.x + 20, y: orig.y + 20 });
  });

  test('a document-bound cover is not copied: C/X/D leave it alone', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('#file-input', FIXTURE);
    await expectFirstPage(page);
    await page.evaluate(() => {
      const d = window.v2.getDoc();
      const pg = d.pages[0];
      pg.annotations.push({ id: 'cover_t', type: 'whiteout', x: 50, y: 50, width: 40, height: 20, ocrBox: { x: 50, y: 50, w: 40, h: 20 } });
      d.selection = { pageId: pg.id, annotationId: 'cover_t' };
    });
    // Checked after EACH key, by id: a cut-then-paste (X deletes, V re-adds) or a
    // D that adds a copy would otherwise net out to "one annotation" at the end.
    // Catches: X deleting the cover, V pasting a re-id'd copy of it, D duplicating it.
    const ids = () => page.evaluate(() => window.v2.getDoc().pages[0].annotations.map((a) => a.id));
    expect(await ids(), 'known-positive: the injected cover is the only annotation').toEqual(['cover_t']);
    for (const k of ['c', 'x', 'v', 'd']) {
      await page.keyboard.press(`${MOD}+${k}`);
      expect(await ids(), `after ${MOD}+${k.toUpperCase()} the cover must be untouched and alone`).toEqual(['cover_t']);
    }
  });

  test('a pasted annotation reaches the exported PDF', async ({ page }) => {
    await withSelectedText(page, 'Tempelan');
    await page.keyboard.press(`${MOD}+c`);
    await page.keyboard.press(`${MOD}+v`);
    // Drop the ORIGINAL from the model so only the pasted copy can supply the text.
    await page.evaluate(() => { window.v2.getDoc().pages[0].annotations.splice(0, 1); });
    await page.click('#btn-download');
    await expect(page.locator('#dl-sheet')).toBeVisible();
    const { buf } = await downloadBytes(page, () => page.click('#ds-cta'));
    await expectRealPdf(page, buf, { pages: 2, text: ['Tempelan'] });
  });

  test('V pastes onto another page when that page is the one on screen', async ({ page }) => {
    await withSelectedText(page);
    await page.keyboard.press(`${MOD}+c`);
    await page.keyboard.press('Escape'); // clear the selection; paste falls back to the page in view
    await page.locator('.pv-page >> nth=1').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.keyboard.press(`${MOD}+v`);
    expect(await annos(page, 1)).toHaveLength(1);
  });
});
