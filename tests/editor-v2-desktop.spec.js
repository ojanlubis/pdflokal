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
    await page.goto('/');
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
    await page.goto('/');
    await page.setInputFiles('#file-input', FIXTURE);
    await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();
    await page.click('#btn-pages');
    await page.click('.pm-tile >> nth=0');
    await page.click('[data-act="rotate"]');
    expect(await page.evaluate(() => window.v2.getDoc().pages[0].rotation)).toBe(90);
  });
});

// Founder desktop punch list (Jul 3): the Figma/PowerPoint model — first
// click SELECTS (drag-enabled), the NEXT click (or a double-click from
// unselected) enters text editing. Single click must never jump to editing.
test.describe('select-then-edit model — desktop', () => {
  async function placeText(page) {
    await page.goto('/');
    await page.setInputFiles('#file-input', FIXTURE);
    await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();
    await page.keyboard.press('t');
    await page.click('.pv-page >> nth=0', { position: { x: 200, y: 200 } });
    await page.keyboard.type('Klik aku');
    await page.keyboard.press('Enter');
    await expect(page.locator('.pv-anno-text')).toHaveText('Klik aku');
    // Deselect: click empty page area far from the text.
    await page.click('.pv-page >> nth=0', { position: { x: 60, y: 480 } });
    await page.waitForTimeout(50);
    expect(await page.evaluate(() => window.v2.getDoc().selection.annotationId)).toBeNull();
  }

  test('single click on unselected text SELECTS, never edits', async ({ page }) => {
    await placeText(page);
    await page.locator('.pv-anno-text').click();
    await page.waitForTimeout(120);
    expect(await page.evaluate(() => window.v2.getDoc().selection.annotationId)).not.toBeNull();
    await expect(page.locator('.v2-text-edit')).toHaveCount(0); // no inline editor
  });

  test('click on the ALREADY-selected text enters editing', async ({ page }) => {
    await placeText(page);
    await page.locator('.pv-anno-text').click();       // select
    await page.waitForTimeout(400);                    // well past any double-click window
    await page.locator('.pv-anno-text').click();       // second click → edit
    await expect(page.locator('.v2-text-edit')).toHaveCount(1);
  });

  test('drag of a selected text moves it without entering editing', async ({ page }) => {
    await placeText(page);
    await page.locator('.pv-anno-text').click();       // select
    const before = await page.evaluate(() => window.v2.getDoc().pages[0].annotations[0].x);
    const box = await page.locator('.pv-anno-text').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    const after = await page.evaluate(() => window.v2.getDoc().pages[0].annotations[0].x);
    expect(after).toBeGreaterThan(before);
    await expect(page.locator('.v2-text-edit')).toHaveCount(0);
  });

  test('custom color input applies any color to the selected text', async ({ page }) => {
    await placeText(page);
    await page.locator('.pv-anno-text').click(); // select → format bar shows
    await expect(page.locator('#format-bar')).toBeVisible();
    await page.locator('.fb-color-custom').fill('#8b5cf6');
    await expect(page.locator('.pv-anno-text')).toHaveCSS('color', 'rgb(139, 92, 246)');
  });
});

// Founder-caught (Jul 4, desktop): if pointer capture fails mid-drag, the
// lifted tile (pointerEvents:none) never hears pointerup — the ghost hung in
// the air with its placeholder until later reorders. Window-level listeners
// now own the drag lifetime; this test forces the capture failure.
test('Kelola drag settles even when pointer capture fails', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();
  await page.click('#btn-pages');
  await expect(page.locator('#pm-sheet')).toBeVisible();
  await page.evaluate(() => {
    Element.prototype.setPointerCapture = () => { throw new Error('capture denied'); };
  });

  const tile = await page.locator('.pm-tile:not(.pm-add)').first().elementHandle();
  const box = await tile.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // Past DRAG_SLOP arms the mouse drag, then wander and release elsewhere.
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + 20, { steps: 4 });
  await page.mouse.move(box.x + box.width + 120, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();

  await page.waitForTimeout(500); // glide + settle window
  await expect(page.locator('.pm-drag-ghost')).toHaveCount(0);
  await expect(page.locator('.pm-placeholder')).toHaveCount(0);
});
