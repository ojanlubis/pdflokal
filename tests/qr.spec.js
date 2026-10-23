/*
 * /qr — PASTE A LINK, GET THE QR, AND THE LINK GOES NOWHERE.
 * ============================================================================
 * The page promises "Nggak lewat server kami". That is a claim about every request
 * the page makes, so it is asserted over the whole network log, not over one call:
 * a unique marker typed into the field must appear in no request URL and no request
 * body. Telemetry is allowed (it is how the page counts a download), but only as
 * the enum qr_use event, and the marker must not be in it.
 *
 * ⚠️ WHAT WOULD LOOK IDENTICAL IF BROKEN: "the QR changed" is checked on the
 * drawn path data, not on the presence of an <svg> (an <svg> that never updated
 * would pass a presence check), and the control for the leak assertion is the
 * telemetry request itself: it must be SEEN carrying qr_use, or "no request has
 * the marker" proves only that no request was looked at.
 */
import { test, expect } from '@playwright/test';

const MARKER = 'rahasia-ojan-7f3a9c';

test.describe('/qr', () => {
  test('opens with the sample drawn, buttons enabled, in the page chrome', async ({ page }) => {
    await page.goto('/qr');
    await expect(page.locator('h1')).toHaveText('Tempel link. Ambil QR-nya.');
    await expect(page.locator('#tautan')).toHaveValue('https://pdflokal.id');
    await expect(page.locator('#qr-img svg')).toBeVisible();
    await expect(page.locator('#qr-unduh')).toBeEnabled();
    await expect(page.locator('#qr-salin')).toBeEnabled();
    await expect(page.locator('#qr-kosong')).toBeHidden();
    // The normal header and footer, not a bare page.
    await expect(page.locator('.ld-hd .ld-mark')).toBeVisible();
    await expect(page.locator('.ld-foot a[href="/privasi"]')).toBeVisible();
  });

  test('typing redraws the code; clearing empties it; both buttons follow', async ({ page }) => {
    await page.goto('/qr');
    const d0 = await page.locator('#qr-img path[stroke]').getAttribute('d');
    expect(d0 && d0.length).toBeGreaterThan(50);

    await page.locator('#tautan').fill('https://contoh.id/menu-warung');
    await expect(page.locator('#qr-img')).toHaveAttribute('aria-label', 'Kode QR untuk https://contoh.id/menu-warung');
    const d1 = await page.locator('#qr-img path[stroke]').getAttribute('d');
    expect(d1).not.toEqual(d0);

    await page.locator('#tautan').fill('   ');
    await expect(page.locator('#qr-img')).toBeHidden();
    await expect(page.locator('#qr-kosong')).toHaveText('QR-nya muncul di sini.');
    await expect(page.locator('#qr-unduh')).toBeDisabled();
    await expect(page.locator('#qr-salin')).toBeDisabled();
    await expect(page.locator('#qr-galat')).toHaveText('');
  });

  test('a text too long for one QR says so, and recovers when shortened', async ({ page }) => {
    await page.goto('/qr');
    await page.locator('#tautan').fill('a'.repeat(3000));
    await expect(page.locator('#qr-galat')).toHaveText('Isinya kepanjangan buat satu QR. Coba perpendek dulu linknya.');
    await expect(page.locator('#qr-kosong')).toHaveText('Belum ada QR yang bisa dibentuk.');
    await expect(page.locator('#qr-unduh')).toBeDisabled();

    await page.locator('#tautan').fill('https://pdflokal.id');
    await expect(page.locator('#qr-galat')).toHaveText('');
    await expect(page.locator('#qr-img svg')).toBeVisible();
    await expect(page.locator('#qr-unduh')).toBeEnabled();
  });

  test('Unduh PNG downloads qr.png, a real 1024px PNG', async ({ page }) => {
    await page.goto('/qr');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#qr-unduh').click()]);
    expect(dl.suggestedFilename()).toBe('qr.png');
    const bytes = await (async () => {
      const stream = await dl.createReadStream();
      const chunks = [];
      for await (const c of stream) chunks.push(c);
      return Buffer.concat(chunks);
    })();
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(bytes.readUInt32BE(16)).toBe(1024); // IHDR width
    expect(bytes.readUInt32BE(20)).toBe(1024); // IHDR height
  });

  test('Salin gambar: a refusing clipboard says so honestly; an accepting one says Tersalin', async ({ page }) => {
    await page.goto('/qr');
    // Refusal first: the success line must not appear when the browser says no.
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, 'write', { configurable: true, value: () => Promise.reject(new Error('NotAllowedError')) });
    });
    await page.locator('#qr-salin').click();
    await expect(page.locator('#qr-status')).toHaveText('Browser ini menolak menyalin gambar. Pakai Unduh PNG.');

    // Typing clears the stale status line.
    await page.locator('#tautan').fill('https://contoh.id');
    await expect(page.locator('#qr-status')).toHaveText('');

    // Acceptance: capture what was handed over and check it is the PNG.
    await page.evaluate(() => {
      window.__clip = null;
      Object.defineProperty(navigator.clipboard, 'write', {
        configurable: true,
        value: async (items) => { window.__clip = items[0].types.join(','); },
      });
    });
    await page.locator('#qr-salin').click();
    await expect(page.locator('#qr-status')).toHaveText('Tersalin. Tinggal tempel.');
    expect(await page.evaluate(() => window.__clip)).toContain('image/png');
  });

  test('the typed link appears in no request; telemetry carries only the verb', async ({ page }) => {
    const seen = [];
    page.on('request', (r) => seen.push({ url: r.url(), body: r.postData() || '' }));
    await page.goto('/qr');
    await page.locator('#tautan').fill(`https://contoh.id/${MARKER}`);
    await expect(page.locator('#qr-img')).toHaveAttribute('aria-label', `Kode QR untuk https://contoh.id/${MARKER}`);
    await Promise.all([page.waitForEvent('download'), page.locator('#qr-unduh').click()]);
    // The beacon goes out when the tab hides; force that.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => seen.some((r) => r.url.endsWith('/api/t'))).toBe(true);

    // CONTROL: the telemetry request exists and names the verb. Without this the
    // assertion below could pass over an empty log.
    const t = seen.find((r) => r.url.endsWith('/api/t'));
    expect(t.body).toContain('qr_use');
    expect(t.body).toContain('download');

    expect(seen.length).toBeGreaterThan(3);
    for (const r of seen) {
      expect(r.url, `request URL ${r.url}`).not.toContain(MARKER);
      expect(r.body, `request body of ${r.url}`).not.toContain(MARKER);
    }
  });

  test('the sitemap lists /qr once as a clean URL, and every tool grid links to it', async ({ page, request }) => {
    const xml = await (await request.get('/sitemap.xml')).text();
    expect(xml.match(/<loc>https:\/\/www\.pdflokal\.id\/qr<\/loc>/g)).toHaveLength(1);
    await page.goto('/gabung-pdf');
    await expect(page.locator('nav[aria-label="Semua alat"] a[href="/qr"]')).toHaveText('Bikin QR Code');
  });

  test('the QR tile stays light in dark mode (a scanner needs dark modules on light)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/qr');
    const bg = await page.locator('.qr-tile').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe('rgb(255, 255, 255)');
    const page_bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(page_bg).not.toBe('rgb(255, 255, 255)'); // the page really is dark: the control
  });
});
