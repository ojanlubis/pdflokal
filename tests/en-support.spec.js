/*
 * THE ENGLISH SUPPORT PAGE (/en/support), RENDERED.
 * ============================================================================
 * tests/core/en-support.test.mjs proves the generator and the files. This
 * proves what a browser shows: no Indonesian visible, the QRIS QR really loads
 * from /en/support (a relative path would 404 one directory down), every link
 * resolves, the language control works in both directions on both pages, and
 * the work-log drawer opens with its months in English.
 *
 * ⚠️ THE STOPLIST IS ONLY WORTH ITS HITS: it is first pointed at /dukung, which
 * is Indonesian by construction and must find plenty.
 *
 * Exempt, and only these: the work log's commit subjects (English dev-speak by
 * design, scripts/gen-riwayat.js), the brand pun "Dibuat di Indonesia", the
 * company name, and anything inside a [lang="id"] element in the body (the
 * "Bahasa Indonesia" link).
 */
import { test, expect } from '@playwright/test';

const STOP = /\b(dan|yang|untuk|atau|dengan|dari|ini|itu|kamu|nggak|aja|udah|saya|ke|di|jadi|mau|bisa|biar|Unduh|halaman|ketuk|Tarik|Pilih|Seret|Buka|Hapus|Kirim|Gratis|Cepat|Tutup|Batal|Pakai|Kembali|Bantu|Traktir|Kopi|Dukung|Kasih|Makasih|Balik|Tanya|Jawab)\b/i;
const EXEMPT_TEXT = ['Dibuat di Indonesia', '© 2026 PT Fauzan Karya Digital'];

// textContent semantics (the log drawer is a closed <dialog>, still copy), minus
// script/style, the declared-Indonesian link and the log's commit subjects.
async function indonesianHits(page) {
  return page.evaluate(({ stop, exempt }) => {
    const re = new RegExp(stop.source, stop.flags);
    const hits = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || el.closest('script, style, body [lang="id"], .rw-log li > span')) continue;
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
    const desc = document.querySelector('meta[name="description"]')?.getAttribute('content');
    if (desc && re.test(desc)) hits.push(`description: ${desc}`);
    if (re.test(document.title)) hits.push(`title: ${document.title}`);
    return hits;
  }, { stop: { source: STOP.source, flags: STOP.flags }, exempt: EXEMPT_TEXT });
}

test.describe('/en/support', () => {
  test('0. the detector is not blind: /dukung is full of Indonesian', async ({ page }) => {
    await page.goto('/dukung');
    const hits = await indonesianHits(page);
    expect(hits.length, hits.slice(0, 5).join('\n')).toBeGreaterThan(25);
  });

  test('1. no Indonesian anywhere on /en/support, and the page boots clean', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/en/support');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('h1')).toHaveText('Support PDFLokal');
    await expect(page.locator('.topi h2')).toHaveText('Buy me a coffee');
    expect(await indonesianHits(page)).toEqual([]);
    expect(await page.locator('.ld-foot').innerText()).toContain('Dibuat di Indonesia');
    expect(errors).toEqual([]);
  });

  test('2. the QRIS image and its logo load from /en/support, and Download QR is the same file', async ({ page }) => {
    const bad = [];
    page.on('response', (r) => {
      const u = new URL(r.url());
      // Vercel provides /_vercel/ and /api/ in production; `npx serve` has neither.
      if (u.origin !== new URL(page.url()).origin || u.pathname.startsWith('/_vercel/') || u.pathname.startsWith('/api/')) return;
      if (r.status() >= 400) bad.push(`${r.status()} ${u.pathname}`);
    });
    await page.goto('/en/support');
    for (const sel of ['.qr-image', '.qris-logo', '.performer-face']) {
      const ok = await page.locator(sel).evaluate((img) => img.complete && img.naturalWidth > 0);
      expect(ok, `${sel} did not load`).toBe(true);
    }
    const dl = page.locator('.qr-unduh');
    await expect(dl).toHaveText('Download QR');
    await expect(dl).toHaveAttribute('href', '/images/qris.png');
    await expect(dl).toHaveAttribute('download', 'QRIS-PDFLokal.png');
    expect(bad).toEqual([]);
  });

  test('3. every link on the page resolves (no 404), and none points at the Indonesian support page except the language option', async ({ page, request }) => {
    await page.goto('/en/support');
    const links = await page.locator('a[href]').evaluateAll((as) => as.map((a) => ({ href: a.getAttribute('href'), id: a.getAttribute('hreflang') === 'id' })));
    expect(links.length).toBeGreaterThan(8);
    const local = [...new Set(links.filter((l) => l.href.startsWith('/')).map((l) => l.href.split('#')[0]))];
    expect(local).toEqual(expect.arrayContaining(['/en', '/en/support', '/privasi', '/dukung', '/images/qris.png']));
    for (const href of local) {
      const res = await request.get(href);
      expect(res.status(), href).toBe(200);
    }
    expect(links.filter((l) => l.href === '/dukung' && !l.id)).toEqual([]);
  });

  test('4. the language control works both ways: /dukung <-> /en/support', async ({ page }) => {
    await page.goto('/dukung');
    await expect(page.locator('html')).toHaveAttribute('lang', 'id');
    await expect(page.locator('.ld-lang-menu a[hreflang="en"]')).toHaveAttribute('href', '/en/support');
    await page.locator('.ld-lang-btn').click();
    await page.locator('.ld-lang-menu a[hreflang="en"]').click();
    await expect(page).toHaveURL(/\/en\/support$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    const toId = page.locator('.ld-lang-menu a[hreflang="id"]');
    await expect(toId).toHaveText('Bahasa Indonesia');
    await page.locator('.ld-lang-btn').click();
    await toId.click();
    await expect(page).toHaveURL(/\/dukung$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'id');
  });

  test('5. mobile: the drawer carries the language link; the wordmark and "Back to tools" go to /en', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto('/en/support');
    await page.click('#ld-burger');
    await expect(page.locator('#ld-burger-menu a[hreflang="id"]')).toHaveText('Bahasa Indonesia');
    await expect(page.locator('#ld-burger-menu a[href="/en/support"]')).toHaveText('Support');
    await expect(page.locator('.ld-mark')).toHaveAttribute('href', '/en');
    await expect(page.locator('.dk-balik a')).toHaveAttribute('href', '/en');
    await page.goto('/dukung');
    await page.click('#ld-burger');
    await expect(page.locator('#ld-burger-menu a[hreflang="en"]')).toHaveAttribute('href', '/en/support');
  });

  test('6. the work-log drawer opens (also from #development) with English months and kinds', async ({ page }) => {
    await page.goto('/en/support#development');
    const drawer = page.locator('#rw-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer.locator('h2')).toHaveText('PDFLokal development');
    expect(await drawer.locator('.rw-log li').count()).toBeGreaterThan(100);
    const times = await drawer.locator('.rw-log time').evaluateAll((ts) => ts.map((t) => t.textContent).slice(0, 400));
    expect(times.some((t) => /December|September/.test(t))).toBe(true);
    expect(times.filter((t) => /Desember|Agustus|Januari|Februari|Maret|Mei|Juni|Juli|Oktober/.test(t))).toEqual([]);
    const kinds = await drawer.locator('.rw-jenis').evaluateAll((bs) => [...new Set(bs.map((b) => b.textContent))]);
    expect(kinds).toEqual(expect.arrayContaining(['Feature', 'Fix']));
    expect(kinds.filter((k) => /^(Fitur|Perbaikan|Tes|Teknis|Tulisan|Catatan)$/.test(k))).toEqual([]);
  });
});
