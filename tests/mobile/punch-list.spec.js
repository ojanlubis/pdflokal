/*
 * Founder's phone punch list (Jul 2, round 2) — one test per item:
 *   1. text resizes via handle like TTD (fontSize scaling)
 *   2. Tip-Ex color-matches the paper (not always white)
 *   3. Tip-Ex returns to Pilih after a stroke
 *   4. saved TTD offers "Gambar Ulang"
 *   5. Hapus works both ways (armed delete-mode)
 *   6. pinch zooms, zoomed doc pans (Google-Maps camera)
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'sample-2pages.pdf');
const RED_FIXTURE = path.join(__dirname, '..', 'fixtures', 'alt-red-1page.pdf');

async function openDoc(page, fixture = FIXTURE) {
  await page.goto('/editor-v2.html');
  await page.setInputFiles('#file-input', fixture);
  await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();
}

async function placeText(page, text = 'ubah ukuranku') {
  await page.tap('[data-tool="text"]');
  await page.tap('.pv-page >> nth=0', { position: { x: 100, y: 150 } });
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  await expect(page.locator('.pv-anno-text')).toBeVisible();
}

function drag(page, el, dx, dy) {
  return page.evaluate(async ({ sel, dx, dy }) => {
    const target = document.querySelector(sel);
    const r = target.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const fire = (type, x, y) => target.dispatchEvent(new PointerEvent(type, {
      pointerId: 21, pointerType: 'touch', isPrimary: true,
      clientX: x, clientY: y, bubbles: true, cancelable: true,
    }));
    fire('pointerdown', cx, cy);
    for (let i = 1; i <= 5; i += 1) {
      fire('pointermove', cx + (dx * i) / 5, cy + (dy * i) / 5);
      await new Promise((res) => requestAnimationFrame(res));
    }
    fire('pointerup', cx + dx, cy + dy);
  }, { sel: el, dx, dy });
}

test.describe('punch list — round 2', () => {
  test('1. text resizes via its handle (fontSize scales)', async ({ page }) => {
    await openDoc(page);
    await placeText(page);
    // Committed text stays selected → handle present.
    await expect(page.locator('.pv-anno-text .pv-handle')).toHaveCount(1);
    const before = await page.evaluate(() => window.v2.getDoc().pages[0].annotations[0].fontSize);
    await drag(page, '.pv-anno-text .pv-handle', 80, 0);
    const after = await page.evaluate(() => window.v2.getDoc().pages[0].annotations[0].fontSize);
    expect(after).toBeGreaterThan(before);
    await expect(page.locator('.pv-anno-text')).toHaveCSS('font-size', `${after}px`);
  });

  test('2+3. Tip-Ex color-matches a red page and returns to Pilih', async ({ page }) => {
    await openDoc(page, RED_FIXTURE);
    await page.tap('[data-tool="whiteout"]');
    const pg = await page.locator('.pv-page >> nth=0').boundingBox();
    await page.evaluate(async ({ x1, y1, x2, y2 }) => {
      const target = document.elementFromPoint(x1, y1);
      const fire = (type, x, y) => target.dispatchEvent(new PointerEvent(type, {
        pointerId: 22, pointerType: 'touch', isPrimary: true,
        clientX: x, clientY: y, bubbles: true, cancelable: true,
      }));
      fire('pointerdown', x1, y1);
      for (let i = 1; i <= 5; i += 1) {
        fire('pointermove', x1 + ((x2 - x1) * i) / 5, y1 + ((y2 - y1) * i) / 5);
        await new Promise((r) => requestAnimationFrame(r));
      }
      fire('pointerup', x2, y2);
    }, { x1: pg.x + 80, y1: pg.y + 150, x2: pg.x + 220, y2: pg.y + 200 });

    // 3: tool went home immediately.
    expect(await page.evaluate(() => window.v2.getTool())).toBe('select');
    // 2: sampling is async — poll until the color leaves default white.
    await expect.poll(async () => page.evaluate(
      () => window.v2.getDoc().pages[0].annotations[0]?.color || '#fff',
    ), { timeout: 5000 }).not.toBe('#fff');
    const color = await page.evaluate(() => window.v2.getDoc().pages[0].annotations[0].color);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
    expect(r).toBeGreaterThan(150);            // strongly red…
    expect(r - Math.max(g, b)).toBeGreaterThan(40); // …and clearly redder than g/b
  });

  test('4. armed TTD offers Gambar Ulang (saved sig is not a trap)', async ({ page }) => {
    await openDoc(page);
    await page.tap('[data-tool="signature"]');
    const box = await page.locator('#sig-canvas').boundingBox();
    await page.mouse.move(box.x + 40, box.y + 60);
    await page.mouse.down();
    await page.mouse.move(box.x + 180, box.y + 90, { steps: 5 });
    await page.mouse.up();
    await page.tap('#sig-use');
    // Tool armed → strip offers redraw.
    await expect(page.locator('#btn-redraw-sig')).toBeVisible();
    await page.tap('#btn-redraw-sig');
    await expect(page.locator('#sig-modal')).toBeVisible();
  });

  test('5. Hapus with nothing selected arms delete-mode: next tap removes', async ({ page }) => {
    await openDoc(page);
    await placeText(page, 'hapus aku');
    // Deselect first (tap empty page area with select tool).
    await page.tap('.pv-page >> nth=0', { position: { x: 300, y: 500 } });
    expect(await page.evaluate(() => window.v2.getDoc().selection.annotationId)).toBe(null);

    await page.tap('#btn-delete-anno');
    expect(await page.evaluate(() => window.v2.getTool())).toBe('delete');
    await page.tap('.pv-anno-text');
    expect(await page.evaluate(() => window.v2.getDoc().pages[0].annotations.length)).toBe(0);
    expect(await page.evaluate(() => window.v2.getTool())).toBe('select');
  });

  test('6. pinch zooms in; zoomed doc pans horizontally (map camera)', async ({ page }) => {
    await openDoc(page);
    const z0 = await page.evaluate(() => window.v2.getSlots()[0].view.getBoundingClientRect().width);
    // Two-finger spread on the scroll container.
    await page.evaluate(async () => {
      const el = document.getElementById('v2-scroll');
      const t = (id, x, y) => new Touch({ identifier: id, target: el, clientX: x, clientY: y });
      const fire = (type, touches) => el.dispatchEvent(new TouchEvent(type, {
        touches, changedTouches: touches, bubbles: true, cancelable: true,
      }));
      fire('touchstart', [t(1, 180, 300), t(2, 220, 340)]);
      for (let i = 1; i <= 6; i += 1) {
        fire('touchmove', [t(1, 180 - i * 15, 300 - i * 15), t(2, 220 + i * 15, 340 + i * 15)]);
        await new Promise((r) => requestAnimationFrame(r));
        await new Promise((r) => setTimeout(r, 20));
      }
      fire('touchend', []);
    });
    const z1 = await page.evaluate(() => window.v2.getSlots()[0].view.getBoundingClientRect().width);
    expect(z1).toBeGreaterThan(z0 * 1.2); // visibly zoomed in

    // Camera pans: content now overflows horizontally and scrollLeft moves.
    const pan = await page.evaluate(() => {
      const el = document.getElementById('v2-scroll');
      const overflow = el.scrollWidth > el.clientWidth;
      el.scrollLeft = 60;
      return { overflow, scrolled: el.scrollLeft > 0 };
    });
    expect(pan.overflow).toBe(true);
    expect(pan.scrolled).toBe(true);
  });
});
