/*
 * Ganti Baris — the LINE is the editing primitive (founder ruling 2026-07-19).
 * ============================================================================
 * js/core/text-lines.js clusters pdf.js's fragment-level runs into visual
 * Lines by geometry alone. This suite proves the whole chain against
 * tests/fixtures/nasty/surat-fragmen.pdf, a fixture built to fragment the
 * exact way real-world exporters (Word, LibreOffice) do:
 *
 *   Line A "Nomor: 045/SEK/VII/2026"        Helvetica 12, y=760, 3 kern
 *                                            fragments (no gaps between them)
 *   Line B "Perihal: Undangan Rapat Anggota" y=730, word-gap fragments (a
 *                                            real space must be INFERRED)
 *   Line C "Kolom Kiri A" / "Kolom Kanan B"  y=680, two columns sharing a
 *                                            baseline — must NOT merge
 *   Line D "Rapat Tahunan"                   CID/Montserrat, y=620, 2 fragments
 *   Line E "Diterbitkan oleh Sekretariat"    y=90, single-fragment control
 *
 * On a single-fragment-per-line document (every OTHER ganti-teks fixture) a
 * Line IS a Run — this suite is what proves the multi-fragment case without
 * touching that invariant (see tests/ganti-teks.spec.js, unchanged).
 */
import { test, expect } from '@playwright/test';
// Line addressing via the app's own index (helpers/lines.js) — the hint DOM
// the old helpers clicked was removed by the QUIET PAGE ruling.
import path from 'path';
import { fileURLToPath } from 'url';
import { armGanti, lineBox, centerOf, tapLine as tapLineByTarget } from './helpers/lines.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NASTY = (name) => path.join(__dirname, 'fixtures', 'nasty', name);
const FIXTURE = NASTY('surat-fragmen.pdf');

async function openDoc(page, fixture) {
  await page.goto('/');
  await page.setInputFiles('#file-input', fixture);
  await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();
}


// Index of each hinted LINE, verified against a live extraction (not
// guessed): text-runs.js's getLines() re-sorts groupRunsIntoLines' output back
// into PAINT order (the fixture's own drawText call order — see js/v2/
// text-runs.js's getLines comment for why), which for this fixture is the
// natural top-down reading order it was built in: A, B, C-kiri, C-kanan, D, E.
const LINE = { A: 0, B: 1, C_KIRI: 2, C_KANAN: 3, D: 4, E: 5 };

// Replace one hinted line end to end and download via the REAL Unduh sheet
// (same pattern as tests/ganti-teks-export.spec.js — never a synthetic
// buildPdfBytes call, this is the path an actual user takes).
async function replaceLineAndDownload(page, idx, replacement) {
  await openDoc(page, FIXTURE);
  await armGanti(page);
  await tapLineByTarget(page, { index: idx });
  await page.keyboard.type(replacement);
  await page.keyboard.press('Enter');

  await page.click('#btn-download');
  await expect(page.locator('#dl-sheet')).toBeVisible();
  const dl = page.waitForEvent('download');
  await page.click('#ds-cta');
  const download = await dl;
  const chunks = [];
  for await (const c of await download.createReadStream()) chunks.push(c);
  return Buffer.concat(chunks);
}

async function extractStrings(page, buf) {
  return page.evaluate(async (arr) => {
    const bytes = new Uint8Array(arr);
    const doc = await window.pdfjsLib.getDocument({ data: bytes }).promise;
    const pg = await doc.getPage(1);
    const tc = await pg.getTextContent();
    return tc.items.map((i) => i.str);
  }, Array.from(buf));
}

test.describe('ganti baris — the LINE is the editing primitive (fragmented fixture)', () => {
  test('whole-line prefill: tap the middle of line A → draft is the FULL line, fragments joined, no doubled spaces', async ({ page }) => {
    await openDoc(page, FIXTURE);
    await armGanti(page);
    await tapLineByTarget(page, { index: LINE.A });
    await expect(page.locator('.v2-text-edit')).toHaveText('Nomor: 045/SEK/VII/2026');
  });

  test('word-gap join: line B\'s fragments join with exactly ONE inferred space', async ({ page }) => {
    await openDoc(page, FIXTURE);
    await armGanti(page);
    await tapLineByTarget(page, { index: LINE.B });
    await expect(page.locator('.v2-text-edit')).toHaveText('Perihal: Undangan Rapat Anggota');
  });

  test('column safety: tapping the left column never pulls in the right column\'s text', async ({ page }) => {
    await openDoc(page, FIXTURE);
    await armGanti(page);
    await tapLineByTarget(page, { index: LINE.C_KIRI });
    const text = await page.locator('.v2-text-edit').textContent();
    expect(text).toBe('Kolom Kiri A');
    expect(text).not.toContain('Kolom Kanan B');
  });

  test('QUIET PAGE ("mending opsi a"): no hint boxes; the hover glow spans the WHOLE line, not one fragment', async ({ page }) => {
    await openDoc(page, FIXTURE);
    await armGanti(page);
    // Arming paints NOTHING (founder ruling 2026-07-19) — the layer that once
    // showed 6 boxes here no longer exists at all.
    await expect(page.locator('.pv-run-hints')).toHaveCount(0);
    // The per-LINE grouping this test used to pin via box count is now pinned
    // via the glow: hovering line A (3 kern fragments) lights ONE glow whose
    // width spans the full clustered line, not a single fragment.
    const boxA = await lineBox(page, { index: LINE.A });
    const c = centerOf(boxA);
    await page.mouse.move(c.x, c.y);
    await expect(page.locator('.pv-ganti-glow')).toBeVisible();
    const glow = await page.locator('.pv-ganti-glow').boundingBox();
    expect(glow.width).toBeGreaterThan(boxA.width * 0.9); // all fragments, one line
  });

  test('line surgery end-to-end: replacing line A cuts all three fragments; line B survives untouched', async ({ page }) => {
    const outBuf = await replaceLineAndDownload(page, LINE.A, 'Nomor Baru');
    expect(outBuf.subarray(0, 5).toString()).toBe('%PDF-');
    const strings = await extractStrings(page, outBuf);

    // All three of line A's fragments are gone — not hidden under a cover,
    // genuinely absent from the re-parsed text layer.
    expect(strings.some((s) => s.includes('45/SEK/'))).toBe(false);
    expect(strings.some((s) => s.includes('Nomor:'))).toBe(false);
    // The replacement text made it into the export.
    expect(strings.some((s) => s.includes('Nomor Baru'))).toBe(true);
    // Line B — untouched — still reads intact (its own fragments, un-cut).
    expect(strings.join(' ')).toContain('Perihal:');
    expect(strings.some((s) => s.includes('Undangan') || s.includes('Rapat Anggota'))).toBe(true);
  });

  test('CID line surgery: replacing line D (Montserrat/CID) cuts both fragments; line E survives untouched', async ({ page }) => {
    const outBuf = await replaceLineAndDownload(page, LINE.D, 'Agenda Baru');
    expect(outBuf.subarray(0, 5).toString()).toBe('%PDF-');
    const strings = await extractStrings(page, outBuf);

    // Line D's text is completely gone from the re-parsed text layer.
    expect(strings.filter((s) => s.includes('Rapat Tahunan'))).toHaveLength(0);
    expect(strings.some((s) => s.includes('Agenda Baru'))).toBe(true);
    // Line E — untouched — still present.
    expect(strings.some((s) => s.includes('Diterbitkan') || s.includes('Sekretariat'))).toBe(true);
  });
});
