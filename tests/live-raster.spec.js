/*
 * Live-surgery rasterizer — spec-live-surgery.md §4/§8.2, increment 2.
 * ============================================================================
 * Increment 1 extracted the per-page surgery+insert pipeline into
 * core/page-surgery.js (export-parity.test.mjs pins that). This increment
 * wires the SECOND caller: the editor's own rasterizer (core/import.js's
 * createPageRasterizer) renders a page's background from a per-page,
 * surgically-modified PDF when that page carries a committed Ganti edit,
 * instead of always rasterizing the shared, untouched source doc.
 *
 * This suite does NOT test the commit-flow wiring (overlay suppression,
 * commit/undo re-raster — that's increment 3's job, and app.js is
 * deliberately untouched here beyond wiring the provider + a getRasterizer()
 * test hook). It proves the PIPELINE is correct whenever asked: drive a real
 * Ganti Teks commit through the actual UI, then call the app's own
 * rasterizer directly (window.v2.getRasterizer()) and assert the resulting
 * raster changed — and that an untouched page's raster does not.
 *
 * Deterministic by construction: pdf.js canvas rendering of the same bytes at
 * the same scale is byte-identical run to run, so dataUrl (in)equality is a
 * reliable signal, no pixel-diff tolerance needed.
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

// window.v2.getRasterizer() exercises the SAME rasterizer instance the app's
// own streaming viewport uses (created once per doc in loadFiles, wired with
// the real editedPageProvider) — this is the app's own plumbing, not a
// reimplementation.
async function rasterizeFirstPage(page) {
  return page.evaluate(async () => {
    const pg = window.v2.getDoc().pages[0];
    const raster = await window.v2.getRasterizer().rasterize(pg, { scale: 1 });
    return raster.dataUrl;
  });
}

test.describe('live-surgery rasterizer — the edited page renders from surgically-modified bytes', () => {
  test('a page with no committed edits rasterizes unchanged', async ({ page }) => {
    await openDoc(page, NASTY('undangan-cid.pdf'));
    const first = await rasterizeFirstPage(page);
    const second = await rasterizeFirstPage(page);
    expect(second).toBe(first);
  });

  test('committing a Ganti edit changes the page raster', async ({ page }) => {
    await openDoc(page, NASTY('undangan-cid.pdf'));

    const before = await rasterizeFirstPage(page);

    await armGanti(page);
    // undangan-cid.pdf's MIDDLE "Rapat Anggota Tahunan 2026" repeat — same
    // addressing tests/ganti-teks-export.spec.js pins.
    await tapLine(page, { str: 'Rapat Anggota Tahunan 2026', nth: 1 });
    await expect(page.locator('.v2-text-edit')).toHaveText('Rapat Anggota Tahunan 2026');
    await page.keyboard.type('Rapat Luar Biasa');
    await page.keyboard.press('Enter');
    await expect(page.locator('.v2-text-edit')).toHaveCount(0); // committed

    const after = await rasterizeFirstPage(page);
    expect(after).not.toBe(before);
  });
});
