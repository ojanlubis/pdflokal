/*
 * THE DOCUMENT THAT OPENS BUT NEVER EXPORTS — and the rail finally saying why.
 * ============================================================================
 * PRODUCTION INCIDENT, 2026-07-28. One session: 82 minutes, 174 text
 * annotations, two merged images, 41 download attempts, ZERO successful
 * exports. The user left with nothing. All 41 failures recorded
 * `reason: 'unknown'`.
 *
 * The 'unknown' was not a classifier that came up short. `download-sheet.js`
 * hard-coded the literal — the classifier was never called. 41 samples of a
 * constant, from the one field that exists to answer "why".
 *
 * And fixing THAT alone would have changed nothing, which is the part worth
 * remembering: the classifier switched on `err.name`, which works for PDF.js's
 * named exception classes (the IMPORT path) and is useless for pdf-lib (the
 * EXPORT path), where every failure — truncation, encryption, anything — is a
 * plain `Error`. A classifier that cannot distinguish anything still returns a
 * value, and that value looks like an answer.
 *
 * AND THERE WAS A THIRD LAYER, which is the one that actually did the damage:
 * `doExport` does not build the PDF. `buildBase()` does, asynchronously, when
 * the sheet opens — and it CAUGHT the real error, logged it to the user's own
 * console, toasted "Coba lagi ya", and dropped it. `doExport` then found no
 * bytes and threw its own `new Error('build missing')`. So the only error the
 * reporting catch could ever see was our own placeholder. The cause was
 * destroyed one function away from the instrument that existed to record it.
 *
 * ⚠️ WE DO NOT KNOW what the real user's file was. The rail could not tell us —
 * that is the whole point. These tests make the next one legible.
 *
 * ⚠️ terpotong.pdf IS NOT the "opens fine, never exports" class. That was the
 * expectation when it was built; measured in the browser, PDF.js rejects the
 * truncation too, so it fails at IMPORT. The claim was asserted rather than
 * trusted, which is what caught it. The divergence class is still real —
 * core/export.js re-loads the ORIGINAL bytes through pdf-lib at download time,
 * so anything pdf-lib rejects and PDF.js accepts edits perfectly and fails only
 * at the end — but an encrypted PDF is its known member, not this file.
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

const failures = async (page) => {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  return page.evaluate(() => (window.__rail || [])
    .filter((b) => b.url.includes('/api/t'))
    .flatMap((b) => b.body.events || [])
    .filter((e) => e.event === 'failure'));
};

// WHY POLL: two independent delays sit between the failure and a readable
// event — the import/build is async, and the capture shim reads the beacon via
// blob.text(), which resolves a microtask AFTER sendBeacon returns. Reading
// once found ZERO failures for a file that definitely fails, and an assertion
// over an empty array would have passed for free in the other direction.
async function failuresAt(page, stage) {
  await expect
    .poll(async () => (await failures(page)).filter((r) => r.props.stage === stage).length, { timeout: 25_000 })
    .toBeGreaterThan(0);
  return (await failures(page)).filter((r) => r.props.stage === stage);
}

test.describe('failure reporting', () => {
  test('a genuinely damaged file names itself on the rail at IMPORT', async ({ page }) => {
    await captureRail(page);
    await page.goto('/');
    await page.setInputFiles('#file-input', NASTY('terpotong.pdf'));

    // Measured, not assumed: PDF.js rejects this truncation too, so the file
    // never reaches the editor. What matters is that the rail says WHICH kind
    // of failure it was, from a real throw by a real library on a real file.
    const importFails = await failuresAt(page, 'import');
    expect(importFails[0].props.reason).toBe('corrupt');
  });

  test('the EXPORT catch classifies the thrown error instead of reporting a literal', async ({ page }) => {
    // WHY THE THROW IS FORCED HERE. The defect was never "the classifier is
    // wrong" — it was that download-sheet.js never CALLED it, so `reason` was
    // the constant 'unknown' no matter what happened. That is a property of
    // the catch block, and the honest way to test a catch block is to make the
    // thing it catches actually happen. Real pdf-lib errors are classified for
    // real in tests/core/failure-reason.test.mjs; this pins the WIRING between
    // the throw and the rail.
    await captureRail(page);
    await page.goto('/');
    await page.setInputFiles('#file-input', NASTY('surat-word.pdf'));
    await expectFirstPage(page);

    // pdf-lib is loaded on demand; poison its loader the way a hostile document
    // would, with pdf-lib's OWN error shape — a plain Error, no useful name.
    await page.evaluate(async () => {
      const { ensurePdfLib } = await import('/js/core/vendor.js');
      await ensurePdfLib();
      window.PDFLib.PDFDocument.load = () => {
        throw new Error('Failed to parse PDF document (line:60 col:290 offset=31403)');
      };
    });

    await page.click('#btn-download');
    await expect(page.locator('#dl-sheet')).toBeVisible({ timeout: 15_000 });
    let downloaded = true;
    try {
      const dl = page.waitForEvent('download', { timeout: 15_000 });
      await page.click('#ds-cta');
      await dl;
    } catch { downloaded = false; }
    expect(downloaded, 'the poisoned loader must actually break the export').toBe(false);

    const exportFails = await failuresAt(page, 'export');

    // THE ASSERTION THAT WOULD HAVE SAVED 41 SAMPLES. Before today this said
    // 'unknown' — and could not have said anything else.
    expect(exportFails[0].props.reason).toBe('corrupt');
  });
});
