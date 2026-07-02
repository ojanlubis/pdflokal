/*
 * PDFLokal — Wave 0 keyboard behaviors:
 *  - Arrow keys nudge a selected annotation (Shift = 10px); page-nav preserved
 *    when nothing is selected.
 *  - Ctrl+Z inside the signature/paraf modal rewinds the pen stroke instead of
 *    firing the global editor undo.
 */
import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_PDF = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');

async function loadSample(page) {
  await page.goto('/alat-gambar.html');
  await page.setInputFiles('#file-input', SAMPLE_PDF);
  await page.waitForFunction(() => window.ueState?.pages?.length === 2);
  await page.waitForFunction(() => window.ueState?.eventsSetup === true);
}

// Seed a selected whiteout annotation on page 0 at a known position.
async function seedSelectedAnno(page, x = 100, y = 100) {
  await page.evaluate(({ ax, ay }) => {
    const i = window.ueAddAnnotation(0, { type: 'whiteout', x: ax, y: ay, width: 50, height: 30 });
    window.ueState.selectedAnnotation = { pageIndex: 0, index: i };
  }, { ax: x, ay: y });
}

const pos = (page) => page.evaluate(() => {
  const a = window.ueState.annotations[0][0];
  return { x: a.x, y: a.y };
});

test.describe('arrow-key nudge', () => {
  test('arrows move a selected annotation; Shift = 10px', async ({ page }) => {
    await loadSample(page);
    await seedSelectedAnno(page, 100, 100);

    await page.keyboard.press('ArrowRight');
    expect(await pos(page)).toEqual({ x: 101, y: 100 });

    await page.keyboard.press('ArrowDown');
    expect(await pos(page)).toEqual({ x: 101, y: 101 });

    await page.keyboard.press('Shift+ArrowLeft');
    expect(await pos(page)).toEqual({ x: 91, y: 101 });

    await page.keyboard.press('Shift+ArrowUp');
    expect(await pos(page)).toEqual({ x: 91, y: 91 });
  });

  test('a burst of nudges collapses into ONE undo entry', async ({ page }) => {
    await loadSample(page);
    await seedSelectedAnno(page, 100, 100);
    const undoBefore = await page.evaluate(() => window.ueState.undoStack?.length ?? 0);

    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
    expect((await pos(page)).x).toBe(105);

    const undoAfter = await page.evaluate(() => window.ueState.undoStack?.length ?? 0);
    expect(undoAfter - undoBefore).toBe(1); // one snapshot for the whole burst
  });

  test('arrows still page-navigate when nothing is selected', async ({ page }) => {
    await loadSample(page);
    await page.evaluate(() => { window.ueState.selectedAnnotation = null; window.ueSelectPage(0); });
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => window.ueState.selectedPage === 1);
    expect(await page.evaluate(() => window.ueState.selectedPage)).toBe(1);
  });
});

test.describe('Ctrl+Z inside the signature modal', () => {
  test('rewinds the pen stroke and does NOT fire the global undo', async ({ page }) => {
    await loadSample(page);
    // Something on the document that the global undo COULD roll back.
    await seedSelectedAnno(page, 200, 200);
    await page.evaluate(() => { window.ueState.selectedAnnotation = null; });

    // Spy on the global undo.
    await page.evaluate(() => {
      window.__undoCalls = 0;
      const orig = window.ueUndo;
      window.ueUndo = () => { window.__undoCalls++; return orig && orig(); };
    });

    await page.evaluate(() => window.ueOpenSignatureModal());
    await page.waitForSelector('#signature-modal.active');

    // Draw two strokes on the signature pad.
    await page.evaluate(() => {
      const c = document.getElementById('signature-canvas');
      const r = c.getBoundingClientRect();
      const stroke = (x1, y1, x2, y2) => {
        c.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: r.left + x1, clientY: r.top + y1, pointerId: 1 }));
        c.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: r.left + x2, clientY: r.top + y2, pointerId: 1 }));
        c.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: r.left + x2, clientY: r.top + y2, pointerId: 1 }));
      };
      stroke(10, 10, 40, 40);
      stroke(50, 50, 80, 80);
    });
    expect(await page.evaluate(() => window.state.signaturePad.toData().length)).toBe(2);

    await page.keyboard.press('Control+z');

    expect(await page.evaluate(() => window.state.signaturePad.toData().length)).toBe(1); // one stroke rewound
    expect(await page.evaluate(() => window.__undoCalls)).toBe(0); // global undo NOT fired
    expect(await page.evaluate(() => window.ueState.annotations[0].length)).toBe(1); // doc annotation untouched
  });
});
