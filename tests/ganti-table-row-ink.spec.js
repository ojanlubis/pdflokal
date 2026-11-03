/*
 * PDFLokal — an Edit in a tight table row keeps its ink (feedback 100493).
 *
 * "kok ilang" (2026-10-23): an edited "Rp7.000,00" turned to blank paper in the
 * re-baked page. The ink colour is read off the line box, measured against the
 * paper; the paper was read just outside the box, and in a tight invoice row
 * that is where the row's rules are. Read on the rules, the paper was black, so
 * the cover became a black slab and the "ink" became the box's white paper:
 * the replacement was stamped white on white. core/color-sample.js now takes
 * the box's own ground as the paper (a line's box is mostly paper).
 *
 * The fixture places the rules exactly where paperPoints reads, 3pt outside the
 * box text-runs.js builds (descender -0.25em to ascent 1em, plus a 6% pad).
 */
import { test, expect } from '@playwright/test';
import { downloadBytes } from './helpers/download-bytes.js';
import { armGanti, tapLine } from './helpers/lines.js';

const SIZE = 10;
const BASE = 700;
const PAD = SIZE * 0.06;
const RULE_TOP = BASE + SIZE + PAD + 3;          // PDF y, 3pt above the box
const RULE_BOTTOM = BASE - SIZE * 0.25 - PAD - 3; // 3pt below it

const luminance = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
};

async function openRow(page) {
  await page.goto('/');
  await page.addScriptTag({ url: '/js/vendor/pdf-lib.min.js' });
  const bytes = await page.evaluate(async ({ SIZE, BASE, RULE_TOP, RULE_BOTTOM }) => {
    const L = window.PDFLib;
    const d = await L.PDFDocument.create();
    const font = await d.embedFont(L.StandardFonts.Helvetica);
    const p = d.addPage([595, 842]);
    for (const y of [RULE_TOP, RULE_BOTTOM]) {
      p.drawLine({ start: { x: 40, y }, end: { x: 555, y }, thickness: 1.5, color: L.rgb(0, 0, 0) });
    }
    p.drawText('Total biaya', { x: 72, y: BASE, size: SIZE, font });
    p.drawText('Rp7.000,00', { x: 400, y: BASE, size: SIZE, font });
    return Array.from(await d.save());
  }, { SIZE, BASE, RULE_TOP, RULE_BOTTOM });
  await page.setInputFiles('#file-input', { name: 'nota.pdf', mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  await expect(page.locator('.pv-page')).toHaveCount(1);
}

test('an edited number between table rules keeps dark ink, on screen and in the download', async ({ page }) => {
  await openRow(page);
  await armGanti(page);
  await tapLine(page, { str: 'Rp7' });
  await page.waitForTimeout(500); // the async colour sampler lands on the draft
  const cover = await page.evaluate(() => window.v2.getDoc().pages[0].annotations.find((a) => a.type === 'whiteout').color);
  expect(luminance(cover), `the cover is the cell's white, not a black slab (${cover})`).toBeGreaterThan(200);
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Rp8.500,00');
  await page.keyboard.press('Enter');
  await expect(page.locator('.v2-text-edit')).toHaveCount(0);
  const ink = await page.evaluate(() => window.v2.getDoc().pages[0].annotations.find((a) => a.type === 'text').color);
  expect(luminance(ink), `the replacement's ink is dark, not the paper (${ink})`).toBeLessThan(80);

  // The download: the new number is in the file, painted in that dark ink.
  await page.click('#btn-download');
  const { buf } = await downloadBytes(page, () => page.click('#ds-cta'));
  const painted = await page.evaluate(async (arr) => {
    const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(arr) }).promise;
    const pg = await doc.getPage(1);
    const ol = await pg.getOperatorList();
    const { OPS } = window.pdfjsLib;
    let fill = '#000000';
    const out = [];
    for (let i = 0; i < ol.fnArray.length; i++) {
      if (ol.fnArray[i] === OPS.setFillRGBColor) {
        // pdf.js hands either a ready hex string or the three channel numbers.
        const a = ol.argsArray[i];
        fill = typeof a[0] === 'string' ? a[0]
          : `#${a.slice(0, 3).map((v) => Math.round(v <= 1 ? v * 255 : v).toString(16).padStart(2, '0')).join('')}`;
      }
      if (ol.fnArray[i] === OPS.showText) out.push({ s: ol.argsArray[i][0].map((g) => (g && g.unicode) || '').join(''), fill });
    }
    return out;
  }, Array.from(buf));
  const stamped = painted.find((t) => t.s.includes('8.500'));
  expect(stamped, `the new number is in the file (${JSON.stringify(painted)})`).toBeTruthy();
  expect(luminance(stamped.fill), `painted in ${stamped.fill}`).toBeLessThan(80);
  expect(painted.some((t) => t.s.includes('7.000')), 'the old number is gone').toBe(false);
});
