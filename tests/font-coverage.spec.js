/*
 * Ganti Teks — font-fidelity e2e coverage gate (INDEPENDENT of the concurrent
 * font-engine effort; tests + fixtures only, no production code touched).
 * ============================================================================
 * The Rung C font-coverage contract (core/stamp.js's resolveStampFont +
 * js/v2/app.js's loadDocFont/prepareDocFont/smartReplace) has so far only
 * ever been proven headless — tests/rung-c-native.spec.js drives the ladder
 * directly, tests/ganti-font-preview.spec.js proves the
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
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NASTY = (name) => path.join(__dirname, 'fixtures', 'nasty', name);
const LOREM_FULL = NASTY('lorem-full.pdf');
const LOREM_SUBSET = NASTY('lorem-subset.pdf');
const SUBSTITUTE_TOAST = 'Font aslinya nggak bisa dipakai, diganti yang mirip.';

async function openDoc(page, fixture) {
  await page.goto('/');
  await page.setInputFiles('#file-input', fixture);
  await expectFirstPage(page);
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

test.describe('font-coverage — lorem-subset (genuinely uncoverable glyph, refusal endpoint)', () => {
  // REWRITTEN 2026-10-01 (edit font design slice 1, his answer 2: "a
  // character no font can write is refused at input with a short note"). This
  // test used to TYPE 'Ж', commit it, and expect the substitute toast plus a
  // DOM twin overlay — i.e. the old behaviour where the line was written in
  // the doc font with the twin painting 'Ж' per glyph. No bundled font covers
  // Cyrillic either, so 'Ж' is now refused while typing: it never reaches the
  // editor's text, the note names it, and the rest of the line commits in ONE
  // decided font. The hard endpoint is unchanged in spirit — a genuinely
  // uncoverable glyph never bakes — it is just enforced earlier.
  test('typing a foreign-script character (Cyrillic Ж): REFUSED at input with the note, the rest commits in one decided font', async ({ page }) => {
    await openDoc(page, LOREM_SUBSET);
    await armGanti(page);
    await tapLine(page, { str: 'Nomor: 002' });
    await expect(page.locator('.v2-text-edit')).toHaveText('Nomor: 002/LOR/2026');

    // The live decision is in place (js/v2/line-font-live.js marks the face
    // it paints) — refusal needs the loaded candidates to judge against.
    await expect(page.locator('.v2-text-edit')).toHaveAttribute('data-font-path', /^(native|clone|substitute)$/, { timeout: 10_000 });

    await page.keyboard.type('Nomor: Ж02/BARU/2026');
    await expect(page.locator('.v2-text-edit')).toHaveText('Nomor: 02/BARU/2026');
    // The note's words are his (TODO(copy)) — read them from their one home
    // rather than pinning a placeholder here.
    const note = await page.evaluate(async () => (await import('/js/v2/line-font-live.js')).refusalNote('Ж'));
    await expect(page.locator('#toast')).toHaveText(note);

    await page.keyboard.press('Enter');
    await expect(page.locator('.v2-text-edit')).toHaveCount(0); // committed

    const anno = await committedTextAnno(page);
    expect(anno.text).toBe('Nomor: 02/BARU/2026');
    expect(anno.text).not.toContain('Ж');
    expect(anno.replaceCoverId).toBeTruthy();
    expect(['native', 'clone', 'substitute']).toContain(anno.fontDecision?.path);
  });
});
