// A font the user brings (his call 2026-11-27; core/user-fonts.js). Picked from
// the font list, it paints on screen, lands in the file, and is still in the
// list after a reload: kept in this browser only. Served with the PRODUCTION
// CSP (vercel.json), because font-src 'self' is the one rule that could stop
// a FontFace made from file bytes, and the test server sends no CSP at all.
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PDF = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');
const TTF = path.join(__dirname, 'fixtures', 'carlito-latin.ttf');
const VERCEL = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
const CSP = VERCEL.headers.flatMap((h) => h.headers).find((x) => x.key === 'Content-Security-Policy').value;

test.beforeEach(async ({ page }) => {
  await page.route('**/*', async (route) => {
    const res = await route.fetch();
    const isDoc = route.request().resourceType() === 'document';
    await route.fulfill({ response: res, headers: isDoc ? { ...res.headers(), 'content-security-policy': CSP } : res.headers() });
  });
});

async function placeText(page) {
  await page.goto('/');
  await page.setInputFiles('#file-input', PDF);
  await expectFirstPage(page);
  await page.click('[data-tool="text"]');
  await page.click('.pv-page >> nth=0', { position: { x: 120, y: 180 } });
  await page.keyboard.type('Font sendiri');
  await page.keyboard.press('Enter');
}

test('a brought TTF paints on screen under the production CSP, embeds in the file, and is kept', async ({ page }) => {
  const cspErrors = [];
  page.on('console', (m) => { if (/Content Security Policy|font-src/i.test(m.text())) cspErrors.push(m.text()); });
  await placeText(page);
  const sel = page.locator('#format-bar .fb-font');
  await expect(sel.locator('option[value="__add-font__"]')).toHaveText('+ Font sendiri…');
  const chooser = page.waitForEvent('filechooser');
  await sel.selectOption('__add-font__');
  await (await chooser).setFiles(TTF);

  const anno = page.locator('.pv-anno-text');
  await expect.poll(() => page.evaluate(() => window.v2.getDoc().pages[0].annotations[0].fontFamily)).toMatch(/^user:/);
  await expect(anno).toHaveCSS('font-family', /pdflokal-user-/);
  // Landing, not presence: the browser really has the face, not a fallback.
  const key = await page.evaluate(() => window.v2.getDoc().pages[0].annotations[0].fontFamily);
  const css = 'pdflokal-user-' + key.slice('user:'.length);
  expect(await page.evaluate((c) => document.fonts.check(`16px "${c}"`, 'F'), css)).toBe(true);
  expect(await page.evaluate((c) => [...document.fonts].some((f) => f.family.replace(/"/g, '') === c && f.status === 'loaded'), css)).toBe(true);
  await expect(page.locator('#format-bar .fb-bold')).toBeDisabled();
  expect(cspErrors).toEqual([]);

  // The file: built through the ONE browser export edge (js/v2/pdf-builder.js),
  // which must hand core/export.js this browser's copy of the font.
  const fileFonts = await page.evaluate(async () => {
    const { buildPdfArtifact } = await import('/js/v2/pdf-builder.js');
    const { bytes, fontFallback } = await buildPdfArtifact(window.v2.getDoc());
    const out = await window.PDFLib.PDFDocument.load(bytes);
    const names = [];
    for (const [, obj] of out.context.enumerateIndirectObjects()) {
      const t = obj?.get?.(window.PDFLib.PDFName.of('Type'));
      if (t && String(t) === '/Font') names.push(String(obj.get(window.PDFLib.PDFName.of('BaseFont'))));
    }
    return { names, fontFallback };
  });
  expect(fileFonts.fontFallback).toBe(false);
  expect(fileFonts.names.join(' ')).toMatch(/Carlito/);

  // Kept: after a reload it is in the list, under its own name.
  await page.reload();
  await page.setInputFiles('#file-input', PDF);
  await expectFirstPage(page);
  await page.click('[data-tool="text"]');
  await expect(page.locator(`#format-bar .fb-font option[value="${key}"]`)).toHaveText(/Carlito/);
});

test('a file that is not a font says so and changes nothing', async ({ page }) => {
  await placeText(page);
  const before = await page.evaluate(() => window.v2.getDoc().pages[0].annotations[0].fontFamily);
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#format-bar .fb-font').selectOption('__add-font__');
  await (await chooser).setFiles(PDF);
  await expect(page.locator('#toast')).toHaveText('File ini bukan font. Pilih file .ttf atau .otf');
  expect(await page.evaluate(() => window.v2.getDoc().pages[0].annotations[0].fontFamily)).toBe(before);
  await expect(page.locator('#format-bar .fb-font')).toHaveValue(before);
});
