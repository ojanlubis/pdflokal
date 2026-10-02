/*
 * THE SCRIPT THAT DID NOT ARRIVE — export/unknown, and the retry that was missing.
 * ============================================================================
 * Rail 2026-09-18..09-30 (Turso, `failure` + `failure_cause`): five export
 * sessions with `export/unknown`, cause Error/glyph (x2) or Error/none (x3),
 * 30 events in the four sessions of the 2026-10-01 routine row (19 of those are
 * a different, fontkit-hmtx RangeError — commit-bake's). Three of the five did
 * not edit at all (a photo, an untouched PDF). Two show the user getting the
 * file after closing and reopening the sheet (bf32bd80: 28 s later, e7306cc1:
 * 24 s later). Reproduced signature, from the rail's own classifier: the
 * loader's `Gagal memuat /js/vendor/fontkit.umd.min.js` reads Error/glyph, the
 * pdf-lib one Error/none (tests/core/failure-reason.test.mjs 15).
 *
 * THE MECHANISM. pdf-lib + fontkit load at the moment of intent
 * (core/vendor.js). A document nothing has edited has not needed them yet, so
 * the first Unduh is the first fetch of ~1.2 MB on the phone's network. One
 * refused request failed buildBase; buildBase KEEPS its error; every later tap
 * on Unduh re-threw it. Only closing and reopening the sheet rebuilt.
 *
 * Two fixes, two tests, each red without its own fix:
 *   1. the loader tries a script twice (a blip never reaches the user);
 *   2. a failed build is retried by the tap itself (a longer outage).
 * Plus the rail: a load that fails for good is reported as cause `fetch`.
 *
 * The fixture MUST distinguish: an untouched sample PDF has not loaded pdf-lib
 * or fontkit when the sheet opens, and each test asserts that first. A page
 * that had already loaded them would pass with or without the fix.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';
import { downloadBytes } from './helpers/download-bytes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_PDF = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');

async function captureRail(page) {
  await page.addInitScript(() => {
    window.__rail = [];
    const push = (url, txt) => {
      try { window.__rail.push({ url: String(url), body: JSON.parse(txt) }); } catch { /* non-JSON */ }
    };
    navigator.sendBeacon = (url, blob) => {
      Promise.resolve(blob && blob.text ? blob.text() : blob).then((t) => push(url, t));
      return true;
    };
    const origFetch = window.fetch ? window.fetch.bind(window) : null;
    window.fetch = (url, opts) => {
      if (typeof url === 'string' && url.includes('/api/') && opts?.body) push(url, String(opts.body));
      return origFetch ? origFetch(url, opts) : Promise.resolve(new Response('{}'));
    };
  });
}

async function railEvents(page, name) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  return page.evaluate((n) => (window.__rail || [])
    .filter((b) => b.url.includes('/api/t'))
    .flatMap((b) => b.body.events || [])
    .filter((e) => e.event === n), name);
}

// Refuse requests for one vendor file while `blocked()` says so; count them.
async function gate(page, file, blocked) {
  const hits = { n: 0 };
  await page.route(`**/js/vendor/${file}`, (route) => {
    hits.n += 1;
    return blocked(hits.n) ? route.abort('failed') : route.continue();
  });
  return hits;
}

async function openUntouchedPdf(page) {
  await page.goto('/');
  await page.setInputFiles('#file-input', SAMPLE_PDF);
  await expectFirstPage(page);
  const loaded = await page.evaluate(() => ({ lib: !!window.PDFLib, fk: !!window.fontkit }));
  expect(loaded, 'fixture must not have loaded the export libs before Unduh').toEqual({ lib: false, fk: false });
}

// The page's service worker answers /js/vendor/ itself, and page.route cannot
// see a request a worker handles — the first run counted zero hits for that reason.
test.use({ serviceWorkers: 'block' });

test.describe('export when a vendor script does not arrive', () => {
  test('1 · one refused request for fontkit does not cost the user the file', async ({ page }) => {
    const hits = await gate(page, 'fontkit.umd.min.js', (n) => n === 1);
    await openUntouchedPdf(page);

    await page.click('#btn-download');
    await expect(page.locator('#dl-sheet')).toBeVisible();
    // Pre-fix: the build dies here and the CTA never shows a size.
    await expect(page.locator('#ds-cta-main')).toContainText(/KB|MB/, { timeout: 20000 });
    const { buf } = await downloadBytes(page, () => page.click('#ds-cta'));
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(hits.n, 'the loader asked twice').toBe(2);
  });

  test('2 · after a build that lost the script outright, tapping Unduh again rebuilds', async ({ page }) => {
    let open = false;
    const hits = await gate(page, 'pdf-lib.min.js', () => !open);
    await openUntouchedPdf(page);

    await page.click('#btn-download');
    await expect(page.locator('#dl-sheet')).toBeVisible();
    // Every attempt of the opening build is refused; wait until the build has
    // given up (no spinner, no size), so what follows is the stored-error case.
    await expect.poll(() => hits.n, { timeout: 20000 }).toBeGreaterThanOrEqual(2);
    await expect(page.locator('#ds-cta-main .ds-spin')).toHaveCount(0, { timeout: 20000 });
    await expect(page.locator('#ds-cta-main')).not.toContainText(/KB|MB/);

    open = true; // the network is back
    // Pre-fix: this tap re-throws the stored buildError, nothing downloads.
    const { buf } = await downloadBytes(page, () => page.click('#ds-cta'));
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  test('3 · a script that never arrives is reported as cause fetch, and the tap does not loop', async ({ page }) => {
    await captureRail(page);
    await gate(page, 'fontkit.umd.min.js', () => true);
    await openUntouchedPdf(page);

    await page.click('#btn-download');
    await expect(page.locator('#dl-sheet')).toBeVisible();
    await expect(page.locator('#ds-cta-main .ds-spin')).toHaveCount(0, { timeout: 20000 });
    await page.click('#ds-cta');
    await expect.poll(async () => (await railEvents(page, 'failure_cause')).length, { timeout: 20000 }).toBeGreaterThan(0);

    const failures = (await railEvents(page, 'failure')).filter((e) => e.props.stage === 'export');
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].props).toMatchObject({ stage: 'export', reason: 'unknown', blocked: true });
    const causes = (await railEvents(page, 'failure_cause')).filter((e) => e.props.stage === 'export');
    // Pre-fix this read { Error, glyph }: the message quotes "fontkit".
    expect(causes[0].props).toMatchObject({ name: 'Error', hint: 'fetch' });
    // The sheet is still usable after the failure: the CTA came back.
    await expect(page.locator('#ds-cta')).toBeEnabled();
  });
});
