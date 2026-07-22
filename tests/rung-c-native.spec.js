/*
 * Rung C — native re-insert (core/stamp.js, rebuilt spec-edit-rebuild-
 * composite.md 2026-07-22, Path B founder ruling).
 * ============================================================================
 * Rung B (ganti-teks-export.spec.js) proves the ORIGINAL run is truly cut
 * from the content stream and the cover skipped. This suite proves the other
 * half: when the cut run's own font is provably covered by the replacement
 * text (founder ruling 2026-07-19 — never guess a substitute font), the
 * replacement is written INTO the content stream with the document's OWN
 * font, not drawn as a metric-twin annotation on top.
 *
 * REBUILD NOTE: core/stamp.js's ladder stamps via pdf-lib's own
 * drawText+embedFont — pdf-lib ALWAYS registers a fresh font object (even for
 * the exact same program bytes an existing resource already carries), so a
 * native stamp now ALSO grows the page's font-resource count by exactly one,
 * same as a twin. The structural proof that used to be "no new resource" is
 * now "the NEW resource's /BaseFont carries the doc's own font family name"
 * (see fontKeyCount's replacement, newFontBaseName, below) — a clone or twin
 * substitute would carry a Croscore/crosextra/Helvetica name instead. Every
 * fallback path (no embedded font program, multiline text) must still export
 * cleanly via the twin — Rung C never costs the export anything.
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
// call ALWAYS grows now (see module header — native and twin both add one
// post-rebuild). Self-contained (no closure refs) — passed straight into
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

// The /BaseFont name of whichever font key in the OUTPUT is NOT present (by
// key string) in the ORIGINAL — i.e. the one resource this edit just added.
// pdf-lib derives /BaseFont from the embedded program's own internal name
// table, so this is the one honest after-the-fact signal for WHICH rung
// fired (see module header): a native stamp of undangan-cid.pdf's Montserrat
// subset carries "Montserrat" in it; a clone/twin substitute would carry
// Arimo/Tinos/Cousine/Carlito/Caladea/Helvetica instead.
async function newFontBaseName({ origArr, outArr }) {
  const { PDFLib } = window;
  const { PDFName, PDFRef, PDFDict } = PDFLib;
  const origDoc = await PDFLib.PDFDocument.load(new Uint8Array(origArr));
  const outDoc = await PDFLib.PDFDocument.load(new Uint8Array(outArr));
  const fontDictOf = (pdfDoc) => {
    const pg = pdfDoc.getPages()[0];
    const context = pdfDoc.context;
    const res = (v) => (v instanceof PDFRef ? context.lookup(v) : v);
    const resources = pg.node.Resources();
    const raw = resources?.get(PDFName.of('Font'));
    const dict = raw ? res(raw) : null;
    return dict instanceof PDFDict ? { dict, context, res } : null;
  };
  const origKeys = (fontDictOf(origDoc)?.dict.keys() ?? []).map((k) => k.toString());
  const out = fontDictOf(outDoc);
  const newKey = out.dict.keys().find((k) => !origKeys.includes(k.toString()));
  if (!newKey) return null;
  const fontObj = out.res(out.dict.get(newKey));
  const baseFontRaw = fontObj.get(PDFName.of('BaseFont'));
  return baseFontRaw ? out.res(baseFontRaw).toString() : null;
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
  test('native re-insert end-to-end: replacement lands in the text layer, stamped with the doc\'s OWN font', async ({ page }) => {
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

    // A stamp (native, clone, OR twin) always registers a FRESH pdf-lib font
    // object (module header) — exactly one new resource, whichever rung
    // supplied it.
    expect(outCount).toBe(origCount + 1);
    // — and it's the NATIVE rung specifically: the new resource's /BaseFont
    // carries this fixture's own font family name, proving pdf-lib embedded
    // the DOC'S Montserrat subset program, not a clone/twin substitute.
    const newBaseFont = await page.evaluate(newFontBaseName, { origArr: Array.from(origBuf), outArr: Array.from(outBuf) });
    expect(newBaseFont).toMatch(/Montserrat/i);
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

  test('fallback intact: Line A\'s multi-fragment geometry declines BOTH stamp rungs (mixed-fonts) — still exports via the twin path', async ({ page }) => {
    // CORRECTED WHY (verified empirically against this exact fixture+edit via
    // window.v2.getDoc().pages[0].editOutcomes, not assumed): Line A is 3 kern
    // fragments (ganti-baris.spec.js's module header) — text-walk.js's walk
    // flags this target's `insert.mixedFonts` true, and core/stamp.js's
    // resolveStampFont checks that structural guard FIRST, before either rung
    // (same order reinsert.js's old planNativeInsert used) — so this was
    // ALWAYS a twin via 'mixed-fonts', unaffected by the Path B rebuild. (An
    // earlier draft of this test guessed the font-decide.js CLONE_TABLE route
    // for standard-14 Helvetica would fire here instead — it doesn't, because
    // the mixed-fonts guard short-circuits before font resolution is ever
    // attempted. That clone route DOES exist and IS reachable — see
    // core/stamp.test.mjs's rung-2 coverage — just not on this fixture/edit.)
    await openDoc(page, FRAGMEN_FIXTURE);
    await armGanti(page);
    // Line A (index 0, per ganti-baris.spec.js's LINE map).
    await tapLine(page, { index: 0 });
    await expect(page.locator('.v2-text-edit')).toHaveText('Nomor: 045/SEK/VII/2026');
    await page.keyboard.type('Nomor Baru 001');
    await page.keyboard.press('Enter');

    const outBuf = await downloadCurrent(page);
    expect(outBuf.subarray(0, 5).toString()).toBe('%PDF-');

    const items = await extractItems(page, outBuf);
    expect(items.some((i) => i.str.includes('Nomor Baru 001'))).toBe(true);

    // Contrast proof: the twin path DID add a new font resource (drawText ->
    // embedFont), unlike a resolved stamp reusing an already-cached embed.
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
