/*
 * THE THREE GAPS THE RAIL COULD NOT SEE (2026-10-02) — driven end to end.
 * ============================================================================
 *   R4  split / Ekstrak: the tap, the file it produces, and the Halaman sheet
 *       opened FOR the user by an intent (/pisah-pdf, the Halaman card).
 *
 * The unit tests (tests/core/telemetry-schema.test.mjs, telemetry-delivery) pin
 * what the SCHEMA and api/t.js accept. This file pins that the EDITOR EMITS them:
 * the beacon the browser actually builds, read off navigator.sendBeacon, same
 * seam tests/telemetry.spec.js uses and for the same reason.
 *
 * Each test names the one thing that must be true and was proven red against the
 * tree without the emitter (the commit messages say which).
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';
import { downloadBytes } from './helpers/download-bytes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');

async function captureBeacons(page) {
  await page.addInitScript(() => {
    window.__beacons = [];
    navigator.sendBeacon = (url, blob) => {
      Promise.resolve(blob && blob.text ? blob.text() : blob)
        .then((txt) => { try { window.__beacons.push(JSON.parse(txt)); } catch { /* non-JSON ignored */ } });
      return true;
    };
  });
}

// Force a flush (the client flushes when the tab goes hidden), then return EVERY
// event captured so far, flattened, oldest first.
async function railEvents(page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  // blob.text() is async; give the capture a beat, then read.
  await page.waitForTimeout(150);
  return page.evaluate(() => (window.__beacons || []).flatMap((b) => b.events.map(({ event, props }) => ({ event, props }))));
}
const named = (events, name) => events.filter((e) => e.event === name);

// A dialog's `close` event is a queued task, so right after `toBeHidden()` the
// event may not have run yet and a flush taken that instant would honestly miss
// it. Poll for the event we are waiting on rather than sleeping a guessed time.
async function railUntil(page, name, count = 1) {
  let last = [];
  await expect.poll(async () => { last = await railEvents(page); return named(last, name).length; }, { timeout: 5_000 }).toBeGreaterThanOrEqual(count);
  return last;
}

async function openDoc(page, url = '/') {
  await captureBeacons(page);
  await page.goto(url);
  await page.setInputFiles('#file-input', FIXTURE);
  await expectFirstPage(page);
}

// The sheet's CTA shows a size once the build has finished; that is the visible
// "bytes are ready" witness the user themselves would see.
const sheetReady = (page) => expect(page.locator('#ds-cta-main')).toContainText(/KB|MB/, { timeout: 15_000 });

test.describe('R4 split / Ekstrak on the rail', () => {
  test('Ekstrak: tool_use halaman/extract on the tap, extract_export when the file exists, and NO export event', async ({ page }) => {
    await openDoc(page);
    await page.click('#btn-pages');
    await expect(page.locator('#pm-sheet')).toBeVisible();
    await page.click('.pm-tile:not(.pm-add) >> nth=0');
    await expect(page.locator('#pm-bulk')).toBeVisible();

    await downloadBytes(page, () => page.click('#pm-bulk [data-act="extract"]'));

    const ev = await railEvents(page);
    expect(named(ev, 'tool_use').map((e) => e.props)).toContainEqual({ tool: 'halaman', action: 'extract' });
    const made = named(ev, 'extract_export');
    expect(made, 'Ekstrak produced a file and the rail was told nothing').toHaveLength(1);
    expect(made[0].props).toMatchObject({ pages: '1', pages_scope: 'some' });
    expect(typeof made[0].props.duration).toBe('number');
    // The reason it is NOT an `export`: api/routine.js and api/cron/watch.js count
    // `export`, and its pairing with export_intent is how abandonment is read.
    expect(named(ev, 'export'), 'Ekstrak leaked into the Unduh sheet\'s event').toHaveLength(0);
    expect(named(ev, 'export_intent')).toHaveLength(0);
  });

  test('Ekstrak with every page selected says pages_scope "all" (a plain copy, not a split)', async ({ page }) => {
    await openDoc(page);
    await page.click('#btn-pages');
    await page.click('.pm-tile:not(.pm-add) >> nth=0');
    await page.click('.pm-tile:not(.pm-add) >> nth=1');
    await downloadBytes(page, () => page.click('#pm-bulk [data-act="extract"]'));
    const made = named(await railEvents(page), 'extract_export');
    expect(made).toHaveLength(1);
    expect(made[0].props).toMatchObject({ pages: '2-5', pages_scope: 'all' });
  });

  test('an intent that auto-opens the page manager is a pages_open (nobody pressed Halaman)', async ({ page }) => {
    // /pisah-pdf declares <body data-intent="split">; dropping a file applies it.
    await openDoc(page, '/pisah-pdf');
    await expect(page.locator('#pm-sheet')).toBeVisible();
    const opens = named(await railEvents(page), 'tool_use').filter((e) => e.props.action === 'pages_open');
    expect(opens, 'the sheet opened by an intent and the rail never heard').toHaveLength(1);
    expect(opens[0].props).toEqual({ tool: 'halaman', action: 'pages_open' });
  });

  test('CONTROL: pressing Halaman is still exactly one pages_open, and opening the sheet is not an extract', async ({ page }) => {
    await openDoc(page);
    await page.click('#btn-pages');
    await expect(page.locator('#pm-sheet')).toBeVisible();
    const ev = await railEvents(page);
    const tools = named(ev, 'tool_use').map((e) => e.props.action);
    expect(tools.filter((a) => a === 'pages_open')).toHaveLength(1);
    expect(tools).not.toContain('extract');
    expect(named(ev, 'extract_export')).toHaveLength(0);
  });
});
