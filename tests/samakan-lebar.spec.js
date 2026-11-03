/*
 * PDFLokal — "Samakan lebar": one width for every page, on the user's word.
 *
 * Founder rulings 2026-11-03 (js/v2/even-widths.js holds them in full):
 *   - a single file with mixed widths is never changed unasked: ONE offer,
 *     once per opened document; Esc / outside / "Nanti aja" keep it as is;
 *   - evening anchors on page 1, ratio kept; a toast says so with ONE action,
 *     "Kembalikan"; undo/redo treat it as one step;
 *   - a merge still evens by itself and now says so, with the same way back;
 *   - Kelola Halaman shows TRUE relative widths, and a row that offers
 *     Samakan / Kembalikan; on a 667px phone the grid scrolls, the footer stays;
 *   - an Edit (Ganti) on an evened page lands where it was in the download.
 * Copy is the seat's, verbatim.
 */
import { test, expect } from '@playwright/test';
import { downloadBytes } from './helpers/download-bytes.js';
import { armGanti, tapLine } from './helpers/lines.js';

const A5 = [420, 595];
const A4 = [595, 842];

// A PDF built in the page with the vendored pdf-lib: `pages` is a list of
// [w, h, text?] with the text at 20% in, 30% down.
async function buildPdf(page, pages) {
  if (!(await page.evaluate(() => Boolean(window.PDFLib)))) await page.addScriptTag({ url: '/js/vendor/pdf-lib.min.js' });
  return Buffer.from(await page.evaluate(async (specs) => {
    const L = window.PDFLib;
    const d = await L.PDFDocument.create();
    const font = await d.embedFont(L.StandardFonts.Helvetica);
    for (const [w, h, text] of specs) {
      const p = d.addPage([w, h]);
      p.drawRectangle({ x: 4, y: 4, width: w - 8, height: h - 8, borderColor: L.rgb(0.6, 0.6, 0.6), borderWidth: 2 });
      if (text) p.drawText(text, { x: w * 0.2, y: h * 0.7, size: 14, font });
    }
    return Array.from(await d.save());
  }, pages));
}

async function open(page, pages, name = 'lebar.pdf') {
  const buffer = await buildPdf(page, pages);
  await page.setInputFiles('#file-input', { name, mimeType: 'application/pdf', buffer });
  await expect(page.locator('.pv-page')).toHaveCount(pages.length);
}
const widths = (page) => page.evaluate(() => window.v2.getDoc().pages.map((p) => Math.round(p.width)));
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

test.describe('the offer on open', () => {
  test('a single file with mixed widths is asked once, in the seat\'s words, and not changed unasked', async ({ page }) => {
    await page.goto('/');
    await open(page, [A5, A4, A4]);
    const offer = page.locator('#even-offer');
    await expect(offer).toBeVisible();
    await expect(offer.locator('#eo-title')).toHaveText('Lebar halamannya beda-beda');
    await expect(offer.locator('#eo-body')).toHaveText('Ukuran lebar halaman beda-beda. Mau disamakan? Lebarnya akan mengikuti halaman pertama semua. Isi halaman ikut menyesuaikan.');
    await expect(offer.locator('#eo-go')).toHaveText('Samakan lebar');
    await expect(offer.locator('#eo-later')).toHaveText('Nanti aja');
    await page.keyboard.press('Escape');
    await expect(offer).toBeHidden();
    expect(await widths(page)).toEqual([420, 595, 595]);
    // Once per document: opening and closing Halaman does not bring it back.
    await page.click('#btn-pages');
    await expect(page.locator('#pm-sheet')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(offer).toBeHidden();
  });

  test('a tap outside the card keeps the document as it is', async ({ page }) => {
    await page.goto('/');
    await open(page, [A5, A4]);
    await expect(page.locator('#even-offer')).toBeVisible();
    await page.mouse.click(5, 5);
    await expect(page.locator('#even-offer')).toBeHidden();
    expect(await widths(page)).toEqual([420, 595]);
  });

  test('a uniform document is never asked', async ({ page }) => {
    await page.goto('/');
    await open(page, [A4, A4]);
    await page.waitForTimeout(400);
    await expect(page.locator('#even-offer')).toBeHidden();
  });

  test('the offer stands down when another dialog is already up (Kelola Halaman from /pisah-pdf)', async ({ page }) => {
    await page.goto('/pisah-pdf');
    await open(page, [A5, A4]);
    await expect(page.locator('#pm-sheet')).toBeVisible();
    await expect(page.locator('#even-offer')).toBeHidden();
  });
});

test.describe('evening and the way back', () => {
  test('Samakan lebar evens to page 1, the toast offers Kembalikan, and it restores', async ({ page }) => {
    await page.goto('/');
    await open(page, [A5, A4, A4]);
    await page.click('#eo-go');
    expect(await widths(page)).toEqual([420, 420, 420]);
    const toast = page.locator('#toast');
    await expect(toast).toContainText('Lebar halaman sudah disamakan.');
    await expect(toast.locator('.toast-action')).toHaveText('Kembalikan');
    await toast.locator('.toast-action').click();
    expect(await widths(page)).toEqual([420, 595, 595]);
  });

  test('evening is one undo step, and redo evens again', async ({ page }) => {
    await page.goto('/');
    await open(page, [A5, A4, A4]);
    await page.click('#eo-go');
    expect(await widths(page)).toEqual([420, 420, 420]);
    await page.keyboard.press(`${MOD}+z`);
    expect(await widths(page)).toEqual([420, 595, 595]);
    await page.keyboard.press(`${MOD}+Shift+z`);
    expect(await widths(page)).toEqual([420, 420, 420]);
  });

  test('a merge still evens by itself, and says so with the same Kembalikan', async ({ page }) => {
    await page.goto('/');
    await open(page, [A4], 'a.pdf');
    await expect(page.locator('#even-offer')).toBeHidden();
    const more = await buildPdf(page, [A5]);
    await page.setInputFiles('#file-input', { name: 'b.pdf', mimeType: 'application/pdf', buffer: more });
    await expect(page.locator('.pv-page')).toHaveCount(2);
    expect(await widths(page)).toEqual([595, 595]);
    const toast = page.locator('#toast');
    await expect(toast).toContainText('sekarang 2 halaman. Lebar halaman sudah disamakan.');
    await toast.locator('.toast-action').click();
    expect(await widths(page)).toEqual([595, 420]);
    await expect(page.locator('#even-offer')).toBeHidden(); // a merge is never asked, only told
  });
});

test.describe('Kelola Halaman', () => {
  async function openSheet(page) {
    await page.click('#btn-pages');
    await expect(page.locator('#pm-sheet')).toBeVisible();
  }

  test('tiles show true relative widths, and the row evens and restores', async ({ page }) => {
    await page.goto('/');
    await open(page, [A5, A4, A4]);
    await page.click('#eo-later');
    await openSheet(page);
    const tileWidths = () => page.$$eval('#pm-grid .pm-tile:not(.pm-add)', (ts) => ts.map((t) => t.getBoundingClientRect().width));
    const [a5, a4] = await tileWidths();
    expect(a5 / a4).toBeCloseTo(420 / 595, 2);

    const row = page.locator('#pm-widths');
    await expect(row).toBeVisible();
    await expect(row.locator('.pm-widths-note')).toHaveText('Lebar halaman beda-beda');
    await expect(row.locator('.pm-widths-act')).toHaveText('Samakan');
    await row.locator('.pm-widths-act').click();
    expect(await widths(page)).toEqual([420, 420, 420]);
    await expect(row.locator('.pm-widths-note')).toHaveText('Lebar halaman sudah disamakan');
    await expect(row.locator('.pm-widths-act')).toHaveText('Kembalikan');
    const even = await tileWidths();
    expect(even[0]).toBeCloseTo(even[1], 0);
    await row.locator('.pm-widths-act').click();
    expect(await widths(page)).toEqual([420, 595, 595]);
  });

  test('a uniform document shows no widths row', async ({ page }) => {
    await page.goto('/');
    await open(page, [A4, A4]);
    await openSheet(page);
    await expect(page.locator('#pm-widths')).toBeHidden();
  });

  test('on a 667px phone the grid scrolls and the footer stays on screen', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/');
    await open(page, Array.from({ length: 14 }, (_, i) => (i % 2 ? A4 : A5)));
    await page.click('#eo-later');
    await openSheet(page);
    const m = await page.evaluate(() => {
      const g = document.getElementById('pm-grid');
      const bulk = document.getElementById('pm-bulk').getBoundingClientRect();
      return { scrolls: g.scrollHeight > g.clientHeight + 1, bulkBottom: bulk.bottom, bulkTop: bulk.top, vh: innerHeight };
    });
    expect(m.scrolls, 'the grid scrolls inside the sheet').toBe(true);
    expect(m.bulkBottom).toBeLessThanOrEqual(m.vh);
    expect(m.bulkTop).toBeGreaterThan(0);
  });
});

test('an Edit on an evened page lands where it was, in the download', async ({ page }) => {
  await page.goto('/');
  await open(page, [[...A5, 'Halaman satu'], [...A4, 'Halo Budi Santoso']]);
  await page.click('#eo-go');
  expect(await widths(page)).toEqual([420, 420]);
  await armGanti(page);
  await tapLine(page, { str: 'Budi', pageIndex: 1 });
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Halo Rina Wati');
  await page.keyboard.press('Enter');
  await expect(page.locator('.v2-text-edit')).toHaveCount(0);

  await page.click('#btn-download');
  const { buf } = await downloadBytes(page, () => page.click('#ds-cta'));
  const p2 = await page.evaluate(async (arr) => {
    const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(arr) }).promise;
    const p = await doc.getPage(2);
    const vp = p.getViewport({ scale: 1 });
    const items = (await p.getTextContent()).items.filter((it) => it.str.trim()).map((it) => {
      const [x, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
      return { str: it.str, fx: x / vp.width, fy: y / vp.height };
    });
    return { w: vp.width, items };
  }, Array.from(buf));
  expect(p2.w).toBeCloseTo(420, 0); // the file's page 2 is evened, like the screen
  const all = p2.items.map((i) => i.str).join(' | ');
  expect(all, 'the old words are gone').not.toContain('Budi');
  const now = p2.items.find((i) => i.str.includes('Rina'));
  expect(now, `the new words are in the file (${all})`).toBeTruthy();
  expect(now.fx).toBeCloseTo(0.2, 1);
  expect(now.fy).toBeCloseTo(0.3, 1);
});
