/*
 * Founder's launch punch list (Jul 3 phone pass) — the repro specs.
 * #1: ttd → hapus → ttd again must offer Gambar Ulang, never trap the user
 *     with the old signature.
 * #3: tapping the wordmark goes home (with a guard when a doc is open).
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

async function drawStroke(page) {
  const box = await page.locator('#sig-canvas').boundingBox();
  await page.mouse.move(box.x + 40, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 90, { steps: 6 });
  await page.mouse.move(box.x + 200, box.y + 50, { steps: 6 });
  await page.mouse.up();
}

test.describe('punch list rd2 — mobile', () => {
  test('ttd → hapus → ttd again: Gambar Ulang is offered on the bar', async ({ page }) => {
    await openDoc(page);
    // Draw and place a signature.
    await page.tap('[data-tool="signature"]');
    await expect(page.locator('#sig-modal')).toBeVisible();
    await drawStroke(page);
    await page.tap('#sig-use');
    await page.tap('.pv-page >> nth=0', { position: { x: 150, y: 250 } });
    expect(await page.evaluate(() => window.v2.getDoc().pages[0].annotations.length)).toBe(1);

    // Drew it wrong → Hapus it (selected → delete now).
    await page.tap('#btn-delete-anno');
    expect(await page.evaluate(() => window.v2.getDoc().pages[0].annotations.length)).toBe(0);

    // Tap TTD again: the bar must be up with Gambar Ulang visible — the saved
    // signature must never be a trap.
    await page.tap('[data-tool="signature"]');
    await expect(page.locator('#sig-bar')).toBeVisible();
    await expect(page.locator('#btn-redraw-sig')).toBeVisible();

    // Gambar Ulang reopens the modal.
    await page.tap('#btn-redraw-sig');
    await expect(page.locator('#sig-modal')).toBeVisible();
  });

  test('delete via delete-MODE (nothing selected first), then ttd again: same guarantee', async ({ page }) => {
    await openDoc(page);
    await page.tap('[data-tool="signature"]');
    await drawStroke(page);
    await page.tap('#sig-use');
    await page.tap('.pv-page >> nth=0', { position: { x: 150, y: 250 } });
    // Deselect by choosing Pilih, then arm delete-mode and tap the signature.
    await page.tap('[data-tool="select"]');
    await page.evaluate(() => { window.v2.getDoc().selection.annotationId = null; });
    await page.tap('#btn-delete-anno');
    await page.tap('.pv-page >> nth=0', { position: { x: 150, y: 250 } });
    expect(await page.evaluate(() => window.v2.getDoc().pages[0].annotations.length)).toBe(0);

    await page.tap('[data-tool="signature"]');
    await expect(page.locator('#sig-bar')).toBeVisible();
    await expect(page.locator('#btn-redraw-sig')).toBeVisible();
  });

  test('wordmark tap goes home: guarded when a doc is open', async ({ page }) => {
    await page.goto('/');
    // On the landing the editor header is hidden — the landing IS home.
    await expect(page.locator('header .brand')).toBeHidden();

    await page.setInputFiles('#file-input', FIXTURE);
    await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();
    await page.tap('header .brand');
    await expect(page.locator('#home-confirm')).toBeVisible();
    // Batal keeps the doc.
    await page.tap('#hc-cancel');
    await expect(page.locator('#home-confirm')).toBeHidden();
    await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();
    // Ke Beranda leaves for the landing.
    await page.tap('header .brand');
    await page.tap('#hc-go');
    await expect(page.locator('.ld h1')).toBeVisible();
  });
});
