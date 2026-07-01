/*
 * PDFLokal — contextual text format bar.
 *
 * Backlog (Jun 10): after PR #54 rerouted the Text tool to inline-on-first-click,
 * the font-family / bold / italic controls (which lived in the now-orphaned
 * text-input-modal) became unreachable. This suite verifies the replacement:
 * a Word/Figma/Canva-style floating bar that applies formatting live and works
 * both while typing and when a text annotation is later selected.
 */
import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_PDF = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');

async function loadSample(page) {
  await page.goto('/');
  await page.setInputFiles('#file-input', SAMPLE_PDF);
  await page.waitForFunction(() => document.body.classList.contains('editor-active'));
  await page.waitForFunction(() => window.ueState?.pages?.length === 2);
  await page.waitForFunction(() => window.ueState?.eventsSetup === true);
}

// Text tool → click canvas → inline editor + format bar open. Types text.
async function createTextAndOpenBar(page, text, cx = 90, cy = 90) {
  await page.evaluate(() => window.ueSetTool('text'));
  await page.waitForFunction(() => window.ueState?.currentTool === 'text');
  await page.evaluate(({ x, y }) => {
    const canvas = document.querySelectorAll('.ue-page-slot canvas')[0];
    const rect = canvas.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, clientX: rect.left + x, clientY: rect.top + y, button: 0 };
    canvas.dispatchEvent(new MouseEvent('mousedown', opts));
    canvas.dispatchEvent(new MouseEvent('mouseup', opts));
  }, { x: cx, y: cy });
  await page.waitForSelector('#inline-text-editor');
  await page.waitForSelector('#text-format-bar:not([hidden])');
  await page.locator('#inline-text-editor').focus();
  await page.keyboard.type(text);
}

const anno0 = (page) => page.evaluate(() => window.ueState.annotations[0]?.[0]);

test.describe('text format bar', () => {
  test('appears while editing and applies font / bold / italic / size / color live', async ({ page }) => {
    await loadSample(page);
    await createTextAndOpenBar(page, 'Halo');

    // Font family
    await page.selectOption('#tfb-font', 'Courier');
    expect(await page.evaluate(() => window.ueState.annotations[0][0].fontFamily)).toBe('Courier');

    // Bold + italic toggles (buttons keep editor focus via mousedown preventDefault)
    await page.click('#tfb-bold');
    await page.click('#tfb-italic');
    let a = await anno0(page);
    expect(a.bold).toBe(true);
    expect(a.italic).toBe(true);
    await expect(page.locator('#tfb-bold')).toHaveClass(/active/);

    // Size via number input
    await page.fill('#tfb-size', '30');
    await page.dispatchEvent('#tfb-size', 'change');
    expect(await page.evaluate(() => window.ueState.annotations[0][0].fontSize)).toBe(30);

    // Color via input event
    await page.evaluate(() => {
      const c = document.getElementById('tfb-color');
      c.value = '#2563eb';
      c.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect((await anno0(page)).color.toLowerCase()).toBe('#2563eb');

    // Commit and confirm formatting survived + persisted for the next annotation
    await page.locator('#inline-text-editor').focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('#inline-text-editor', { state: 'detached' });
    a = await anno0(page);
    expect(a).toMatchObject({ text: 'Halo', fontFamily: 'Courier', bold: true, italic: true, fontSize: 30 });
    const last = await page.evaluate(() => window.ueState.lastTextOptions);
    expect(last).toMatchObject({ fontFamily: 'Courier', bold: true, italic: true, fontSize: 30 });

    // Bar hidden after commit
    await expect(page.locator('#text-format-bar')).toBeHidden();
  });

  // Regression: creating a new text via the Text tool, then clicking elsewhere to
  // finish, used to place a SECOND (empty) text box — the tool stayed 'text' and
  // the click's mouseup created another annotation. The click that ends an edit
  // must commit-and-consume, then revert to Pilih.
  test('click-away after creating text commits and does NOT create a second box', async ({ page }) => {
    await loadSample(page);
    await createTextAndOpenBar(page, 'test', 90, 90);

    // Click an empty area far from the new text.
    await page.evaluate(() => {
      const canvas = document.querySelectorAll('.ue-page-slot canvas')[0];
      const rect = canvas.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, clientX: rect.left + rect.width * 0.7, clientY: rect.top + rect.height * 0.7, button: 0 };
      canvas.dispatchEvent(new MouseEvent('mousedown', opts));
      canvas.dispatchEvent(new MouseEvent('mouseup', opts));
    });

    await page.waitForSelector('#inline-text-editor', { state: 'detached' });
    expect(await page.evaluate(() => window.ueState.currentTool)).toBe('select');
    expect(await page.evaluate(() => window.ueState.annotations[0].length)).toBe(1);
    expect(await page.evaluate(() => window.ueState.annotations[0][0].text)).toBe('test');
    await expect(page.locator('#text-format-bar')).toBeHidden();
  });

  test('restyles an already-selected text annotation (select tool)', async ({ page }) => {
    await loadSample(page);
    await createTextAndOpenBar(page, 'Dunia');
    await page.locator('#inline-text-editor').focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('#inline-text-editor', { state: 'detached' });

    // WHY deselect first: a freshly-created annotation stays selected
    // (canvas-events.js sets selectedAnnotation on inline create), so a click
    // near its edge would hit a resize handle instead of re-selecting. Click
    // empty space to clear selection, then click the annotation's interior.
    await page.evaluate(() => window.ueSetTool('select'));
    await page.evaluate(() => {
      const canvas = document.querySelectorAll('.ue-page-slot canvas')[0];
      const rect = canvas.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, clientX: rect.right - 12, clientY: rect.bottom - 12, button: 0 };
      canvas.dispatchEvent(new MouseEvent('mousedown', opts));
      canvas.dispatchEvent(new MouseEvent('mouseup', opts));
    });
    await expect(page.locator('#text-format-bar')).toBeHidden(); // deselected

    // Now click the annotation interior (x past the left edge, y mid-height).
    await page.evaluate(() => {
      const a = window.ueState.annotations[0][0];
      const canvas = document.querySelectorAll('.ue-page-slot canvas')[0];
      const rect = canvas.getBoundingClientRect();
      const scale = rect.width / (canvas.width / window.ueState.devicePixelRatio);
      const sx = rect.left + (a.x + 8) * scale;
      const sy = rect.top + (a.y - a.fontSize / 2) * scale;
      const opts = { bubbles: true, cancelable: true, clientX: sx, clientY: sy, button: 0 };
      canvas.dispatchEvent(new MouseEvent('mousedown', opts));
      canvas.dispatchEvent(new MouseEvent('mouseup', opts));
    });

    expect(await page.evaluate(() => window.ueState.selectedAnnotation)).not.toBeNull();
    await expect(page.locator('#text-format-bar')).toBeVisible();
    await page.click('#tfb-bold');
    expect((await anno0(page)).bold).toBe(true);

    // Deselect (switch tool) hides the bar.
    await page.evaluate(() => window.ueSetTool('whiteout'));
    await expect(page.locator('#text-format-bar')).toBeHidden();
  });
});
