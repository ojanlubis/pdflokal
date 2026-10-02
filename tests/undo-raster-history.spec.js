/*
 * Undo history holds no page rasters — core/history.js, 2026-10-02.
 * ============================================================================
 * THE DEFECT: history snapshots spread-copied every page ({...p}), carrying
 * page.raster (a PNG data URL, 1-4 MB per page, 4x that after zoom-sharpen) by
 * reference into up to 50 undo steps. Replacing a page's raster freed nothing,
 * because a snapshot still pointed at the old one. tests/core/history.test.mjs
 * proves the model; THIS file proves the WIRING in the real app:
 *   1. the rasterizer stamps every raster with its provenance key;
 *   2. after real re-renders between recorded edits, no raster is reachable
 *      from the app's own undo/redo stacks;
 *   3. undo of an overlay-only edit keeps the live raster (no re-render);
 *   4. undo of a rotation never shows the wrong-orientation raster: the page
 *      comes back re-rendered the right way up;
 *   5. undo/redo of a deleted page still restores it, rendered.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');

async function openDoc(page) {
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await expectFirstPage(page);
  // both pages rastered (the second may be below the fold)
  await expect.poll(() => page.evaluate(() => window.v2.getDoc().pages.every((p) => p.raster)), { timeout: 15_000 }).toBe(true);
}

// One recorded gesture, exactly as the app does it: record() BEFORE the mutation.
const gesture = (page, fn) => page.evaluate(async (src) => {
  const ops = await import('/js/core/operations.js');
  const { record } = await import('/js/core/history.js');
  const doc = window.v2.getDoc();
  record(window.v2.history, doc);
  // eslint-disable-next-line no-new-func
  new Function('ops', 'doc', src)(ops, doc);
}, fn);

test.describe('undo history holds no rasters', () => {
  test('the rasterizer stamps provenance on every raster', async ({ page }) => {
    await openDoc(page);
    const keys = await page.evaluate(() => window.v2.getDoc().pages.map((p) => p.raster.key));
    for (const k of keys) expect(typeof k).toBe('string');
    expect(new Set(keys).size).toBe(2); // different source pages -> different keys
  });

  test('after 12 recorded edits with real re-renders between them, no raster is reachable from the stacks', async ({ page }) => {
    await openDoc(page);
    const result = await page.evaluate(async () => {
      const ops = await import('/js/core/operations.js');
      const { record } = await import('/js/core/history.js');
      const doc = window.v2.getDoc();
      const rz = window.v2.getRasterizer();
      for (let i = 0; i < 12; i++) {
        record(window.v2.history, doc);
        ops.addAnnotation(doc, doc.pages[0].id, { id: 'a' + i, type: 'text', x: i, y: i, text: 'e' + i });
        for (const p of doc.pages) await rz.rasterize(p, { scale: 2 + (i % 2) }); // sharpen-style re-render: a NEW raster each time
      }
      const seen = new Set();
      let rasterObjects = 0, rasterFields = 0;
      const walk = (v) => {
        if (!v || typeof v !== 'object' || seen.has(v)) return;
        seen.add(v);
        if (typeof v.dataUrl === 'string' && v.dataUrl.startsWith('data:image/png')) rasterObjects += 1;
        if ('raster' in v) rasterFields += 1;
        for (const k of Object.keys(v)) walk(v[k]);
      };
      walk([window.v2.history.undoStack, window.v2.history.redoStack]);
      return { depth: window.v2.history.undoStack.length, rasterObjects, rasterFields };
    });
    expect(result.depth).toBe(12);
    expect(result.rasterObjects).toBe(0);
    expect(result.rasterFields).toBe(0);
  });

  test('undo of an overlay-only edit keeps the live raster: no re-render', async ({ page }) => {
    await openDoc(page);
    await gesture(page, "ops.addAnnotation(doc, doc.pages[0].id, { id: 'keep', type: 'text', x: 5, y: 5, text: 'hai' })");
    const before = await page.evaluate(() => { window.__r0 = window.v2.getDoc().pages[0].raster; window.__r1 = window.v2.getDoc().pages[1].raster; return true; });
    expect(before).toBe(true);
    await page.keyboard.press('Control+z');
    const same = await page.evaluate(() => {
      const d = window.v2.getDoc();
      return { annos: d.pages[0].annotations.length, p0: d.pages[0].raster === window.__r0, p1: d.pages[1].raster === window.__r1 };
    });
    expect(same).toEqual({ annos: 0, p0: true, p1: true });
    await page.keyboard.press("Control+y");
    expect(await page.evaluate(() => window.v2.getDoc().pages[0].annotations.length)).toBe(1);
    expect(await page.evaluate(() => window.v2.getDoc().pages[0].raster === window.__r0)).toBe(true);
  });

  test('undo of a rotation never shows the wrong-orientation raster; the page re-renders upright', async ({ page }) => {
    await openDoc(page);
    const portrait = await page.evaluate(() => { const r = window.v2.getDoc().pages[0].raster; return r.height > r.width; });
    expect(portrait).toBe(true);

    await gesture(page, 'ops.rotatePage(doc, doc.pages[0].id, 90)');
    await page.evaluate(async () => { const d = window.v2.getDoc(); await window.v2.getRasterizer().rasterize(d.pages[0], { scale: 2 }); }); // rendered rotated
    expect(await page.evaluate(() => { const r = window.v2.getDoc().pages[0].raster; return r.width > r.height; })).toBe(true);

    await page.keyboard.press('Control+z');
    expect(await page.evaluate(() => window.v2.getDoc().pages[0].rotation)).toBe(0);
    // the landscape raster must not survive the restore; the stream re-renders portrait
    await expect.poll(() => page.evaluate(() => { const r = window.v2.getDoc().pages[0].raster; return r ? r.height > r.width : null; }), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => page.evaluate(() => { const i = document.querySelector('.pv-page .pv-bg'); return i ? i.naturalHeight > i.naturalWidth : null; }), { timeout: 15_000 }).toBe(true);

    await page.keyboard.press("Control+y");
    await expect.poll(() => page.evaluate(() => { const r = window.v2.getDoc().pages[0].raster; return r ? r.width > r.height : null; }), { timeout: 15_000 }).toBe(true);
  });

  test('undo of a page delete restores the page and it renders again', async ({ page }) => {
    await openDoc(page);
    await gesture(page, 'ops.removePage(doc, doc.pages[1].id)');
    expect(await page.evaluate(() => window.v2.getDoc().pages.length)).toBe(1);
    await page.keyboard.press('Control+z');
    expect(await page.evaluate(() => window.v2.getDoc().pages.length)).toBe(2);
    await expect.poll(() => page.evaluate(() => window.v2.getDoc().pages.every((p) => p.raster && p.raster.key)), { timeout: 15_000 }).toBe(true);
    await expect(page.locator('.pv-page .pv-bg')).toHaveCount(2, { timeout: 15_000 });
  });
});
