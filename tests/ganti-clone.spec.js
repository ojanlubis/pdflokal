/*
 * Rung C — CLONE-rung end-to-end through the REAL UI (spec-edit-rebuild-
 * composite.md, founder-ruled Path B, 2026-07-22, increment 2).
 * ============================================================================
 * RENAMED from ganti-compose.spec.js (increment 2, deletion): this suite used
 * to pin core/compose.js's glyph-composition tier — a missing É was painted
 * from the document's own outlines (base E + a donor acute), silently, no
 * substitute disclosed. Path B RETIRES compose.js from the write path whole
 * (spec §1's ⚖1): a doc-subset decline for EITHER char below now falls
 * straight to core/stamp.js's rung 2 (clone), which routes this fixture's
 * /BaseFont ("Carlito-Regular-<n>", from carlito-subset.ttf) to the bundled
 * REAL Carlito — full coverage for both É (which the old composer could also
 * reach, via its glyf donor parse) and Ñ (which it could NEVER reach — no
 * tilde anywhere in this subset's cmap or any donor composite). Both edits
 * now bake fully (both overlay halves suppressed, same as compose's own
 * best case), but neither is silent anymore: a clone IS a substitute over a
 * REAL embedded original (this fixture's font is a true subset with its own
 * outlines, not a name-only standard-14), so the founder's notice policy
 * (spec §3, verbatim: "no embedded program + exact clone → silent;
 * embedded-but-unusable original → notice") fires the honest substitute
 * toast for both. js/v2/app.js's draft-time prediction was fixed in this
 * same increment (its `covered` check now shares core/stamp.js's own
 * textCoveredBy, with the old compose.js-backed "composable → silent"
 * escape hatch removed) so the toast can no longer promise silence an
 * export that only ever uses clone/twin will not deliver.
 *
 * Fixture: nasty/nota-subset.pdf (scripts/gen-fixture-subset.mjs) — a TRUE
 * subset: é present, É ABSENT, the acute reachable only as an un-cmapped
 * glyf component of é (the old composer's whole trick). Editing "Kafé
 * Andréa…" to "KAFÉ ANDRÉA"/"SEÑORA" forces glyphs the embedded subset
 * cannot show natively either way.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { armGanti, tapLine } from './helpers/lines.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'nasty', 'nota-subset.pdf');
const SUBSTITUTE_TOAST = 'Huruf ini memakai font pengganti yang mirip';

async function openDoc(page) {
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();
}

function pageRaster(page) {
  return page.evaluate(() => window.v2.getDoc().pages[0].raster?.dataUrl ?? null);
}

// The commit-time toast decision reads draft.docFontkitFont — landed
// asynchronously by prepareDocFont. Waiting for the doc font to reach the
// editor element (it prepends its runtime family, 'pdflokal-doc-…') both
// pins the intended UX and keeps the toast assertion race-free.
async function waitForDocFont(page) {
  await expect.poll(async () => page.evaluate(() => {
    const ed = document.querySelector('.v2-text-edit');
    return ed ? getComputedStyle(ed).fontFamily : '';
  }), { timeout: 10_000 }).toContain('pdflokal-doc-');
}

test.describe('ganti teks — clone rung (real embedded original, substitute honestly disclosed)', () => {
  test('É missing from the subset: commit BAKES via the clone rung, both overlays suppressed, substitute toast FIRES', async ({ page }) => {
    await openDoc(page);
    const before = await pageRaster(page);

    await armGanti(page);
    await tapLine(page, { str: 'Kafé Andréa' });
    await waitForDocFont(page);
    await page.keyboard.type('KAFÉ ANDRÉA');
    await page.keyboard.press('Enter');
    await expect(page.locator('.v2-text-edit')).toHaveCount(0); // committed

    // Clone resolves = applied natively (from export's POV — pdf-lib stamps
    // it straight into the page): the bake consumes BOTH halves of the edit
    // (cover cut + clone-stamped text), so neither survives as a DOM overlay —
    // same Decision-1 contract live-surgery-editor.spec.js pins for the
    // fully-covered case, now holding for a glyph the doc's own subset lacks.
    await expect(page.locator('.pv-anno-whiteout')).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator('.pv-anno-text')).toHaveCount(0);

    const after = await pageRaster(page);
    expect(after).not.toBe(before);

    // HONEST NOTICE: nota-subset.pdf's font is a REAL embedded subset (its
    // own outlines), not a name-only standard-14 — the clone substituting
    // for it must be disclosed, per the founder's notice policy (spec §3).
    await expect(page.locator('#toast')).toHaveText(SUBSTITUTE_TOAST);
  });

  test('Ñ (never reachable by the old compose trick): also BAKES via the clone rung, substitute toast fires', async ({ page }) => {
    // Ñ has no tilde anywhere in carlito-subset.ttf's cmap OR any donor
    // composite — the retired compose.js could never have composed this one
    // even before the rebuild. The bundled REAL Carlito clone covers it fine,
    // so this now bakes fully too — the SAME outcome as the É case above,
    // proving the clone rung's net is strictly wider than compose ever was
    // (one ladder, not two different tricks for "reachable" vs "not").
    await openDoc(page);

    await armGanti(page);
    await tapLine(page, { str: 'Kafé Andréa' });
    await waitForDocFont(page);
    await page.keyboard.type('SEÑORA');
    await page.keyboard.press('Enter');
    await expect(page.locator('.v2-text-edit')).toHaveCount(0);

    // One grammar, today's copy — the ratified notice for every substitute tier.
    await expect(page.locator('#toast')).toHaveText(SUBSTITUTE_TOAST);

    // Surgery (the cut) still succeeds → the cover bakes away; the
    // REPLACEMENT resolves via the CLONE rung (real Carlito covers Ñ) → it
    // bakes into the raster too — no DOM overlay survives for either half.
    await expect(page.locator('.pv-anno-whiteout')).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator('.pv-anno-text')).toHaveCount(0);
  });
});
