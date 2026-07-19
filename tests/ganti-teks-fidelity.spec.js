/*
 * Ganti Teks — three field defects from the founder's phone test on a real
 * Word-made PDF (bold Arial headings, black text), 2026-07-19.
 * ============================================================================
 *   1. NO-OP COMMIT MUST BE A CANCEL — tap a line, change nothing, blur
 *      elsewhere → the founder watched pixels change after "doing nothing".
 *      js/v2/app.js's commit() now routes a committed-text-equals-prefill
 *      draft to draft.onCancel() exactly like the empty/Escape backout.
 *   2. BOLD/ITALIC NEVER ADOPTED — pdf.js's public getTextContent() never
 *      exposes the real font name (verified against the vendored worker
 *      bundle, see js/core/font-style.js's header); prepareDocFont now reads
 *      the document's own /BaseFont via the SAME pdf-lib dry run it already
 *      runs for the doc-font preview, and seeds draft.bold/draft.italic.
 *   3. INK COLOR SAMPLED WRONG — matchReplaceColors rendered solid black
 *      bold text back visibly GRAY (median of a "farthest from paper"
 *      quartile that was mostly anti-aliased stroke-edge pixels). Fixed by
 *      clustering to a tight band around the single most extreme sample
 *      actually seen (the genuine ink-CORE), not a diluted quartile.
 *
 * Fixture: tests/fixtures/nasty/tebal-hitam.pdf (scripts/gen-fixture-bold.mjs)
 * — a large BOLD, solid-black heading ("PENGUMUMAN RESMI", real embedded
 * font whose PostScript name is 'MontserratThin-Bold') over a REGULAR-weight
 * black control line, so both the bold-adoption AND the "stays regular"
 * negative case can be proven off one document.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { armGanti, tapLine } from './helpers/lines.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FX = (name) => path.join(__dirname, 'fixtures', name);
const NASTY = (name) => path.join(__dirname, 'fixtures', 'nasty', name);

async function openDoc(page, fixture) {
  await page.goto('/');
  await page.setInputFiles('#file-input', fixture);
  await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();
}

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
}

test.describe('bug 1 — no-op commit is a cancel', () => {
  test('tap a line, change nothing, blur elsewhere — zero annotations, no cover left behind', async ({ page }) => {
    await openDoc(page, FX('sample-2pages.pdf'));
    await armGanti(page);
    await tapLine(page, { str: 'Test Page 1' });
    await expect(page.locator('.v2-text-edit')).toHaveText('Test Page 1');

    await page.mouse.click(400, 300); // tap-away = blur = commit; nothing was typed
    await expect(page.locator('.v2-text-edit')).toHaveCount(0);

    // The whole gesture (cover it would have placed + any replacement) must
    // leave NOTHING behind — not just "no text object", the cover too.
    expect(await page.evaluate(() => window.v2.getDoc().pages[0].annotations.length)).toBe(0);
    await expect(page.locator('.pv-anno-whiteout')).toHaveCount(0);
    await expect(page.locator('.pv-anno-text')).toHaveCount(0);

    // Backing out is silent — same law as the existing Escape/empty-commit
    // path (no toast for "you did nothing").
    await expect(page.locator('#toast')).not.toHaveClass(/show/);
  });

  test('content edited then reverted back to the exact prefill — still a cancel, not a same-text replacement', async ({ page }) => {
    await openDoc(page, FX('sample-2pages.pdf'));
    await armGanti(page);
    await tapLine(page, { str: 'Test Page 1' });

    // Simulate "typed something, then deleted it back to the original words"
    // — the comparison must be against the FINAL committed text, not against
    // whether any keystroke happened.
    await page.evaluate(() => {
      document.querySelector('.v2-text-edit').textContent = 'Test Page 1';
    });
    await page.mouse.click(400, 300);
    await expect(page.locator('.v2-text-edit')).toHaveCount(0);
    expect(await page.evaluate(() => window.v2.getDoc().pages[0].annotations.length)).toBe(0);
  });

  test('a REAL edit still creates the cover + replacement (no regression)', async ({ page }) => {
    await openDoc(page, FX('sample-2pages.pdf'));
    await armGanti(page);
    await tapLine(page, { str: 'Test Page 1' });
    await page.keyboard.type('Halaman Satu Baru');
    await page.mouse.click(400, 300);
    expect(await page.evaluate(() => window.v2.getDoc().pages[0].annotations.length)).toBe(2);
  });
});

test.describe('bug 2 — bold/italic adoption', () => {
  test('a real Bold-named font seeds draft.bold live, and the committed annotation carries it', async ({ page }) => {
    await openDoc(page, NASTY('tebal-hitam.pdf'));
    await armGanti(page);
    await tapLine(page, { str: 'PENGUMUMAN' });
    await expect(page.locator('.v2-text-edit')).toBeVisible();

    // Bold detection rides the SAME async pdf-lib dry run as the doc-font
    // preview (js/v2/app.js's prepareDocFont) — poll until it lands.
    await expect.poll(async () => page.evaluate(
      () => getComputedStyle(document.querySelector('.v2-text-edit')).fontWeight,
    ), { timeout: 10_000 }).toBe('700');

    // A genuine edit (not a no-op — bug 1's cancel path must not swallow this).
    await page.keyboard.type('PENGUMUMAN BARU');
    await page.keyboard.press('Enter');

    const anno = await page.evaluate(() =>
      window.v2.getDoc().pages[0].annotations.find((a) => a.type === 'text'));
    expect(anno.bold).toBe(true);

    // Export twin path already draws bold/italic end-to-end (core/export.js's
    // resolveFontName/FONT_NAME_MAP) — proven here at the render layer, which
    // reads the SAME anno.bold field via render/page-view.js's textFontCss.
    const annoWeight = await page.evaluate(() =>
      getComputedStyle(document.querySelector('.pv-anno-text')).fontWeight);
    expect(annoWeight).toBe('700');
  });

  test('the regular-weight control line does NOT come back bold', async ({ page }) => {
    await openDoc(page, NASTY('tebal-hitam.pdf'));
    await armGanti(page);
    await tapLine(page, { str: 'Diterbitkan' });
    await expect(page.locator('.v2-text-edit')).toBeVisible();
    // Give prepareDocFont a beat to settle either way (it never blocks the
    // editor, but the assertion must not race a still-pending lookup).
    await page.waitForTimeout(500);
    const weight = await page.evaluate(
      () => getComputedStyle(document.querySelector('.v2-text-edit')).fontWeight,
    );
    expect(weight).not.toBe('700');
  });
});

test.describe('bug 3 — ink color sampling', () => {
  test('solid black bold text commits near-black ink, not gray', async ({ page }) => {
    await openDoc(page, NASTY('tebal-hitam.pdf'));
    await armGanti(page);
    await tapLine(page, { str: 'PENGUMUMAN' });
    // The async color sampler (matchReplaceColors) lands on the open draft.
    await page.waitForTimeout(500);
    // A genuine edit — bug 1's no-op-cancel path must not interfere here.
    await page.keyboard.type('PENGUMUMAN BARU');
    await page.keyboard.press('Enter');

    const anno = await page.evaluate(() =>
      window.v2.getDoc().pages[0].annotations.find((a) => a.type === 'text'));
    // The OLD bug rendered this back at a mid-gray luminance (well above
    // 100). Near-black is the honest read of solid black ink.
    expect(luminance(anno.color)).toBeLessThan(60);
  });

  test('the paper (cover) color is unaffected by the ink fix — stays near-white', async ({ page }) => {
    await openDoc(page, NASTY('tebal-hitam.pdf'));
    await armGanti(page);
    await tapLine(page, { str: 'PENGUMUMAN' });
    await page.waitForTimeout(500);

    const coverColor = await page.evaluate(() =>
      window.v2.getDoc().pages[0].annotations.find((a) => a.type === 'whiteout').color);
    expect(luminance(coverColor)).toBeGreaterThan(200);
  });
});
