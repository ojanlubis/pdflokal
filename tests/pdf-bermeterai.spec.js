/*
 * A STAMPED DOCUMENT — say it at Unduh, and do not lie about it.
 * ============================================================================
 * A PDF carrying an Indonesian e-meterai or a PAdES digital signature opens
 * here perfectly and, until 2026-09-09, exported to a file whose seal was
 * silently destroyed: export rebuilds the document with pdf-lib and there is
 * no incremental-update path in this stack, so the digest covers byte offsets
 * that no longer exist. The visible meterai graphic survives as ordinary page
 * content, so the user holds a document that LOOKS stamped and fails Peruri
 * verification, and nothing on screen ever said so.
 *
 * Two things ship together and this file pins both:
 *   1. an UNTOUCHED document is not rebuilt at all (core/export.js
 *      passThroughSource), so the seal genuinely survives;
 *   2. when a rebuild really is going to happen, the sheet says so, right
 *      beside the button that does it — and never blocks. Editing your own
 *      stamped document is legitimate.
 *
 * ⚠️ THE HIDE CASE IS THE ONE WITH POWER. A note wired to "the document is
 * signed" alone would be visible on the untouched PDF path too, where it would
 * be FALSE. So the assertion that can actually fail is the one that shows it
 * disappearing when the download is the safe one, and coming back the instant
 * anything makes a rebuild necessary. [[fixture-must-distinguish]]
 *
 * ⚠️ UNVERIFIED AGAINST A REAL E-METERAI. bermeterai.pdf is generated
 * (scripts/gen-fixture-bermeterai.mjs) and structurally shaped; no real Peruri
 * file exists on this bench. Copy is a placeholder awaiting Fauzan, so the
 * assertions name a marker word rather than a sentence.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';
import { downloadBytes } from './helpers/download-bytes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NASTY = (n) => path.join(__dirname, 'fixtures', 'nasty', n);
const SIGNED = 'bermeterai.pdf';
const PLAIN = 'surat-resmi.pdf';

const note = (page) => page.locator('#ds-signed');

// Rail capture, the same shape tests/pdf-terkunci.spec.js uses (each spec
// keeps its own copy today; not consolidated here because that is a change to
// four other files, not to this feature).
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

const railEvents = async (page) => {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  return page.evaluate(() => (window.__rail || [])
    .filter((b) => b.url.includes('/api/t'))
    .flatMap((b) => b.body.events || []));
};

async function openSheet(page, fixture) {
  await page.goto('/');
  await page.setInputFiles('#file-input', NASTY(fixture));
  await expectFirstPage(page);
  await page.click('#btn-download');
  await expect(page.locator('#dl-sheet')).toBeVisible();
}

test.describe('a stamped document', () => {
  test('it is DETECTED at import, and the detection is on the source, not on a guess', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('#file-input', NASTY(SIGNED));
    await expectFirstPage(page);
    expect(await page.evaluate(() => window.v2.getDoc().sources.map((s) => s.signed))).toEqual([true]);
  });

  test('THE RAIL learns it — doc_open carries signed, and the event still arrives whole', async ({ page }) => {
    // Two things at once, and the second is the one that could bite: the new
    // prop must be TRUE for a stamped file, and the event must still validate.
    // core/telemetry-schema.js is imported by the client AND by api/t.js, and
    // an off-schema event is dropped in silence — a mis-wired call site would
    // not error, doc_open would simply stop existing.
    await captureRail(page);
    await page.goto('/');
    await page.setInputFiles('#file-input', NASTY(SIGNED));
    await expectFirstPage(page);

    await expect.poll(async () => (await railEvents(page)).some((e) => e.event === 'doc_open')).toBe(true);
    const open = (await railEvents(page)).find((e) => e.event === 'doc_open');
    expect(open.props.signed).toBe(true);
    // The rest of the event is intact — the skew failure mode is a blank
    // doc_open, not a wrong one.
    expect(open.props).toMatchObject({ pages: '1', display_mode: 'browser' });
  });

  test('CONTROL: the rail says FALSE for an ordinary PDF', async ({ page }) => {
    // A prop hard-coded to true would satisfy the test above and nothing else.
    await captureRail(page);
    await page.goto('/');
    await page.setInputFiles('#file-input', NASTY(PLAIN));
    await expectFirstPage(page);

    await expect.poll(async () => (await railEvents(page)).some((e) => e.event === 'doc_open')).toBe(true);
    expect((await railEvents(page)).find((e) => e.event === 'doc_open').props.signed).toBe(false);
  });

  test('CONTROL: an ordinary PDF is not flagged, and the sheet stays silent', async ({ page }) => {
    // Without this half, "the note appears on a signed file" would also be
    // satisfied by a note that appears on every file.
    await openSheet(page, PLAIN);
    expect(await page.evaluate(() => window.v2.getDoc().sources.map((s) => s.signed))).toEqual([false]);
    await expect(note(page)).toBeHidden();
  });

  test('the UNTOUCHED PDF download is silent — because the seal really does survive', async ({ page }) => {
    // THE ASSERTION THAT KEEPS THE NOTE HONEST. On PDF, Asli, whole document,
    // nothing changed, core/export.js hands the original bytes back. Warning
    // here would be a lie, so the note must be hidden — and the bytes are read
    // to prove the claim underneath it, never inferred from the note itself.
    await openSheet(page, SIGNED);
    await expect(note(page)).toBeHidden();

    const { buf } = await downloadBytes(page, () => page.click('#ds-cta'));
    const source = fs.readFileSync(NASTY(SIGNED));
    expect(buf.length).toBe(source.length);
    expect(buf.equals(source), 'the untouched stamped document was rebuilt').toBe(true);
    expect(buf.toString('latin1'), 'the signature dictionary did not survive').toMatch(/\/ByteRange\s*\[/);
  });

  test('ONE EDIT and the note appears — the download that breaks the seal says so', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('#file-input', NASTY(SIGNED));
    await expectFirstPage(page);

    // A real Tip-Ex through the real tool: this is a document the user changed,
    // so a rebuild is genuinely required and the seal is genuinely lost.
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
    await expect(note(page)).toBeVisible();
    // ⚠️ VERBATIM, and that is the point (INCLUDE 7 receipt 3). He RULED this
    // sentence on 2026-09-09 ("ok the copy is approved"); asserting it word for
    // word is what stops a later session tidying his words into its own. If this
    // assertion fails, the fix is to ask him, never to update the expectation.
    await expect(note(page)).toHaveText(
      'Dokumen ini punya meterai atau tanda tangan digital. Kalau disimpan dari sini, segelnya rusak dan dokumen bisa gagal diverifikasi. File aslimu nggak berubah.',
    );

    // AND IT NEVER BLOCKS. The button is live and the file arrives.
    await expect(page.locator('#ds-cta')).toBeEnabled();
    const { buf } = await downloadBytes(page, () => page.click('#ds-cta'));
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  test('CHANGING THE FORMAT flips it live — Gambar rebuilds, so Gambar warns', async ({ page }) => {
    // The note tracks the DOWNLOAD, not the document. Same untouched file,
    // two answers, and the transition is what proves it is not a constant.
    await openSheet(page, SIGNED);
    await expect(note(page)).toBeHidden();

    await page.click('#ds-format button[data-v="img"]');
    await expect(note(page)).toBeVisible();

    await page.click('#ds-format button[data-v="pdf"]');
    await expect(note(page)).toBeHidden();

    // Compress rebuilds too — there is no seal on the other side of a raster.
    await page.click('#ds-size button[data-v="kompres"]');
    await expect(note(page)).toBeVisible();
  });

  test('SCREENSHOT: the sheet with the note, for the taste review', async ({ page }) => {
    await openSheet(page, SIGNED);
    await page.click('#ds-format button[data-v="img"]'); // the simplest way to make it visible
    await expect(note(page)).toBeVisible();
    await page.locator('#dl-sheet').screenshot({ path: 'test-results/seal-note-sheet.png' });
  });
});

// THE SIGNING PAGE'S OWN WORDS, ASSERTED VERBATIM (INCLUDE 7 receipt 3).
// This page used to INVITE people to paste a meterai image — the one place the
// site stopped being a neutral tool and started instructing, and the only real
// exposure the 2026-09-09 legal read turned up (a pasted picture is never a
// valid stamp, and a picture lifted off a USED meterai is UU 10/2020 Pasal 26).
// He ruled both replacements on 2026-09-09. Word for word on purpose: if this
// goes red, ask him — do not update the expectation.
test.describe('tanda-tangan-pdf: what we say about materai', () => {
  test('both ruled paragraphs are live, verbatim', async ({ page }) => {
    await page.goto('/tanda-tangan-pdf');

    await expect(page.locator('.ld-copy p', { hasText: 'Yang perlu kamu tahu' })).toHaveText(
      'Yang perlu kamu tahu: menempelkan gambar meterai lewat Upload itu cuma gambar, bukan meterai yang sah. Untuk dokumen elektronik, yang sah cuma e-meterai dari Peruri. Saya lebih memilih menjelaskan batasannya daripada membiarkanmu mengira sudah beres padahal belum.',
    );

    await expect(page.locator('.ld-faq details p', { hasText: 'tidak menerbitkan e-meterai' })).toHaveText(
      'PDFLokal tidak menerbitkan e-meterai, itu hanya sah lewat kanal resmi Peruri. Menempelkan gambar meterai di sini tidak membuat dokumenmu bermeterai sah, dan kalau gambarnya diambil dari meterai yang sudah terpakai, itu bisa kena pidana.',
    );

    // THE CONTROL. The old invitation must be gone, not merely outnumbered —
    // an added paragraph next to a surviving "tempelkan ... lalu tanda tangani"
    // would satisfy both assertions above and still tell people to do it.
    await expect(page.locator('body')).not.toContainText('tempelkan gambar meterai yang sudah sah kamu peroleh');
    await expect(page.locator('body')).not.toContainText('kamu bisa menempelkannya lewat menu Upload');
  });
});
