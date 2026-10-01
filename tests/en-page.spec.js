/*
 * THE ENGLISH EDITOR (/en), RENDERED.
 * ============================================================================
 * tests/core/en-page.test.mjs proves the generator and the files. This proves
 * what a browser shows: no Indonesian visible anywhere, English from the JS
 * layer too (a toast, the Download sheet), nothing that 404s, the language link
 * on both pages, and that the removed pieces (QRIS, /dukung, the maker card, the
 * Template row) are really gone and nothing that used them throws.
 *
 * ⚠️ THE STOPLIST IS ONLY WORTH ITS HITS: it is first pointed at `/`, which is
 * Indonesian by construction, and must find plenty. A detector that finds
 * nothing on `/` would pass /en for free.
 *
 * Exempt, and only these: the brand pun "Dibuat di Indonesia", the brand, and
 * anything inside a [lang="id"] element in the body (the "Bahasa Indonesia"
 * link; not <html lang="id">, which would exempt every word on `/`).
 *
 * Set EN_SHOT_DIR to also drop a screenshot of /en there (the seat looks).
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');

const STOP = /\b(dan|yang|untuk|atau|dengan|dari|ini|itu|kamu|nggak|aja|udah|saya|ke|di|jadi|mau|bisa|biar|Unduh|halaman|ketuk|Tarik|Pilih|Seret|Buka|Hapus|Kirim|Gratis|Cepat|Tutup|Batal|Pakai|Kembali|Ukuran|Simpan|Ulangi|Urungkan)\b/i;
const EXEMPT_TEXT = new Set(['Dibuat di Indonesia']);

// Every visible-or-hidden text node (dialogs, the folded tool grid, the FAQ
// answers) and every accessible-name attribute, minus script/style and the
// declared-Indonesian language link. textContent semantics, not innerText:
// innerText skips whatever is hidden, and a hidden dialog is still copy.
async function indonesianHits(page) {
  return page.evaluate(({ stop, exempt }) => {
    const re = new RegExp(stop.source, stop.flags);
    const hits = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || el.closest('script, style, body [lang="id"]')) continue;
      const text = n.textContent.replace(/\s+/g, ' ').trim();
      if (!text || exempt.includes(text)) continue;
      if (re.test(text)) hits.push(`text: ${text}`);
    }
    for (const el of document.querySelectorAll('[aria-label],[title],[placeholder],[alt]')) {
      if (el.closest('body [lang="id"]')) continue;
      for (const a of ['aria-label', 'title', 'placeholder', 'alt']) {
        const v = el.getAttribute(a);
        if (v && re.test(v)) hits.push(`${a}: ${v}`);
      }
    }
    for (const sel of ['meta[name="description"]', 'meta[property="og:title"]', 'meta[property="og:description"]']) {
      const v = document.querySelector(sel)?.getAttribute('content');
      if (v && re.test(v)) hits.push(`${sel}: ${v}`);
    }
    if (re.test(document.title)) hits.push(`title: ${document.title}`);
    return hits;
  }, { stop: { source: STOP.source, flags: STOP.flags }, exempt: [...EXEMPT_TEXT] });
}

test.describe('/en', () => {
  test('0. the detector is not blind: `/` is full of Indonesian', async ({ page }) => {
    await page.goto('/');
    const hits = await indonesianHits(page);
    expect(hits.length, hits.slice(0, 5).join('\n')).toBeGreaterThan(25);
  });

  test('1. no Indonesian text anywhere on /en, hidden dialogs and attributes included', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/en');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('h1')).toHaveText('For sorting out PDFs.');
    expect(await indonesianHits(page)).toEqual([]);
    expect(await page.locator('.ld-foot').innerText()).toContain('Dibuat di Indonesia');
    expect(errors).toEqual([]);
    if (process.env.EN_SHOT_DIR) await page.screenshot({ path: path.join(process.env.EN_SHOT_DIR, 'en-desktop.png'), fullPage: true });
  });

  test('2. the pieces /en drops are really gone, and the app boots without them', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/en');
    for (const sel of ['#maker-card', '.tl-band', '#sc-donate', '.sc-qr', 'a[href^="/dukung"]', 'img[src*="qris"]']) {
      expect(await page.locator(sel).count(), sel).toBe(0);
    }
    // Opening a document runs the whole boot path (celebrate.js wires #sc-donate).
    await page.setInputFiles('#file-input', SAMPLE);
    await expectFirstPage(page);
    // /privasi is the one link kept, and it stays Indonesian.
    await expect(page.locator('.ld-nav a[href="/privasi"]')).toHaveText('Privacy');
    expect(errors).toEqual([]);
  });

  test('3. strings that come from JS are English too: a toast, the Download sheet', async ({ page }) => {
    await page.goto('/en');
    await page.setInputFiles('#file-input', SAMPLE);
    await expectFirstPage(page);

    await page.click('[data-tool="text"]');
    await expect(page.locator('#toast')).toContainText('Pick a spot to write');

    await page.click('#btn-download');
    const sheet = page.locator('#dl-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('.ds-title h2')).toHaveText('Download');
    await expect(sheet.locator('#ds-meta')).toContainText('2 pages');
    await expect(sheet.locator('#ds-cta-main')).toContainText(/Download PDF|\d+(\.\d)? ?(KB|MB)/, { timeout: 15000 });
    await expect(sheet.locator('#ds-size')).toContainText('Compress');
    const text = await sheet.innerText();
    expect(text).not.toMatch(STOP);

    // The Pages sheet: its title, hint and bulk buttons are markup + JS together.
    await page.click('#ds-close');
    await page.click('#btn-pages');
    const pm = page.locator('#pm-sheet');
    await expect(pm).toBeVisible();
    await expect(pm.locator('.pm-head h2')).toHaveText('Manage Pages');
    expect(await pm.innerText()).not.toMatch(STOP);
  });

  test('4. no same-origin 4xx while loading /en and opening a document', async ({ page }) => {
    const bad = [];
    const origin = new URL(test.info().project.use.baseURL).origin;
    page.on('response', (r) => {
      const u = new URL(r.url());
      if (u.origin !== origin) return;
      // Vercel provides these in production; `npx serve` has neither.
      if (u.pathname.startsWith('/api/') || u.pathname.startsWith('/_vercel/')) return;
      if (r.status() >= 400) bad.push(`${r.status()} ${u.pathname}`);
    });
    await page.goto('/en');
    await page.setInputFiles('#file-input', SAMPLE);
    await expectFirstPage(page);
    expect(bad).toEqual([]);
  });

  test('5. the language link: `/` -> /en and back, no redirect either way', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'id');
    const toEn = page.locator('.ld-lang-menu a[href="/en"]');
    await expect(toEn).toHaveCount(1);
    await page.locator('.ld-lang-btn').click();
    await toEn.click();
    await expect(page).toHaveURL(/\/en\/?$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');

    const toId = page.locator('.ld-lang-menu a[href="/"]');
    await expect(toId).toHaveText('Bahasa Indonesia');
    await page.locator('.ld-lang-btn').click();
    await toId.click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'id');
  });

  test('6. both drawers carry the language link (mobile width)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto('/');
    await page.click('#ld-burger');
    await expect(page.locator('#ld-burger-menu a[href="/en"]')).toBeVisible();
    await page.goto('/en');
    await page.click('#ld-burger');
    await expect(page.locator('#ld-burger-menu a[href="/"]')).toHaveText('Bahasa Indonesia');
    expect(await page.locator('#ld-burger-menu a[href^="/dukung"]').count()).toBe(0);
  });

  test('7. an English browser on `/` is NOT redirected', async ({ browser }) => {
    const ctx = await browser.newContext({ locale: 'en-US' });
    const page = await ctx.newPage();
    await page.goto('/');
    await page.waitForTimeout(800);
    expect(new URL(page.url()).pathname).toBe('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'id');
    await ctx.close();
  });

  test('8. "Back to home" on /en goes to /en, not to the Indonesian page', async ({ page }) => {
    await page.goto('/en');
    await page.setInputFiles('#file-input', SAMPLE);
    await expectFirstPage(page);
    await page.click('#btn-home');
    await expect(page.locator('#home-confirm')).toBeVisible();
    await expect(page.locator('#home-confirm h2')).toHaveText('Back to home?');
    await page.click('#hc-go');
    await expect(page).toHaveURL(/\/en\/?$/);
  });

  // Evidence for the seat, not an assertion: the language control OPEN on both
  // pages, desktop dropdown and 390px drawer. Runs only when EN_SHOT_DIR is set.
  test('9. screenshots of the language control (EN_SHOT_DIR only)', async ({ page }) => {
    test.skip(!process.env.EN_SHOT_DIR, 'set EN_SHOT_DIR to write the PNGs');
    const out = (n) => path.join(process.env.EN_SHOT_DIR, n);
    for (const [url, tag] of [['/', 'id'], ['/en', 'en']]) {
      await page.setViewportSize({ width: 1280, height: 400 });
      await page.goto(url);
      await page.locator('.ld-lang-btn').click();
      await page.screenshot({ path: out(`lang-menu-${tag}-desktop.png`), clip: { x: 760, y: 0, width: 520, height: 220 } });
      await page.setViewportSize({ width: 390, height: 560 });
      await page.goto(url);
      await page.click('#ld-burger');
      await page.screenshot({ path: out(`lang-drawer-${tag}-390.png`) });
    }
  });
});
