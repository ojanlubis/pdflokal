/*
 * Editor v2 on a phone (Pixel 7 emulation: touch, mobile viewport, DPR 2.6).
 * Runs under the `mobile-chrome` Playwright project — see playwright.config.js.
 *
 * These are the FIRST touch tests in the repo. They exercise the one flow the
 * business runs on (product-definition §4): open → edit → download, on mobile.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'sample-2pages.pdf');

async function openWithFixture(page) {
  await page.goto('/editor-v2.html');
  await page.setInputFiles('#file-input', FIXTURE);
  // Both pages get slots instantly; near pages rasterize to <img>.
  await expect(page.locator('.pv-page')).toHaveCount(2);
  await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();
}

test.describe('editor v2 — mobile', () => {
  test('opens a PDF: instant slots, image-backed pages, no empty state', async ({ page }) => {
    await openWithFixture(page);
    await expect(page.locator('#empty')).toBeHidden();
    // Pages are <img>, not <canvas> — the locked render decision.
    expect(await page.locator('.pv-page canvas').count()).toBe(0);
  });

  test('tap-to-type: text tool places editable text via touch', async ({ page }) => {
    await openWithFixture(page);
    await page.tap('[data-tool="text"]');
    await page.tap('.pv-page >> nth=0', { position: { x: 150, y: 200 } });
    await expect(page.locator('.v2-text-edit')).toBeVisible();
    await page.keyboard.type('Halo dari HP');
    await page.keyboard.press('Enter');

    const annos = await page.evaluate(() => window.v2.getDoc().pages[0].annotations);
    expect(annos).toHaveLength(1);
    expect(annos[0].type).toBe('text');
    expect(annos[0].text).toBe('Halo dari HP');
    // Tool returned home to Pilih (tools are verbs).
    expect(await page.evaluate(() => window.v2.getTool())).toBe('select');
    await expect(page.locator('.pv-anno-text')).toHaveText('Halo dari HP');
  });

  test('undo/redo round-trips an edit and updates button state', async ({ page }) => {
    await openWithFixture(page);
    await page.tap('[data-tool="text"]');
    await page.tap('.pv-page >> nth=0', { position: { x: 100, y: 150 } });
    await page.keyboard.type('sekali');
    await page.keyboard.press('Enter');
    await expect(page.locator('#btn-undo')).toBeEnabled();

    await page.tap('#btn-undo');
    expect(await page.evaluate(() => window.v2.getDoc().pages[0].annotations.length)).toBe(0);
    await expect(page.locator('#btn-redo')).toBeEnabled();

    await page.tap('#btn-redo');
    expect(await page.evaluate(() => window.v2.getDoc().pages[0].annotations.length)).toBe(1);
  });

  test('drag moves an annotation and clamps inside the page', async ({ page }) => {
    await openWithFixture(page);
    // Place a text annotation programmatically (drag is what we're testing).
    await page.evaluate(() => {
      const doc = window.v2.getDoc();
      return import('/js/core/model.js').then((m) =>
        import('/js/core/operations.js').then((o) => {
          o.addAnnotation(doc, doc.pages[0].id, m.createAnnotation('text', {
            text: 'geser aku', x: 100, y: 100, fontSize: 20,
          }));
          window.v2.setTool('select');
          window.dispatchEvent(new Event('resize'));
        }));
    });
    await page.reloadStageForTest?.();
    await page.evaluate(() => {
      // Re-sync the stage after the direct model poke.
      const doc = window.v2.getDoc();
      const slot = window.v2.getSlots()[0];
      return import('/js/render/page-view.js').then((pv) => pv.syncOverlay(doc.pages[0], slot.view, {}));
    });

    const anno = page.locator('.pv-anno-text');
    await expect(anno).toBeVisible();
    const before = await page.evaluate(() => {
      const a = window.v2.getDoc().pages[0].annotations[0];
      return { x: a.x, y: a.y };
    });

    // Camera-first touch model: tap SELECTS (commits at release)…
    await page.tap('.pv-anno-text');
    expect(await page.evaluate(() => window.v2.getDoc().selection.annotationId)).toBeTruthy();

    // …then a drag on the SELECTED object moves it.
    const box = await anno.boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await anno.dispatchEvent('pointerdown', { pointerId: 1, clientX: cx, clientY: cy, bubbles: true, isPrimary: true });
    await page.locator('#v2-stage').dispatchEvent('pointermove', { pointerId: 1, clientX: cx + 60, clientY: cy + 40, bubbles: true });
    await page.locator('#v2-stage').dispatchEvent('pointerup', { pointerId: 1, clientX: cx + 60, clientY: cy + 40, bubbles: true });

    const after = await page.evaluate(() => {
      const a = window.v2.getDoc().pages[0].annotations[0];
      return { x: a.x, y: a.y };
    });
    expect(after.x).toBeGreaterThan(before.x);
    expect(after.y).toBeGreaterThan(before.y);
  });

  test('merge: adding a second PDF appends its pages', async ({ page }) => {
    await openWithFixture(page);
    await page.setInputFiles('#file-input', FIXTURE);
    await expect(page.locator('.pv-page')).toHaveCount(4);
    const sources = await page.evaluate(() => window.v2.getDoc().sources.length);
    expect(sources).toBe(2);
  });

  test('adding an image appends it as one page (isFromImage)', async ({ page }) => {
    await openWithFixture(page);
    // 1×1 red PNG — the smallest possible image-as-page.
    const redPixel = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    await page.setInputFiles('#file-input', { name: 'foto.png', mimeType: 'image/png', buffer: redPixel });
    await expect(page.locator('.pv-page')).toHaveCount(3);
    const last = await page.evaluate(() => {
      const p = window.v2.getDoc().pages.at(-1);
      return { isFromImage: p.isFromImage, w: p.width, h: p.height };
    });
    expect(last.isFromImage).toBe(true);
    expect(last.w).toBe(1);
    expect(last.h).toBe(1);
  });
});
