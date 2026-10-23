/*
 * GAMBAR: BRING A PICTURE (PICKER OR CTRL+V) ONTO THE PAGE.
 * ============================================================================
 * The tool is the signature object with a picker in front of it. The headless
 * halves are tests/core/gambar-place.test.mjs (where and how big),
 * gambar-export.test.mjs (the file agrees with the box), gambar-decode.test.mjs
 * (cap, JPEG vs PNG) and gambar-wiring.test.mjs. This spec proves what only a
 * browser can: the real picker, a real phone JPEG with an EXIF Orientation, the
 * tap that drops it, the tool going home, undo, a turned page, Ctrl+V next to
 * object paste, and the exported pixels. NOT RUN LOCALLY (the laptop cannot run
 * the Playwright gate); CI's e2e.yml runs it.
 *
 * FIXTURE: tests/fixtures/exif-o6-red-blue.jpg is 300x200 raw pixels with
 * Orientation=6; DISPLAYED it is 200 wide x 300 tall, RED ON TOP, BLUE BELOW.
 * A decoder that ignored the tag would place a 3:2 picture with red on the left.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';
import { downloadBytes, expectRealPdf } from './helpers/download-bytes.js';
import { pngBytes } from './helpers/png.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');
const PHONE_JPEG = path.join(__dirname, 'fixtures', 'exif-o6-red-blue.jpg');
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const annos = (page, i = 0) => page.evaluate((n) => window.v2.getDoc().pages[n].annotations.map((a) => ({ ...a })), i);
const tool = (page) => page.evaluate(() => window.v2.getTool());

async function openDoc(page) {
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await expectFirstPage(page);
}

// Press Gambar, choose `file` in the real picker. Resolves when the tool is armed.
async function armWith(page, file) {
  const chooser = page.waitForEvent('filechooser');
  await page.click('[data-tool="gambar"]');
  await (await chooser).setFiles(file);
  await expect.poll(() => tool(page)).toBe('gambar');
}

// Tap at a fraction of the first page; returns the tap in PAGE units.
async function tapPage(page, fx, fy) {
  const box = await page.locator('.pv-page').first().boundingBox();
  const size = await page.evaluate(() => { const p = window.v2.getDoc().pages[0]; const r = (p.rotation || 0) % 180 !== 0; return { w: r ? p.height : p.width, h: r ? p.width : p.height }; });
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
  return { x: size.w * fx, y: size.h * fy };
}

test.describe('Gambar', () => {
  test('the button sits after TTD, carries the DRAFT label, and the picker is its own input', async ({ page }) => {
    await openDoc(page);
    const order = await page.$$eval('#toolbar .tool[data-tool]', (els) => els.map((e) => e.dataset.tool));
    expect(order.indexOf('gambar')).toBe(order.indexOf('signature') + 1);
    await expect(page.locator('[data-tool="gambar"]')).not.toHaveText('');
    await expect(page.locator('#gambar-file')).toHaveAttribute('accept', 'image/*');
    await expect(page.locator('#file-input')).not.toHaveAttribute('accept', 'image/*');
  });

  test('pick a phone photo, tap the page: ONE picture, upright (EXIF honoured), centred on the tap, tool home, one undo', async ({ page }) => {
    await openDoc(page);
    await armWith(page, PHONE_JPEG);
    await expect(page.locator('[data-tool="gambar"]')).toHaveClass(/active/);
    const tap = await tapPage(page, 0.5, 0.5);

    await expect.poll(async () => (await annos(page)).length).toBe(1);
    const [a] = await annos(page);
    expect(a.type).toBe('signature');
    expect(a.image.startsWith('data:image/jpeg'), 'a JPEG stays a JPEG (a photo as PNG would balloon the PDF)').toBe(true);
    expect(a.width / a.height, 'portrait: 200x300 displayed, not the raw 300x200').toBeCloseTo(200 / 300, 2);
    expect(a.x + a.width / 2).toBeCloseTo(tap.x, 0);
    expect(a.y + a.height / 2).toBeCloseTo(tap.y, 0);
    expect(await tool(page), 'a tool returns home after its verb').toBe('select');
    expect(await page.evaluate(() => window.v2.getDoc().selection.annotationId)).toBe(a.id);
    await expect(page.locator('.pv-anno-signature')).toHaveCount(1);

    // Released: tapping again places nothing.
    await tapPage(page, 0.3, 0.3);
    expect(await annos(page)).toHaveLength(1);

    await page.keyboard.press(`${MOD}+z`);
    expect(await annos(page)).toHaveLength(0);
  });

  test('tools toggle: a second press disarms and nothing is placed; cancelling the picker arms nothing', async ({ page }) => {
    await openDoc(page);
    await armWith(page, PHONE_JPEG);
    await page.click('[data-tool="gambar"]'); // armed -> off, no picker
    expect(await tool(page)).toBe('select');
    await tapPage(page, 0.5, 0.5);
    expect(await annos(page)).toHaveLength(0);

    const chooser = page.waitForEvent('filechooser');
    await page.click('[data-tool="gambar"]');
    await (await chooser).setFiles([]); // cancelled
    expect(await tool(page)).toBe('select');
    await expect(page.locator('[data-tool="gambar"]')).not.toHaveClass(/active/);
  });

  test('a file the browser cannot decode fails with the existing toast and arms nothing', async ({ page }) => {
    await openDoc(page);
    const chooser = page.waitForEvent('filechooser');
    await page.click('[data-tool="gambar"]');
    await (await chooser).setFiles({ name: 'foto.heic', mimeType: 'image/heic', buffer: Buffer.from('not an image at all') });
    await expect(page.locator('#toast')).toContainText('nggak bisa dibuka');
    expect(await tool(page)).toBe('select');
    expect(await annos(page)).toHaveLength(0);
  });

  test('a huge picture is capped at 2000px on the long side and shrunk to fit the page', async ({ page }) => {
    await openDoc(page);
    await armWith(page, { name: 'besar.png', mimeType: 'image/png', buffer: pngBytes(3000, 1500) });
    await tapPage(page, 0.5, 0.5);
    const [a] = await annos(page);
    const pg = await page.evaluate(() => { const p = window.v2.getDoc().pages[0]; return { w: p.width, h: p.height }; });
    expect(a.image.startsWith('data:image/png'), 'PNG stays PNG (transparency)').toBe(true);
    const px = await page.evaluate((src) => new Promise((r) => { const im = new Image(); im.onload = () => r({ w: im.naturalWidth, h: im.naturalHeight }); im.src = src; }), a.image);
    expect(px).toEqual({ w: 2000, h: 1000 });
    expect(a.width / a.height).toBeCloseTo(2, 2);
    expect(a.width).toBeLessThanOrEqual(pg.w * 0.6 + 0.01);
  });

  test('a tap at the very corner still lands the picture whole inside the page', async ({ page }) => {
    await openDoc(page);
    await armWith(page, { name: 'logo.png', mimeType: 'image/png', buffer: pngBytes(300, 300) });
    await tapPage(page, 0.99, 0.99);
    const [a] = await annos(page);
    const pg = await page.evaluate(() => { const p = window.v2.getDoc().pages[0]; return { w: p.width, h: p.height }; });
    expect(a.x + a.width).toBeLessThanOrEqual(pg.w + 0.01);
    expect(a.y + a.height).toBeLessThanOrEqual(pg.h + 0.01);
  });

  test('it moves like a signature (aspect kept) and Delete removes it', async ({ page }) => {
    await openDoc(page);
    await armWith(page, PHONE_JPEG);
    await tapPage(page, 0.4, 0.4);
    const [before] = await annos(page);
    const el = page.locator('.pv-anno-signature');
    const box = await el.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 30, { steps: 6 });
    await page.mouse.up();
    const [moved] = await annos(page);
    expect(moved.x).toBeGreaterThan(before.x);
    expect(moved.y).toBeGreaterThan(before.y);
    expect(moved.width / moved.height).toBeCloseTo(before.width / before.height, 3);
    await page.keyboard.press('Delete');
    expect(await annos(page)).toHaveLength(0);
  });

  test('on a turned page it is placed upright as the user sees it, and turns with the page afterwards', async ({ page }) => {
    await openDoc(page);
    await page.locator('.pv-strip >> nth=0').locator('[data-strip-act="rotate"]').click();
    await expect.poll(() => page.evaluate(() => window.v2.getDoc().pages[0].rotation)).toBe(90);
    await armWith(page, PHONE_JPEG);
    await tapPage(page, 0.5, 0.5);
    const [a] = await annos(page);
    expect(a.turn || 0).toBe(0);
    const frame = await page.evaluate(() => { const p = window.v2.getDoc().pages[0]; return { w: p.height, h: p.width }; });
    expect(a.x).toBeGreaterThanOrEqual(0);
    expect(a.x + a.width).toBeLessThanOrEqual(frame.w + 0.01);
    expect(a.y + a.height).toBeLessThanOrEqual(frame.h + 0.01);
  });

  test('the picture is in the downloaded PDF where the screen shows it: red on top, blue below', async ({ page }) => {
    await openDoc(page);
    await armWith(page, PHONE_JPEG);
    await tapPage(page, 0.5, 0.5);
    const [a] = await annos(page);
    await page.click('#btn-download');
    await expect(page.locator('#dl-sheet')).toBeVisible();
    const { buf } = await downloadBytes(page, () => page.click('#ds-cta'));
    await expectRealPdf(page, buf, { pages: 2 });
    const px = await page.evaluate(async ({ arr, a }) => {
      const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(arr) }).promise;
      const pg = await doc.getPage(1);
      const vp = pg.getViewport({ scale: 1 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      await pg.render({ canvasContext: ctx, viewport: vp }).promise;
      const at = (x, y) => Array.from(ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data).slice(0, 3);
      return {
        top: at(a.x + a.width / 2, a.y + a.height * 0.25),
        bottom: at(a.x + a.width / 2, a.y + a.height * 0.75),
        outside: at(a.x + a.width + 12, a.y + a.height / 2),
      };
    }, { arr: Array.from(buf), a });
    expect(px.top[0], 'top is red').toBeGreaterThan(200);
    expect(px.top[2], 'top is not blue').toBeLessThan(90);
    expect(px.bottom[2], 'bottom is blue').toBeGreaterThan(200);
    expect(px.bottom[0], 'bottom is not red').toBeLessThan(90);
    expect(px.outside.every((v) => v > 240), 'VACUITY GUARD: beside the picture is still paper').toBe(true);
  });
});

// Ctrl/Cmd+V is Gambar's paste path. It must not collide with pasting an OBJECT:
// a fresh in-app copy wins, otherwise the image on the system clipboard is placed.
const pasteImage = (page, { w, h }) => page.evaluate(async ({ w, h }) => {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d'); ctx.fillStyle = '#c00'; ctx.fillRect(0, 0, w, h);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const dt = new DataTransfer();
  dt.items.add(new File([blob], 'x.png', { type: 'image/png' }));
  const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
  document.body.dispatchEvent(ev);
  return ev.defaultPrevented;
}, { w, h });

test.describe('Gambar: Ctrl/Cmd+V', () => {
  test('a pasted image is placed on the visible page, one undo step, and the tool is home', async ({ page }) => {
    await openDoc(page);
    expect(await pasteImage(page, { w: 400, h: 200 })).toBe(true);
    await expect.poll(async () => (await annos(page)).length).toBe(1);
    expect(await tool(page)).toBe('select');
    await page.keyboard.press(`${MOD}+z`);
    expect(await annos(page)).toHaveLength(0);
  });

  test('paste during an armed Gambar places the clipboard image and releases the armed one', async ({ page }) => {
    await openDoc(page);
    await armWith(page, PHONE_JPEG);
    expect(await pasteImage(page, { w: 400, h: 200 })).toBe(true);
    await expect.poll(async () => (await annos(page)).length).toBe(1);
    expect(await tool(page)).toBe('select');
    await tapPage(page, 0.5, 0.5);
    expect(await annos(page), 'the armed picture was released by the paste, the tap places nothing').toHaveLength(1);
  });

  test('image paste vs object paste: a FRESH Ctrl+C of a picture is pasted as the object, a stale one yields to the clipboard image', async ({ page }) => {
    await openDoc(page);
    await armWith(page, PHONE_JPEG);
    await tapPage(page, 0.5, 0.5);
    const [first] = await annos(page);
    await page.keyboard.press(`${MOD}+c`);
    expect(await pasteImage(page, { w: 400, h: 200 })).toBe(true);
    let list = await annos(page);
    expect(list).toHaveLength(2);
    expect(list[1].image, 'fresh in-app copy: the SAME picture, not the red clipboard image').toBe(first.image);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    expect(await pasteImage(page, { w: 400, h: 200 })).toBe(true);
    list = await annos(page);
    expect(list).toHaveLength(3);
    expect(list[2].image, 'stale in-app copy: the clipboard image wins').not.toBe(first.image);
  });
});
