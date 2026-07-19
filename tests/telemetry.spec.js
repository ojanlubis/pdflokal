/*
 * PDFLokal — telemetry client integration spec (spec-telemetry.md).
 *
 * WHY page.route, not a real endpoint: `npx serve` (this suite's dev server —
 * see playwright.config.js) has no /api runtime at all — there is no Vercel
 * function to hit locally. Route interception at the browser's network layer
 * is the correct integration seam here: navigator.sendBeacon is a real
 * network request Playwright can intercept, so this proves the CLIENT builds
 * the right envelope and calls the right endpoint — everything testable
 * without a deployed function. api/t.js's own logic (validation, caps, the
 * Supabase insert) is Node code with zero DOM/browser surface and belongs in
 * its own unit coverage, not here.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_PDF = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');

// Intercepts every beacon POST to /api/t and returns the array it appends
// parsed bodies to. sendBeacon's body is a Blob of JSON — postDataJSON()
// parses it for us.
async function captureBeacons(page) {
  const bodies = [];
  await page.route('**/api/t', async (route) => {
    bodies.push(route.request().postDataJSON());
    await route.fulfill({ status: 204, body: '' });
  });
  return bodies;
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
    await page.goto('/');
    const bodies = await captureBeacons(page);

    await page.evaluate(async () => {
      const { tel } = await import('/js/v2/telemetry.js');
      for (let i = 0; i < 10; i += 1) tel('tool_use', { tool: 'teks', action: 'text' });
    });

    await expect.poll(() => bodies.length).toBe(1);
    const payload = bodies[0];
    // (b) payload shape: {session_id, app_version, events:[...]}
    expect(payload).toHaveProperty('session_id');
    expect(payload.session_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(payload).toHaveProperty('app_version');
    expect(typeof payload.app_version).toBe('string');
    expect(Array.isArray(payload.events)).toBe(true);
    expect(payload.events).toHaveLength(10);
    expect(payload.events[0]).toEqual({ event: 'tool_use', props: { tool: 'teks', action: 'text' } });
  });

  test('(a) flushes on visibilitychange:hidden even under the 10-event threshold', async ({ page }) => {
    await page.goto('/');
    const bodies = await captureBeacons(page);

    await page.evaluate(async () => {
      const { tel } = await import('/js/v2/telemetry.js');
      tel('ganti_tap', { hit: true });
      tel('ganti_tap', { hit: false });
    });
    expect(bodies).toHaveLength(0); // nothing sent yet — under threshold, tab still visible

    await fakeTabHidden(page);

    await expect.poll(() => bodies.length).toBe(1);
    expect(bodies[0].events).toHaveLength(2);
  });

  test('(c) an off-schema event never appears in any flush', async ({ page }) => {
    await page.goto('/');
    const bodies = await captureBeacons(page);

    await page.evaluate(async () => {
      const { tel } = await import('/js/v2/telemetry.js');
      tel('not_a_real_event', { anything: 'goes' });               // unknown event
      tel('doc_open', { text_layer: true, pages: '1', device: 'smart-fridge' }); // bad enum value
      tel('tool_use', { tool: 'teks' });                            // missing required prop "action"
      for (let i = 0; i < 10; i += 1) tel('ganti_tap', { hit: true }); // 10 valid — trips the flush
    });

    await expect.poll(() => bodies.length).toBe(1);
    const events = bodies[0].events;
    expect(events).toHaveLength(10);
    expect(events.every((e) => e.event === 'ganti_tap')).toBe(true);
  });

  test('(d) doc_open fires on import with valid props', async ({ page }) => {
    await page.goto('/');
    const bodies = await captureBeacons(page);

    await page.setInputFiles('#file-input', SAMPLE_PDF);
    await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();

    // doc_open alone won't trip the 10-event threshold — force the flush the
    // same way a real navigating-away user would (spec §2's own mitigation).
    await fakeTabHidden(page);

    await expect.poll(() => bodies.length).toBeGreaterThan(0);
    const events = bodies.flatMap((b) => b.events);
    const docOpen = events.find((e) => e.event === 'doc_open');
    expect(docOpen).toBeTruthy();
    // fixtures/sample-2pages.pdf has real "(Test Page N) Tj" show-text ops on
    // both pages (born-digital, not a scan) — text_layer must read true; the
    // file is 2 pages → pagesBucket puts it in '2-5'; Desktop Chrome's default
    // viewport (>900px) reads as 'desktop' (js/v2/app.js's deviceClass()).
    expect(docOpen.props).toEqual({ text_layer: true, pages: '2-5', device: 'desktop' });
  });
});
