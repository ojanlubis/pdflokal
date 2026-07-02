/*
 * Page manager sheet (v2) on a phone — assemble is ~36% of in-editor actions.
 * Covers: open/select/bulk-rotate/bulk-delete/undo, extract download, and the
 * pointer-based reorder (the old HTML5-DnD version never worked on touch).
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'sample-2pages.pdf');

async function openSheet(page) {
  await page.goto('/editor-v2.html');
  await page.setInputFiles('#file-input', FIXTURE);
  await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();
  await page.tap('#btn-pages');
  await expect(page.locator('#pm-sheet')).toBeVisible();
  await expect(page.locator('.pm-tile:not(.pm-add)')).toHaveCount(2);
}

test.describe('page manager — mobile', () => {
  test('opens with a tile per page + an add tile; thumbnails stream in', async ({ page }) => {
    await openSheet(page);
    await expect(page.locator('.pm-add')).toHaveCount(1);
    // Thumbs render async; wait for the first background-image.
    await expect(page.locator('.pm-thumb').first()).toHaveAttribute('style', /background-image/, { timeout: 10000 });
  });

  test('tap selects; bulk rotate goes through core + invalidates rasters', async ({ page }) => {
    await openSheet(page);
    await page.tap('.pm-tile >> nth=0');
    await expect(page.locator('#pm-bulk')).toBeVisible();
    await expect(page.locator('.pm-count')).toHaveText('1 dipilih');

    await page.tap('[data-act="rotate"]');
    const rot = await page.evaluate(() => window.v2.getDoc().pages[0].rotation);
    expect(rot).toBe(90);
    // Main stage rebuilt with swapped dims (rotated frame).
    const dims = await page.evaluate(() => {
      const pg = window.v2.getDoc().pages[0];
      const view = document.querySelector(`[data-page-id="${pg.id}"]`);
      return { css: view.style.width, pageH: pg.height + 'px' };
    });
    expect(dims.css).toBe(dims.pageH);
  });

  test('bulk delete removes pages; deleting ALL pages is blocked; undo restores', async ({ page }) => {
    await openSheet(page);
    // Select both → delete disabled (empty doc is a dead end).
    await page.tap('.pm-tile >> nth=0');
    await page.tap('.pm-tile >> nth=1');
    await expect(page.locator('[data-act="delete"]')).toBeDisabled();

    // Deselect one → delete the other.
    await page.tap('.pm-tile >> nth=1');
    await page.tap('[data-act="delete"]');
    expect(await page.evaluate(() => window.v2.getDoc().pages.length)).toBe(1);
    await expect(page.locator('.pm-tile:not(.pm-add)')).toHaveCount(1);

    // Undo (sheet stays usable; model restored).
    await page.tap('#pm-close');
    await page.tap('#btn-undo');
    expect(await page.evaluate(() => window.v2.getDoc().pages.length)).toBe(2);
  });

  test('pointer drag reorders pages (annotations travel, zero re-keying)', async ({ page }) => {
    await openSheet(page);
    // Pin an annotation to page 1 so we can prove it travels.
    const p1id = await page.evaluate(() => {
      const doc = window.v2.getDoc();
      return import('/js/core/model.js').then((m) =>
        import('/js/core/operations.js').then((o) => {
          o.addAnnotation(doc, doc.pages[0].id, m.createAnnotation('text', { text: 'aku ikut', x: 10, y: 10 }));
          return doc.pages[0].id;
        }));
    });

    const first = page.locator('.pm-tile >> nth=0');
    const second = page.locator('.pm-tile >> nth=1');
    const a = await first.boundingBox();
    const b = await second.boundingBox();

    // Long-press (280ms) then drag onto the second tile — the touch path.
    await first.dispatchEvent('pointerdown', {
      pointerId: 7, pointerType: 'touch', clientX: a.x + 40, clientY: a.y + 40, bubbles: true, isPrimary: true,
    });
    await page.waitForTimeout(380);
    await first.dispatchEvent('pointermove', {
      pointerId: 7, pointerType: 'touch', clientX: b.x + 40, clientY: b.y + 40, bubbles: true,
    });
    await first.dispatchEvent('pointerup', {
      pointerId: 7, pointerType: 'touch', clientX: b.x + 40, clientY: b.y + 40, bubbles: true,
    });

    const order = await page.evaluate(() => window.v2.getDoc().pages.map((p) => p.id));
    expect(order[1]).toBe(p1id); // page 1 moved to position 2
    const travelled = await page.evaluate(() => window.v2.getDoc().pages[1].annotations[0]?.text);
    expect(travelled).toBe('aku ikut'); // its annotation came along — no re-keying
  });

  test('extract downloads the selected pages as a PDF', async ({ page }) => {
    await openSheet(page);
    await page.tap('.pm-tile >> nth=0');
    const dl = page.waitForEvent('download');
    await page.tap('[data-act="extract"]');
    const download = await dl;
    expect(download.suggestedFilename()).toMatch(/halaman-1\.pdf$/);
  });
});
