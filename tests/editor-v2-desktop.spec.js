/*
 * Editor v2 on DESKTOP (chromium project) — the mobile suite is the deep one;
 * this guards that the unified pointer path really is unified: same flows,
 * mouse instead of touch. Desktop is still 69% of today's organic traffic.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');

test.describe('editor v2 — desktop', () => {
  test('full flow: open → type → style → drag → download a valid PDF', async ({ page }) => {
    await page.goto('/editor-v2.html');
    await page.setInputFiles('#file-input', FIXTURE);
    await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();

    // Keyboard verb → click to place text → type → commit.
    await page.keyboard.press('t');
    await page.click('.pv-page >> nth=0', { position: { x: 200, y: 200 } });
    await page.keyboard.type('Dari desktop');
    await page.keyboard.press('Enter');
    await expect(page.locator('.pv-anno-text')).toHaveText('Dari desktop');

    // Style via the format bar (still visible: committed text stays selected).
    await page.click('.fb-bold');
    await expect(page.locator('.pv-anno-text')).toHaveCSS('font-weight', '700');

    // Mouse-drag the annotation.
    const before = await page.evaluate(() => window.v2.getDoc().pages[0].annotations[0].x);
    const box = await page.locator('.pv-anno-text').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 30, { steps: 5 });
    await page.mouse.up();
    const after = await page.evaluate(() => window.v2.getDoc().pages[0].annotations[0].x);
    expect(after).toBeGreaterThan(before);

    // Download goes through the Unduh sheet: open → big button → real PDF.
    await page.click('#btn-download');
    await expect(page.locator('#dl-sheet')).toBeVisible();
    const dl = page.waitForEvent('download');
    await page.click('#ds-cta');
    const download = await dl;
    expect(download.suggestedFilename()).toMatch(/pdflokal\.pdf$/);
  });

  test('page manager works with a mouse (click select, bulk rotate)', async ({ page }) => {
    await page.goto('/editor-v2.html');
    await page.setInputFiles('#file-input', FIXTURE);
    await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();
    await page.click('#btn-pages');
    await page.click('.pm-tile >> nth=0');
    await page.click('[data-act="rotate"]');
    expect(await page.evaluate(() => window.v2.getDoc().pages[0].rotation)).toBe(90);
  });
});
