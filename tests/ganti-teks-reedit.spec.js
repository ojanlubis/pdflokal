/*
 * Ganti Teks — RE-EDIT an already-edited line (spec-live-surgery.md §5/§8.4,
 * increment 4 of the live-surgery substrate, Decision 3 "3 defaults
 * CONFIRMED", seat decisions.md 2026-07-20).
 * ============================================================================
 * Increment 3 baked a committed Ganti edit straight into the page's raster
 * (no cover/sticker DOM overlay for a successful edit — spec Decision 1). But
 * hit-testing (js/v2/text-runs.js) only ever reads the ORIGINAL source bytes
 * — it has no idea an edit exists. Founder-verified live bug: tapping an
 * already-edited line reopened Ganti prefilled with the ORIGINAL words,
 * silently discarding the user's own edit. Re-editing was incoherent.
 *
 * Decision 3 (the default, confirmed): re-editing is DROP-AND-REAPPLY from
 * the pristine source — remove the previous edit's cover+text pair, create a
 * fresh pair against the SAME original target geometry, re-bake. Never
 * surgery-on-surgery; the original bytes stay authoritative. One undo step
 * per re-edit gesture; undoing a re-edit returns to the PREVIOUS edit, not
 * all the way back to the original.
 *
 * Same nasty fixture + geometry tests/ganti-teks-export.spec.js and
 * tests/live-raster.spec.js already pin: undangan-cid.pdf's "Rapat Anggota
 * Tahunan 2026" repeats three times (a CID/Identity-H font — string match
 * alone can't prove which line moved, only position-matched removal can).
 * The MIDDLE repeat (nth: 1) is edited, twice.
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
// own streaming viewport uses (tests/live-raster.spec.js's own pattern) — its
// edited-page cache keys itself off editSignature(page), so calling it
// directly is always current, independent of app.js's own fire-and-forget
// rebakePage() timing (see js/core/import.js's getEditedDoc).
async function rasterizeFirstPage(page) {
  return page.evaluate(async () => {
    const pg = window.v2.getDoc().pages[0];
    const raster = await window.v2.getRasterizer().rasterize(pg, { scale: 1 });
    return raster.dataUrl;
  });
}

// The "no double-surgery" proof: re-derive this page's edited bytes RIGHT NOW
// from the CURRENT annotation list — the exact call editedPageProvider itself
// makes (js/v2/app.js) — and read its text layer back with pdf.js. Independent
// of the rasterizer's own cache entirely (a fresh buildEditedPageBytes call).
async function editedPageTextItems(page) {
  return page.evaluate(async () => {
    const { ensurePdfLib } = await import('/js/core/vendor.js');
    const { buildEditedPageBytes } = await import('/js/core/page-surgery.js');
    const { PDFLib, fontkit } = await ensurePdfLib();
    const d = window.v2.getDoc();
    const pg = d.pages[0];
    const source = d.sources.find((s) => s.id === pg.sourceId);
    const srcDoc = await PDFLib.PDFDocument.load(source.bytes);
    const result = await buildEditedPageBytes(srcDoc, pg, pg.annotations, { PDFLib, fontkit });
    const parsed = await window.pdfjsLib.getDocument({ data: result.bytes.slice() }).promise;
    const p = await parsed.getPage(1);
    const tc = await p.getTextContent();
    return tc.items.map((i) => i.str);
  });
}

test.describe('ganti teks — RE-EDIT an already-edited line (Decision 3: drop-and-reapply)', () => {
  test('re-tap prefills the CURRENT text (not the original); re-commit swaps it; ' +
    'exactly one generation of replacement survives; undo returns to the FIRST edit', async ({ page }) => {
    await openDoc(page, NASTY('undangan-cid.pdf'));
    const originalRaster = await rasterizeFirstPage(page);

    // ---- edit #1: the middle "Rapat Anggota Tahunan 2026" repeat ----------
    await armGanti(page);
    await tapLine(page, { str: 'Rapat Anggota Tahunan 2026', nth: 1 });
    await expect(page.locator('.v2-text-edit')).toHaveText('Rapat Anggota Tahunan 2026');
    await page.keyboard.type('Rapat Luar Biasa');
    await page.keyboard.press('Enter');
    await expect(page.locator('.v2-text-edit')).toHaveCount(0); // baked, no overlay

    const afterFirst = await rasterizeFirstPage(page);
    expect(afterFirst).not.toBe(originalRaster);

    const annosAfterFirst = await page.evaluate(() => window.v2.getDoc().pages[0].annotations
      .map((a) => ({ id: a.id, t: a.type, text: a.text })));
    expect(annosAfterFirst).toHaveLength(2);
    const firstCoverId = annosAfterFirst.find((a) => a.t === 'whiteout').id;
    const firstTextId = annosAfterFirst.find((a) => a.t === 'text').id;

    // ---- RE-EDIT: tap the SAME source line again ---------------------------
    // hitTest below (js/v2/text-runs.js) always resolves against the PRISTINE
    // source, which still says "Rapat Anggota Tahunan 2026" at this position —
    // the bug this increment fixes is that the OLD code took hitTest's word
    // for the prefill. The new tap→edit entry (js/v2/app.js's smartReplace)
    // must instead recognize this tap lands inside edit #1's own box first.
    await armGanti(page);
    await tapLine(page, { str: 'Rapat Anggota Tahunan 2026', nth: 1 });
    await expect(page.locator('.v2-text-edit')).toHaveText('Rapat Luar Biasa'); // CURRENT text, not original

    await page.keyboard.type('Rapat Diperbarui Lagi');
    await page.keyboard.press('Enter');
    await expect(page.locator('.v2-text-edit')).toHaveCount(0);

    const afterSecond = await rasterizeFirstPage(page);
    expect(afterSecond).not.toBe(afterFirst);
    expect(afterSecond).not.toBe(originalRaster);

    // ---- drop-and-reapply, never accumulation ------------------------------
    const annosAfterSecond = await page.evaluate(() => window.v2.getDoc().pages[0].annotations
      .map((a) => ({ id: a.id, t: a.type, text: a.text })));
    expect(annosAfterSecond).toHaveLength(2); // still exactly ONE cover + ONE text
    expect(annosAfterSecond.some((a) => a.id === firstCoverId)).toBe(false); // OLD cover removed
    expect(annosAfterSecond.some((a) => a.id === firstTextId)).toBe(false); // OLD text removed
    expect(annosAfterSecond.find((a) => a.t === 'text').text).toBe('Rapat Diperbarui Lagi');

    // ---- no double-surgery: exactly one generation of replacement survives -
    const items = await editedPageTextItems(page);
    const repeatedCount = items.filter((s) => s === 'Rapat Anggota Tahunan 2026').length;
    expect(repeatedCount).toBe(2); // the tapped line's original run cut ONCE; the other 2 repeats untouched
    expect(items.some((s) => s.includes('Rapat Luar Biasa'))).toBe(false); // edit #1's text is gone, not lingering
    expect(items.filter((s) => s.includes('Rapat Diperbarui Lagi')).length).toBe(1); // newest text, exactly once

    // ---- undo returns to the FIRST edit, not all the way to the original --
    await page.click('#btn-undo');
    const annosAfterUndo = await page.evaluate(() => window.v2.getDoc().pages[0].annotations
      .map((a) => ({ t: a.type, text: a.text })));
    expect(annosAfterUndo).toHaveLength(2);
    expect(annosAfterUndo.find((a) => a.t === 'text').text).toBe('Rapat Luar Biasa');
    const afterUndo = await rasterizeFirstPage(page);
    expect(afterUndo).toBe(afterFirst); // byte-identical re-bake of edit #1's own state

    // ---- second undo unwinds all the way back to the pristine original -----
    await page.click('#btn-undo');
    expect(await page.evaluate(() => window.v2.getDoc().pages[0].annotations.length)).toBe(0);
    const afterSecondUndo = await rasterizeFirstPage(page);
    expect(afterSecondUndo).toBe(originalRaster);
  });

  test('re-edit backs out cleanly: Escape / no-op-retype leaves the existing edit untouched', async ({ page }) => {
    await openDoc(page, NASTY('undangan-cid.pdf'));
    await armGanti(page);
    await tapLine(page, { str: 'Rapat Anggota Tahunan 2026', nth: 1 });
    await page.keyboard.type('Rapat Luar Biasa');
    await page.keyboard.press('Enter');
    await expect(page.locator('.v2-text-edit')).toHaveCount(0);

    const before = await page.evaluate(() => window.v2.getDoc().pages[0].annotations
      .map((a) => ({ id: a.id, t: a.type, text: a.text })));

    // Escape on a re-edit must not touch the model at all — nothing was
    // mutated at tap time (reEditLine only reads), so there is nothing to
    // undo back out of.
    await armGanti(page);
    await tapLine(page, { str: 'Rapat Anggota Tahunan 2026', nth: 1 });
    await expect(page.locator('.v2-text-edit')).toHaveText('Rapat Luar Biasa');
    await page.keyboard.press('Escape');
    await expect(page.locator('.v2-text-edit')).toHaveCount(0);

    const afterEscape = await page.evaluate(() => window.v2.getDoc().pages[0].annotations
      .map((a) => ({ id: a.id, t: a.type, text: a.text })));
    expect(afterEscape).toEqual(before);

    // Re-tap again, retype the SAME text, blur elsewhere — a no-op commit,
    // same law as a fresh replace's own no-op-cancel guard.
    await armGanti(page);
    await tapLine(page, { str: 'Rapat Anggota Tahunan 2026', nth: 1 });
    await expect(page.locator('.v2-text-edit')).toHaveText('Rapat Luar Biasa');
    await page.mouse.click(400, 300); // tap-away = commit/blur
    await expect(page.locator('.v2-text-edit')).toHaveCount(0);

    const afterNoOp = await page.evaluate(() => window.v2.getDoc().pages[0].annotations
      .map((a) => ({ id: a.id, t: a.type, text: a.text })));
    expect(afterNoOp).toEqual(before);
  });
});
