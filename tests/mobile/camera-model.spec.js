/*
 * The camera-first touch model (founder's design, Jul 2 round 3):
 *   - movement is ALWAYS camera unless the object was already selected
 *   - selection commits at RELEASE (press+move ≠ tap → nothing selected)
 *   - armed placement tools beat object hits (write ON TOP of a tip-ex)
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'sample-2pages.pdf');

async function openWithText(page) {
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();
  await page.tap('[data-tool="text"]');
  await page.tap('.pv-page >> nth=0', { position: { x: 120, y: 150 } });
  await page.keyboard.type('objek uji');
  await page.keyboard.press('Enter');
  // Deselect (tap empty space) so tests start from the unselected state.
  await page.tap('.pv-page >> nth=0', { position: { x: 300, y: 500 } });
  expect(await page.evaluate(() => window.v2.getDoc().selection.annotationId)).toBe(null);
}

// Touch press + move + release across an element (pointerType touch).
async function touchDragOn(page, selector, dx, dy) {
  await page.evaluate(async ({ selector, dx, dy }) => {
    const el = document.querySelector(selector);
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const fire = (type, x, y) => el.dispatchEvent(new PointerEvent(type, {
      pointerId: 31, pointerType: 'touch', isPrimary: true,
      clientX: x, clientY: y, bubbles: true, cancelable: true,
    }));
    fire('pointerdown', cx, cy);
    for (let i = 1; i <= 4; i += 1) {
      fire('pointermove', cx + (dx * i) / 4, cy + (dy * i) / 4);
      await new Promise((res) => requestAnimationFrame(res));
    }
    fire('pointerup', cx + dx, cy + dy);
  }, { selector, dx, dy });
}

test.describe('camera-first touch model', () => {
  test('press+move on an UNSELECTED object: no selection, no movement (camera)', async ({ page }) => {
    await openWithText(page);
    const before = await page.evaluate(() => {
      const a = window.v2.getDoc().pages[0].annotations[0];
      return { x: a.x, y: a.y };
    });
    await touchDragOn(page, '.pv-anno-text', 70, 50);
    const after = await page.evaluate(() => {
      const d = window.v2.getDoc();
      const a = d.pages[0].annotations[0];
      return { x: a.x, y: a.y, sel: d.selection.annotationId };
    });
    expect(after.x).toBe(before.x);   // object did not move
    expect(after.y).toBe(before.y);
    expect(after.sel).toBe(null);      // and was not selected (press+move ≠ tap)
  });

  test('clean tap on an unselected object selects it AT RELEASE', async ({ page }) => {
    await openWithText(page);
    await page.tap('.pv-anno-text');
    const sel = await page.evaluate(() => window.v2.getDoc().selection.annotationId);
    expect(sel).toBeTruthy();
    await expect(page.locator('.pv-anno-text.pv-selected')).toHaveCount(1);
  });

  test('drag on the ALREADY-selected object moves it (deliberate grab)', async ({ page }) => {
    await openWithText(page);
    await page.tap('.pv-anno-text'); // select first
    const before = await page.evaluate(() => window.v2.getDoc().pages[0].annotations[0].x);
    await touchDragOn(page, '.pv-anno-text', 70, 40);
    const after = await page.evaluate(() => window.v2.getDoc().pages[0].annotations[0].x);
    expect(after).toBeGreaterThan(before);
  });

  test('armed Teks writes ON TOP of an existing whiteout', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('#file-input', FIXTURE);
    await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();

    // Draw a whiteout.
    await page.tap('[data-tool="whiteout"]');
    const pg = await page.locator('.pv-page >> nth=0').boundingBox();
    await page.evaluate(async ({ x1, y1, x2, y2 }) => {
      const el = document.elementFromPoint(x1, y1);
      const fire = (type, x, y) => el.dispatchEvent(new PointerEvent(type, {
        pointerId: 32, pointerType: 'touch', isPrimary: true,
        clientX: x, clientY: y, bubbles: true, cancelable: true,
      }));
      fire('pointerdown', x1, y1);
      for (let i = 1; i <= 4; i += 1) {
        fire('pointermove', x1 + ((x2 - x1) * i) / 4, y1 + ((y2 - y1) * i) / 4);
        await new Promise((r) => requestAnimationFrame(r));
      }
      fire('pointerup', x2, y2);
    }, { x1: pg.x + 60, y1: pg.y + 140, x2: pg.x + 240, y2: pg.y + 190 });
    expect(await page.evaluate(() => window.v2.getDoc().pages[0].annotations.length)).toBe(1);

    // Arm Teks and tap INSIDE the whiteout: text places instead of selecting it.
    await page.tap('[data-tool="text"]');
    await page.tap('.pv-page >> nth=0', { position: { x: 150 / 1, y: 165 } });
    await page.keyboard.type('di atas tip-ex');
    await page.keyboard.press('Enter');

    const annos = await page.evaluate(() => window.v2.getDoc().pages[0].annotations.map((a) => a.type));
    expect(annos).toEqual(['whiteout', 'text']); // text AFTER whiteout → renders above
    await expect(page.locator('.pv-anno-text')).toHaveText('di atas tip-ex');
  });
});
