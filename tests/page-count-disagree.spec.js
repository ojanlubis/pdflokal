/*
 * A FILE PDF.js AND pdf-lib COUNT DIFFERENT PAGES IN MUST NOT JOIN A MERGE.
 * ============================================================================
 * The core half is tests/core/rebuild-page-count.test.mjs: a nested page tree
 * whose middle node's /Count lies shows "Halo 0", "Halo 2" on screen while
 * pdf-lib lists three pages, so a rebuild hands back a neighbour page. This
 * spec guards the WIRING in js/v2/app.js that the core tests cannot reach:
 *   - a joining file is checked through importPdf's rebuildCheck with PDF.js's
 *     count (loadFilesInner), and declined as import/corrupt, blocked:true;
 *   - an already-open file is checked with its Source.numPages
 *     (firstUnrebuildableSource), and the merge is refused as merge_blocked.
 * A lone untouched file is never checked and still downloads its own bytes.
 *
 * The fixture is generated per run with the vendored pdf-lib, so no binary is
 * committed and the shape is readable here.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const GOOD2 = path.join(__dirname, 'fixtures', 'nasty', 'surat-word.pdf');

function loadUmd(p) {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports;
}

let LYING;
test.beforeAll(async () => {
  const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
  const { PDFName, PDFNumber } = PDFLib;
  const d = await PDFLib.PDFDocument.create();
  for (let i = 0; i < 3; i += 1) d.addPage([595, 842]).drawText(`Halo ${i}`, { x: 50, y: 700 });
  const rootRef = d.catalog.get(PDFName.of('Pages'));
  const rootNode = d.context.lookup(rootRef);
  const leaves = rootNode.Kids().asArray();
  const midRef = d.context.register(d.context.obj({ Type: 'Pages', Parent: rootRef, Kids: leaves.slice(0, 2), Count: 1 }));
  for (const leaf of leaves.slice(0, 2)) d.context.lookup(leaf).set(PDFName.of('Parent'), midRef);
  rootNode.set(PDFName.of('Kids'), d.context.obj([midRef, leaves[2]]));
  rootNode.set(PDFName.of('Count'), PDFNumber.of(2));
  LYING = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pdflokal-count-')), 'hitungan-beda.pdf');
  fs.writeFileSync(LYING, await d.save({ useObjectStreams: false }));
});

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
const railEvents = async (page) => {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  return page.evaluate(() => (window.__rail || [])
    .filter((b) => b.url.includes('/api/t'))
    .flatMap((b) => b.body.events || []));
};
const importFailures = async (page) => (await railEvents(page))
  .filter((e) => e.event === 'failure' && e.props.stage === 'import');
const mergeBlocked = async (page) => (await railEvents(page)).filter((e) => e.event === 'merge_blocked');
const pageCount = (page) => page.evaluate(() => window.v2.getDoc().pages.length);

test.describe('merge guard: a file the two parsers count differently', () => {
  test('alone it opens with the pages PDF.js shows and downloads untouched', async ({ page }) => {
    await captureRail(page);
    await page.goto('/');
    await page.setInputFiles('#file-input', LYING);
    await expectFirstPage(page);
    expect(await pageCount(page)).toBe(2); // PDF.js trusts the /Count: "Halo 0", "Halo 2"
    await expect.poll(async () => (await railEvents(page)).some((e) => e.event === 'doc_open')).toBe(true);
    expect(await importFailures(page)).toEqual([]);

    await page.click('#btn-download');
    await expect(page.locator('#dl-sheet')).toBeVisible({ timeout: 15_000 });
    const dl = page.waitForEvent('download', { timeout: 15_000 });
    await page.click('#ds-cta');
    expect(fs.readFileSync(await (await dl).path()).equals(fs.readFileSync(LYING))).toBe(true);
  });

  test('joining an open document it is declined: skipped, import/corrupt, document unchanged', async ({ page }) => {
    await captureRail(page);
    await page.goto('/');
    await page.setInputFiles('#file-input', GOOD2);
    await expectFirstPage(page);
    const before = await pageCount(page);

    await page.setInputFiles('#file-input', LYING);
    await expect(page.locator('#toast')).toContainText('1 file dilewati');
    expect(await pageCount(page)).toBe(before);
    await expect.poll(async () => (await importFailures(page)).length).toBeGreaterThan(0);
    expect((await importFailures(page))[0].props).toMatchObject({ stage: 'import', reason: 'corrupt', blocked: true });
    expect(await mergeBlocked(page)).toEqual([]);
  });

  test('already open, it blocks the merge as the open document\'s fault', async ({ page }) => {
    await captureRail(page);
    await page.goto('/');
    await page.setInputFiles('#file-input', LYING);
    await expectFirstPage(page);

    await page.setInputFiles('#file-input', GOOD2);
    await expect(page.locator('#toast')).toContainText('nggak bisa digabung');
    expect(await pageCount(page)).toBe(2);
    await expect.poll(async () => (await mergeBlocked(page)).length).toBe(1);
    expect((await mergeBlocked(page))[0].props).toEqual({ reason: 'open_unrebuildable', pages: '2-5' });
    expect(await importFailures(page)).toEqual([]);
  });
});
