/*
 * The two gaps Ojan found on his phone (Jul 2): text couldn't be dragged,
 * Tip-Ex (whiteout) didn't work. These reproduce the flows with REAL pointer
 * sequences (touch-typed events incl. browser-realistic ordering), not just
 * model pokes.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'sample-2pages.pdf');

async function openDoc(page) {
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();
}

// Real-ish touch drag: pointerdown/move/up WITH pointerType touch AND the
// coalesced single-touch semantics (isPrimary, same pointerId).
async function touchDrag(page, fromX, fromY, toX, toY, steps = 6) {
  await page.evaluate(async ({ fromX, fromY, toX, toY, steps }) => {
    const target = document.elementFromPoint(fromX, fromY);
    const fire = (type, el, x, y) => el.dispatchEvent(new PointerEvent(type, {
      pointerId: 11, pointerType: 'touch', isPrimary: true,
      clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true,
      button: type === 'pointerdown' ? 0 : -1, buttons: type === 'pointerup' ? 0 : 1,
    }));
    fire('pointerdown', target, fromX, fromY);
    for (let i = 1; i <= steps; i += 1) {
      const x = fromX + ((toX - fromX) * i) / steps;
      const y = fromY + ((toY - fromY) * i) / steps;
      // After setPointerCapture the browser retargets to the capture element;
      // dispatching manually we emulate that by firing on the capture target.
      fire('pointermove', document.elementFromPoint(x, y) || target, x, y);
      await new Promise((r) => requestAnimationFrame(r));
    }
    fire('pointerup', document.elementFromPoint(toX, toY) || target, toX, toY);
  }, { fromX, fromY, toX, toY, steps });
}

test.describe('whiteout + text drag — the real-phone gaps', () => {
  test('Tip-Ex: touch drag on the page creates a whiteout with real size', async ({ page }) => {
    await openDoc(page);
    await page.tap('[data-tool="whiteout"]');
    const pageBox = await page.locator('.pv-page >> nth=0').boundingBox();
    await touchDrag(page,
      pageBox.x + 60, pageBox.y + 120,
      pageBox.x + 200, pageBox.y + 180);

    const annos = await page.evaluate(() => window.v2.getDoc().pages[0].annotations);
    expect(annos).toHaveLength(1);
    expect(annos[0].type).toBe('whiteout');
    expect(annos[0].width).toBeGreaterThan(50);
    expect(annos[0].height).toBeGreaterThan(20);
    // And it's visible in the DOM.
    await expect(page.locator('.pv-anno-whiteout')).toBeVisible();
  });

  test('text: touch drag moves a placed text annotation', async ({ page }) => {
    await openDoc(page);
    await page.tap('[data-tool="text"]');
    await page.tap('.pv-page >> nth=0', { position: { x: 120, y: 150 } });
    await page.keyboard.type('geser aku');
    await page.keyboard.press('Enter');
    await expect(page.locator('.pv-anno-text')).toBeVisible();

    const before = await page.evaluate(() => {
      const a = window.v2.getDoc().pages[0].annotations[0];
      return { x: a.x, y: a.y };
    });
    const box = await page.locator('.pv-anno-text').boundingBox();
    await touchDrag(page,
      box.x + box.width / 2, box.y + box.height / 2,
      box.x + box.width / 2 + 70, box.y + box.height / 2 + 50);

    const after = await page.evaluate(() => {
      const a = window.v2.getDoc().pages[0].annotations[0];
      return { x: a.x, y: a.y };
    });
    expect(after.x).toBeGreaterThan(before.x);
    expect(after.y).toBeGreaterThan(before.y);
  });

  test('whiteout also works with a mouse on desktop-like input', async ({ page }) => {
    await openDoc(page);
    await page.click('[data-tool="whiteout"]');
    const pageBox = await page.locator('.pv-page >> nth=0').boundingBox();
    await page.mouse.move(pageBox.x + 50, pageBox.y + 300);
    await page.mouse.down();
    await page.mouse.move(pageBox.x + 180, pageBox.y + 340, { steps: 5 });
    await page.mouse.up();

    const annos = await page.evaluate(() => window.v2.getDoc().pages[0].annotations);
    expect(annos).toHaveLength(1);
    expect(annos[0].type).toBe('whiteout');
  });
});
