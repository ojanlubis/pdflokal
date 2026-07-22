/*
 * Edit Teks Asli — the Word-doc shape (surat-word.pdf), Rung C acceptance.
 * ============================================================================
 * THE common case: a real Word-made PDF writes a SIMPLE /Subtype /TrueType
 * font (code-keyed, /Encoding the bare NAME /WinAnsiEncoding), never the
 * Type0/Identity-H shape pdf-lib's own embedFont() produces — see
 * scripts/gen-fixture-word.mjs's header. tests/core/reinsert-simple.test.mjs
 * used to pin this shape against the OLD hand-rolled writer's own byte-
 * encoding internals (WinAnsi octal escapes, /Differences decline, …); that
 * whole file died with core/reinsert.js (spec-edit-rebuild-composite.md
 * increment 2) because none of it exercised the CURRENT pipeline. This spec
 * closes that gap the honest way: through the REAL editor UI, on the REAL
 * fixture, proving core/stamp.js's doc-subset rung actually handles the
 * Word shape end to end — the phone gate's bar is "per-line flawless on
 * Word docs", so this shape needs its own dedicated pin, not just a unit
 * test of a function nobody calls anymore.
 *
 * Fixture: nasty/surat-word.pdf embeds fonts/carlito-regular.woff2 WHOLE
 * (not subsetted — see the generator's own header) as a simple TrueType
 * font. Line A "Nomor: 123/ABC/2026" (x=72, y=720, size=12) is the edit
 * target — full Carlito coverage means rung 1 (doc-subset/native) should
 * fire for ordinary Latin replacement text; no clone/twin fallback needed.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { armGanti, tapLine } from './helpers/lines.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NASTY = (name) => path.join(__dirname, 'fixtures', 'nasty', name);
const FIXTURE = NASTY('surat-word.pdf');

test('surat-word.pdf (Word-shape simple TrueType font): the replacement stamps NATIVE, extracts back exactly, the original line is gone', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();
  await expect(page.locator('[data-tool="ganti"]')).toBeVisible();
  await armGanti(page);

  // Line A (see gen-fixture-word.mjs's KNOWN Y-COORDS table) —
  // "Nomor: 123/ABC/2026", the fixture's designated edit target. Addressed
  // by text, not paint-order index: the heading ("SURAT UNDANGAN RESMI") is
  // line 0, Line A is line 1.
  await tapLine(page, { str: 'Nomor: 123/ABC/2026' });
  await expect(page.locator('.v2-text-edit')).toHaveText('Nomor: 123/ABC/2026');

  await page.locator('.v2-text-edit').evaluate((el) => { el.textContent = ''; });
  await page.keyboard.type('Nomor: 999/XYZ/2026');
  await page.keyboard.press('Enter');
  await expect(page.locator('.v2-text-edit')).toHaveCount(0); // committed

  // Same buildEditedPageBytes-in-page pattern as tests/edit-org-structure.spec.js's
  // acceptance case: build the edited page bytes headlessly (no download-sheet
  // round-trip needed) and read them back through pdf.js's own getTextContent —
  // the same reader a real "copy text from this PDF" user action would use.
  const out = await page.evaluate(async () => {
    const { ensurePdfLib } = await import('/js/core/vendor.js');
    const { buildEditedPageBytes } = await import('/js/core/page-surgery.js');
    const { PDFLib, fontkit } = await ensurePdfLib();
    const d = window.v2.getDoc(); const pg = d.pages[0];
    const srcDoc = await PDFLib.PDFDocument.load(d.sources.find((s) => s.id === pg.sourceId).bytes);
    const result = await buildEditedPageBytes(srcDoc, pg, pg.annotations, { PDFLib, fontkit });
    const parsed = await window.pdfjsLib.getDocument({ data: result.bytes.slice() }).promise;
    const tc = await (await parsed.getPage(1)).getTextContent();
    return {
      outcome: pg.editOutcomes[0],
      strings: tc.items.map((i) => i.str),
    };
  });

  // (2) rung 1 fired: the doc's OWN embedded Carlito program covers ordinary
  // Latin text (it's a FULL embed, not a subset — see the generator's header),
  // so the doc-subset rung must prove it, never fall to clone/twin.
  expect(out.outcome.insert).toEqual({ path: 'native', reason: 'clean' });

  // (1) the replacement extracts back EXACTLY — an exact `===` match against
  // pdf-lib's own generated ToUnicode CMap, not a substring/regex that would
  // also pass on a spurious-space bug like the old writer's "T estinggg".
  expect(out.strings).toContain('Nomor: 999/XYZ/2026');

  // (3) the original run is truly gone from extraction, not merely covered —
  // surgery cut the show-ops, it didn't just paint over them.
  expect(out.strings.some((s) => s.includes('Nomor: 123/ABC/2026'))).toBe(false);

  // The line's neighbors (untouched by this edit) must still extract intact —
  // proof surgery scoped itself to the ONE tapped run.
  expect(out.strings.some((s) => s.includes('Kepada Yth'))).toBe(true);
  expect(out.strings.some((s) => s.includes('Jakarta, 19 Juli 2026'))).toBe(true);
});
