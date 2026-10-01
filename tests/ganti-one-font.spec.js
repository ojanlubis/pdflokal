/*
 * Ganti Teks — ONE font per line while typing (edit font design slice 1b).
 * ============================================================================
 * His principle (seat decisions.md 2026-10-01): what the user sees while
 * typing is what the file will contain; no letter in another font.
 *
 * This suite tests the DRAWN LETTERS, not the CSS: the editor's painted text
 * width must equal pdf-lib's own advance width for that string in the decided
 * font — the exact number the stamp will lay the line out with. A CSS family
 * name proves nothing on its own (the browser can still paint a glyph from a
 * fallback font under any family list).
 *
 * Fixture: tests/helpers/unrouted-subset.js — the nota-subset Carlito cut
 * (é present, É absent) under a name that routes to NO clone, so its only
 * bundled face is the Arimo substitute, whose metrics differ from Carlito's.
 * (On nota-subset.pdf itself a per-glyph mix of the subset and the Carlito
 * clone paints the SAME width as the clone alone — clones are metric twins by
 * design — so a width test there cannot go red. Measured 2026-10-01.)
 *
 * RED ON REVERT, measured by hand in Chromium against the tree one commit
 * back (old editor), same steps, 'KAFÉ ANDRÉA' at 12px: the editor painted
 * 72.95px (doc font + a fallback glyph) where pdf-lib lays Arimo out at
 * 84.69px. With this slice: 84.69 vs 84.69. Not yet run under Playwright
 * locally (CI-only by the brief).
 */
import { test, expect } from '@playwright/test';
import { armGanti, tapLine } from './helpers/lines.js';
import { expectFirstPage } from './helpers/render.js';
import { unroutedSubsetPdf } from './helpers/unrouted-subset.js';

// The editor's painted text width in its own unscaled px, and the width
// pdf-lib computes for the same string in the decided face at the same size.
async function measure(page) {
  return page.evaluate(async () => {
    const ed = document.querySelector('.v2-text-edit');
    const cs = getComputedStyle(ed);
    const range = document.createRange();
    range.selectNodeContents(ed);
    const scale = ed.getBoundingClientRect().width / parseFloat(cs.width);
    const drawn = range.getBoundingClientRect().width / scale;

    const face = ed.dataset.fontFace;
    const { CLONE_FONT_URLS } = await import('/js/core/clone-fonts.js');
    const { ensurePdfLib } = await import('/js/core/vendor.js');
    const { PDFLib, fontkit } = await ensurePdfLib();
    const bytes = await (await fetch(CLONE_FONT_URLS[face])).arrayBuffer();
    const d = await PDFLib.PDFDocument.create();
    d.registerFontkit(fontkit);
    const font = await d.embedFont(bytes);
    const expected = font.widthOfTextAtSize(ed.textContent, parseFloat(cs.fontSize));
    return { drawn, expected, face, path: ed.dataset.fontPath, family: cs.fontFamily, text: ed.textContent };
  });
}

test('a char the doc font lacks moves the WHOLE line to one face — painted width = the file\'s advance width', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('#file-input', {
    name: 'unrouted-subset.pdf', mimeType: 'application/pdf', buffer: await unroutedSubsetPdf(),
  });
  await expectFirstPage(page);
  await armGanti(page);
  await tapLine(page, { str: 'Kafé Andréa' });
  const ed = page.locator('.v2-text-edit');

  // Prefill: the doc's own font paints it.
  await expect(ed).toHaveAttribute('data-font-path', 'native', { timeout: 10_000 });

  await page.keyboard.type('KAFÉ ANDRÉA');
  await expect(ed).toHaveText('KAFÉ ANDRÉA');
  await expect(ed).toHaveAttribute('data-font-path', 'substitute');
  await expect(ed).toHaveAttribute('data-font-face', 'Arimo');

  const m = await measure(page);
  expect(m.family.includes(','), `one family, no fallback stack: ${m.family}`).toBe(false);
  expect(Math.abs(m.drawn - m.expected), `drawn ${m.drawn} vs pdf-lib ${m.expected}`).toBeLessThan(0.5);

  // Back to letters the subset has: the whole line returns to the doc font —
  // a second whole-line change, still one face at a time.
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Kafe Andre');
  await expect(ed).toHaveAttribute('data-font-path', 'native');

  await page.keyboard.type(' É');
  await expect(ed).toHaveAttribute('data-font-path', 'substitute');
  await page.keyboard.press('Enter');
  await expect(ed).toHaveCount(0);
  const anno = await page.evaluate(() =>
    window.v2.getDoc().pages[0].annotations.find((a) => a.type === 'text'));
  // The committed annotation carries the decision the editor painted with,
  // and its style fields name the same face (the twin's last resort).
  expect(anno.text).toBe('Kafe Andre É');
  expect(anno.fontDecision.path).toBe('substitute');
  expect(anno.fontDecision.face).toBe('Arimo');
  expect(anno.fontFamily).toBe('Arimo');
});
