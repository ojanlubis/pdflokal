/*
 * THE THREE GAPS THE RAIL COULD NOT SEE (2026-10-02) — driven end to end.
 * ============================================================================
 *   R4  split / Ekstrak: the tap, the file it produces, and the Halaman sheet
 *       opened FOR the user by an intent (/pisah-pdf, the Halaman card).
 *   R5  the Unduh sheet's close: how it closed, whether bytes were ready, how
 *       long it was open — so "build never finished" and "closed by accident"
 *       stop looking identical.
 *   0a  the +/- zoom buttons, so the fit-width opening (913eb38) can be judged.
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

test.describe('R5 export_sheet_close', () => {
  test('X: how "x", built true once the size is on the button, waited_ms is a real duration', async ({ page }) => {
    await openDoc(page);
    await page.click('#btn-download');
    await sheetReady(page);
    await page.click('#ds-close');
    await expect(page.locator('#dl-sheet')).toBeHidden();

    const ev = await railUntil(page, 'export_sheet_close');
    const closes = named(ev, 'export_sheet_close');
    expect(closes).toHaveLength(1);
    expect(closes[0].props).toMatchObject({ how: 'x', built: true });
    expect(closes[0].props.waited_ms).toBeGreaterThan(0);
    // The pairing the schema note promises: one open, one close.
    expect(named(ev, 'export_intent')).toHaveLength(1);
  });

  test('Escape and backdrop are told apart from the X', async ({ page }) => {
    await openDoc(page);

    await page.click('#btn-download');
    await sheetReady(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('#dl-sheet')).toBeHidden();

    await page.click('#btn-download');
    await sheetReady(page);
    // A click ON the <dialog> itself (outside the sheet's content) is the backdrop.
    await page.evaluate(() => document.getElementById('dl-sheet').click());
    await expect(page.locator('#dl-sheet')).toBeHidden();

    const closes = named(await railUntil(page, 'export_sheet_close', 2), 'export_sheet_close').map((e) => e.props.how);
    expect(closes).toEqual(['escape', 'backdrop']);
  });

  test('a download closes the sheet itself: how "export", and the export event fires too', async ({ page }) => {
    await openDoc(page);
    await page.click('#btn-download');
    await sheetReady(page);
    await downloadBytes(page, () => page.click('#ds-cta'));
    await expect(page.locator('#dl-sheet')).toBeHidden();

    const ev = await railUntil(page, 'export_sheet_close');
    expect(named(ev, 'export')).toHaveLength(1);
    const closes = named(ev, 'export_sheet_close');
    expect(closes).toHaveLength(1);
    expect(closes[0].props).toMatchObject({ how: 'export', built: true });
  });

  test('closed BEFORE the build finished: built is false (the case the rail could not separate)', async ({ page }) => {
    await openDoc(page);
    // An untouched single-source PDF is handed back as its original bytes
    // (core/export.js passThroughSource) and never reaches pdf-lib, so there would
    // be no build to hold. One text annotation forces the real rebuild.
    await page.click('[data-tool="text"]');
    await page.click('.pv-page >> nth=0', { position: { x: 120, y: 180 } });
    await page.keyboard.type('Uji tutup');
    await page.keyboard.press('Enter');
    // Hold the build back for real: buildBase() cannot finish until the gate
    // opens, so a close inside that window is a genuine "build never finished",
    // not a flag set by the test. (Routing pdf-lib's script was tried first and
    // proved nothing: the library is already loaded by the time a document is open.)
    await page.evaluate(async () => {
      const { ensurePdfLib } = await import('/js/core/vendor.js');
      const { PDFLib } = await ensurePdfLib();
      const gate = new Promise((r) => { window.__releaseBuild = r; });
      const orig = PDFLib.PDFDocument.create.bind(PDFLib.PDFDocument);
      PDFLib.PDFDocument.create = async (...a) => { await gate; return orig(...a); };
    });

    await page.click('#btn-download');
    await expect(page.locator('#dl-sheet')).toBeVisible();
    await expect(page.locator('#ds-cta-main .ds-spin')).toBeVisible(); // still building
    await page.click('#ds-close');
    await expect(page.locator('#dl-sheet')).toBeHidden();
    await page.evaluate(() => window.__releaseBuild());

    const closes = named(await railUntil(page, 'export_sheet_close'), 'export_sheet_close');
    expect(closes).toHaveLength(1);
    expect(closes[0].props).toMatchObject({ how: 'x', built: false });
  });
});

test.describe('0a zoom buttons', () => {
  const zoomNow = (page) => page.evaluate(() => Number(/scale\(([\d.]+)\)/.exec(document.getElementById('v2-stage').style.transform)[1]));

  test('each press reports its direction and the zoom BEFORE the press, and the zoom still happens', async ({ page }) => {
    await openDoc(page);
    const z0 = await zoomNow(page);

    await page.click('#z-out');
    const z1 = await zoomNow(page);
    await page.click('#z-in');
    const z2 = await zoomNow(page);
    expect(z1, 'telemetry stopped the zoom').toBeLessThan(z0);
    expect(z2).toBeGreaterThan(z1);

    const taps = named(await railEvents(page), 'zoom_tap').map((e) => e.props);
    expect(taps).toHaveLength(2);
    const bucket = (z) => {
      const p = Math.round(z * 100);
      return p < 60 ? '<60' : p < 100 ? '60-99' : p < 150 ? '100-149' : p < 200 ? '150-199' : p < 250 ? '200-249' : '250+';
    };
    // Independent re-statement of the cuts: the event must carry the zoom the
    // user was looking at when they pressed, not the one they got.
    expect(taps[0]).toEqual({ dir: 'out', level: bucket(z0), device: 'desktop' });
    expect(taps[1]).toEqual({ dir: 'in', level: bucket(z1), device: 'desktop' });
  });

  test('pressing + at the 300% ceiling still reports (wanting more than the ceiling is a signal)', async ({ page }) => {
    await openDoc(page);
    for (let i = 0; i < 12; i += 1) await page.click('#z-in');
    expect(await zoomNow(page)).toBe(3);
    const taps = named(await railEvents(page), 'zoom_tap').map((e) => e.props);
    expect(taps).toHaveLength(12);
    expect(taps.at(-1)).toEqual({ dir: 'in', level: '250+', device: 'desktop' });
  });
});
