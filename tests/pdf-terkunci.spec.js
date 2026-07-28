/*
 * PROTECTED PDFs — warn at import, never at the finish line.
 * ============================================================================
 * Founder field report (bug 2): a 444-page government table (KBLI 2020→2025)
 * opened, rendered all 444 pages, and then failed at Unduh with the generic
 * "Waduh, gagal membuat file. Coba sekali lagi ya."
 *
 * The document is encrypted with the standard security handler. PDF.js
 * implements decryption so it VIEWS perfectly; pdf-lib implements none, so
 * `PDFDocument.load` throws and it can never be written back. Nothing to do
 * with 444 pages — a 2-page protected PDF fails identically, which is what
 * this fixture is. Every earlier repro attempt varied page count and was
 * measuring the wrong variable.
 *
 * Two harms, both fixed here:
 *   1. We told the user to RETRY — the one thing that can never work — after
 *      they may have edited a long document. Now they are told at import,
 *      before the investment, and the export message is specific.
 *   2. The failure was invisible to the rail. We only learned about it because
 *      a founder forwarded the file. `failure {stage, reason}` now carries it.
 *
 * ⚠️ THE CONTROL CASE IS THE POINT OF THIS FILE. `info.EncryptFilterName` is
 * PRESENT on every document PDF.js parses — `null` on an ordinary PDF, the
 * handler name on a protected one. A `'key' in info` test would flag every PDF
 * ever opened as protected, and every assertion about the encrypted file would
 * still pass. The plain-PDF test below is what can actually fail if detection
 * regresses to reading the key instead of its value.
 *
 * Copy is deliberately asserted loosely (a marker word, not a sentence): the
 * strings are placeholders until Fauzan writes them, and pinning his words
 * here would mean this test has to change when he rules on them.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NASTY = (n) => path.join(__dirname, 'fixtures', 'nasty', n);

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

const flushRail = (page) => page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
});

const railEvents = async (page) => {
  await flushRail(page);
  return page.evaluate(() => (window.__rail || [])
    .filter((b) => b.url.includes('/api/t'))
    .flatMap((b) => b.body.events || []));
};

test.describe('protected PDFs', () => {
  test('a protected PDF still OPENS and renders — we warn about the edge, we do not build a wall', async ({ page }) => {
    await captureRail(page);
    await page.goto('/');
    await page.setInputFiles('#file-input', NASTY('terkunci.pdf'));

    // Viewing is untouched: PDF.js decrypts, so the pages are really there.
    await expectFirstPage(page);
    const state = await page.evaluate(() => {
      const d = window.v2.getDoc();
      return { pages: d.pages.length, encrypted: d.sources.map((s) => s.encrypted) };
    });
    expect(state.pages).toBe(2);
    expect(state.encrypted).toEqual([true]);

    // ...and they are told NOW, not at the download.
    await expect(page.locator('#toast')).toContainText(/terkunci/i);

    await expect.poll(async () => (await railEvents(page)).some((e) => e.event === 'failure')).toBe(true);
    const f = (await railEvents(page)).find((e) => e.event === 'failure');
    expect(f.props).toEqual({ stage: 'import', reason: 'encrypted' });
  });

  test('CONTROL: an ordinary PDF is not flagged — detection reads the VALUE, not the key', async ({ page }) => {
    await captureRail(page);
    await page.goto('/');
    await page.setInputFiles('#file-input', NASTY('surat-word.pdf'));
    await expectFirstPage(page);

    const encrypted = await page.evaluate(() => window.v2.getDoc().sources.map((s) => s.encrypted));
    expect(encrypted).toEqual([false]);

    // No protection warning, and no failure event, on a perfectly good file.
    const events = await railEvents(page);
    expect(events.filter((e) => e.event === 'failure')).toEqual([]);
  });

  test('export says something SPECIFIC and tells the rail — never "try again" for something that can never work', async ({ page }) => {
    await captureRail(page);
    await page.goto('/');
    await page.setInputFiles('#file-input', NASTY('terkunci.pdf'));
    await expectFirstPage(page);

    await page.click('#btn-download');
    await expect(page.locator('#dl-sheet')).toBeVisible();
    await page.click('#ds-cta');

    // The export message must NOT be the generic retry advice.
    const toasts = page.locator('#toast');
    await expect(toasts).toContainText(/terkunci/i);
    await expect(toasts).not.toContainText(/sekali lagi/i);

    await expect.poll(async () => (await railEvents(page))
      .filter((e) => e.event === 'failure')
      .some((e) => e.props.stage === 'export')).toBe(true);
    const f = (await railEvents(page)).find((e) => e.event === 'failure' && e.props.stage === 'export');
    expect(f.props).toEqual({ stage: 'export', reason: 'encrypted' });
  });
});
