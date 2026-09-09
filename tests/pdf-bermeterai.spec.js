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
    // Copy is Fauzan's and unruled — assert the subject, not his sentence.
    await expect(note(page)).toContainText(/meterai/i);

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
