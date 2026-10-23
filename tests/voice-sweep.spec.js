/*
 * The 2026-10-06 voice sweep: nobody on a live page says "saya" any more (his
 * ruling: what he says to users is in his texting voice; the tool pages and
 * /privasi are PDFLokal speaking, calm). A user speaking would be the one
 * allowed exception, and no FAQ question uses it today, so the check is flat.
 * Visible text only: comments, the dated work log and the legacy wing are not
 * what a visitor reads here.
 *
 * AND THE ONE FACT FIX: tanda-tangan-pdf used to say the signature vanishes when
 * the tab closes. Since the opt-in "Simpan tanda tangan" checkbox shipped
 * (cb351d0) that is false for anyone who ticks it. The page must name the
 * checkbox by its real on-screen label.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PAGES = ['/', '/privasi', '/dukung', '/gabung-pdf', '/kompres-pdf', '/kompres-pdf-1mb', '/kompres-pdf-500kb',
  '/kompres-pdf-200kb', '/kompres-pdf-100kb', '/pisah-pdf', '/tanda-tangan-pdf', '/jpg-ke-pdf', '/pdf-ke-jpg',
  '/edit-pdf', '/hapus-halaman-pdf'];

test.use({ serviceWorkers: 'block' });

for (const url of PAGES) {
  test(`${url}: no "saya" in what a visitor reads`, async ({ page }) => {
    await page.goto(url);
    // textContent, not innerText: closed <details> (FAQ) and the burger drawer are still copy
    const text = await page.evaluate(() => {
      const c = document.body.cloneNode(true);
      c.querySelectorAll('script, style, template').forEach((n) => n.remove());
      const attrs = [...c.querySelectorAll('[title],[aria-label],[placeholder]')]
        .map((n) => [n.getAttribute('title'), n.getAttribute('aria-label'), n.getAttribute('placeholder')].join(' '));
      return `${c.textContent} ${attrs.join(' ')} ${document.title}`;
    });
    const m = text.match(/\b[Ss]aya\b/g);
    // the dated work log on /dukung quotes what the product once said (a record, not a voice)
    const allowed = url === '/dukung' ? 1 : 0;
    expect(m?.length ?? 0, `"saya" on ${url}`).toBeLessThanOrEqual(allowed);
  });
}

test('footer link reads "Dukung PDFLokal" on the live pages', async ({ page }) => {
  for (const url of ['/', '/privasi', '/dukung', '/kompres-pdf']) {
    await page.goto(url);
    await expect(page.locator('.ld-foot a[href="/dukung"], footer a[href="/dukung"]').first(), url).toHaveText('Dukung PDFLokal');
  }
});

test('tanda-tangan-pdf: the signature claim names the real checkbox and no longer says it vanishes', async ({ page }) => {
  const label = /<label class="sig-check"><input type="checkbox" id="sig-save">\s*([^<]+)<\/label>/
    .exec(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'))?.[1].trim();
  expect(label, 'the checkbox label in index.html').toBeTruthy();
  await page.goto('/tanda-tangan-pdf');
  const copy = await page.locator('.ld-copy, .ld-faq').evaluateAll((els) => els.map((e) => e.textContent).join(' '));
  expect(copy).toContain(`"${label}"`);
  expect(copy).not.toMatch(/lenyap saat kamu menutup tab|hilang saat kamu menutup halaman/);
  expect(copy).not.toMatch(/tidak saya simpan/);
});
