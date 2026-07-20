/*
 * Ganti Teks — font-fidelity e2e coverage gate (INDEPENDENT of the concurrent
 * font-engine effort; tests + fixtures only, no production code touched).
 * ============================================================================
 * The Rung C font-coverage contract (core/reinsert.js's planNativeInsert +
 * js/v2/app.js's loadDocFont/prepareDocFont/smartReplace) has so far only
 * ever been proven headless — tests/core/rung-c-native.spec.js drives
 * planNativeInsert directly, tests/ganti-font-preview.spec.js proves the
 * live-preview FontFace wiring on undangan-cid.pdf/surat-fragmen.pdf. This
 * suite pins the SAME contract's two permanent ENDPOINTS through the real
 * editor UI on purpose-built fixtures whose coverage shape is stated in their
 * own filenames:
 *
 *   nasty/lorem-full.pdf   — Montserrat embedded FULL (subset:false — see
 *                            scripts/gen-fixture-lorem-full.mjs). Editing the
 *                            target line to ANY text within the family's own
 *                            320-glyph program — including a character the
 *                            ORIGINAL line never used — must resolve NATIVE
 *                            (document's own font), never the substitute
 *                            twin.
 *   nasty/lorem-subset.pdf — same shape, same font family, but the e2e test
 *                            introduces U+0416 CYRILLIC CAPITAL LETTER ZHE
 *                            ('Ж') — a character Montserrat has ZERO
 *                            coverage for, at ANY weight (verified: no
 *                            font-family clone within this family could ever
 *                            supply it, and Cyrillic Ж has no NFD
 *                            decomposition into Latin components a glyph-
 *                            composer could exploit either). This must
 *                            ALWAYS decline — see scripts/gen-fixture-
 *                            lorem-subset.mjs's header for why this fixture
 *                            is not a literal byte-subsetted font (the
 *                            vendored fontkit's subset ENCODER is
 *                            independently confirmed broken for every font
 *                            this repo ships) and why the substitute
 *                            character was chosen to make the DECLINE
 *                            outcome permanent regardless.
 *
 * STABILITY NOTE: a concurrent effort is improving font coverage (font-
 * family clone routing + glyph composition), which will legitimately turn
 * SOME today-declined cases into native/clone. Every assertion below whose
 * outcome that work could flip is marked `BASELINE (current behavior)`; the
 * two endpoint claims — full coverage stays native, a genuinely uncoverable
 * foreign-script glyph stays declined — are marked as hard, permanent
 * assertions instead.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { armGanti, tapLine } from './helpers/lines.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NASTY = (name) => path.join(__dirname, 'fixtures', 'nasty', name);
const LOREM_FULL = NASTY('lorem-full.pdf');
const LOREM_SUBSET = NASTY('lorem-subset.pdf');
const SUBSTITUTE_TOAST = 'Huruf ini memakai font pengganti yang mirip';

async function openDoc(page, fixture) {
  await page.goto('/');
  await page.setInputFiles('#file-input', fixture);
  await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();
}

function pageRaster(page) {
  return page.evaluate(() => window.v2.getDoc().pages[0].raster?.dataUrl ?? null);
}

// Same helper as ganti-font-preview.spec.js: the doc-font CSS family is a
// runtime-generated name (`pdflokal-doc-<sourceId>-<resourceFontName>`) —
// never hardcoded. The FIRST family in the computed stack is the doc font
// once prepareDocFont has landed (it prepends ahead of the twin stack).
function firstFontFamily(computed) {
  return computed.split(',')[0].trim().replace(/^"+|"+$/, '');
}

async function waitForDocFont(page) {
  await expect.poll(async () => {
    const family = await page.evaluate(
      () => getComputedStyle(document.querySelector('.v2-text-edit')).fontFamily,
    );
    return firstFontFamily(family);
  }, { timeout: 10_000 }).toMatch(/^pdflokal-doc-/);
}

function committedTextAnno(page) {
  return page.evaluate(() =>
    window.v2.getDoc().pages[0].annotations.find((a) => a.type === 'text'));
}

test.describe('font-coverage — lorem-full (full glyph set, native endpoint)', () => {
  test('editing to text incl. a NEW character never used by the original line: no substitute toast, native re-insert bakes into the page', async ({ page }) => {
    await openDoc(page, LOREM_FULL);
    await armGanti(page);
    await tapLine(page, { str: 'Nomor: 001' });
    await expect(page.locator('.v2-text-edit')).toHaveText('Nomor: 001/LOR/2026');

    // Twin shows first, doc font swaps in live — wait for the SAME async
    // prepareDocFont landing every other font-preview suite in this repo
    // waits for, so the commit-time coverage check has real data to check
    // against (not a race against the fire-and-forget FontFace load).
    await waitForDocFont(page);

    const before = await pageRaster(page);

    // '—' (em dash, U+2014) never appears in the original line — proves
    // coverage is checked against the FINAL typed text, not the prefill.
    // Verified at fixture-generation time (see gen-fixture-lorem-full.mjs's
    // header) that Montserrat's full program covers it.
    await page.keyboard.type('Nomor: 999/BARU/2026 — selesai');
    await page.keyboard.press('Enter');
    await expect(page.locator('.v2-text-edit')).toHaveCount(0); // committed

    // HARD (permanent endpoint): the substitute toast must never fire for a
    // fully-covered replacement. Check immediately and again after a beat —
    // the toast auto-hides at 2.6s, either window would still catch a
    // JUST-fired one.
    expect(await page.locator('#toast').textContent()).not.toBe(SUBSTITUTE_TOAST);
    await page.waitForTimeout(300);
    expect(await page.locator('#toast').textContent()).not.toBe(SUBSTITUTE_TOAST);

    // HARD: the model's committed replacement carries a live doc-font family
    // — proof the document's own program was successfully extracted+parsed
    // (a necessary precondition for the native path; future font-engine work
    // only ever ADDS native cases, it can't remove this one).
    const anno = await committedTextAnno(page);
    expect(anno.docFontFamily).toBeTruthy();
    expect(anno.replaceCoverId).toBeTruthy();

    // HARD: native re-insert bakes the replacement straight into the page's
    // own content stream — neither half of the edit survives as a DOM
    // overlay (Decision 1, live-surgery), and the raster genuinely changed.
    await expect(page.locator('.pv-anno-whiteout')).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator('.pv-anno-text')).toHaveCount(0);
    const after = await pageRaster(page);
    expect(after).not.toBe(before);
  });
});

test.describe('font-coverage — lorem-subset (genuinely uncoverable glyph, decline endpoint)', () => {
  test('editing to introduce a foreign-script character (Cyrillic Ж): the honest substitute-font toast fires', async ({ page }) => {
    await openDoc(page, LOREM_SUBSET);
    await armGanti(page);
    await tapLine(page, { str: 'Nomor: 002' });
    await expect(page.locator('.v2-text-edit')).toHaveText('Nomor: 002/LOR/2026');

    // Same wait as the lorem-full test: prepareDocFont must have landed
    // (docFontkitFont populated) before commit, so the coverage check has a
    // real fontkit font object to test 'Ж' against — not an unresolved
    // promise that would make the assertion pass for the wrong reason.
    await waitForDocFont(page);

    // 'Ж' (U+0416) has zero coverage in Montserrat at any weight (see
    // gen-fixture-lorem-subset.mjs's header) — genuinely uncoverable, not a
    // subset artifact that a wider re-embed could fix.
    await page.keyboard.type('Nomor: Ж02/BARU/2026');
    await page.keyboard.press('Enter');
    await expect(page.locator('.v2-text-edit')).toHaveCount(0); // committed

    // HARD (permanent endpoint): the honest substitute toast, verbatim.
    await expect(page.locator('#toast')).toHaveText(SUBSTITUTE_TOAST);

    // BASELINE (current behavior) — font-engine may flip this to native/
    // clone if it ever routes a declined native insert through a CLONE
    // font's own native re-insert path instead of the twin DOM overlay.
    // Today: surgery (removal of the original run) still succeeds
    // independently of font coverage, so the cover is gone (true background
    // shows through) but the replacement text, having declined NATIVE
    // insert, stays a DOM-rendered twin overlay rather than baking into the
    // raster (js/v2/app.js's editedPageProvider — buildEditedPageBytes'
    // `applied` set only ever contains a text annotation's id when its OWN
    // native insert succeeded; a font decline leaves it out, so page-view.js
    // keeps drawing it as `.pv-anno-text`). If font-engine work changes this
    // (e.g. bakes a clone-font native insert even for a fully foreign
    // script), update this block — the toast assertion above stays true
    // regardless.
    await expect(page.locator('.pv-anno-whiteout')).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator('.pv-anno-text')).toHaveCount(1);

    // BASELINE (current behavior) — docFontFamily is set purely from a
    // successful FontFace LOAD (loadDocFont), independent of whether the
    // FINAL typed text is fully covered (see js/v2/app.js's prepareDocFont —
    // it never checks coverage, only that the program parsed). It is NOT a
    // reliable "native succeeded" signal on its own; the toast above is the
    // decisive one. Documented here so a future reader isn't tempted to read
    // docFontFamily as proof of coverage.
    const anno = await committedTextAnno(page);
    expect(anno.docFontFamily).toBeTruthy();
    expect(anno.replaceCoverId).toBeTruthy();
  });
});
