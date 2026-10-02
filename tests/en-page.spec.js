/*
 * THE ENGLISH EDITOR (/en), RENDERED.
 * ============================================================================
 * tests/core/en-page.test.mjs proves the generator and the files. This proves
 * what a browser shows: no Indonesian visible anywhere, English from the JS
 * layer too (a toast, the Download sheet, the maker card's dates and lines),
 * nothing that 404s, the language link on both pages, and that /en carries
 * everything `/` does (the founder's ruling 2026-10-02: the same product, only
 * the language differs): the Template row, the maker card, the QRIS button and
 * QR, all in English, every support link going to /en/support.
 *
 * ⚠️ THE STOPLIST IS ONLY WORTH ITS HITS: it is first pointed at `/`, which is
 * Indonesian by construction, and must find plenty. A detector that finds
 * nothing on `/` would pass /en for free.
 *
 * Exempt, and only these: the brand pun "Dibuat di Indonesia", the brand, and
 * anything inside a [lang="id"] element in the body (the "Bahasa Indonesia"
 * link; not <html lang="id">, which would exempt every word on `/`).
 *
 * The language link and the browser-language redirect are tests/lang-redirect.spec.js.
 *
 * Set EN_SHOT_DIR to also drop a screenshot of /en there (the seat looks).
 */
import { test, expect } from '@playwright/test';
import { indonesianHits as findIndonesian } from './helpers/indonesian.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';
import { UPDATES } from '../js/updates.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');
// The card's top line is the newest approved entry; read it, so approving a new one moves the pin with it.
const NEWEST = UPDATES.find((u) => u.approved);

// The second line is the vocabulary of the blocks `/en` used to cut and now carries
// (Template row, maker card, QRIS card): the sweep must reach them too.
const STOP = /\b(dan|yang|untuk|atau|dengan|dari|ini|itu|kamu|nggak|aja|udah|saya|ke|di|jadi|mau|bisa|biar|Unduh|halaman|ketuk|Tarik|Pilih|Seret|Buka|Hapus|Kirim|Gratis|Cepat|Tutup|Batal|Pakai|Kembali|Ukuran|Simpan|Ulangi|Urungkan|Dukung|Traktir|kopi|Lihat|selengkapnya|terakhir|Foto|Kwitansi|Gaji|Surat|Jalan|Agu|Okt|Des|Mei)\b/i;
const EXEMPT_TEXT = new Set(['Dibuat di Indonesia']);

const indonesianHits = (page) => findIndonesian(page, { stop: STOP, exempt: [...EXEMPT_TEXT] });

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
    await expect(page.locator('h1')).toHaveText('For all your PDF Needs');
    expect(await indonesianHits(page)).toEqual([]);
    expect(await page.locator('.ld-foot').innerText()).toContain('Dibuat di Indonesia');
    expect(errors).toEqual([]);
    if (process.env.EN_SHOT_DIR) await page.screenshot({ path: path.join(process.env.EN_SHOT_DIR, 'en-desktop.png'), fullPage: true });
  });

  test('2. /en carries what `/` carries: Template row, QRIS button and QR, maker card, all in English', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/en');
    for (const sel of ['#maker-card', '#tl-band', '#sc-donate', '.sc-qr', 'img[src*="qris"]']) {
      expect(await page.locator(sel).count(), sel).toBeGreaterThan(0);
    }
    // The Template row, translated.
    await expect(page.locator('#tl-band .tl-head b')).toHaveText('Template');
    expect(await page.locator('#tl-band .tl-doc span').allTextContents()).toEqual(['Payslip', 'Invoice', 'Receipt', 'Delivery note', 'Work order']);
    // The support card carries its donate button and QR, in English.
    await expect(page.locator('#sc-donate')).toContainText('Buy me a coffee');
    await expect(page.locator('.sc-qr p')).toHaveText('Scan with your e-wallet or mobile banking app.');
    // Support links all point at the English support page; none at /dukung.
    expect(await page.locator('a[href^="/dukung"]').count()).toBe(0);
    expect(await page.locator('a[href^="/en/support"]').count()).toBeGreaterThanOrEqual(5);
    // Opening a document runs the whole boot path (celebrate.js wires #sc-donate).
    await page.setInputFiles('#file-input', SAMPLE);
    await expectFirstPage(page);
    // /privasi is the one link kept, and it stays Indonesian.
    await expect(page.locator('.ld-nav a[href="/privasi"]')).toHaveText('Privacy');
    expect(errors).toEqual([]);
  });

  test('2b. the maker card shows in English, with English dates, and "See more" opens the English work log', async ({ page }) => {
    await page.goto('/en');
    const card = page.locator('#maker-card');
    await expect(card).toBeVisible({ timeout: 6000 });
    await expect(card.locator('.mk-label')).toHaveText('Latest updates');
    await expect(card.locator('.mk-real')).toHaveText('Fauzan Ahladzikri');
    const times = await card.locator('.mk-list time').allTextContents();
    expect(times.length).toBe(3);
    for (const t of times) expect(t).toMatch(/^\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/);
    const lines = await card.locator('.mk-list span').allTextContents();
    expect(lines.join(' ')).not.toMatch(STOP);
    expect(lines[0]).toBe(NEWEST.en);
    expect(await card.innerText()).not.toMatch(STOP);
    // CONTROL: the same card on `/` is the Indonesian line, so the test can tell them apart.
    await page.goto('/');
    await expect(page.locator('#maker-card .mk-list span').first()).toHaveText(NEWEST.text, { timeout: 6000 });
    // "See more" goes to the ENGLISH support page and opens its log.
    await page.goto('/en');
    await expect(card).toBeVisible({ timeout: 6000 });
    await card.locator('.mk-more').click();
    await expect(page).toHaveURL(/\/en\/support#development$/);
    await expect(page.locator('#rw-drawer')).toBeVisible();
  });

  test('2c. the QRIS reveal on the support card works on /en, in English', async ({ page }) => {
    await page.goto('/en');
    await page.evaluate(() => document.getElementById('support-card').classList.add('show'));
    await page.click('#sc-donate');
    await expect(page.locator('#support-card')).toHaveClass(/qr-open/);
    const qr = page.locator('.sc-qr');
    await expect(qr).toBeVisible();
    await expect(qr.locator('img[src="/images/qris.png"]')).toHaveAttribute('alt', 'QRIS to buy me a coffee');
    await expect(qr.locator('.sc-performer b')).toHaveText('Ojan');
    expect(await page.locator('#support-card').innerText()).not.toMatch(STOP);
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
    await expect(page.locator('#ld-burger-menu a[href="/en/support"]')).toHaveText('Support');
  });

  test('7. an Indonesian browser on `/` stays on `/` (English browsers are sent to /en: tests/lang-redirect.spec.js)', async ({ page }) => {
    // playwright.config.js pins the browser language to id-ID.
    await page.goto('/');
    await page.waitForTimeout(800);
    expect(new URL(page.url()).pathname).toBe('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'id');
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
