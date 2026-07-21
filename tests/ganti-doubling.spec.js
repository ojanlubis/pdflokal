// Regression: the intermittent "doubling"/edit-reverts-itself bug (founder
// phone test, 2026-07-20). Root cause: rasterize() is async, so a stale
// in-flight render (e.g. a viewport-stream "page entered view" render of the
// PLAIN page, issued before an edit) could resolve AFTER an edit's rebake and
// overwrite page.raster with the pre-edit image — the edit visually reverts.
// Fix: a per-page monotonic render-sequence guard in createPageRasterizer —
// last-ISSUED wins, a stale resolution is discarded (js/core/import.js).
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { armGanti, tapLine } from './helpers/lines.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NASTY = (name) => path.join(__dirname, 'fixtures', 'nasty', name);

async function openDoc(page, fixture) {
  await page.goto('/');
  await page.setInputFiles('#file-input', fixture);
  await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();
}

test.describe('ganti — no stale-raster doubling/revert', () => {
  // The invariant the guard enforces, tested directly and deterministically:
  // two rasterize() calls for the SAME page issued in order A-then-B — B (the
  // newer) is authoritative for page.raster no matter which render finishes
  // first, and the older A must never CLOBBER it. Looped so the pre-fix
  // behavior (last-RESOLVED wins) cannot slip through on lucky timing.
  test('a stale (older-issued) rasterize never overwrites the newer one', async ({ page }) => {
    await openDoc(page, NASTY('undangan-cid.pdf'));

    const results = await page.evaluate(async () => {
      const rz = window.v2.getRasterizer();
      const pg = window.v2.getDoc().pages[0];
      const out = [];
      for (let i = 0; i < 8; i += 1) {
        const pA = rz.rasterize(pg);       // older — issued first, held in flight
        const rB = await rz.rasterize(pg); // newer — issued after A, fully resolved
        const rasterAfterB = pg.raster;    // must be B's result
        await pA;                          // older resolves now — must stand down
        out.push(pg.raster === rasterAfterB && rasterAfterB === rB);
      }
      return out;
    });

    for (const held of results) expect(held).toBe(true);
  });

  // End-to-end: a committed edit's baked raster must survive a plain rasterize
  // that was in flight from before the edit — the exact founder scenario.
  test('a committed edit is not reverted by an in-flight pre-edit render', async ({ page }) => {
    await openDoc(page, NASTY('undangan-cid.pdf'));

    const plainRaster = await page.evaluate(() => window.v2.getDoc().pages[0].raster.dataUrl);

    // Start a PLAIN rasterize and hold it — the "stale in-flight" call.
    await page.evaluate(() => {
      const rz = window.v2.getRasterizer();
      const pg = window.v2.getDoc().pages[0];
      window.__stale = rz.rasterize(pg); // no edit yet → renders plain
    });

    // Commit a Ganti edit that SURGERY SUCCEEDS on (the middle repeat) →
    // rebakePage fires a newer rasterize and the raster changes.
    await armGanti(page);
    await tapLine(page, { str: 'Rapat Anggota Tahunan 2026', nth: 1 });
    await page.keyboard.type('Rapat Luar Biasa');
    await page.keyboard.press('Enter');
    await expect(page.locator('.v2-text-edit')).toHaveCount(0);
    await expect(page.locator('.pv-anno-whiteout')).toHaveCount(0, { timeout: 10_000 }); // baked

    const editedRaster = await page.evaluate(() => window.v2.getDoc().pages[0].raster.dataUrl);

    // Let the stale pre-edit render resolve. It must NOT revert the page.
    const finalRaster = await page.evaluate(async () => {
      await window.__stale;
      return window.v2.getDoc().pages[0].raster.dataUrl;
    });

    expect(editedRaster).not.toBe(plainRaster); // sanity: the edit baked
    expect(finalRaster).toBe(editedRaster);     // stale render did not revert it
  });
});
