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

    // Pin the ELEMENT (not a locator): once the placeholder joins the grid it
    // also matches .pm-tile, and a re-resolving locator would start dispatching
    // events at it instead of the grabbed tile.
    const first = await page.locator('.pm-tile >> nth=0').elementHandle();
    const a = await first.boundingBox();
    const b = await page.locator('.pm-tile >> nth=1').boundingBox();

    // Long-press (280ms) arms the FLIP drag; the tile lifts (position:fixed)
    // and rides the finger; crossing tile 2 moves the placeholder past it.
    await first.dispatchEvent('pointerdown', {
      pointerId: 7, pointerType: 'touch', clientX: a.x + 40, clientY: a.y + 40, bubbles: true, isPrimary: true,
    });
    await page.waitForTimeout(380);
    // The drag ghost lifted out of the grid.
    await expect(page.locator('.pm-drag-ghost')).toHaveCount(1);
    await expect(page.locator('.pm-placeholder')).toHaveCount(1);
    // Two move steps with a frame between (the drag loop is rAF-throttled).
    for (const fx of [0.5, 1]) {
      await first.dispatchEvent('pointermove', {
        pointerId: 7,
        pointerType: 'touch',
        clientX: a.x + 40 + (b.x - a.x + 30) * fx,
        clientY: b.y + 40,
        bubbles: true,
      });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    }
    await first.dispatchEvent('pointerup', {
      pointerId: 7, pointerType: 'touch', clientX: b.x + 70, clientY: b.y + 40, bubbles: true,
    });

    // The drop settles with an animation, then commits the model.
    await expect.poll(async () => page.evaluate(
      () => window.v2.getDoc().pages.map((p) => p.id)[1],
    ), { timeout: 3000 }).toBe(p1id); // page 1 moved to position 2
    const travelled = await page.evaluate(() => window.v2.getDoc().pages[1].annotations[0]?.text);
    expect(travelled).toBe('aku ikut'); // its annotation came along — no re-keying
  });

  test('File menu: Tambah appends, Buka Baru replaces (no refresh)', async ({ page }) => {
    await openSheet(page);
    await page.tap('#pm-close');

    // Tambah File → merge (4 pages, 2 sources).
    await page.tap('#btn-file');
    await page.tap('#fm-add');
    await page.setInputFiles('#file-input', FIXTURE);
    await expect(page.locator('.pv-page')).toHaveCount(4);
    expect(await page.evaluate(() => window.v2.getDoc().sources.length)).toBe(2);

    // Buka Baru → fresh doc (2 pages, 1 source, empty undo).
    await page.tap('#btn-file');
    await page.tap('#fm-new');
    await page.setInputFiles('#file-input', FIXTURE);
    await expect(page.locator('.pv-page')).toHaveCount(2);
    const state = await page.evaluate(() => ({
      sources: window.v2.getDoc().sources.length,
      undo: window.v2.history.undoStack.length,
    }));
    expect(state.sources).toBe(1);
    expect(state.undo).toBe(0);
  });

  test('drag near the grid edge AUTO-SCROLLS a big document (30+ page reality)', async ({ page }) => {
    await page.goto('/editor-v2.html');
    // 16 pages: fixture + 7 merges — enough to overflow the sheet's grid.
    // (Serialized: loadFiles guards against concurrent picks by design.)
    await page.setInputFiles('#file-input', FIXTURE);
    await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();
    for (let i = 0; i < 7; i += 1) {
      await page.setInputFiles('#file-input', FIXTURE);
      await expect(page.locator('.pv-page')).toHaveCount(2 * (i + 2));
    }
    await page.tap('#btn-pages');
    await expect(page.locator('.pm-tile:not(.pm-add)')).toHaveCount(16);

    const scrollable = await page.evaluate(() => {
      const g = document.getElementById('pm-grid');
      return g.scrollHeight > g.clientHeight;
    });
    expect(scrollable).toBe(true);

    // Arm a drag on the first tile, then HOLD the pointer in the bottom edge
    // zone — the grid must keep scrolling while the finger rests there.
    const first = await page.locator('.pm-tile >> nth=0').elementHandle();
    const a = await first.boundingBox();
    const gr = await page.locator('#pm-grid').boundingBox();
    await first.dispatchEvent('pointerdown', {
      pointerId: 9, pointerType: 'touch', clientX: a.x + 40, clientY: a.y + 40, bubbles: true, isPrimary: true,
    });
    await page.waitForTimeout(380); // long-press arms
    await first.dispatchEvent('pointermove', {
      pointerId: 9, pointerType: 'touch',
      clientX: gr.x + gr.width / 2, clientY: gr.y + gr.height - 12, bubbles: true,
    });
    await page.waitForTimeout(500); // the drag LOOP scrolls even with no new moves
    const scrolled = await page.evaluate(() => document.getElementById('pm-grid').scrollTop);
    expect(scrolled).toBeGreaterThan(50);

    await first.dispatchEvent('pointerup', {
      pointerId: 9, pointerType: 'touch',
      clientX: gr.x + gr.width / 2, clientY: gr.y + gr.height - 12, bubbles: true,
    });
    // Drop somewhere valid — the doc must still have 16 coherent pages.
    await expect.poll(async () => page.evaluate(() => window.v2.getDoc().pages.length)).toBe(16);
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
