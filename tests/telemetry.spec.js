/*
 * PDFLokal — telemetry client integration spec (spec-telemetry.md).
 *
 * WHY an in-page sendBeacon override, not page.route: `npx serve` (this suite's
 * dev server) has no /api runtime — there is no Vercel function to hit locally,
 * so the seam has to be the browser. sendBeacon is a fire-and-forget BACKGROUND
 * request; intercepting it at Playwright's network layer is unreliable headless
 * — it CI-flaked (the 10-event flush timed out on GitHub Actions while passing
 * locally, PR #123). Overriding the exact API the client calls
 * (navigator.sendBeacon) is deterministic: no network round-trip, no
 * interception race, we read the payload the client actually built. api/t.js's
 * own logic (validation, caps, the Supabase insert) is Node code with zero
 * browser surface and lives in tests/core/telemetry-schema.test.mjs.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_PDF = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');

// Installs an in-page navigator.sendBeacon override that parses each beacon's
// JSON Blob onto window.__beacons. MUST run before page.goto (addInitScript
// executes on every navigation, before page scripts) so the override is in
// place the instant the telemetry module first flushes. blob.text() is async;
// the tests poll window.__beacons, which absorbs that microtask latency.
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

// The parsed beacon payloads captured so far, newest-inclusive snapshot.
function beaconBodies(page) {
  return page.evaluate(() => (window.__beacons || []).slice());
}

// visibilityState is normally read-only — this is the standard way to fake
// a tab going hidden in a headless browser (no real second tab to switch to).
function fakeTabHidden(page) {
  return page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

test.describe('telemetry client', () => {
  test('batches events and flushes at the 10-event threshold with the right envelope shape', async ({ page }) => {
    await captureBeacons(page);
    await page.goto('/');

    await page.evaluate(async () => {
      const { tel } = await import('/js/v2/telemetry.js');
      for (let i = 0; i < 10; i += 1) tel('tool_use', { tool: 'teks', action: 'text' });
    });

    await expect.poll(async () => (await beaconBodies(page)).length).toBe(1);
    const payload = (await beaconBodies(page))[0];
    // (b) payload shape: {session_id, app_version, events:[...]}
    expect(payload).toHaveProperty('session_id');
    expect(payload.session_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(payload).toHaveProperty('app_version');
    expect(typeof payload.app_version).toBe('string');
    expect(Array.isArray(payload.events)).toBe(true);
    expect(payload.events).toHaveLength(10);
    // Each event carries `dt` — ms before THIS flush — so the server can derive a
    // per-event ts instead of stamping one batch time for all ten. Asserted as
    // part of the envelope shape, not stripped: it IS the contract now.
    const { dt, ...first } = payload.events[0];
    expect(first).toEqual({ event: 'tool_use', props: { tool: 'teks', action: 'text' } });
    expect(typeof dt).toBe('number');
    expect(dt).toBeGreaterThanOrEqual(0);
    expect(dt).toBeLessThan(60_000);
    // Ten events queued in one tick must not all report the same offset ordering
    // problem: dt is non-increasing as you walk the batch (earlier events are older).
    const dts = payload.events.map((e) => e.dt);
    expect(dts.every((v, i) => i === 0 || dts[i - 1] >= v)).toBe(true);
  });

  test('(a) flushes on visibilitychange:hidden even under the 10-event threshold', async ({ page }) => {
    await captureBeacons(page);
    await page.goto('/');

    await page.evaluate(async () => {
      const { tel } = await import('/js/v2/telemetry.js');
      tel('ganti_tap', { hit: true });
      tel('ganti_tap', { hit: false });
    });
    expect(await beaconBodies(page)).toHaveLength(0); // nothing sent yet — under threshold, tab still visible

    await fakeTabHidden(page);

    await expect.poll(async () => (await beaconBodies(page)).length).toBe(1);
    expect((await beaconBodies(page))[0].events).toHaveLength(2);
  });

  test('(c) an off-schema event never appears in any flush', async ({ page }) => {
    await captureBeacons(page);
    await page.goto('/');

    await page.evaluate(async () => {
      const { tel } = await import('/js/v2/telemetry.js');
      tel('not_a_real_event', { anything: 'goes' });               // unknown event
      tel('doc_open', { text_layer: true, pages: '1', device: 'smart-fridge' }); // bad enum value
      tel('tool_use', { tool: 'teks' });                            // missing required prop "action"
      for (let i = 0; i < 10; i += 1) tel('ganti_tap', { hit: true }); // 10 valid — trips the flush
    });

    await expect.poll(async () => (await beaconBodies(page)).length).toBe(1);
    const events = (await beaconBodies(page))[0].events;
    expect(events).toHaveLength(10);
    expect(events.every((e) => e.event === 'ganti_tap')).toBe(true);
  });

  test('(d) doc_open fires on import with valid props', async ({ page }) => {
    await captureBeacons(page);
    await page.goto('/');

    await page.setInputFiles('#file-input', SAMPLE_PDF);
    await expectFirstPage(page);

    // doc_open alone won't trip the 10-event threshold — force the flush the
    // same way a real navigating-away user would (spec §2's own mitigation).
    await fakeTabHidden(page);

    await expect.poll(async () => (await beaconBodies(page)).length).toBeGreaterThan(0);
    const events = (await beaconBodies(page)).flatMap((b) => b.events);
    const docOpen = events.find((e) => e.event === 'doc_open');
    expect(docOpen).toBeTruthy();
    // fixtures/sample-2pages.pdf has real "(Test Page N) Tj" show-text ops on
    // both pages (born-digital, not a scan) — text_layer must read true; the
    // file is 2 pages → pagesBucket puts it in '2-5'; Desktop Chrome's default
    // viewport (>900px) reads as 'desktop' (js/v2/app.js's deviceClass()).
    // No ?buat= and a bare homepage → intent is 'none'.
    expect(docOpen.props).toEqual({ text_layer: true, pages: '2-5', device: 'desktop', intent: 'none', display_mode: 'browser' });
  });

  test('(e) doc_open carries the declared intent from ?buat=', async ({ page }) => {
    await captureBeacons(page);
    await page.goto('/?buat=kompres'); // the SEO /kompres-pdf landing arrives this way

    await page.setInputFiles('#file-input', SAMPLE_PDF);
    await expectFirstPage(page);
    await fakeTabHidden(page);

    await expect.poll(async () => (await beaconBodies(page)).length).toBeGreaterThan(0);
    const docOpen = (await beaconBodies(page)).flatMap((b) => b.events).find((e) => e.event === 'doc_open');
    expect(docOpen).toBeTruthy();
    expect(docOpen.props.intent).toBe('kompres'); // the "what did they come to do" answer, first-party
  });

  test('(f) a merge-add fires the first-party gabung signal', async ({ page }) => {
    await captureBeacons(page);
    await page.goto('/');

    await page.setInputFiles('#file-input', SAMPLE_PDF); // first load: NOT a merge
    await expectFirstPage(page);
    await page.setInputFiles('#file-input', SAMPLE_PDF); // second load onto an open doc: a merge
    await expect.poll(async () => page.evaluate(() => window.v2.getDoc().pages.length)).toBe(4);
    await fakeTabHidden(page);

    await expect.poll(async () => (await beaconBodies(page)).length).toBeGreaterThan(0);
    const events = (await beaconBodies(page)).flatMap((b) => b.events);
    expect(events.map(({ dt, ...e }) => e)) // eslint-disable-line no-unused-vars
      .toContainEqual({ event: 'tool_use', props: { tool: 'gabung', action: 'merge' } });
    // and the FIRST load must NOT have emitted one — merge is second-load-only
    const merges = events.filter((e) => e.event === 'tool_use' && e.props.tool === 'gabung');
    expect(merges).toHaveLength(1);
  });

  test('(g) export records the download CHOICES (format/size/pages_scope)', async ({ page }) => {
    await captureBeacons(page);
    await page.goto('/');

    await page.setInputFiles('#file-input', SAMPLE_PDF);
    await expectFirstPage(page);

    await page.click('#btn-download');
    await expect(page.locator('#dl-sheet')).toBeVisible();
    const dl = page.waitForEvent('download');
    await page.click('#ds-cta');
    await dl;
    await fakeTabHidden(page); // flush the batched export beacon

    await expect.poll(async () => (await beaconBodies(page)).length).toBeGreaterThan(0);
    const exp = (await beaconBodies(page)).flatMap((b) => b.events).find((e) => e.event === 'export');
    expect(exp).toBeTruthy();
    // A plain, unmodified PDF download: the defaults the sheet opens with.
    expect(exp.props).toMatchObject({ format: 'pdf', size: 'asli', pages_scope: 'all' });
  });
});
