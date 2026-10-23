/*
 * PDFLokal — Ctrl/Cmd+V from the SYSTEM clipboard places an image or text on the page.
 *
 * WHY this exists: paste used to work only inside the signature dialog and for the
 * app's own copied objects. A screenshot or a copied sentence from another app did
 * nothing on the page. The wiring is the `paste` event (clipboardData), so these
 * specs raise a real ClipboardEvent carrying a DataTransfer: no OS clipboard, no
 * permission prompt. The in-app copy/paste contract (fresh copy wins; a stale one
 * yields to the system clipboard) is pinned here; the rest of it is in
 * v2-annotation-clipboard.spec.js. Not run by the foreground gate (nightly CI).
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';
import { downloadBytes, expectRealPdf } from './helpers/download-bytes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

// Raise a paste event on `selector` carrying text and/or a w x h PNG; returns defaultPrevented.
const paste = (page, { text, image, selector = 'body' } = {}) => page.evaluate(async ({ text, image, selector }) => {
  const dt = new DataTransfer();
  if (text != null) dt.setData('text/plain', text);
  if (image) {
    const c = document.createElement('canvas');
    c.width = image.w; c.height = image.h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#c00'; ctx.fillRect(0, 0, image.w, image.h);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    dt.items.add(new File([blob], 'x.png', { type: 'image/png' }));
  }
  const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
  document.querySelector(selector).dispatchEvent(ev);
  return ev.defaultPrevented;
}, { text, image, selector });

const annos = (page, i = 0) => page.evaluate((n) => window.v2.getDoc().pages[n].annotations.map((a) => ({ ...a })), i);

async function openDoc(page) {
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await expectFirstPage(page);
}

async function withSelectedText(page, text) {
  await openDoc(page);
  await page.keyboard.press('t');
  await page.click('.pv-page >> nth=0', { position: { x: 200, y: 200 } });
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  await expect(page.locator('.pv-anno-text')).toHaveText(text);
}

test.describe('system clipboard paste', () => {
  test('an image becomes ONE movable signature-type object, inside the page, aspect kept', async ({ page }) => {
    await openDoc(page);
    expect(await paste(page, { image: { w: 3000, h: 1500 } })).toBe(true);
    await expect.poll(async () => (await annos(page)).length).toBe(1);
    const [a] = await annos(page);
    const pg = await page.evaluate(() => { const p = window.v2.getDoc().pages[0]; return { w: p.width, h: p.height }; });
    expect(a.type).toBe('signature');
    expect(a.image.startsWith('data:image/png')).toBe(true);
    expect(a.width / a.height).toBeCloseTo(2, 2);
    expect(a.width).toBeLessThanOrEqual(pg.w * 0.6 + 0.01);
    expect(a.x).toBeGreaterThanOrEqual(0);
    expect(a.x + a.width).toBeLessThanOrEqual(pg.w + 0.01);
    expect(a.y + a.height).toBeLessThanOrEqual(pg.h + 0.01);
    // The stored pixels are capped (a 3000px screenshot must not ride every undo snapshot).
    const px = await page.evaluate((src) => new Promise((r) => {
      const im = new Image(); im.onload = () => r({ w: im.naturalWidth, h: im.naturalHeight }); im.src = src;
    }), a.image);
    expect(px.w).toBe(1200);
    expect(px.h).toBe(600);
    expect(await page.evaluate(() => window.v2.getDoc().selection.annotationId)).toBe(a.id);
    await expect(page.locator('.pv-anno')).toHaveCount(1);
    // One paste = one undo step.
    await page.keyboard.press(`${MOD}+z`);
    expect(await annos(page)).toHaveLength(0);
  });

  test('plain text becomes a text object in the bar defaults, selected, ONE undo step', async ({ page }) => {
    await openDoc(page);
    expect(await paste(page, { text: '  Baris satu\r\nBaris dua  \n\n' })).toBe(true);
    const [a] = await annos(page);
    expect(a).toMatchObject({ type: 'text', text: 'Baris satu\nBaris dua', fontSize: 18, fontFamily: 'Helvetica', color: '#000000' });
    expect(await page.evaluate(() => window.v2.getDoc().selection.annotationId)).toBe(a.id);
    await page.keyboard.press(`${MOD}+z`);
    expect(await annos(page)).toHaveLength(0);
  });

  test('pasted text reaches the exported PDF', async ({ page }) => {
    await openDoc(page);
    await paste(page, { text: 'Tempelan Luar' });
    await page.click('#btn-download');
    await expect(page.locator('#dl-sheet')).toBeVisible();
    const { buf } = await downloadBytes(page, () => page.click('#ds-cta'));
    await expectRealPdf(page, buf, { pages: 2, text: ['Tempelan Luar'] });
  });

  test('inside the inline text editor the paste stays native (nothing placed, not prevented)', async ({ page }) => {
    await openDoc(page);
    await page.keyboard.press('t');
    await page.click('.pv-page >> nth=0', { position: { x: 200, y: 200 } });
    await expect(page.locator('.v2-text-edit')).toBeFocused();
    expect(await paste(page, { text: 'ke editor', selector: '.v2-text-edit' })).toBe(false);
    expect(await annos(page)).toHaveLength(0);
  });

  test('with no document, or nothing usable on the clipboard, it does nothing', async ({ page }) => {
    await page.goto('/');
    expect(await paste(page, { text: 'tanpa dokumen' })).toBe(false);
    await openDoc(page);
    expect(await paste(page, {})).toBe(false);
    expect(await annos(page)).toHaveLength(0);
  });

  test('a FRESH in-app copy beats whatever the system clipboard holds', async ({ page }) => {
    await withSelectedText(page, 'Salinan');
    await page.keyboard.press(`${MOD}+c`);
    expect(await paste(page, { text: 'basi di clipboard' })).toBe(true);
    const a = await annos(page);
    expect(a.map((x) => x.text)).toEqual(['Salinan', 'Salinan']); // the in-app copy, not 'basi di clipboard'
  });

  test('once the window has lost focus the in-app copy is stale: the system clipboard wins', async ({ page }) => {
    await withSelectedText(page, 'Salinan');
    await page.keyboard.press(`${MOD}+c`);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    expect(await paste(page, { text: 'dari aplikasi lain' })).toBe(true);
    expect((await annos(page)).map((x) => x.text)).toEqual(['Salinan', 'dari aplikasi lain']);
  });

  test('a stale in-app copy is still pasted when the system clipboard has nothing usable', async ({ page }) => {
    await withSelectedText(page, 'Salinan');
    await page.keyboard.press(`${MOD}+c`);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    expect(await paste(page, {})).toBe(true);
    expect((await annos(page)).map((x) => x.text)).toEqual(['Salinan', 'Salinan']);
  });

  test('the real keyboard Ctrl/Cmd+V still pastes the fresh in-app copy', async ({ page }) => {
    await withSelectedText(page, 'Papan');
    await page.keyboard.press(`${MOD}+c`);
    await page.keyboard.press(`${MOD}+v`);
    expect((await annos(page)).map((x) => x.text)).toEqual(['Papan', 'Papan']);
  });
});

// A pasted image is a signature-type object and stays SELECTED after the paste.
// Tapping TTD to make a first signature then used to swap the pasted image
// (a company stamp, a logo) for the drawing, because onReady replaced whatever
// signature was selected. Replacing is Gambar Ulang's job, never a side effect.
test('TTD after pasting an image makes a NEW signature; the pasted image is untouched', async ({ page }) => {
  await openDoc(page);
  expect(await paste(page, { image: { w: 400, h: 200 } })).toBe(true);
  await expect.poll(async () => (await annos(page)).length).toBe(1);
  const [pasted] = await annos(page);
  expect(await page.evaluate(() => window.v2.getDoc().selection.annotationId), 'known-positive: the paste is selected').toBe(pasted.id);

  await page.click('[data-tool="signature"]');
  await expect(page.locator('#sig-modal')).toBeVisible();
  await expect(page.locator('#sig-canvas')).toHaveAttribute('data-ready', 'true');
  const box = await page.locator('#sig-canvas').boundingBox();
  await page.mouse.move(box.x + 40, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + 80, { steps: 8 });
  await page.mouse.up();
  await page.click('#sig-use');
  await expect(page.locator('#sig-modal')).toBeHidden();

  const after = await annos(page);
  expect(after.find((a) => a.id === pasted.id)?.image, 'the pasted image was replaced by the drawing').toBe(pasted.image);
  expect(await page.evaluate(() => window.v2.getTool()), 'TTD must arm placement of the new signature').toBe('signature');
});

// The other half: Gambar Ulang with a signature-type object selected IS the
// explicit "replace this one" (founder punch list #1), and must still swap it in
// place, one object, one undo step.
test('Gambar Ulang on the selected object replaces it in place', async ({ page }) => {
  await openDoc(page);
  expect(await paste(page, { image: { w: 400, h: 200 } })).toBe(true);
  await expect.poll(async () => (await annos(page)).length).toBe(1);
  const [pasted] = await annos(page);
  await expect(page.locator('#btn-redraw-sig')).toBeVisible();
  await page.click('#btn-redraw-sig');
  await expect(page.locator('#sig-canvas')).toHaveAttribute('data-ready', 'true');
  const box = await page.locator('#sig-canvas').boundingBox();
  await page.mouse.move(box.x + 40, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + 80, { steps: 8 });
  await page.mouse.up();
  await page.click('#sig-use');
  await expect(page.locator('#sig-modal')).toBeHidden();
  const after = await annos(page);
  expect(after).toHaveLength(1);
  expect(after[0].id).toBe(pasted.id);
  expect(after[0].image).not.toBe(pasted.image);
});
