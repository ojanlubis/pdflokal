/*
 * Live-surgery editor wiring — spec-live-surgery.md §5/§7/§8.3, increment 3.
 * ============================================================================
 * Increment 2 (tests/live-raster.spec.js) proved the PIPELINE: ask the app's
 * own rasterizer to render a page that carries a committed Ganti edit, and
 * the raster comes back surgically modified. That suite deliberately never
 * drove a commit through the real UI and checked what happened AUTOMATICALLY
 * — this suite is that: the editor must ASK for the re-bake itself (at
 * commit, and after undo/redo), and must stop drawing the baked cover/text
 * as a DOM overlay once it has (Decision 1) — while a DECLINED edit's cover
 * keeps rendering exactly as it always did (Decision 2).
 *
 * Fixtures:
 *   nasty/undangan-cid.pdf — the SAME middle "Rapat Anggota Tahunan 2026"
 *     repeat tests/ganti-teks-export.spec.js and tests/live-raster.spec.js
 *     pin. Both surgery AND native re-insert succeed here (verified against
 *     tests/core/page-surgery-edited.test.mjs) — a clean SUCCESSFUL bake.
 *   nasty/surat-resmi.pdf — its label/value lines (e.g. ": Budi Santoso")
 *     are real, UI-reachable text that this exact pipeline DECLINES surgery
 *     on (verified live against the app's own buildEditedPageBytes) — a
 *     fixture that proves the decline path without any synthetic geometry.
 */
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

function pageRaster(page) {
  return page.evaluate(() => window.v2.getDoc().pages[0].raster?.dataUrl ?? null);
}

test.describe('live-surgery editor — commit re-bake + overlay suppression', () => {
  test('committing a Ganti edit changes the raster and leaves no DOM overlay for the successful edit', async ({ page }) => {
    await openDoc(page, NASTY('undangan-cid.pdf'));
    const before = await pageRaster(page);

    await armGanti(page);
    // undangan-cid.pdf's MIDDLE "Rapat Anggota Tahunan 2026" repeat — same
    // addressing tests/ganti-teks-export.spec.js / live-raster.spec.js pin.
    await tapLine(page, { str: 'Rapat Anggota Tahunan 2026', nth: 1 });
    await page.keyboard.type('Rapat Luar Biasa');
    await page.keyboard.press('Enter');
    await expect(page.locator('.v2-text-edit')).toHaveCount(0); // committed

    // The bake is async (commit fires it fire-and-forget) — wait for it,
    // then confirm NEITHER half of the edit still paints as a DOM overlay
    // (Decision 1: a committed edit is document text, not a draggable
    // cover+sticker collage).
    await expect(page.locator('.pv-anno-whiteout')).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator('.pv-anno-text')).toHaveCount(0);

    // The model still carries both annotations (undo needs them) — only the
    // DOM overlay is suppressed, never the edit itself.
    const annoTypes = await page.evaluate(() =>
      window.v2.getDoc().pages[0].annotations.map((a) => a.type).sort());
    expect(annoTypes).toEqual(['text', 'whiteout']);

    const after = await pageRaster(page);
    expect(after).not.toBe(before);
  });

  test('a DECLINED edit keeps its cover (and twin text) as a visible DOM overlay (Decision 2)', async ({ page }) => {
    await openDoc(page, NASTY('surat-resmi.pdf'));

    await armGanti(page);
    await tapLine(page, { str: ': Budi Santoso' });
    await page.keyboard.type(': Joko Wibowo');
    await page.keyboard.press('Enter');
    await expect(page.locator('.v2-text-edit')).toHaveCount(0);

    // Give the (declined) bake attempt the same beat a successful one gets —
    // it must settle on "still show the DOM fallback", not just not-yet-hidden.
    await page.waitForTimeout(500);

    await expect(page.locator('.pv-anno-whiteout')).toHaveCount(1);
    await expect(page.locator('.pv-anno-text')).toHaveText(': Joko Wibowo');
  });
});

test.describe('live-surgery editor — undo/redo re-bake', () => {
  test('undo reverts the raster to the plain source render and drops the overlay; redo re-bakes', async ({ page }) => {
    await openDoc(page, NASTY('undangan-cid.pdf'));
    const original = await pageRaster(page);

    await armGanti(page);
    await tapLine(page, { str: 'Rapat Anggota Tahunan 2026', nth: 1 });
    await page.keyboard.type('Rapat Luar Biasa');
    await page.keyboard.press('Enter');
    await expect(page.locator('.pv-anno-whiteout')).toHaveCount(0, { timeout: 10_000 }); // wait for the bake

    const edited = await pageRaster(page);
    expect(edited).not.toBe(original);

    await page.click('#btn-undo');
    expect(await page.evaluate(() => window.v2.getDoc().pages[0].annotations.length)).toBe(0);
    // The edit-signature dropped to empty — syncEditedRasters re-bakes this
    // page back to the plain source render (deterministic: same bytes, same
    // scale, same pdf.js canvas render → byte-identical dataUrl).
    await expect.poll(() => pageRaster(page), { timeout: 10_000 }).toBe(original);
    await expect(page.locator('.pv-anno-whiteout')).toHaveCount(0);
    await expect(page.locator('.pv-anno-text')).toHaveCount(0);

    await page.click('#btn-redo');
    await expect.poll(() => pageRaster(page), { timeout: 10_000 }).toBe(edited);
    // Suppressed again — redo re-bakes AND re-derives the same applied set.
    await expect(page.locator('.pv-anno-whiteout')).toHaveCount(0);
    await expect(page.locator('.pv-anno-text')).toHaveCount(0);
  });
});

test.describe('live-surgery editor — the commit seam (taste-judge law, §7)', () => {
  test('no white flash: the raster swap never drops to zero backgrounds', async ({ page }) => {
    await openDoc(page, NASTY('undangan-cid.pdf'));
    await armGanti(page);
    await tapLine(page, { str: 'Rapat Anggota Tahunan 2026', nth: 1 });
    await page.keyboard.type('Rapat Tanpa Kedip');

    // Start sampling BEFORE the commit key lands, so the poll is running
    // through the whole invalidate → rasterize → decode → swap window
    // (~85-90ms, spec §6) — 90 frames at 60fps comfortably covers it even on
    // a slow CI runner.
    const minCountPromise = page.evaluate(() => new Promise((resolve) => {
      let min = Infinity;
      let frames = 0;
      function tick() {
        min = Math.min(min, document.querySelectorAll('.pv-page .pv-bg').length);
        frames += 1;
        if (frames < 90) requestAnimationFrame(tick);
        else resolve(min);
      }
      requestAnimationFrame(tick);
    }));
    await page.keyboard.press('Enter');
    expect(await minCountPromise).toBeGreaterThanOrEqual(1);
  });
});
