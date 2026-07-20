/*
 * Ganti Teks — Rung C live doc-font preview (founder ruling, tonight 2026-07-19).
 * ============================================================================
 * core/export.js already writes the FINAL file with the document's own
 * embedded font when coverage allows it (core/reinsert.js, proven in
 * rung-c-native.spec.js) — but until now the EDITOR only ever showed the twin
 * CSS font while typing and after commit, so "what you see" and "what you
 * get" visibly diverged for the whole window between tap and download. This
 * suite proves the fix: js/v2/app.js's prepareDocFont loads the SAME font
 * program into the browser via FontFace so the draft (and the committed
 * annotation) render in the document's real font live, AND the founder's
 * companion ruling — when a substitute font WILL be used, the app says so
 * plainly at commit with the verbatim toast wording.
 *
 * Fixtures (same as rung-c-native.spec.js, on purpose — same fonts, same
 * known coverage shape):
 *   nasty/undangan-cid.pdf  — Montserrat embedded FULL coverage (Type0/
 *                             Identity-H) — the doc-font-loads case.
 *   nasty/surat-fragmen.pdf — Line A "Nomor: 045/SEK/VII/2026" is Helvetica
 *                             standard-14 (Type1, no FontFile at all) —
 *                             guaranteed 'unsupported-font' decline, so the
 *                             substitute-font toast MUST fire.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { armGanti, tapLine } from './helpers/lines.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NASTY = (name) => path.join(__dirname, 'fixtures', 'nasty', name);
const CID_FIXTURE = NASTY('undangan-cid.pdf');
const FRAGMEN_FIXTURE = NASTY('surat-fragmen.pdf');
const SUBSTITUTE_TOAST = 'Huruf ini memakai font pengganti yang mirip';

async function openDoc(page, fixture) {
  await page.goto('/');
  await page.setInputFiles('#file-input', fixture);
  await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();
}

// The doc-font CSS family is a runtime-generated name (`pdflokal-doc-<src
// id>-<resource font name>`, see js/v2/app.js's sanitizeForCssIdent) — never
// hardcoded here. Instead, read it back off whatever element's computed
// font-family the caller points at: the FIRST family in the stack is the doc
// font when prepareDocFont has landed (it prepends), the twin's own name
// (Montserrat, Helvetica, …) otherwise. Self-contained (no closure refs) so
// it can run inside page.evaluate/expect.poll.
function firstFontFamily(computed) {
  return computed.split(',')[0].trim().replace(/^"+|"+$/, '');
}

// WHY this exists instead of a bare `document.fonts.check(...)` call: verified
// empirically (a throwaway probe against this exact Chromium build) that
// FontFaceSet.check() returns true for a SINGLE custom family spec even when
// that family was NEVER registered at all — the CSS font-matching algorithm's
// generic-fallback clause makes it trivially satisfiable, so it can't actually
// prove presence OR absence on its own. Membership in the live `document.fonts`
// set is what genuinely reflects add()/delete() — that's what "is the doc font
// really loaded / really gone after Buka Baru" needs.
function isFamilyRegistered(name) {
  return [...document.fonts].some((f) => f.family.replace(/^"+|"+$/g, '') === name);
}

test.describe('ganti teks — live doc-font preview', () => {
  test('draft editor: twin shows immediately, doc font swaps in live', async ({ page }) => {
    await openDoc(page, CID_FIXTURE);
    await armGanti(page);

    // Capture the editor's font family at the EXACT instant it enters the DOM.
    // WHY a MutationObserver and not a read after the editor is visible: the
    // "twin first" claim is about the very first frame, and openTextEditor sets
    // the twin font synchronously (`ed.style.font = textFontCss(...)`) BEFORE
    // appendChild, whereas prepareDocFont only prepends the `pdflokal-doc-`
    // family in an async continuation many awaits later (ensurePdfLib script
    // load → pdf-lib dry run → FontFace.load — see js/v2/app.js). The observer's
    // microtask fires right after that synchronous appendChild, so it records a
    // guaranteed twin-only value. The old approach — a page.evaluate round-trip
    // AFTER the editor was already visible — was never synchronized against that
    // async prepend, so a warm module/HTTP cache (full-suite runs) could let the
    // doc font land inside the round-trip window and flip this assertion. That
    // was the intermittent full-suite failure diagnosed 2026-07-20.
    await page.evaluate(() => {
      window.__firstEditorFont = null;
      const obs = new MutationObserver((records) => {
        for (const rec of records) {
          for (const node of rec.addedNodes) {
            if (node.nodeType === 1 && node.classList.contains('v2-text-edit')) {
              window.__firstEditorFont = getComputedStyle(node).fontFamily;
              obs.disconnect();
              return;
            }
          }
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
    });

    await tapLine(page, { str: 'Rapat Anggota Tahunan 2026', nth: 1 });
    await expect(page.locator('.v2-text-edit')).toBeVisible();

    // Twin immediately — the family captured at insertion time is never the doc
    // font, no matter how fast prepareDocFont resolves afterward.
    const initialFamily = await page.evaluate(() => window.__firstEditorFont);
    expect(initialFamily, 'observer never saw the .v2-text-edit insertion').not.toBeNull();
    expect(firstFontFamily(initialFamily)).not.toMatch(/^pdflokal-doc-/);

    // prepareDocFont is async (vendor scripts + pdf-lib dry run + FontFace
    // load) — poll until it lands, then prove BOTH halves of the claim: the
    // editor is now painting with that family, AND the browser itself has it
    // ready (document.fonts.check), not just a name we hoped got registered.
    await expect.poll(async () => {
      const family = await page.evaluate(() =>
        getComputedStyle(document.querySelector('.v2-text-edit')).fontFamily);
      return firstFontFamily(family);
    }, { timeout: 10_000 }).toMatch(/^pdflokal-doc-/);

    const docFontName = firstFontFamily(await page.evaluate(() =>
      getComputedStyle(document.querySelector('.v2-text-edit')).fontFamily));
    // document.fonts.check() is ALSO true here per the plan's literal ask —
    // but per isFamilyRegistered's note above it's true even for a family
    // that was never registered, so it can't carry the proof on its own;
    // the membership check right after it is the assertion that actually
    // discriminates "loaded" from "never happened".
    const checked = await page.evaluate(
      (name) => document.fonts.check(`12px "${name}"`),
      docFontName,
    );
    expect(checked).toBe(true);
    const registered = await page.evaluate(isFamilyRegistered, docFontName);
    expect(registered).toBe(true);
  });

  // RETARGETED (spec-live-surgery.md increment 3, Decision 1, 2026-07-20):
  // this test used to read the COMMITTED annotation's computed font-family
  // off `.pv-anno-text` — proof that the live-preview doc font "stuck" past
  // commit. Under live surgery a committed Ganti edit is no longer a
  // draggable DOM twin holding a live CSS font: this fixture's Montserrat is
  // full-coverage, so native re-insert SUCCEEDS and the replacement is baked
  // straight into the page's own content stream (in the document's real
  // font) — the DOM overlay is suppressed so it can't double-paint the same
  // pixels (js/render/page-view.js's editApplied skip). Reading
  // `.pv-anno-text` after commit now races the async bake and, once it
  // resolves, finds nothing there at all. The claim this test protects — the
  // doc font genuinely reaches the page, not just the draft — now shows up
  // as: no DOM twin survives the commit, and the PAGE RASTER actually
  // changed (the pixels ARE the document; page-view.js's swapPageRaster is
  // what got them there with no visible seam).
  test('commit with covered text: no substitute toast, the edit bakes into the page raster', async ({ page }) => {
    await openDoc(page, CID_FIXTURE);
    await armGanti(page);
    await tapLine(page, { str: 'Rapat Anggota Tahunan 2026', nth: 1 });

    await expect.poll(async () => {
      const family = await page.evaluate(() =>
        getComputedStyle(document.querySelector('.v2-text-edit')).fontFamily);
      return firstFontFamily(family);
    }, { timeout: 10_000 }).toMatch(/^pdflokal-doc-/);

    const before = await page.evaluate(() => window.v2.getDoc().pages[0].raster.dataUrl);

    // Every character here already appears in the original painted line — the
    // fixture's font is full-coverage, so this is squarely the "covered" case
    // (same subset-of-original discipline rung-c-native.spec.js's native
    // re-insert test uses, for the same reason).
    await page.keyboard.type('Rapat Anggota 2026');
    await page.keyboard.press('Enter');
    await expect(page.locator('.v2-text-edit')).toHaveCount(0);

    // The substitute-font toast must NEVER have shown for this commit — check
    // right away and again after a beat (toast auto-hides at 2.6s; either
    // window would still show a JUST-fired toast's text).
    expect(await page.locator('#toast').textContent()).not.toBe(SUBSTITUTE_TOAST);
    await page.waitForTimeout(300);
    expect(await page.locator('#toast').textContent()).not.toBe(SUBSTITUTE_TOAST);

    // Both halves of the edit baked: neither the cover nor its twin text
    // survive as a DOM overlay (Decision 1), and the raster genuinely
    // changed (Decision 1's "the pixels are the document" — not a no-op).
    await expect(page.locator('.pv-anno-whiteout')).toHaveCount(0);
    await expect(page.locator('.pv-anno-text')).toHaveCount(0);
    const after = await page.evaluate(() => window.v2.getDoc().pages[0].raster.dataUrl);
    expect(after).not.toBe(before);
  });

  test('name-only font + exact clone: commit is SILENT and the clone is the committed family', async ({ page }) => {
    // PIN MOVED (name-only ruling, founder 2026-07-20 evening — the e-AHU
    // field case): this line's Helvetica is standard-14, no FontFile at all —
    // the file has NO outlines of its own and every viewer substitutes for
    // it. With the exact clone (Arimo) routed, the old substitute toast
    // compared us against an original that never existed — so this commit is
    // now SILENT. The toast still fires when a REAL embedded font gets a
    // substitute (pinned by ganti-compose.spec.js's uncomposable case).
    await openDoc(page, FRAGMEN_FIXTURE);
    await armGanti(page);
    // Line A (index 0, per rung-c-native.spec.js / ganti-baris.spec.js's LINE
    // map): Helvetica standard-14 — extraction declines, no doc font loads.
    await tapLine(page, { index: 0 });
    await expect(page.locator('.v2-text-edit')).toHaveText('Nomor: 045/SEK/VII/2026');
    // The ruling's facts (fontUnembedded + cloneRouted) land async via
    // prepareDocFont — wait for the clone to reach the draft's editor style
    // so the commit decision is deterministic, not a race.
    await expect.poll(async () => page.evaluate(() => {
      const ed = document.querySelector('.v2-text-edit');
      return ed ? getComputedStyle(ed).fontFamily : '';
    }), { timeout: 10_000 }).toContain('Arimo');
    await page.keyboard.type('Nomor Baru 001');
    await page.keyboard.press('Enter');

    // Silent — check twice across the toast's own display window, same
    // double-read discipline as the doc-font suite above.
    expect(await page.locator('#toast').textContent()).not.toBe(SUBSTITUTE_TOAST);
    await page.waitForTimeout(400);
    expect(await page.locator('#toast').textContent()).not.toBe(SUBSTITUTE_TOAST);

    const anno = await page.evaluate(() =>
      window.v2.getDoc().pages[0].annotations.find((a) => a.type === 'text'));
    expect(anno.fontFamily).toBe('Arimo');
  });

  test('Buka Baru clears the doc-font cache: the old FontFace is gone from document.fonts', async ({ page }) => {
    await openDoc(page, CID_FIXTURE);
    await armGanti(page);
    await tapLine(page, { str: 'Rapat Anggota Tahunan 2026', nth: 1 });

    await expect.poll(async () => {
      const family = await page.evaluate(() =>
        getComputedStyle(document.querySelector('.v2-text-edit')).fontFamily);
      return firstFontFamily(family);
    }, { timeout: 10_000 }).toMatch(/^pdflokal-doc-/);
    const docFontName = firstFontFamily(await page.evaluate(() =>
      getComputedStyle(document.querySelector('.v2-text-edit')).fontFamily));
    expect(await page.evaluate(isFamilyRegistered, docFontName)).toBe(true);

    // Back out of the draft cleanly, then start a fresh document via the
    // real "Buka Baru" menu path (File menu -> fm-new sets the replace flag,
    // the subsequent file selection triggers resetDoc() before loadFiles()).
    await page.keyboard.press('Escape');
    await page.click('#btn-file');
    await page.click('#fm-new');
    await page.setInputFiles('#file-input', FRAGMEN_FIXTURE);
    await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();

    const stillRegistered = await page.evaluate(isFamilyRegistered, docFontName);
    expect(stillRegistered).toBe(false);
  });
});
