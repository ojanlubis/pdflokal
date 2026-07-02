/*
 * Regression tests for the pre-swap review's verified findings.
 * H1: a superseded compress run must not wedge `compressing` true forever.
 * H2: selection chrome (outline/handle/touch-action) survives rebuildStage.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'sample-2pages.pdf');
const BIGDOC = path.join(__dirname, '..', 'fixtures', 'bigdoc-120.pdf');

test.describe('review fixes', () => {
  test('H1: re-pick WHILE compressing (superseded run) — Compress recovers, download works', async ({ page }) => {
    test.setTimeout(90000);
    await page.goto('/');
    await page.setInputFiles('#file-input', BIGDOC); // big → compression takes seconds
    await expect(page.locator('.pv-page').first()).toBeVisible();
    await page.tap('#btn-download');
    await expect(page.locator('#ds-cta-main')).toContainText(/KB|MB/, { timeout: 60000 });

    await page.tap('#ds-size [data-v="kompres"]');
    // While the 120-page compression is IN FLIGHT, change the page selection.
    await page.tap('#ds-pages [data-v="some"]');
    await page.tap('.pm-tile >> nth=0');
    await page.tap('.pm-tile >> nth=1');
    await page.tap('#pm-pick-ok');
    await expect(page.locator('#ds-cta-main')).toContainText('(2 hal.)');

    // The wedge would leave the spinner forever; recovery = a result lands.
    await expect(page.locator('#ds-size [data-v="kompres"]')).toContainText(/hemat|optimal/, { timeout: 60000 });
    const dl = page.waitForEvent('download');
    await page.tap('#ds-cta');
    expect((await dl).suggestedFilename()).toMatch(/\.pdf$/);
  });

  test('H2: selection chrome survives rebuildStage (Semua Hal. + undo keep it draggable)', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('#file-input', FIXTURE);
    await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();

    // Draw + place a signature (lands selected), then fan out (rebuildStage).
    await page.tap('[data-tool="signature"]');
    const box = await page.locator('#sig-canvas').boundingBox();
    await page.mouse.move(box.x + 40, box.y + 60);
    await page.mouse.down();
    await page.mouse.move(box.x + 180, box.y + 90, { steps: 5 });
    await page.mouse.up();
    await page.tap('#sig-use');
    await page.tap('.pv-page >> nth=0', { position: { x: 150, y: 250 } });
    await page.tap('#btn-all-pages'); // → rebuildStage with selection intact

    // Chrome must be back: outline class, resize handle, touch-action none.
    const sel = page.locator('.pv-anno.pv-selected');
    await expect(sel).toHaveCount(1);
    await expect(sel.locator('.pv-handle')).toHaveCount(1);
    expect(await sel.evaluate((el) => el.style.touchAction)).toBe('none');

    // And the object must actually DRAG on touch after the rebuild.
    const before = await page.evaluate(() => {
      const a = window.v2.getDoc().pages[0].annotations[0];
      return { x: a.x, y: a.y };
    });
    await page.evaluate(async () => {
      const el = document.querySelector('.pv-anno.pv-selected');
      const r = el.getBoundingClientRect();
      const fire = (type, x, y) => el.dispatchEvent(new PointerEvent(type, {
        pointerId: 41, pointerType: 'touch', isPrimary: true,
        clientX: x, clientY: y, bubbles: true, cancelable: true,
      }));
      fire('pointerdown', r.left + r.width / 2, r.top + r.height / 2);
      for (let i = 1; i <= 4; i += 1) {
        fire('pointermove', r.left + r.width / 2 + i * 12, r.top + r.height / 2 + i * 8);
        await new Promise((res) => requestAnimationFrame(res));
      }
      fire('pointerup', r.left + r.width / 2 + 48, r.top + r.height / 2 + 32);
    });
    const after = await page.evaluate(() => {
      const a = window.v2.getDoc().pages[0].annotations[0];
      return { x: a.x, y: a.y };
    });
    expect(after.x).toBeGreaterThan(before.x);

    // Undo (another rebuildStage path): chrome still coherent — either a
    // decorated selection or a clean deselection, never a naked "selected".
    await page.tap('#btn-undo');
    const coherent = await page.evaluate(() => {
      const id = window.v2.getDoc().selection.annotationId;
      const el = document.querySelector('.pv-anno.pv-selected');
      return (id === null && el === null) || (id !== null && el?.dataset.annoId === id);
    });
    expect(coherent).toBe(true);
  });
});
