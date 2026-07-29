/*
 * THE ROUND TRIP: a file WE OCR is a file we will later be asked to EDIT.
 * ============================================================================
 * tests/ocr-layer-writer.spec.js proves a fact about the FILE: PDF.js reports
 * no visible text and the words are extractable. That is not the same as a fact
 * about the PRODUCT'S BEHAVIOUR on that file, and the gap between those two is
 * exactly where the 2026-07-28 incident lived.
 *
 * So this feeds our own output back through our own front door and asks the
 * only question that matters: **when the user opens a document we made
 * searchable and taps Edit, does the editor DECLINE?**
 *
 * If it does not, we have manufactured the incident ourselves, at scale, on
 * every document we "helped": Edit cuts show-ops that were never visible (no
 * visible change, they were invisible), stamps the replacement over an
 * untouched scan image, and the original stays on the page beside the new text.
 *
 * ⭐ WHY THE VISIBLE TWIN IS THE WHOLE TEST. "The editor declined" passes for
 * free against an editor that declines everything, a writer that emits nothing,
 * and a probe that can only return false. The control writes THE SAME WORDS,
 * through THE SAME writer, at THE SAME coordinates, with one operand changed
 * (3 Tr -> 0 Tr), and demands the OPPOSITE behaviour. Only the pair has power.
 *
 * (An earlier attempt at this control rewrote the operand inside the finished,
 * flate-compressed PDF and produced a file with no text at all. A control that
 * fails for its own reasons looks exactly like the finding. The render-mode
 * seam in core/ocr-layer.js exists so the twin goes through the real path.)
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { armGanti } from './helpers/lines.js';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NASTY = (n) => path.join(__dirname, 'fixtures', 'nasty', n);
const OUT = path.join(__dirname, '..', 'test-results', 'ocr-roundtrip');

// Positioned over the letterhead lines of scan-bersih.pdf, which is rendered
// from surat-resmi.pdf, so these sit where words visibly are.
const WORDS = [
  { text: 'Yang', x: 72, y: 690, w: 30, h: 11 },
  { text: 'bertanda', x: 105, y: 690, w: 52, h: 11 },
  { text: 'tangan', x: 160, y: 690, w: 42, h: 11 },
  { text: 'Budi', x: 72, y: 640, w: 26, h: 11 },
  { text: 'Santoso', x: 101, y: 640, w: 46, h: 11 },
];

// Produce an OCR'd document through the REAL writer, at the given render mode,
// and drop it on disk so the app can open it like any other file.
async function makeOcrPdf(page, renderMode, outName) {
  const src = fs.readFileSync(NASTY('scan-bersih.pdf')).toString('base64');
  const b64 = await page.evaluate(async ({ s, mode, words }) => {
    const { ensurePdfLib } = await import('/js/core/vendor.js');
    await ensurePdfLib();
    const { writeInvisibleTextLayer } = await import('/js/core/ocr-layer.js');
    const bin = atob(s);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const out = await writeInvisibleTextLayer(
      u, [{ pageIndex: 0, words }], { PDFLib: window.PDFLib }, { renderMode: mode },
    );
    let str = '';
    for (let i = 0; i < out.bytes.length; i++) str += String.fromCharCode(out.bytes[i]);
    return { b64: btoa(str), written: out.written };
  }, { s: src, mode: renderMode, words: WORDS });

  expect(b64.written, 'the writer produced no words, so the round trip proves nothing').toBe(WORDS.length);
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, outName);
  fs.writeFileSync(file, Buffer.from(b64.b64, 'base64'));
  return file;
}

// Open a document and tap where the words are, with Edit armed.
async function tapWithEditArmed(page, file) {
  await page.goto('/');
  await page.setInputFiles('#file-input', file);
  await expectFirstPage(page);
  await armGanti(page);
  const box = await page.locator('.pv-page').first().boundingBox();
  const dims = await page.evaluate(() => {
    const p = window.v2.getDoc().pages[0];
    return { w: p.width, h: p.height };
  });
  // PDF space is bottom-left; the view is top-left.
  const sx = box.width / dims.w;
  const sy = box.height / dims.h;
  await page.mouse.click(box.x + (WORDS[0].x + 15) * sx, box.y + (dims.h - WORDS[0].y - 5) * sy);
  await page.waitForTimeout(600);
}

test.describe('a document WE made searchable, opened in OUR editor', () => {
  test('Edit DECLINES it, exactly as it declines any other scan', async ({ page }) => {
    await page.goto('/');
    const file = await makeOcrPdf(page, 3, 'ocr-invisible.pdf');
    await tapWithEditArmed(page, file);

    // The words on this page are still pixels. Our layer added searchability,
    // not editable text, and the editor must know the difference.
    await expect(
      page.locator('#scan-offer'),
      'Edit did NOT decline a document we OCR\'d ourselves. It will cut invisible show-ops and stamp '
      + 'the replacement over an untouched scan image, leaving the original beside the new text. '
      + 'That is the 2026-07-28 incident, manufactured by us, on every file we made searchable.',
    ).toBeVisible();

    // And it must not have silently armed anything on the user's behalf.
    expect(await page.evaluate(() => window.v2.getTool())).toBe('ganti');
  });

  test('CONTROL: the same words written VISIBLE do NOT decline', async ({ page }) => {
    // One operand apart. If this also declines, the assertion above is blind to
    // render mode and the pair proves nothing.
    await page.goto('/');
    const file = await makeOcrPdf(page, 0, 'ocr-visible.pdf');
    await tapWithEditArmed(page, file);

    await expect(
      page.locator('#scan-offer'),
      'flipping the layer to VISIBLE did not change the editor\'s behaviour, so the decline above '
      + 'is not evidence of anything',
    ).toBeHidden();
  });
});
