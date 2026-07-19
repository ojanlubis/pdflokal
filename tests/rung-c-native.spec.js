/*
 * Rung C — native re-insert (core/reinsert.js).
 * ============================================================================
 * Rung B (ganti-teks-export.spec.js) proves the ORIGINAL run is truly cut
 * from the content stream and the cover skipped. This suite proves the other
 * half: when the cut run's own font is provably covered by the replacement
 * text (founder ruling 2026-07-19 — never guess a substitute font), the
 * replacement is written INTO the content stream with the document's OWN
 * font, not drawn as a metric-twin annotation on top. Structural proof: no
 * NEW font resource is added to the page for a native replacement (the twin
 * path always embeds one via drawText -> env.getFont). Every fallback path
 * (no embedded font program, multiline text) must still export cleanly via
 * the twin — Rung C never costs the export anything.
 *
 * Fixtures:
 *   nasty/undangan-cid.pdf  — Montserrat embedded FULL coverage (subset:
 *                             false), Type0/Identity-H — the native-capable
 *                             case. Draws "Rapat Anggota Tahunan 2026" three
 *                             times (PDF y 660/630/600 — pinned in
 *                             tests/rung-b-lab.spec.js and reused here).
 *   nasty/surat-fragmen.pdf — Line A "Nomor: 045/SEK/VII/2026" is Helvetica
 *                             standard-14 (Type1, no FontFile) — guaranteed
 *                             'unsupported-font' decline, twin path only.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { armGanti, tapLine } from './helpers/lines.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NASTY = (name) => path.join(__dirname, 'fixtures', 'nasty', name);
const CID_FIXTURE = NASTY('undangan-cid.pdf');
const FRAGMEN_FIXTURE = NASTY('surat-fragmen.pdf');

async function openDoc(page, fixture) {
  await page.goto('/');
  await page.setInputFiles('#file-input', fixture);
  await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();
}

async function downloadCurrent(page) {
  await page.click('#btn-download');
  await expect(page.locator('#dl-sheet')).toBeVisible();
  const dl = page.waitForEvent('download');
  await page.click('#ds-cta');
  const download = await dl;
  const chunks = [];
  for await (const c of await download.createReadStream()) chunks.push(c);
  return Buffer.concat(chunks);
}

// Same read shape as core/redact.js / core/reinsert.js: Contents may be one
// stream or an array, decode/tokenize is irrelevant here — we only need the
// page's Resources -> Font key COUNT, which is what a NEW drawText/embedFont
// call (the twin path) would grow. A native re-insert reuses an EXISTING key
// and adds none. Self-contained (no closure refs) — passed straight into
// page.evaluate(fontKeyCount, arr).
async function fontKeyCount(arr) {
  const bytes = new Uint8Array(arr);
  const { PDFLib } = window;
  const { PDFName, PDFRef, PDFDict } = PDFLib;
  const pdfDoc = await PDFLib.PDFDocument.load(bytes);
  const pg = pdfDoc.getPages()[0];
  const context = pdfDoc.context;
  const resolve = (v) => (v instanceof PDFRef ? context.lookup(v) : v);
  const resources = pg.node.Resources();
  if (!resources) return 0;
  const fontDictRaw = resources.get(PDFName.of('Font'));
  if (!fontDictRaw) return 0;
  const fontDict = resolve(fontDictRaw);
  if (!(fontDict instanceof PDFDict)) return 0;
  return fontDict.keys().length;
}

async function extractItems(page, buf) {
  return page.evaluate(async (arr) => {
    const bytes = new Uint8Array(arr);
    const doc = await window.pdfjsLib.getDocument({ data: bytes }).promise;
    const pg = await doc.getPage(1);
    const tc = await pg.getTextContent();
    return tc.items.map((i) => ({ str: i.str, x: i.transform[4], y: i.transform[5] }));
  }, Array.from(buf));
}

test.describe('rung C — native re-insert (own-font replacement)', () => {
  test('native re-insert end-to-end: replacement lands in the text layer with NO new font resource added', async ({ page }) => {
    await openDoc(page, CID_FIXTURE);
    await armGanti(page);
    // The 2nd paint-order match (nth: 1) is the MIDDLE of the three identical
    // lines (y=630) — same addressing as ganti-teks-export.spec.js.
    await tapLine(page, { str: 'Rapat Anggota Tahunan 2026', nth: 1 });
    await expect(page.locator('.v2-text-edit')).toHaveText('Rapat Anggota Tahunan 2026');
    // Every character here (incl. the space) already appears in the original
    // line — this is deliberate: the fixture's embedded font is full-coverage,
    // but picking a subset of the ORIGINAL painted string also guarantees any
    // ToUnicode entries already on this exact font resource cover it too.
    await page.keyboard.type('Rapat Anggota 2026');
    await page.keyboard.press('Enter');

    const outBuf = await downloadCurrent(page);
    expect(outBuf.subarray(0, 5).toString()).toBe('%PDF-');

    const items = await extractItems(page, outBuf);
    expect(items.some((i) => i.str.includes('Rapat Anggota 2026'))).toBe(true);

    const origBuf = fs.readFileSync(CID_FIXTURE);
    const origCount = await page.evaluate(fontKeyCount, Array.from(origBuf));
    const outCount = await page.evaluate(fontKeyCount, Array.from(outBuf));

    // No NEW font resource was added for this replacement — the twin path
    // (drawText -> env.getFont -> embedFont) always grows this count by at
    // least one; a native re-insert reuses an EXISTING /Font key and adds
    // none. This is the structural proof the replacement was painted with
    // the document's OWN font, not a metric-twin annotation.
    expect(outCount).toBe(origCount);
  });

  test('position held: the replacement paints at the removed line\'s own baseline (y) and start (x)', async ({ page }) => {
    await openDoc(page, CID_FIXTURE);
    // Independently derive the ORIGINAL middle line's geometry (not
    // hardcoded) from the fixture itself, same self-consistency discipline as
    // ganti-teks-export.spec.js's buildTextSourceDoc. window.pdfjsLib is
    // already loaded (openDoc just used it) so this can run before armGanti.
    const origBuf = fs.readFileSync(CID_FIXTURE);
    const origItems = await extractItems(page, origBuf);
    const repeatedOrig = origItems
      .filter((i) => i.str === 'Rapat Anggota Tahunan 2026')
      .sort((a, b) => b.y - a.y); // 660, 630, 600
    expect(repeatedOrig).toHaveLength(3);
    const middle = repeatedOrig[1];
    expect(Math.round(middle.y)).toBe(630);

    await armGanti(page);
    await tapLine(page, { str: 'Rapat Anggota Tahunan 2026', nth: 1 });
    await page.keyboard.type('Rapat Anggota 2026');
    await page.keyboard.press('Enter');
    const outBuf = await downloadCurrent(page);

    const outItems = await extractItems(page, outBuf);
    const replacement = outItems.find((i) => i.str.includes('Rapat Anggota 2026'));
    expect(replacement).toBeTruthy();
    expect(Math.abs(replacement.y - middle.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(replacement.x - middle.x)).toBeLessThanOrEqual(1);
  });

  test('fallback intact: a standard-14 (no embedded font program) line still exports via the twin path', async ({ page }) => {
    await openDoc(page, FRAGMEN_FIXTURE);
    await armGanti(page);
    // Line A (index 0, per ganti-baris.spec.js's LINE map): Helvetica
    // Type1/standard-14 — no FontFile2/3 at all, guaranteed 'unsupported-font'.
    await tapLine(page, { index: 0 });
    await expect(page.locator('.v2-text-edit')).toHaveText('Nomor: 045/SEK/VII/2026');
    await page.keyboard.type('Nomor Baru 001');
    await page.keyboard.press('Enter');

    const outBuf = await downloadCurrent(page);
    expect(outBuf.subarray(0, 5).toString()).toBe('%PDF-');

    const items = await extractItems(page, outBuf);
    expect(items.some((i) => i.str.includes('Nomor Baru 001'))).toBe(true);

    // Contrast proof: the twin path DID add a new font resource (drawText ->
    // embedFont), unlike the native path in the test above.
    const origBuf = fs.readFileSync(FRAGMEN_FIXTURE);
    const origCount = await page.evaluate(fontKeyCount, Array.from(origBuf));
    const outCount = await page.evaluate(fontKeyCount, Array.from(outBuf));
    expect(outCount).toBeGreaterThan(origCount);
  });

  test('multiline falls back: a newline in the replacement declines native re-insert, twin path paints both lines', async ({ page }) => {
    await openDoc(page, CID_FIXTURE);
    await armGanti(page);
    await tapLine(page, { str: 'Rapat Anggota Tahunan 2026', nth: 1 });
    // A real Enter keystroke COMMITS (see js/v2/app.js openTextEditor's
    // keydown handler) — the reliable way to land a literal '\n' in the
    // committed annotation text without depending on a browser's
    // contentEditable Shift+Enter DOM shape (a <br> doesn't round-trip
    // through .textContent as '\n') is to set it directly, then blur the
    // SAME real editor element to run the SAME commit() path a keyboard
    // Enter would have used.
    await page.evaluate(() => {
      document.querySelector('.v2-text-edit').textContent = 'Rapat Baru\nAgenda Baru';
      document.querySelector('.v2-text-edit').blur();
    });

    const outBuf = await downloadCurrent(page);
    expect(outBuf.subarray(0, 5).toString()).toBe('%PDF-');

    const items = await extractItems(page, outBuf);
    // drawText (js/core/export.js) splits on '\n' into separate lines/items.
    expect(items.some((i) => i.str.includes('Rapat Baru'))).toBe(true);
    expect(items.some((i) => i.str.includes('Agenda Baru'))).toBe(true);
  });
});
