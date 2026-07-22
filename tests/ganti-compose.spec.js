/*
 * Font-fidelity tier 2 — glyph composition, end to end through the REAL UI
 * (spec-font-fidelity-engine.md §4, founder-ratified 2026-07-20).
 * ============================================================================
 * Fixture: nasty/nota-subset.pdf (scripts/gen-fixture-subset.mjs) — a TRUE
 * subset: é present, É ABSENT, the acute reachable only as an un-cmapped
 * glyf component of é. Editing "Kafé Andréa…" to "KAFÉ ANDRÉA" forces two É
 * glyphs the embedded font cannot show natively — the composed path must
 * paint them from the document's own outlines (base E + é's acute), bake
 * them into the raster, suppress both overlay halves, and stay SILENT
 * (founder ruling: a composed glyph is the document's own font — there is
 * no substitution to disclose, so the substitute toast must NOT fire).
 *
 * The negative twin: 'SEÑORA' — S/E/O/R/A are all covered; the tilde exists
 * NOWHERE in the subset (no ñ donor, no cmap entry), so the doc's own font
 * declines whole. REBUILD NOTE (spec-edit-rebuild-composite.md, 2026-07-22):
 * core/compose.js no longer runs on the write path (Path B, ⚖1 RETIRED) — a
 * doc-subset decline now falls to core/stamp.js's CLONE rung instead, which
 * routes this fixture's /BaseFont to the bundled REAL Carlito (this fixture
 * embeds carlito-subset.ttf, a TRUE subset of that same family), and real
 * Carlito DOES cover Ñ. So this edit now bakes via clone rather than staying
 * a twin overlay — strictly wider than compose ever reached. The substitute
 * toast still fires (one grammar for every substitute tier — ratified over
 * per-tier wording; a clone IS a substitute per the founder's notice policy).
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

// The commit-time toast decision reads draft.docFontBytes/docFontFlavor —
// landed asynchronously by prepareDocFont. Waiting for the doc font to reach
// the editor element (it prepends its runtime family, 'pdflokal-doc-…') both
// pins the intended UX and keeps the toast assertion race-free.
async function waitForDocFont(page) {
  await expect.poll(async () => page.evaluate(() => {
    const ed = document.querySelector('.v2-text-edit');
    return ed ? getComputedStyle(ed).fontFamily : '';
  }), { timeout: 10_000 }).toContain('pdflokal-doc-');
}

test.describe('ganti teks — composed glyphs (document\'s own font)', () => {
  test('É missing from the subset: commit bakes a COMPOSED glyph, both overlays suppressed, NO substitute toast', async ({ page }) => {
    await openDoc(page);
    const before = await pageRaster(page);

    await armGanti(page);
    await tapLine(page, { str: 'Kafé Andréa' });
    await waitForDocFont(page);
    await page.keyboard.type('KAFÉ ANDRÉA');
    await page.keyboard.press('Enter');
    await expect(page.locator('.v2-text-edit')).toHaveCount(0); // committed

    // Composed = applied natively: the bake consumes BOTH halves of the edit
    // (cover cut + composed text), so neither survives as a DOM overlay —
    // same Decision-1 contract live-surgery-editor.spec.js pins for the
    // fully-covered case, now holding for a glyph the subset doesn't have.
    await expect(page.locator('.pv-anno-whiteout')).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator('.pv-anno-text')).toHaveCount(0);

    const after = await pageRaster(page);
    expect(after).not.toBe(before);

    // RATIFIED SILENCE: the pixels are the document's own outlines — the
    // substitute toast must never have fired for this commit. Check twice
    // (toast auto-hides at 2.6s; either read would still catch a just-fired
    // one) — same double-read discipline as ganti-font-preview.spec.js.
    expect(await page.locator('#toast').textContent()).not.toBe(SUBSTITUTE_TOAST);
    await page.waitForTimeout(400);
    expect(await page.locator('#toast').textContent()).not.toBe(SUBSTITUTE_TOAST);
  });

  test('char uncomposable by the OLD tier-2 trick (Ñ): now BAKES via the clone rung instead of staying a twin overlay (spec-edit-rebuild-composite.md, 2026-07-22)', async ({ page }) => {
    // REBUILD NOTE: this test used to pin core/compose.js's own boundary —
    // Ñ has no tilde anywhere in carlito-subset.ttf's cmap OR any donor
    // composite, so the OLD tier-2 composer declined whole and the
    // replacement stayed a DOM-rendered twin TEXT overlay. Path B retires
    // compose.js from the WRITE path entirely (spec §1's ⚖1, RETIRED):
    // a doc-subset decline now falls to core/stamp.js's rung 2 (clone)
    // instead, which routes nota-subset.pdf's /BaseFont ("Carlito-Regular-
    // <n>", from the SAME carlito-subset.ttf this fixture embeds — see
    // scripts/gen-fixture-subset.mjs) to the bundled REAL Carlito, which DOES
    // cover Ñ (unlike the doc's own true subset). So this edit now bakes
    // fully — both overlay halves suppressed — a strictly wider outcome than
    // compose ever produced. js/v2/app.js's own draft-time toast prediction
    // is untouched by this rebuild (still reads compose.js's coverage check,
    // not stamp.js's) — it still calls Ñ "not covered by the doc's own font"
    // and fires the substitute notice, which happens to still be the CORRECT
    // signal here (a clone IS a substitute, per the founder's notice policy
    // — spec §3), just reached via an outdated prediction path. That toast
    // assertion is untouched below; only the overlay expectation changes.
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
    // REPLACEMENT now resolves via the CLONE rung (real Carlito covers Ñ) →
    // it bakes into the raster too, same as the composed case above — no DOM
    // overlay survives for either half.
    await expect(page.locator('.pv-anno-whiteout')).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator('.pv-anno-text')).toHaveCount(0);
  });
});
