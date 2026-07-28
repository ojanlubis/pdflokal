/*
 * ACCEPTANCE CASE — spec-edit-fidelity-instrumentation.md Increment A
 * (the founder's own phone-gate defect, decisions.md 2026-07-23).
 * ============================================================================
 * org-structure.pdf's `"T & PPGA"` box (bold, all-caps, blocky) baked THIN and
 * non-bold after a Ganti Teks replace on the pushed rebuild (83631c8). Root
 * cause: the font is `/BaseFont = CIDFont+F1` (Flags=6, no /FontWeight) — the
 * PDF WRAPPER genuinely says nothing about weight anywhere, though the
 * embedded PROGRAM underneath it ("Arial-BoldMT") self-identifies as bold
 * four redundant ways (name-table subfamily "Bold", OS/2.usWeightClass 700,
 * OS/2.fsSelection.bold, PANOSE weight byte 7). The native rung honestly
 * declines (this subset has no lowercase "s" — "testingg" can't be drawn in
 * it); the OLD clone rung declined too (the wrapper name has no routable
 * family) and fell to the twin tier, which read the WRAPPER's silence as
 * "regular" — that silent default was the bug.
 *
 * This pins the fix end-to-end through the REAL editor (not just
 * tests/core/stamp.test.mjs's headless ladder pin): tap the box, retype it,
 * commit, and assert — in a way that can't lie — that the committed replace
 * bakes bold. `style_source` is pinned to 'program-name' so a future
 * regression to label-reading (trusting the WRAPPER's silence again) fails
 * loudly here, not just in a unit test.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { armGanti, tapLine } from './helpers/lines.js';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NASTY = (n) => path.join(__dirname, 'fixtures', 'nasty', n);

test('acceptance: "T & PPGA" -> "testingg" bakes BOLD via the embedded program\'s own fingerprint, not the (silent) PDF wrapper name', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('#file-input', NASTY('org-structure.pdf'));
  await expectFirstPage(page);
  await expect(page.locator('[data-tool="ganti"]')).toBeVisible();
  await page.waitForTimeout(500);
  await armGanti(page);

  await tapLine(page, { str: 'PPGA' });
  await page.locator('.v2-text-edit').evaluate((el) => { el.textContent = ''; });
  await page.keyboard.type('testingg');
  await page.keyboard.press('Enter');
  await expect(page.locator('.v2-text-edit')).toHaveCount(0);

  const out = await page.evaluate(async () => {
    const { ensurePdfLib } = await import('/js/core/vendor.js');
    const { buildEditedPageBytes } = await import('/js/core/page-surgery.js');
    const { PDFLib, fontkit } = await ensurePdfLib();
    const d = window.v2.getDoc(); const pg = d.pages[0];
    const srcDoc = await PDFLib.PDFDocument.load(d.sources.find((s) => s.id === pg.sourceId).bytes);
    const result = await buildEditedPageBytes(srcDoc, pg, pg.annotations, { PDFLib, fontkit });

    // Re-parse the ACTUAL exported bytes' newly-added font resource — proves
    // genuinely bold PIXELS bake, not just a telemetry label (same discipline
    // as tests/core/stamp.test.mjs's headless acceptance pin).
    const outDoc = await PDFLib.PDFDocument.load(result.bytes);
    const outPage = outDoc.getPages()[0];
    const { PDFName, PDFRef, PDFDict, PDFRawStream, decodePDFRawStream } = PDFLib;
    const ctx = outPage.doc.context;
    const res = (v) => (v instanceof PDFRef ? ctx.lookup(v) : v);
    const fontDict = res(outPage.node.Resources().get(PDFName.of('Font')));
    let newBaseFont = null;
    let boldFromProgram = null;
    if (fontDict instanceof PDFDict) {
      for (const key of fontDict.keys()) {
        const fontObj = res(fontDict.get(key));
        const baseFontRaw = fontObj.get(PDFName.of('BaseFont'));
        const baseFont = baseFontRaw ? res(baseFontRaw).toString() : '';
        // F1/F2 (the doc's own fonts) mention Arial, never Arimo — any
        // resource mentioning Arimo is the NEW clone this edit embedded.
        if (/arimo/i.test(baseFont)) {
          newBaseFont = baseFont;
          let fdOwner = fontObj;
          const subtypeRaw = fontObj.get(PDFName.of('Subtype'));
          const subtype = subtypeRaw ? res(subtypeRaw) : null;
          if (subtype instanceof PDFName && subtype.toString() === '/Type0') {
            const descendantsRaw = fontObj.get(PDFName.of('DescendantFonts'));
            const descendants = descendantsRaw ? res(descendantsRaw) : null;
            const desc0 = descendants ? res(descendants.asArray()[0]) : null;
            if (desc0) fdOwner = desc0;
          }
          const fdRaw = fdOwner.get(PDFName.of('FontDescriptor'));
          const fd = fdRaw ? res(fdRaw) : null;
          const streamRaw = fd && (fd.get(PDFName.of('FontFile2')) || fd.get(PDFName.of('FontFile3')));
          const stream = streamRaw ? res(streamRaw) : null;
          if (stream instanceof PDFRawStream) {
            const bytes = decodePDFRawStream(stream).decode();
            const parsed = fontkit.create(bytes);
            boldFromProgram = parsed['OS/2'].usWeightClass >= 600
              || !!(parsed['OS/2'].fsSelection && parsed['OS/2'].fsSelection.bold);
          }
        }
      }
    }
    return { outcome: pg.editOutcomes[0], newBaseFont, boldFromProgram };
  });

  // The ladder's own verdict, pinned so a regression to label-reading fails
  // loudly HERE: rung 1 (the PDF wrapper's silent 'CIDFont+F1') must have
  // declined, and it must have been the embedded program's own name table
  // that decided bold — never a bare 'pdf-name'/'pdf-flags' claiming the
  // wrapper's silence as "regular".
  expect(out.outcome.insert.style_source).toBe('program-name');
  // Native declined (no lowercase "s" in this Bold subset); the fingerprint
  // routed the clone rung to the real bundled Arimo family instead of the
  // old twin-drawer fallback.
  expect(out.outcome.insert.path).toBe('clone');
  expect(out.outcome.insert.glyph_shortfall).toBeGreaterThan(0);

  // The genuinely-bold assertion — can't lie: re-parses the ACTUAL embedded
  // program that paints "testingg"'s pixels.
  expect(out.newBaseFont).toMatch(/Arimo-Bold/i);
  expect(out.boldFromProgram).toBe(true);
});
