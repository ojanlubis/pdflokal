/*
 * THE CHECKMARK THAT KILLED THE EXPORT — end to end, through the real UI.
 * ============================================================================
 * Measured on the rail 2026-08-23..09-05: six sessions hit
 * `failure{stage:'export', reason:'unsupported'}`, five of them exported
 * NOTHING, and one user retried 24 times in fourteen minutes. Every one was a
 * phone user with the Teks tool. The character was fine on screen (the browser
 * paints anything) and fatal at Unduh (Helvetica encodes through WinAnsi).
 *
 * Since 2026-09-06 core/export.js paints such an annotation as an image the
 * browser rendered (js/v2/text-raster.js, injected by js/v2/pdf-builder.js).
 * This spec drives the path a user takes — type, commit, Unduh — and reads
 * the BYTES back: the download must happen, and the page must carry more ink
 * than the untouched source did. RED-ON-REVERT: on the pre-fix build
 * `#ds-cta` never yields a download (buildBase throws, the sheet toasts).
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';
import { downloadBytes } from './helpers/download-bytes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_PDF = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');

// Count dark pixels on page 1 of `bytes` at scale 2 — position-independent, so
// the assertion does not depend on where the tap landed in page space.
async function countInk(arr) {
  const bytes = new Uint8Array(arr);
  const out = await window.pdfjsLib.getDocument({ data: bytes }).promise;
  const p = await out.getPage(1);
  const vp = p.getViewport({ scale: 2 });
  const c = document.createElement('canvas');
  c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  await p.render({ canvasContext: ctx, viewport: vp }).promise;
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let ink = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] < 128 && d[i + 1] < 128 && d[i + 2] < 128) ink++;
  const tc = await p.getTextContent();
  return { ink, strings: tc.items.map((i) => i.str), png: c.toDataURL('image/png') };
}

test.describe('export glyph fallback — real UI, real download', () => {
  for (const [label, typed] of [
    ['a checkmark (U+2713, WinAnsi cannot encode it)', 'Setuju ✓'],
    ['an emoji (astral plane, surrogate pair)', 'Terima kasih 🙂'],
  ]) {
    test(`Teks with ${label} still downloads, and the page carries the ink`, async ({ page }, testInfo) => {
      await page.goto('/');
      await page.setInputFiles('#file-input', SAMPLE_PDF);
      await expectFirstPage(page);

      // The untouched source, for the ink baseline: rendered through the same
      // counter the assertion uses, so the comparison is like for like.
      const srcBytes = Array.from(fs.readFileSync(SAMPLE_PDF));

      await page.click('[data-tool="text"]');
      await page.click('.pv-page >> nth=0', { position: { x: 120, y: 180 } });
      // insertText, not keyboard.type: an astral-plane emoji is a surrogate PAIR.
      await page.keyboard.insertText(typed);
      await page.keyboard.press('Enter');
      await expect(page.locator('.v2-text-edit')).toHaveCount(0);

      await page.click('#btn-download');
      await expect(page.locator('#dl-sheet')).toBeVisible();
      // The pre-fix build never reaches a size here: buildBase throws first.
      await expect(page.locator('#ds-cta-main')).toContainText(/KB|MB/, { timeout: 15000 });
      const { buf } = await downloadBytes(page, () => page.click('#ds-cta'));
      expect(buf.subarray(0, 5).toString()).toBe('%PDF-');

      const out = await page.evaluate(countInk, Array.from(buf));
      const base = await page.evaluate(countInk, srcBytes);
      // The rendered export, kept as an attachment: INCLUDE 8 reports every
      // shipped surface with a picture, and this IS the surface.
      const png = Buffer.from(out.png.split(',')[1], 'base64');
      await testInfo.attach('exported-page-1.png', { body: png, contentType: 'image/png' });
      // A passing run keeps no attachments on disk; the seat's INCLUDE 8 report
      // needs the picture, so an opt-in env var also writes it out.
      if (process.env.PDFLOKAL_SNAP_DIR) {
        fs.writeFileSync(path.join(process.env.PDFLOKAL_SNAP_DIR, `glyph-raster-${testInfo.testId}.png`), png);
      }
      // 18pt text at page scale, rendered at 2x: a short line is thousands of
      // dark pixels. 500 is a floor that a missing annotation cannot clear.
      expect(out.ink - base.ink, 'the typed line must add ink to page 1').toBeGreaterThan(500);
      // The whole annotation went in as an image: none of its text is
      // selectable. (A partial paint — the ASCII half as text and the glyph
      // dropped — would leak 'Setuju' / 'Terima kasih' here.)
      const leaked = out.strings.filter((s) => /Setuju|Terima kasih/.test(s));
      expect(leaked, 'the rasterised annotation must not also be drawn as text').toEqual([]);
    });
  }
});
