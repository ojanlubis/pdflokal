/*
 * The Edit tool says its limits at the moment the person hits them
 * (founder-approved copy, 2026-10-03; rules in js/v2/edit-expectations.js, words
 * in js/locales/id.js). Each message is pinned from both sides: it appears where
 * it should, and the control case says nothing, because a message that appears
 * everywhere would also pass the first half.
 *
 *   toast.notText        Edit armed, tap on a page that HAS text but none there
 *   sheet.coveredNote    Unduh, PDF: a Tip-Ex is still text in the file; Gambar and a
 *                        cut that really worked say nothing; undo leaves no stale note
 *   toast.armEditLocked / armEditSigned   once per document, instead of the beta line
 *   toast.lineNoWrap     typing past the original line's width, once per document
 *   toast duration       scales with the sentence (900 + 330 ms a word, floor 2.6 s)
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';
import { armGanti, tapLine, lineBox, centerOf } from './helpers/lines.js';
import { LINE, openDoc, paperPoint, armHapus, tapAt, annos } from './helpers/original-delete.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NASTY = (n) => path.join(__dirname, 'fixtures', 'nasty', n);
const toast = (page) => page.locator('#toast');
const covered = (page) => page.locator('#ds-covered');

async function openSheet(page) {
  await page.click('#btn-download');
  await expect(page.locator('#dl-sheet')).toBeVisible();
}

async function drawTipEx(page, { x0 = 60, y0 = 150, x1 = 260, y1 = 210 } = {}) {
  await page.click('[data-tool="whiteout"]');
  const box = await page.locator('.pv-page').first().boundingBox();
  await page.mouse.move(box.x + x0, box.y + y0);
  await page.mouse.down();
  await page.mouse.move(box.x + x1, box.y + y1, { steps: 8 });
  await page.mouse.up();
}

test.describe('tap with Edit armed where there is no text', () => {
  test('says what it is and what to use instead; no editor opens', async ({ page }) => {
    await openDoc(page);
    await armGanti(page);
    const pt = await paperPoint(page);
    await page.mouse.click(pt.x, pt.y);
    await expect(toast(page)).toHaveText('Nggak ada teks di situ. Kalau gambar, pakai Tip-Ex.');
    await expect(page.locator('.v2-text-edit')).toHaveCount(0);
  });

  test('CONTROL: a tap ON a line opens the editor and says no such thing', async ({ page }) => {
    await openDoc(page);
    await armGanti(page);
    await tapLine(page, { str: LINE, nth: 1 });
    await expect(toast(page)).not.toContainText('Nggak ada teks');
  });
});

test.describe('Unduh: covered text is still in the file', () => {
  test('a Tip-Ex shows the note on PDF, hides it on Gambar, and shows it again on PDF', async ({ page }) => {
    await openDoc(page);
    await drawTipEx(page);
    await openSheet(page);
    await expect(covered(page)).toBeVisible();
    await expect(covered(page)).toHaveText('Yang ditutup masih ada di file. Buat isi rahasia, unduh sebagai Gambar.');
    await page.click('#ds-format button[data-v="img"]');
    await expect(covered(page)).toBeHidden();
    await page.click('#ds-format button[data-v="pdf"]');
    await expect(covered(page)).toBeVisible();
  });

  test('CONTROL: no Tip-Ex, no note', async ({ page }) => {
    await openDoc(page);
    await openSheet(page);
    await expect(page.locator('#ds-covered')).toBeHidden();
  });

  test('undo leaves no stale note', async ({ page }) => {
    await openDoc(page);
    await drawTipEx(page);
    await page.click('#btn-undo');
    expect(await annos(page)).toEqual([]);
    await openSheet(page);
    await expect(covered(page)).toBeHidden();
  });

  test('CONTROL: Hapus on printed text whose cut WORKED does not warn (nothing is covering it)', async ({ page }) => {
    test.setTimeout(60000);
    await openDoc(page);
    await armHapus(page);
    await tapAt(page, 'mouse', centerOf(await lineBox(page, { str: LINE, nth: 1 })));
    // the cut is real once the bake has resolved and the cover is not painted
    await expect.poll(async () => page.evaluate(() => {
      const p = window.v2.getDoc().pages[0];
      return p.annotations.length > 0 && p.editApplied && p.annotations.every((a) => p.editApplied.has(a.id));
    }), { timeout: 15000 }).toBe(true);
    await openSheet(page);
    // the note follows the build, which is async: wait for the size, then look
    await expect(page.locator('#ds-size button[data-v="asli"]')).toContainText(/MB|KB/);
    await expect(covered(page)).toBeHidden();
  });
});

test.describe('arming Edit on a locked or signed document', () => {
  test('signed: the first arm says so INSTEAD of the beta line, the second is normal', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('#file-input', NASTY('bermeterai.pdf'));
    await expectFirstPage(page);
    await page.click('[data-tool="ganti"]');
    await expect(toast(page)).toHaveText('Ada meterai/TTD digital. Kalau diedit, jadi nggak sah.');
    await page.click('[data-tool="ganti"]'); // disarm
    await page.click('[data-tool="ganti"]');
    await expect(toast(page)).toContainText('fitur beta');
  });

  test('locked: the first arm says edits cannot be downloaded, the second is normal', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('#file-input', NASTY('terkunci-izin.pdf'));
    await expectFirstPage(page);
    await page.click('[data-tool="ganti"]');
    await expect(toast(page)).toHaveText('PDF ini dikunci, hasil edit nggak bisa diunduh.');
    await page.click('[data-tool="ganti"]');
    await page.click('[data-tool="ganti"]');
    await expect(toast(page)).toContainText('fitur beta');
  });

  test('CONTROL: an ordinary PDF gets the beta line the first time', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('#file-input', NASTY('surat-resmi.pdf'));
    await expectFirstPage(page);
    await page.click('[data-tool="ganti"]');
    await expect(toast(page)).toContainText('fitur beta');
  });
});

test.describe('a single line cannot wrap', () => {
  const LONG = ' tambahan teks yang jauh lebih panjang dari baris aslinya supaya melebar';

  test('typing past the original width says so, once per document', async ({ page }) => {
    test.setTimeout(60000);
    await openDoc(page);
    await armGanti(page);
    await tapLine(page, { str: LINE, nth: 1 });
    await page.keyboard.press('End');
    await page.keyboard.type(LONG);
    await expect(toast(page)).toHaveText('Baris ini nggak bisa turun, jadi melebar ke samping.');
    await page.keyboard.press('Enter');
    await expect(page.locator('.v2-text-edit')).toHaveCount(0);

    // the same thing on the next edit in this document stays silent
    await page.evaluate(() => document.getElementById('toast').classList.remove('show'));
    await armGanti(page);
    await tapLine(page, { str: LINE, nth: 2 });
    await page.keyboard.press('End');
    await page.keyboard.type(LONG);
    await page.waitForTimeout(300);
    await expect(toast(page)).not.toHaveClass(/show/);
  });

  test('CONTROL: typing within the original width says nothing', async ({ page }) => {
    await openDoc(page);
    await armGanti(page);
    await tapLine(page, { str: LINE, nth: 1 });
    await page.keyboard.type('Rapat');
    await page.waitForTimeout(300);
    await expect(toast(page)).not.toContainText('nggak bisa turun');
  });
});

test.describe('toast duration', () => {
  test('a long sentence stays up longer than the old 2.6 s', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('#file-input', NASTY('terkunci-izin.pdf'));
    await expectFirstPage(page);
    // timed in the page's own clock, so test-runner latency cannot skew it
    await page.evaluate(() => {
      window.__toastMs = null; window.__t0 = null;
      const el = document.getElementById('toast');
      new MutationObserver(() => {
        const on = el.classList.contains('show');
        if (on && window.__t0 === null) window.__t0 = performance.now();
        if (!on && window.__t0 !== null && window.__toastMs === null) window.__toastMs = performance.now() - window.__t0;
      }).observe(el, { attributes: true, attributeFilter: ['class'] });
    });
    // let the import toast finish first, then arm: 8 words = 900 + 330 * 8 = 3540 ms
    await expect(toast(page)).not.toHaveClass(/show/, { timeout: 10000 });
    await page.evaluate(() => { window.__toastMs = null; window.__t0 = null; });
    await page.click('[data-tool="ganti"]');
    await expect.poll(() => page.evaluate(() => window.__toastMs), { timeout: 10000 }).not.toBeNull();
    const ms = await page.evaluate(() => window.__toastMs);
    expect(ms).toBeGreaterThan(3200);
    expect(ms).toBeLessThan(4200);
  });
});
