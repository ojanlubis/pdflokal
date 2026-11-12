/*
 * His two asks of 2026-11-12, end to end in the real editor:
 *  1. A PICTURE dropped onto an open document asks where it goes: on top of the
 *     page under the drop (a Gambar object, centred on the drop point) or a page
 *     of its own. A PDF in the drop keeps the add-or-replace question.
 *  2. Rata kiri / tengah / kanan: on typed Teks text (sticky like the other
 *     styles), and on an Edit paragraph, where the bar shows alignment only and
 *     an alignment change with the words untouched still commits.
 * Where the lines land in the FILE is tests/core/text-align-export.test.mjs.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { armGanti, tapLine } from './helpers/lines.js';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NASTY = (name) => path.join(__dirname, 'fixtures', 'nasty', name);

// A drop as the browser delivers it: files in a DataTransfer at a viewport point.
async function dropPng(page, { x, y, color = '#cc3333', name = 'gambar.png' }) {
  await page.evaluate(async ({ x, y, color, name }) => {
    const c = document.createElement('canvas');
    c.width = 200; c.height = 120;
    const g = c.getContext('2d');
    g.fillStyle = color; g.fillRect(0, 0, 200, 120);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], name, { type: 'image/png' }));
    document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true }));
  }, { x, y, color, name });
}

async function openPdf(page, name) {
  await page.goto('/');
  await page.setInputFiles('#file-input', NASTY(name));
  await expectFirstPage(page);
}

test('a dropped picture: "Di atas halaman" places it centred on the drop point', async ({ page }) => {
  await openPdf(page, 'paragraf-badan.pdf');
  const box = await page.locator('.pv-page').first().boundingBox();
  const at = { x: box.x + box.width * 0.6, y: box.y + box.height * 0.4 };
  await dropPng(page, at);
  await expect(page.locator('#drop-image-choice')).toBeVisible();
  await expect(page.locator('#drop-choice')).toBeHidden();
  await page.locator('#dic-onpage').click();
  const pic = page.locator('.pv-anno-signature');
  await expect(pic).toHaveCount(1);
  const r = await pic.boundingBox();
  expect(Math.abs(r.x + r.width / 2 - at.x), 'centred on the drop, x').toBeLessThan(2);
  expect(Math.abs(r.y + r.height / 2 - at.y), 'centred on the drop, y').toBeLessThan(2);
  expect(await page.evaluate(() => window.v2.getDoc().pages.length)).toBe(1);
});

test('a dropped picture: "Halaman baru" adds it as a page; a dropped PDF still asks add-or-replace', async ({ page }) => {
  await openPdf(page, 'paragraf-badan.pdf');
  await dropPng(page, { x: 300, y: 300 });
  await page.locator('#dic-newpage').click();
  await expect.poll(() => page.evaluate(() => window.v2.getDoc().pages.length)).toBe(2);
  await expect(page.locator('.pv-anno-signature')).toHaveCount(0);

  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([37, 80, 68, 70])], 'lain.pdf', { type: 'application/pdf' }));
    document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: 300, clientY: 300, bubbles: true, cancelable: true }));
  });
  await expect(page.locator('#drop-choice')).toBeVisible();
  await expect(page.locator('#drop-image-choice')).toBeHidden();
});

test('Teks: rata tengah from the bar lands on the committed text and stays for the next one', async ({ page }) => {
  await openPdf(page, 'paragraf-badan.pdf');
  await page.click('[data-tool="text"]');
  await page.click('.pv-page >> nth=0', { position: { x: 200, y: 200 } });
  await expect(page.locator('.v2-text-edit')).toBeFocused();
  await page.keyboard.type('Baris yang panjang');
  await page.locator('#format-bar .fb-align-btn[data-align="center"]').click();
  await expect(page.locator('.v2-text-edit')).toHaveCSS('text-align', 'center');
  await expect(page.locator('#format-bar .fb-align-btn[data-align="justify"]')).toBeHidden();
  await page.keyboard.press('Enter');
  const anno = await page.evaluate(() => window.v2.getDoc().pages[0].annotations.find((a) => a.type === 'text' && !a.block));
  expect(anno.align).toBe('center');
  await expect(page.locator(`[data-anno-id="${anno.id}"]`)).toHaveCSS('text-align', 'center');
});

test('Edit paragraph: the bar shows alignment only; centring with the words untouched commits', async ({ page }) => {
  await openPdf(page, 'paragraf-badan.pdf');
  await armGanti(page);
  await tapLine(page, { str: 'lingkungan kantor' });
  const ed = page.locator('.v2-text-edit');
  await expect(ed).toHaveAttribute('data-block', 'justify');
  await expect(page.locator('#format-bar')).toHaveClass(/fb-align-only/);
  await expect(page.locator('#format-bar .fb-font')).toBeHidden();
  await expect(page.locator('#format-bar .fb-align-btn[data-align="justify"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#format-bar .fb-align-btn[data-align="center"]').click();
  await expect(ed).toHaveCSS('text-align', 'center');
  await page.keyboard.press('Enter');
  await expect(ed).toHaveCount(0);
  const block = await page.evaluate(() => window.v2.getDoc().pages[0].annotations.find((a) => a.type === 'text')?.block);
  expect(block?.align, 'an alignment-only change is a change, not the untouched-prefill no-op').toBe('center');
});
