/*
 * Shared by tests/hapus-original-delete.spec.js and tests/ganti-empty-delete.spec.js:
 * the "what the person SAW is what the file HOLDS" instruments for deleting a
 * printed line. Fixture undangan-cid.pdf draws LINE three times in a CID font, so
 * a string match cannot prove WHICH line died; pixels of that line's box and a
 * count going 3 -> 2 can.
 */
import { expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { lineBox, centerOf } from './lines.js';
import { expectFirstPage } from './render.js';
import { downloadBytes, inspectPdf } from './download-bytes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const NASTY = (name) => path.join(__dirname, '..', 'fixtures', 'nasty', name);
export const UNDANGAN = NASTY('undangan-cid.pdf');
export const LINE = 'Rapat Anggota Tahunan 2026';

export async function openDoc(page, fixture = UNDANGAN) {
  await page.addInitScript(() => {
    window.__beacons = [];
    navigator.sendBeacon = (url, blob) => {
      Promise.resolve(blob && blob.text ? blob.text() : blob)
        .then((txt) => { try { window.__beacons.push(JSON.parse(txt)); } catch { /* ignored */ } });
      return true;
    };
  });
  await page.goto('/');
  await page.setInputFiles('#file-input', fixture);
  await expectFirstPage(page);
}

// A point on bare paper: the page's left margin, level with the middle repeat.
// (helpers/lines.js's marginPoint answers in the coordinates of wherever the page
// was scrolled when it measured, and came back off-screen here.)
export async function paperPoint(page) {
  const box = await lineBox(page, { str: LINE, nth: 1 });
  const view = await page.locator('.pv-page').first().boundingBox();
  return { x: view.x + 24, y: box.y + box.height / 2 };
}

export const tool = (page) => page.evaluate(() => window.v2.getTool());
export const annos = (page) => page.evaluate(() => window.v2.getDoc().pages[0].annotations
  .map((a) => ({ t: a.type, text: a.text, cut: !!(a.replaceTargets && a.replaceTargets.length), ocr: !!a.ocrBox })));

export async function armHapus(page) {
  await page.click('#btn-delete-anno');
  expect(await tool(page)).toBe('delete');
}

// A tap on a printed line: a real mouse click, or a real touch tap.
export async function tapAt(page, pointer, pt) {
  if (pointer === 'touch') await page.touchscreen.tap(pt.x, pt.y);
  else await page.mouse.click(pt.x, pt.y);
}

// The pixels of one line's box, as the person sees them. The line is re-located
// right before the shot because lineBox scrolls the page toward it.
export async function crop(page, target) {
  const box = await lineBox(page, target);
  const c = centerOf(box);
  const vp = page.viewportSize();
  const clip = {
    x: Math.max(0, Math.floor(box.x - 4)),
    y: Math.max(0, Math.floor(box.y - 2)),
    width: Math.min(vp.width, Math.ceil(box.width + 8)),
    height: Math.ceil(box.height + 4),
  };
  const buf = await page.screenshot({ clip });
  return { buf: buf.toString('base64'), center: c };
}

// Count of dark pixels in a PNG crop (decoded by the browser): "is there ink".
export async function inkOf(page, b64) {
  return page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const cv = document.createElement('canvas');
    cv.width = bmp.width; cv.height = bmp.height;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(bmp, 0, 0);
    const d = cx.getImageData(0, 0, cv.width, cv.height).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 110 && d[i + 1] < 110 && d[i + 2] < 110) dark += 1;
    return dark;
  }, b64);
}

export async function unduh(page) {
  await page.click('#btn-download');
  await expect(page.locator('#dl-sheet')).toBeVisible();
  const { buf } = await downloadBytes(page, () => page.click('#ds-cta'));
  // The sheet closes itself on success; make sure it is gone before the next action.
  await page.keyboard.press('Escape').catch(() => {});
  return inspectPdf(page, buf);
}
export const countIn = (info, s) => info.pages.map((p) => p.text).join('\n').split(s).length - 1;

export async function railHapus(page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => page.evaluate(() => window.__beacons.length)).toBeGreaterThan(0);
  const bodies = await page.evaluate(() => window.__beacons.slice());
  return bodies.flatMap((b) => b.events);
}
export const hapusActions = (evs) => evs.filter((e) => e.event === 'tool_use' && e.props.tool === 'hapus').map((e) => e.props.action);

