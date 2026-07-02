/*
 * Signature flow (v2) on a phone — sign = ~19% of in-editor actions.
 * Covers: draw→place→selected, paraf sizing, "Semua Hal." fan-out, upload tab
 * with white-background removal.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'sample-2pages.pdf');

// 1×1 red pixel PNG — enough for the upload pipeline (opaque → survives trim).
const RED_PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function openDoc(page) {
  await page.goto('/editor-v2.html');
  await page.setInputFiles('#file-input', FIXTURE);
  await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();
}

async function drawStroke(page) {
  const box = await page.locator('#sig-canvas').boundingBox();
  await page.mouse.move(box.x + 40, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 90, { steps: 6 });
  await page.mouse.move(box.x + 200, box.y + 50, { steps: 6 });
  await page.mouse.up();
}

test.describe('signature — mobile', () => {
  test('draw → place: annotation lands selected, Semua Hal. offered', async ({ page }) => {
    await openDoc(page);
    await page.tap('[data-tool="signature"]');
    await expect(page.locator('#sig-modal')).toBeVisible();
    await drawStroke(page);
    await page.tap('#sig-use');
    await page.tap('.pv-page >> nth=0', { position: { x: 150, y: 250 } });

    const anno = await page.evaluate(() => window.v2.getDoc().pages[0].annotations[0]);
    expect(anno.type).toBe('signature');
    expect(anno.width).toBe(150);
    expect(anno.image).toMatch(/^data:image\/png/);
    // Placed → selected → the fan-out action is one tap away.
    expect(await page.evaluate(() => window.v2.getDoc().selection.annotationId)).toBe(anno.id);
    await expect(page.locator('#sig-bar')).toBeVisible();
  });

  test('Semua Hal. copies to every other page with independent ids', async ({ page }) => {
    await openDoc(page);
    await page.tap('[data-tool="signature"]');
    await drawStroke(page);
    await page.tap('#sig-use');
    await page.tap('.pv-page >> nth=0', { position: { x: 150, y: 250 } });
    await page.tap('#btn-all-pages');

    const info = await page.evaluate(() => {
      const d = window.v2.getDoc();
      return {
        p1: d.pages[0].annotations.map((a) => a.id),
        p2: d.pages[1].annotations.map((a) => a.id),
        pos: [d.pages[0].annotations[0], d.pages[1].annotations[0]].map((a) => [a.x, a.y]),
      };
    });
    expect(info.p1).toHaveLength(1);
    expect(info.p2).toHaveLength(1);
    expect(info.p2[0]).not.toBe(info.p1[0]);        // own object, own id
    expect(info.pos[1]).toEqual(info.pos[0]);        // same position
    // One undo removes the fan-out.
    await page.tap('#btn-undo');
    expect(await page.evaluate(() => window.v2.getDoc().pages[1].annotations.length)).toBe(0);
  });

  test('paraf mode places small (80px) with subtype', async ({ page }) => {
    await openDoc(page);
    await page.tap('[data-tool="signature"]');
    await drawStroke(page);
    await page.tap('#sig-paraf');
    await page.tap('#sig-use');
    await page.tap('.pv-page >> nth=0', { position: { x: 120, y: 300 } });

    const anno = await page.evaluate(() => window.v2.getDoc().pages[0].annotations[0]);
    expect(anno.subtype).toBe('paraf');
    expect(anno.width).toBe(80);
    await expect(page.locator('#sig-bar-label')).toHaveText('Paraf terpilih');
  });

  test('upload tab: image file flows through bg-removal to placement', async ({ page }) => {
    await openDoc(page);
    await page.tap('[data-tool="signature"]');
    await page.tap('.sig-tab[data-tab="upload"]');
    await page.setInputFiles('#sig-file', { name: 'ttd.png', mimeType: 'image/png', buffer: RED_PIXEL });
    await expect(page.locator('#sig-preview canvas')).toBeVisible();
    await page.tap('#sig-use');
    await page.tap('.pv-page >> nth=0', { position: { x: 180, y: 220 } });

    const anno = await page.evaluate(() => window.v2.getDoc().pages[0].annotations[0]);
    expect(anno.type).toBe('signature');
    expect(anno.image).toMatch(/^data:image\/png/);
  });
});
