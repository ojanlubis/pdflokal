/*
 * "Pisah PDF" everywhere — one tool, one name.
 * ============================================================================
 * The split-pages tool carried two names: the homepage tool card and its
 * JSON-LD featureList entry said "Split PDF" (English, inside an
 * otherwise-Indonesian card set), while the footer link and pisah-pdf.html's
 * own content already said "Pisah PDF". Bench brief 2026-08-14: make it
 * "Pisah PDF" everywhere — the tool card, the footer, and any generated SEO
 * page that carries it (via `npm run seo`, never hand-edited).
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

test.describe('Pisah PDF — one name, everywhere', () => {
  test('homepage: the tool card under "Lihat semua alat" reads "Pisah PDF"', async ({ page }) => {
    await page.goto('/');
    await page.click('#ld-lihat'); // the accordion the split card lives behind
    const card = page.locator('.ld-card[data-intent="split"]');
    await expect(card).toBeVisible();
    await expect(card.locator('b')).toHaveText('Pisah PDF');
    await expect(card).toHaveAttribute('href', '/pisah-pdf');
  });

  test('homepage: the footer link already said "Pisah PDF" — still does', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('a[href="/pisah-pdf"]').last()).toHaveText('Pisah PDF');
  });

  test('homepage: the JSON-LD featureList carries "Pisah PDF", not "Split PDF"', async ({ page }) => {
    await page.goto('/');
    const featureList = await page.evaluate(() => {
      const scripts = [...document.querySelectorAll('script[type="application/ld+json"]')];
      for (const s of scripts) {
        try {
          const data = JSON.parse(s.textContent);
          if (Array.isArray(data.featureList)) return data.featureList;
        } catch { /* not this one */ }
      }
      return null;
    });
    expect(featureList, 'no featureList found in any JSON-LD block — the scan broke').not.toBeNull();
    expect(featureList).toContain('Pisah PDF');
    expect(featureList).not.toContain('Split PDF');
  });

  test('old wing (alat-gambar.html): the tool card reads "Pisah PDF"', async ({ page }) => {
    await page.goto('/alat-gambar.html');
    await expect(page.locator('.tool-card h3', { hasText: 'Pisah PDF' })).toBeVisible();
  });

  test('every generated SEO page propagates the fix — none carries "Split PDF" anywhere', async () => {
    // The generator (scripts/gen-seo-pages.js) templates the BODY HALF from
    // index.html — a stale generated file is a distinct failure from a wrong
    // source (CLAUDE.md: "seo:check cannot catch a bug in the generator...
    // render a page before believing it"), so this reads the actual files on
    // disk rather than trusting `npm run seo` having been run.
    const generated = [
      'gabung-pdf.html', 'kompres-pdf.html', 'pisah-pdf.html', 'tanda-tangan-pdf.html',
      'pdf-ke-jpg.html', 'jpg-ke-pdf.html', 'edit-pdf.html', 'hapus-halaman-pdf.html',
      'kompres-pdf-500kb.html', 'kompres-pdf-1mb.html', 'kompres-pdf-200kb.html', 'kompres-pdf-100kb.html',
    ];
    for (const name of generated) {
      const html = fs.readFileSync(path.join(ROOT, name), 'utf8');
      expect(html, `${name} still contains "Split PDF"`).not.toContain('Split PDF');
      expect(html, `${name} lost the "Pisah PDF" tool card link entirely`).toContain('Pisah PDF');
    }
  });
});
