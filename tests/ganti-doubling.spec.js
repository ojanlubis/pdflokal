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
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NASTY = (name) => path.join(__dirname, 'fixtures', 'nasty', name);

async function openDoc(page, fixture) {
  await page.goto('/');
  await page.setInputFiles('#file-input', fixture);
  await expectFirstPage(page);
}

// A ONE-SHOT HOLD on the next pdf.js page render, so an older rasterize is
// PROVABLY still in flight when a newer one lands. Without it the two real
// renders never overlap (tests/zoom-sharpen.spec.js measured that) and the
// ordering test passed on a guard it never exercised.
// WHY patch PDFPageProxy.prototype.render and not rz.rasterize (the way
// edit-survives-bake.spec.js gates it): a wrapper around rasterize would delay
// the ISSUE, which is exactly the renderSeq tick the guard keys on, so A would
// become the newer call. The hold has to sit INSIDE rasterize, after its seq is
// taken — the pdf.js render is the await it is actually waiting on.
async function installRenderHold(page) {
  await page.evaluate(async () => {
    const lib = window.pdfjsLib;
    const src = window.v2.getDoc().sources[0];
    const probe = await lib.getDocument({ data: src.bytes.slice() }).promise;
    const proto = Object.getPrototypeOf(await probe.getPage(1));
    await probe.destroy();
    const orig = proto.render;
    window.__hold = { armed: false, engaged: 0 };
    // Arm: the NEXT render of PDF page 1 resolves only when __hold.release() runs.
    window.__armHold = () => {
      let release;
      const gate = new Promise((r) => { release = r; });
      Object.assign(window.__hold, { armed: true, gate, release });
    };
    proto.render = function (...args) {
      const task = orig.apply(this, args);
      if (!window.__hold.armed || this.pageNumber !== 1) return task;
      window.__hold.armed = false;
      window.__hold.engaged += 1;
      const gate = window.__hold.gate;
      return { promise: task.promise.then(async (v) => { await gate; return v; }), cancel: (...a) => task.cancel(...a) };
    };
  });
}

test.describe('ganti — no stale-raster doubling/revert', () => {
  // The invariant the guard enforces, tested directly and deterministically:
  // two rasterize() calls for the SAME page issued in order A-then-B — B (the
  // newer) is authoritative for page.raster no matter which render finishes
  // first, and the older A must never CLOBBER it. Looped so the pre-fix
  // behavior (last-RESOLVED wins) cannot slip through on lucky timing.
  test('a stale (older-issued) rasterize never overwrites the newer one', async ({ page }) => {
    await openDoc(page, NASTY('undangan-cid.pdf'));
    await installRenderHold(page);

    const results = await page.evaluate(async () => {
      const rz = window.v2.getRasterizer();
      const pg = window.v2.getDoc().pages[0];
      const out = [];
      for (let i = 0; i < 4; i += 1) {
        window.__armHold();
        let aSettled = false;
        const pA = rz.rasterize(pg).finally(() => { aSettled = true; }); // older — issued first, HELD
        // Wait until A's render has actually reached the hold (it is behind a few awaits).
        for (let t = 0; t < 200 && window.__hold.engaged <= i; t += 1) await new Promise((r) => setTimeout(r, 25));
        const engaged = window.__hold.engaged > i;
        const rB = await rz.rasterize(pg); // newer — issued after A, fully resolved
        const rasterAfterB = pg.raster;    // must be B's result
        const aPendingWhenBLanded = !aSettled;
        window.__hold.release();
        await pA;                          // older resolves now — must stand down
        out.push({ engaged, aPendingWhenBLanded, held: pg.raster === rasterAfterB && rasterAfterB === rB });
      }
      return out;
    });

    expect(results).toHaveLength(4);
    for (const r of results) {
      // Catches: a test where A finished before B was even issued (no overlap), under
      // which the old last-RESOLVED-wins bug also passed — the ordering was never contested.
      expect(r.engaged, 'the hold never caught A\'s render').toBe(true);
      expect(r.aPendingWhenBLanded, 'A was not still in flight when B landed: the race was never run').toBe(true);
      expect(r.held, 'the older render clobbered the newer raster').toBe(true);
    }
  });

  // End-to-end: a committed edit's baked raster must survive a plain rasterize
  // that was in flight from before the edit — the exact founder scenario.
  test('a committed edit is not reverted by an in-flight pre-edit render', async ({ page }) => {
    await openDoc(page, NASTY('undangan-cid.pdf'));

    const plainRaster = await page.evaluate(() => window.v2.getDoc().pages[0].raster.dataUrl);
    await installRenderHold(page);

    // Start a PLAIN rasterize and HOLD it — the "stale in-flight" call.
    await page.evaluate(() => {
      const rz = window.v2.getRasterizer();
      const pg = window.v2.getDoc().pages[0];
      window.__armHold();
      window.__staleSettled = false;
      window.__stale = rz.rasterize(pg).finally(() => { window.__staleSettled = true; }); // no edit yet → renders plain
    });
    await expect.poll(() => page.evaluate(() => window.__hold.engaged),
      { message: 'known-positive: the plain render must be held in flight' }).toBe(1);

    // Commit a Ganti edit that SURGERY SUCCEEDS on (the middle repeat) →
    // rebakePage fires a newer rasterize and the raster changes.
    await armGanti(page);
    await tapLine(page, { str: 'Rapat Anggota Tahunan 2026', nth: 1 });
    await page.keyboard.type('Rapat Luar Biasa');
    await page.keyboard.press('Enter');
    await expect(page.locator('.v2-text-edit')).toHaveCount(0);
    await expect(page.locator('.pv-anno-whiteout')).toHaveCount(0, { timeout: 10_000 }); // baked

    const editedRaster = await page.evaluate(() => window.v2.getDoc().pages[0].raster.dataUrl);
    // Catches: a stale render that resolved before the bake (no overlap), which made
    // "not reverted" pass without the stale-guard ever being contested.
    expect(await page.evaluate(() => window.__staleSettled), 'the stale render was not still in flight when the edit baked').toBe(false);

    // Let the stale pre-edit render resolve. It must NOT revert the page.
    const finalRaster = await page.evaluate(async () => {
      window.__hold.release();
      await window.__stale;
      return window.v2.getDoc().pages[0].raster.dataUrl;
    });

    expect(editedRaster).not.toBe(plainRaster); // sanity: the edit baked
    expect(finalRaster).toBe(editedRaster);     // stale render did not revert it
  });
});
