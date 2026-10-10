/*
 * A FILE THAT PDF.js OPENS AND pdf-lib CANNOT REBUILD MUST NOT JOIN A MERGE.
 * ============================================================================
 * Rail: `export/corrupt` (hint `parse`), 5 sessions on 2026-08-20, 09-18 and
 * 10-01, EVERY ONE a merge (intent gabung, two or more doc_open), zero files
 * out. PDF.js read the file; pdf-lib could not re-parse it for the rebuild; the
 * user found out at Unduh, after the work, with no hint which file was at fault.
 *
 * orphan-rusak.pdf is the smallest member of that class that reproduces the
 * signature (gen-fixture-orphan-rusak.mjs proves the pdf-lib half in node; test 1
 * here proves the PDF.js half in the browser — terpotong.pdf was built for this
 * divergence and PDF.js rejected it too, so neither half is assumed).
 *
 * THE RULE (js/v2/app.js, the merge guard): a lone file is never checked (it
 * passes through untouched, as before); the moment a second file would join, each
 * PDF is proven loadable by pdf-lib, and one that is not is declined through the
 * ordinary unreadable-file path: skipped, import/corrupt, blocked:true. Nothing
 * is rasterised or repaired. When it is the file ALREADY OPEN that cannot be
 * rebuilt, the new file is innocent: that branch reports merge_blocked
 * {open_unrebuildable}, never import/corrupt (EXCLUDE 4: the triple keeps its meaning).
 *
 * WHAT DISTINGUISHES: against the old code tests 2-4 fail — the bad file joins
 * the document (or the good one joins the bad one) and no import failure row
 * exists. Test 5 is the control that the guard does not over-reach.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NASTY = (n) => path.join(__dirname, 'fixtures', 'nasty', n);
const BAD = NASTY('orphan-rusak.pdf');
const GOOD = path.join(__dirname, 'fixtures', 'sample-2pages.pdf'); // the file BAD was cut from, 2 pages
const GOOD2 = NASTY('surat-word.pdf');

async function captureRail(page) {
  await page.addInitScript(() => {
    window.__rail = [];
    navigator.sendBeacon = (url, blob) => {
      Promise.resolve(blob && blob.text ? blob.text() : blob).then((t) => {
        try { window.__rail.push({ url: String(url), body: JSON.parse(t) }); } catch { /* non-JSON */ }
      });
      return true;
    };
  });
}
const importFailures = async (page) => {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  return page.evaluate(() => (window.__rail || [])
    .filter((b) => b.url.includes('/api/t'))
    .flatMap((b) => b.body.events || [])
    .filter((e) => e.event === 'failure' && e.props.stage === 'import'));
};
const mergeBlocked = async (page) => {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  return page.evaluate(() => (window.__rail || [])
    .filter((b) => b.url.includes('/api/t'))
    .flatMap((b) => b.body.events || [])
    .filter((e) => e.event === 'merge_blocked'));
};
// Every event name the rail has carried so far (flushes first, like the two above).
const railEventNames = async (page) => {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  return page.evaluate(() => (window.__rail || [])
    .filter((b) => b.url.includes('/api/t'))
    .flatMap((b) => b.body.events || [])
    .map((e) => e.event));
};
const pageCount = (page) => page.evaluate(() => window.v2.getDoc().pages.length);

test.describe('merge guard: a document pdf-lib cannot rebuild', () => {
  test('the fixture is a REAL divergence: PDF.js opens it, and a lone file keeps working', async ({ page }) => {
    await captureRail(page);
    await page.goto('/');
    await page.setInputFiles('#file-input', BAD);
    await expectFirstPage(page);
    expect(await pageCount(page)).toBe(2); // PDF.js read both pages
    // Known-positive: the open's own doc_open reached the rail, so a failure row
    // would have arrived by now too. Catches: an import/corrupt row hidden by an
    // empty (not-yet-flushed or dead) rail — the old read-once passed for free.
    await expect.poll(async () => (await railEventNames(page)).includes('doc_open'),
      { message: 'doc_open never reached the rail, so "no import failure" proves nothing' }).toBe(true);
    expect(await importFailures(page)).toEqual([]); // alone it is never checked, never declined

    // And the untouched download still hands back the user's own bytes, so
    // the guard did not take away something that worked.
    await page.click('#btn-download');
    await expect(page.locator('#dl-sheet')).toBeVisible({ timeout: 15_000 });
    const dl = page.waitForEvent('download', { timeout: 15_000 });
    await page.click('#ds-cta');
    const file = await (await dl).path();
    expect(fs.readFileSync(file).equals(fs.readFileSync(BAD))).toBe(true);
  });

  test('adding it to an open document is declined: skipped, import/corrupt, document unchanged', async ({ page }) => {
    await captureRail(page);
    await page.goto('/');
    await page.setInputFiles('#file-input', GOOD2);
    await expectFirstPage(page);
    const before = await pageCount(page);

    await page.setInputFiles('#file-input', BAD);
    await expect(page.locator('#toast')).toContainText('1 file dilewati');
    expect(await pageCount(page)).toBe(before);
    const fails = await expect.poll(async () => (await importFailures(page)).length).toBeGreaterThan(0)
      .then(() => importFailures(page));
    expect(fails[0].props).toMatchObject({ stage: 'import', reason: 'corrupt', blocked: true });
    // The NEW file is the unrebuildable one: that is the import/corrupt meaning, and
    // the open-document event must not fire alongside it.
    expect(await mergeBlocked(page)).toEqual([]);
  });

  test('picking it together with a good file skips only the bad one', async ({ page }) => {
    await captureRail(page);
    await page.goto('/');
    await page.setInputFiles('#file-input', [BAD, GOOD2]);
    await expectFirstPage(page);
    await expect(page.locator('#toast')).toContainText('1 file dilewati');
    const names = await page.evaluate(() => window.v2.getDoc().sources.map((s) => s.name));
    expect(names).toEqual(['surat-word.pdf']);
    await expect.poll(async () => (await importFailures(page)).length).toBeGreaterThan(0);
    expect(await mergeBlocked(page)).toEqual([]);
  });

  test('when the file ALREADY OPEN is the unrebuildable one, adding anything is declined and says so', async ({ page }) => {
    await captureRail(page);
    await page.goto('/');
    await page.setInputFiles('#file-input', BAD);
    await expectFirstPage(page);

    await page.setInputFiles('#file-input', GOOD2);
    await expect(page.locator('#toast')).toContainText('nggak bisa digabung');
    expect(await pageCount(page)).toBe(2); // nothing was added
    // The rail says WHICH side was at fault: a merge_blocked for the open document,
    // and NOT failure/import/corrupt, because GOOD2 would have opened fine and
    // counting it there would widen what that triple means.
    await expect.poll(async () => (await mergeBlocked(page)).length).toBe(1);
    expect((await mergeBlocked(page))[0].props).toEqual({ reason: 'open_unrebuildable', pages: '2-5' });
    expect(await importFailures(page)).toEqual([]);
  });

  test('control: two ordinary files still merge, and a protected file is not mistaken for a corrupt one', async ({ page }) => {
    await captureRail(page);
    await page.goto('/');
    await page.setInputFiles('#file-input', GOOD);
    await expectFirstPage(page);
    await page.setInputFiles('#file-input', GOOD2);
    await expect.poll(() => pageCount(page)).toBeGreaterThan(2);

    // terkunci.pdf is encrypted: pdf-lib cannot load it either, but that is the
    // protected-PDF path (warned at import), never "corrupt".
    await page.setInputFiles('#file-input', NASTY('terkunci.pdf'));
    await expect.poll(() => page.evaluate(() => window.v2.getDoc().sources.map((s) => s.name))).toContain('terkunci.pdf');
    await expect.poll(async () => (await importFailures(page)).length).toBeGreaterThan(0);
    const reasons = (await importFailures(page)).map((r) => `${r.props.reason}/${r.props.blocked}`);
    expect(reasons).toEqual(['encrypted/false']); // the warning, and nothing declined as corrupt
  });
});
