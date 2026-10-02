/*
 * Hapus on a RECOGNISED scan line (founder ruling 2026-10-02, scan half).
 * A scan has no show-ops to cut, so the deletion is the same Tip-Ex patch Edit
 * would place, painted in the sampled paper, with no text over it. It exists
 * only on a page the person already recognised through Edit (Hapus never
 * downloads the 5 MB engine). Real engine, real scan, like ocr-tap-edit.spec.js.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function inkOf(page, buf) {
  return page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const cv = document.createElement('canvas');
    cv.width = bmp.width; cv.height = bmp.height;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(bmp, 0, 0);
    const d = cx.getImageData(0, 0, cv.width, cv.height).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 120 && d[i + 1] < 120 && d[i + 2] < 120) dark += 1;
    return dark;
  }, buf.toString('base64'));
}

test('Hapus on a recognised scan line patches it with paper; undo brings the ink back', async ({ page }) => {
  test.setTimeout(150000);
  await page.goto('/');
  await page.setInputFiles('#file-input', path.join(__dirname, 'fixtures', 'nasty', 'scan-bersih.pdf'));
  await expectFirstPage(page);
  const pageId = await page.evaluate(() => window.v2.getDoc().pages[0].id);
  await page.evaluate((id) => window.v2.runOcrOnPage(id), pageId);
  await page.waitForFunction((id) => window.v2.ocrIndex.hasLines(id), pageId, { timeout: 90000 });

  const box = async () => page.evaluate((id) => {
    const line = window.v2.ocrIndex.getLines(id).filter((l) => l.w > 150 && l.str.trim().length > 12)[1];
    const view = document.querySelector(`.pv-page[data-page-id="${id}"]`);
    const sc = document.getElementById('v2-scroll');
    let r = view.getBoundingClientRect();
    const sy = r.height / view.offsetHeight;
    const scr = sc.getBoundingClientRect();
    sc.scrollTop += r.top + (line.y + line.h / 2) * sy - (scr.top + scr.height / 2);
    r = view.getBoundingClientRect();
    const sx = r.width / view.offsetWidth;
    const sy2 = r.height / view.offsetHeight;
    return { x: r.left + line.x * sx, y: r.top + line.y * sy2, w: line.w * sx, h: line.h * sy2 };
  }, pageId);
  const shot = async () => {
    const b = await box();
    return page.screenshot({ clip: { x: Math.floor(b.x), y: Math.floor(b.y), width: Math.ceil(b.w), height: Math.ceil(b.h) } });
  };

  const before = await inkOf(page, await shot());
  expect(before, 'no ink in the recognised line, so the crop proves nothing').toBeGreaterThan(100);

  await page.click('#btn-delete-anno');
  expect(await page.evaluate(() => window.v2.getTool())).toBe('delete');
  const b = await box();
  await page.mouse.click(b.x + b.w / 2, b.y + b.h / 2);

  await expect.poll(async () => inkOf(page, await shot()), { timeout: 15000 }).toBeLessThan(before * 0.05);
  const annos = await page.evaluate(() => window.v2.getDoc().pages[0].annotations
    .map((a) => ({ t: a.type, ocr: !!a.ocrBox, cut: !!a.replaceTargets, paper: !!a.paperImage })));
  // A patch with no text over it, and NEVER surgery intent (that field points the cutter at real text).
  expect(annos).toEqual([{ t: 'whiteout', ocr: true, cut: false, paper: true }]);
  expect(await page.evaluate(() => window.v2.getTool())).toBe('delete');

  await page.click('#btn-undo');
  await expect.poll(async () => inkOf(page, await shot()), { timeout: 15000 }).toBeGreaterThan(before * 0.9);
});
