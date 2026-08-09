/*
 * TIP-EX IS A GROUND, NOT A LAYER — the screen half.
 * ============================================================================
 * Founder ruling 2026-08-09: "it should be default that the layer order on the
 * canvas is tipex at the bottom and teks at top. by definition. we're not
 * photoshop. we're pdflokal."
 *
 * tests/core/annotation-order.test.mjs pins the FILE (which operator the
 * exported content stream paints first, red-on-revert). This pins the SCREEN,
 * which that suite structurally cannot reach — js/render/page-view.js needs a
 * DOM. The two meet at one named contract, core/annotation-order.js's
 * `orderedForPaint`: the core suite asserts the export follows it, and the
 * test below asserts the overlay's own DOM order IS it. Neither painter has
 * its own idea of order any more, which is the whole point of the module.
 *
 * THE DEFECT THAT MOTIVATED THE SCREEN HALF is not the ruling at all — it is
 * that page-view.js gave the SELECTED annotation z-index 1000 outright and
 * export had no such notion. So a Tip-Ex you were holding looked like it was
 * above your text and dropped behind the instant you let go. The screen lied
 * during editing, and the file was the honest one.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_PDF = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');

// The overlay's children, in DOM order, with the z-index each was given. DOM
// order IS paint order for equal z-index, so both are needed to describe what
// the user actually sees.
const overlayStack = (page) => page.evaluate(() => {
  const doc = window.v2.getDoc();
  const byId = new Map(doc.pages[0].annotations.map((a) => [a.id, a.type]));
  return [...document.querySelectorAll('.pv-page .pv-overlay > .pv-anno')].map((el) => ({
    type: byId.get(el.dataset.annoId),
    z: Number(el.style.zIndex),
    selected: doc.selection.annotationId === el.dataset.annoId,
  }));
});

async function drawWhiteout(page, { x0 = 60, y0 = 150, x1 = 260, y1 = 210 } = {}) {
  await page.click('[data-tool="whiteout"]');
  const box = await page.locator('.pv-page').first().boundingBox();
  await page.mouse.move(box.x + x0, box.y + y0);
  await page.mouse.down();
  await page.mouse.move(box.x + x1, box.y + y1, { steps: 8 });
  await page.mouse.up();
}

async function placeText(page, text, at = { x: 120, y: 180 }) {
  await page.click('[data-tool="text"]');
  await page.click('.pv-page >> nth=0', { position: at });
  await page.keyboard.insertText(text);
  await page.keyboard.press('Enter');
}

// Select by TAPPING the thing, the way a user does — a freshly drawn Tip-Ex is
// not auto-selected, and poking doc.selection directly would skip the very
// code path (interaction.js's setSelected) that used to write z-index 1000.
async function selectAt(page, x, y) {
  await page.evaluate(() => { window.v2.setTool('select'); });
  await page.click('.pv-page >> nth=0', { position: { x, y } });
  await expect.poll(async () => page.evaluate(
    () => !!window.v2.getDoc().selection.annotationId,
  )).toBe(true);
}

test.describe('annotation layering', () => {
  test('THE SHARP CASE: a Tip-Ex drawn OVER existing text still sits under it', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('#file-input', SAMPLE_PDF);
    await expectFirstPage(page);

    // Text FIRST, then the Tip-Ex dragged over it. In creation order — what
    // both painters used before the ruling — the Tip-Ex wins and the text
    // vanishes under a white box.
    await placeText(page, 'HARUS TERLIHAT');
    await drawWhiteout(page);

    const stack = await overlayStack(page);
    expect(stack.map((s) => s.type)).toEqual(['whiteout', 'text']);
    // ...and z-index agrees with DOM order, so nothing can lift the ground
    // back over the text by winning on the other axis.
    expect(stack[0].z).toBeLessThan(stack[1].z);
  });

  test('A HELD Tip-Ex does not float above text, and does not jump when released', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('#file-input', SAMPLE_PDF);
    await expectFirstPage(page);
    // Text well clear of the Tip-Ex, so the tap below can only land on one.
    await placeText(page, 'HARUS TERLIHAT', { x: 120, y: 70 });
    await drawWhiteout(page);
    await selectAt(page, 160, 180);

    // Holding the Tip-Ex — the exact state where the old z-index 1000 made it
    // appear on top of the text it belongs under.
    const held = await overlayStack(page);
    const whileSelected = held.find((s) => s.type === 'whiteout');
    expect(whileSelected.selected, 'the tap should have selected the Tip-Ex').toBe(true);
    expect(
      whileSelected.z,
      'a SELECTED Tip-Ex is above text — this is the screen lying during an edit',
    ).toBeLessThan(held.find((s) => s.type === 'text').z);

    // Deselect. Nothing may visibly move: the stack the user was looking at
    // while holding it is the stack they get when they let go.
    await page.click('.pv-page >> nth=0', { position: { x: 20, y: 400 } });
    const released = await overlayStack(page);
    expect(released.map((s) => s.type)).toEqual(held.map((s) => s.type));
  });

  test('a buried Tip-Ex still lifts above its OWN neighbours when held — it stays grabbable', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('#file-input', SAMPLE_PDF);
    await expectFirstPage(page);

    await drawWhiteout(page);
    // A second Tip-Ex, clear of the first, so there is a neighbour in the same
    // band to lift above and the tap is unambiguous about which one it hits.
    await drawWhiteout(page, { x0: 60, y0: 250, x1: 260, y1: 310 });
    await selectAt(page, 160, 280);

    const stack = await overlayStack(page);
    expect(stack.length).toBe(2);
    const selected = stack.find((s) => s.selected);
    const other = stack.find((s) => !s.selected);
    expect(selected, 'the tap should have selected the second Tip-Ex').toBeTruthy();
    expect(selected.z).toBeGreaterThan(other.z);
  });

  test('the overlay order IS core/annotation-order.js — one contract, both painters', async ({ page }) => {
    // The join between this file and tests/core/annotation-order.test.mjs.
    // That suite proves the EXPORT walks orderedForPaint (by reading the
    // operators it emitted); this proves the SCREEN does. Asserting each side
    // against the shared function is what makes "render order and export order
    // agree" a property of the code rather than a coincidence of two tests.
    await page.goto('/');
    await page.setInputFiles('#file-input', SAMPLE_PDF);
    await expectFirstPage(page);
    await placeText(page, 'SATU');
    await drawWhiteout(page);
    await placeText(page, 'DUA');

    const agree = await page.evaluate(async () => {
      const { orderedForPaint } = await import('/js/core/annotation-order.js');
      const annos = window.v2.getDoc().pages[0].annotations;
      const expected = orderedForPaint(annos).map((a) => a.id);
      const onScreen = [...document.querySelectorAll('.pv-page .pv-overlay > .pv-anno')]
        .map((el) => el.dataset.annoId);
      return { expected, onScreen, model: annos.map((a) => a.id) };
    });
    expect(agree.onScreen).toEqual(agree.expected);
    // Three annotations, and the model is STILL in creation order — the render
    // sorted a copy. core/page-surgery.js pairs Ganti covers to their
    // replacement text out of this very array.
    expect(agree.model.length).toBe(3);
    expect(agree.model).not.toEqual(agree.expected);
  });
});
