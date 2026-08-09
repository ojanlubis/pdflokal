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
import { downloadBytes } from './helpers/download-bytes.js';

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
    // blocked:FALSE — this file OPENED and is fully editable; only a PDF-format
    // export will refuse it. Its twin (a file that genuinely could not be
    // opened) carries the SAME stage and reason with blocked:true — see the
    // decline test at the bottom of this file.
    expect(f.props).toEqual({ stage: 'import', reason: 'encrypted', class: 'none', blocked: false });
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
    expect(f.props).toEqual({ stage: 'export', reason: 'encrypted', class: 'none', blocked: true });
  });
});

/*
 * A LOCKED PDF CAN STILL BE SAVED AS IMAGES (2026-08-09).
 * ============================================================================
 * `buildBase()` ran pdf-lib's buildPdfBytes the moment the sheet opened,
 * whatever format was selected. pdf-lib throws on an encrypted source, so
 * state.base stayed null and the IMAGE branch threw before it ever reached
 * renderPdfToImages — which is pure PDF.js and contains no pdf-lib at all.
 * PDF.js implements the standard security handler, so it rasterizes these
 * files perfectly. We were refusing an export we can perform, and saying "PDF
 * ini terkunci, jadi nggak bisa disimpan ulang", which is true of the PDF
 * format and false of images.
 *
 * ⚠️ WHY `terkunci-izin.pdf` AND NOT `terkunci.pdf`. terkunci.pdf carries
 * `/P -4` — encrypted, every permission GRANTED. It reproduces the pdf-lib
 * refusal, but it cannot tell an implementation that IGNORES the permission
 * flags from one that HONOURS them, because it has nothing to honour: both
 * answer "yes, you may". terkunci-izin.pdf revokes printing AND extraction
 * (`/P -24`, self-verified by its generator), so it is the fixture that can
 * distinguish them. [[fixture-must-distinguish]]
 *
 * The position that pins: we already RENDER these pages on screen, the
 * permission bits are advisory flags addressed to a conforming reader rather
 * than encryption, and an image export is the same pixels the user is already
 * looking at, produced on their own device. We decrypt nothing and claim to
 * remove nothing — and the PDF-format refusal below stays exactly as it was,
 * because pdf-lib genuinely cannot write those bytes back.
 */
test.describe('protected PDFs — the image path', () => {
  const LOCKED = 'terkunci-izin.pdf';

  test('a locked PDF EXPORTS AS IMAGES — the refusal was ours, not the format\'s', async ({ page }) => {
    await captureRail(page);
    await page.goto('/');
    await page.setInputFiles('#file-input', NASTY(LOCKED));
    await expectFirstPage(page);
    expect(await page.evaluate(() => window.v2.getDoc().sources.map((s) => s.encrypted))).toEqual([true]);

    await page.click('#btn-download');
    await expect(page.locator('#dl-sheet')).toBeVisible();
    await page.click('#ds-format button[data-v="img"]');

    const { buf, filename } = await downloadBytes(page, () => page.click('#ds-cta'));

    // READ THE BYTES, never the filename. A filename is produced by the code
    // that NAMES the file, not by the code that builds it — the whole reason
    // helpers/download-bytes.js exists. Two pages means a ZIP (PK\x03\x04),
    // and a ZIP of two EMPTY files would satisfy every cheaper check, so it
    // is opened and each entry inspected.
    expect(filename).toMatch(/\.zip$/);
    expect([...buf.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const entries = await page.evaluate((arr) => {
      const unzipped = window.fflate.unzipSync(new Uint8Array(arr));
      return Object.entries(unzipped).map(([name, b]) => ({
        name, head: [...b.slice(0, 3)], len: b.length,
      }));
    }, Array.from(buf));
    expect(entries.length).toBe(2);
    for (const e of entries) {
      // FFD8FF is the JPEG SOI + first marker.
      expect(e.head, `${e.name} is not a JPEG`).toEqual([0xff, 0xd8, 0xff]);
      // Real raster, not a 200-byte stub of one.
      expect(e.len, `${e.name} is suspiciously small`).toBeGreaterThan(5000);
    }
    // Filenames follow the DISPLAY position (1, 2, …), exactly as the
    // built-PDF path produces them. renderPdfToImages names each file after
    // its page number in the document it is handed, which on the fallback is
    // the SOURCE page number — extracting pages 5 and 9 would otherwise hand
    // the user "hal-5" and "hal-9". A fallback the user can SEE they were
    // given is a fallback that needs explaining.
    expect(entries.map((e) => e.name.replace(/^.*-hal-/, '')).sort())
      .toEqual(['1.jpg', '2.jpg']);

    // And nothing was reported as a failure, because nothing failed.
    const events = await railEvents(page);
    expect(events.filter((e) => e.event === 'failure' && e.props.stage === 'export')).toEqual([]);
    // The export event still describes the job honestly.
    const ex = events.find((e) => e.event === 'export');
    expect(ex?.props.format).toBe('jpg');
  });

  test('CONTROL: the same file still refuses the PDF format — that refusal is honest', async ({ page }) => {
    // Without this half, "images work" could be satisfied by a change that
    // simply stopped refusing anything. pdf-lib has no decrypt path, so a PDF
    // rebuild genuinely cannot happen and must keep saying so.
    await captureRail(page);
    await page.goto('/');
    await page.setInputFiles('#file-input', NASTY(LOCKED));
    await expectFirstPage(page);

    await page.click('#btn-download');
    await expect(page.locator('#dl-sheet')).toBeVisible();
    await page.click('#ds-cta'); // default format is PDF

    await expect(page.locator('#toast')).toContainText(/terkunci/i);
    await expect.poll(async () => (await railEvents(page))
      .some((e) => e.event === 'failure' && e.props.stage === 'export')).toBe(true);
  });

  test('an EDITED locked PDF still refuses — we never silently drop what the user drew', async ({ page }) => {
    // THE GUARD THAT KEEPS THE FALLBACK HONEST. The normal image export
    // rasterizes the BUILT pdf, which carries every annotation. Falling back
    // to the source bytes whenever the build fails would quietly ship images
    // with the user's Tip-Ex, signature or text missing — trading a loud
    // refusal for silent data loss, which is the same trade
    // `ignoreEncryption` offers and the same one this codebase refused there.
    // So the fallback is used only when the source bytes are provably the
    // whole truth, and one annotation is enough to make them not be.
    await captureRail(page);
    await page.goto('/');
    await page.setInputFiles('#file-input', NASTY(LOCKED));
    await expectFirstPage(page);

    // Draw a real Tip-Ex through the real tool, not a hand-poked model field.
    await page.click('[data-tool="whiteout"]');
    const box = await page.locator('.pv-page').first().boundingBox();
    await page.mouse.move(box.x + 60, box.y + 80);
    await page.mouse.down();
    await page.mouse.move(box.x + 220, box.y + 130, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => page.evaluate(
      () => window.v2.getDoc().pages[0].annotations.length,
    )).toBeGreaterThan(0);

    await page.click('#btn-download');
    await expect(page.locator('#dl-sheet')).toBeVisible();
    await page.click('#ds-format button[data-v="img"]');
    await page.click('#ds-cta');

    // No file, and the honest message.
    await expect(page.locator('#toast')).toContainText(/terkunci/i);
    await expect.poll(async () => (await railEvents(page))
      .some((e) => e.event === 'failure' && e.props.stage === 'export')).toBe(true);
  });

  test('arriving on /?buat=gambar with a locked file says nothing false', async ({ page }) => {
    // The sheet opens straight onto Gambar from this route, and buildBase's
    // pdf-lib failure used to toast "nggak bisa disimpan ulang" the instant it
    // appeared — a statement about the PDF format, shown to someone who had
    // already chosen images and was about to get them.
    await captureRail(page);
    await page.goto('/?buat=gambar');
    await page.setInputFiles('#file-input', NASTY(LOCKED));
    await expectFirstPage(page);
    await expect(page.locator('#dl-sheet')).toBeVisible();

    // The two messages are nearly identical and share one #toast element, so
    // the assertion has to name what tells them apart:
    //   import  : "PDF ini terkunci, BISA DIBACA, TAPI nggak bisa disimpan ulang"
    //   the sheet: "PDF ini terkunci, JADI nggak bisa disimpan ulang"
    // The import toast fires first and the sheet's would overwrite it, so the
    // import wording still being on screen IS the proof the sheet stayed quiet.
    await expect.poll(async () => page.evaluate(
      () => !!window.v2.getDoc().sources[0]?.encrypted,
    )).toBe(true);
    await expect(page.locator('#dl-sheet')).toBeVisible();
    await expect(page.locator('#toast')).toContainText(/bisa dibaca/i);
    await expect(page.locator('#toast')).not.toContainText(/jadi nggak bisa/i);
  });

  test('the genuine import DECLINE is blocked:true — the notice that opened fine is not', async ({ page }) => {
    // The two share a stage AND a reason. Before `blocked` the only thing
    // telling them apart on the rail was whether a doc_open happened to arrive
    // alongside — a per-session join, unreliable by construction. So "how many
    // people cannot open their files" was being answered with a number that
    // included people whose files opened perfectly.
    await captureRail(page);
    await page.goto('/');
    await page.setInputFiles('#file-input', {
      name: 'rusak.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4\nthis is not a pdf at all\n'),
    });

    await expect.poll(async () => (await railEvents(page))
      .some((e) => e.event === 'failure' && e.props.stage === 'import')).toBe(true);
    const f = (await railEvents(page)).find((e) => e.event === 'failure' && e.props.stage === 'import');
    expect(f.props.blocked).toBe(true);
    expect(f.props.class).toBe('none');
  });
});
