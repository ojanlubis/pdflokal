/*
 * THE INVISIBLE TEXT LAYER — a scan that claims to have text.
 * ============================================================================
 * A searchable scan is an image with an INVISIBLE text layer painted over it
 * (`3 Tr` — neither fill nor stroke). Every phone scanner ships this shape:
 * Adobe Scan, CamScanner, Google Drive's "make searchable", every ABBYY export.
 * The glyphs you see are PIXELS IN THE IMAGE; the text objects exist only so
 * you can select and search. They are not the visible marks.
 *
 * WE READ THAT SHAPE AS "THIS DOCUMENT HAS TEXT", at three layers, none of
 * which look at render mode:
 *   core/import.js  probeTextLayer  → any item with a non-empty string
 *   v2/text-runs.js extract         → same filter, and this one is the ROUTER:
 *                                     runs.length === 0 is what sends a scan to
 *                                     the scan offer instead of into Edit
 *   core/text-walk.js               → tracks Tc Tw Tz TL Ts Tf Tm Td TD T* Tj
 *                                     TJ ' " and no Tr, so the cut is blind too
 *
 * So Edit opens on a searchable scan, cuts show-ops that were never visible
 * (no visible change — they were invisible), and stamps the replacement over an
 * untouched image. The original stays where it was and the new text lands
 * beside it. That is `: Pondok Sapi, : Cibeber,` — the live incident of
 * 2026-07-28 — arriving through a second door.
 *
 * WHY THE FIXTURES ARE A PAIR. scan-ocr.pdf and scan-ocr-terlihat.pdf are
 * identical files except ONE BYTE: the operand of Tr ('3' vs '0'). The
 * generator asserts that property on every run. So these tests cannot pass by
 * accident of content — if the two files produce the same verdict, the code
 * under test is not reading render mode, and there is nowhere else for the
 * difference to have come from.
 *
 * WHY THIS BLOCKS THE OCR SPEC (PM, 2026-07-28). Writing our own searchable
 * layer would flip every scan we "helped" into this shape, turning the one path
 * that currently fails HONESTLY into silent duplication — and it would mute
 * `scan_offer` on exactly the population we OCR'd, so the demand signal the
 * build decision rests on would decay as the feature spread.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { armGanti } from './helpers/lines.js';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NASTY = (n) => path.join(__dirname, 'fixtures', 'nasty', n);

// Both fixtures put "Pondok Sapi" at the same place; only visibility differs.
const WORD = { x: 72, y: 700 };

async function open(page, file) {
  await page.goto('/');
  await page.setInputFiles('#file-input', NASTY(file));
  await expectFirstPage(page);
  await armGanti(page);
}

// Tap the page at the PDF-space point where the word sits, in view coordinates.
async function tapWord(page) {
  const el = page.locator('.pv-page').first();
  const box = await el.boundingBox();
  // MediaBox is 595x842 and the raster preserves it, so a PDF point maps by
  // ratio. PDF y counts up from the bottom; the view counts down from the top.
  const sx = box.width / 595;
  const sy = box.height / 842;
  await page.mouse.click(box.x + (WORD.x + 30) * sx, box.y + (842 - WORD.y - 4) * sy);
}

test.describe('invisible OCR text layer', () => {
  test('a searchable scan is still a SCAN — Edit declines and offers the scan route', async ({ page }) => {
    await open(page, 'scan-ocr.pdf');
    await tapWord(page);

    // The words on this page are pixels. There is nothing here Edit can cut,
    // so it must route to the scan offer exactly as it does for a bare scan.
    await expect(page.locator('#scan-offer')).toBeVisible();
  });

  test('CONTROL: the same file with visible text edits normally — one byte apart', async ({ page }) => {
    await open(page, 'scan-ocr-terlihat.pdf');
    await tapWord(page);

    // Real text: no offer, and the line opens for editing. If this ever fails
    // together with the test above, the code stopped editing ANY text rather
    // than learning to read render mode — a green pair would be meaningless.
    await expect(page.locator('#scan-offer')).toBeHidden();
    await expect(page.locator('.v2-text-edit')).toBeVisible();
  });
});
