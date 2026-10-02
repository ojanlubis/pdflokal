/*
 * Armed-Hapus deletes are REPORTED (R6, 2026-10-02).
 *
 * `tool_use`/hapus/arm only fires on the armed path (Hapus pressed with nothing
 * selected). `tool_use`/hapus/delete fired only on the OTHER path (an object
 * already selected, Hapus pressed: deleteSelected). The two were mutually
 * exclusive, so a person who armed Hapus and deleted their own object left
 * arm + no outcome, indistinguishable from one who gave up. onDeleteTap, the
 * armed path's own delete, emitted nothing.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_PDF = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');

async function sentHapus(page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => page.evaluate(() => window.__beacons.length)).toBeGreaterThan(0);
  const bodies = await page.evaluate(() => window.__beacons.slice());
  return bodies.flatMap((b) => b.events)
    .filter((e) => e.event === 'tool_use' && e.props.tool === 'hapus')
    .map((e) => e.props.action);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__beacons = [];
    navigator.sendBeacon = (url, blob) => {
      Promise.resolve(blob && blob.text ? blob.text() : blob)
        .then((txt) => { try { window.__beacons.push(JSON.parse(txt)); } catch { /* ignored */ } });
      return true;
    };
  });
  await page.goto('/');
  await page.setInputFiles('#file-input', SAMPLE_PDF);
  await expectFirstPage(page);
  await page.click('[data-tool="text"]');
  await page.click('.pv-page >> nth=0', { position: { x: 100, y: 150 } });
  await page.keyboard.type('punya saya');
  await page.keyboard.press('Enter');
  await expect(page.locator('.pv-anno-text')).toBeVisible();
  await page.click('.pv-page >> nth=0', { position: { x: 300, y: 500 } }); // deselect
});

test('arm Hapus, tap your own object: arm then delete, nothing else', async ({ page }) => {
  await page.click('#btn-delete-anno');
  await page.click('.pv-anno-text');
  expect(await page.evaluate(() => window.v2.getDoc().pages[0].annotations.length)).toBe(0);
  expect(await sentHapus(page)).toEqual(['arm', 'delete']);
});

test('select your object, press Hapus: delete only, exactly once (no double count)', async ({ page }) => {
  await page.click('.pv-anno-text');                 // select
  await page.click('#btn-delete-anno');              // delete-now branch
  expect(await page.evaluate(() => window.v2.getDoc().pages[0].annotations.length)).toBe(0);
  expect(await sentHapus(page)).toEqual(['delete']);
});
