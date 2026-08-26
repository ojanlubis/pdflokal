/*
 * THE REV PIN: one page load carries ONE build, even as deploys land under it.
 * ============================================================================
 * This is the property the low-risk list's EXPORT-PATH row depends on. Auto-push
 * assumes we can tell whether a defect belongs to the build we just shipped, and
 * before /api/rev we could not: api/t.js stamped the SERVER's deploy SHA at the
 * moment each BATCH ARRIVED, so one 82-minute session on 2026-07-28 carried FOUR
 * versions. Nothing had reloaded; four deploys had simply landed while it was
 * flushing.
 *
 * ⚠️ WHY A TEST AND NOT THE LIVE RAIL. The rail says 123 of 123 sessions carry
 * exactly one version, worst case one. That reads like proof and is not: in the
 * deploy-dense window, the number of sessions ALIVE at the moment a new build
 * first appeared was ZERO. A clean result with no opportunity to fail is
 * indistinguishable from a broken pin. That is the empty-set rule landing on the
 * fix built to close the previous instance of the empty-set rule.
 *
 * So this manufactures the opportunity: serve SHA A, let the page pin it, then
 * change the endpoint to B mid-session and demand the batches still say A.
 *
 * WHAT IT DOES NOT COVER: the server half (api/t.js preferring a real client SHA
 * over its own) is pinned headlessly in tests/core/app-version-attribution.test.mjs
 * test 6, proven red on revert to server-precedence. This file is the client half.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'nasty', 'surat-word.pdf');

const SHA_A = 'aaaaaaa1111111111111111111111111111aaaa1';
const SHA_B = 'bbbbbbb2222222222222222222222222222bbbb2';

// Capture every telemetry envelope the page sends.
async function captureRail(page) {
  await page.addInitScript(() => {
    window.__rail = [];
    const push = (txt) => { try { window.__rail.push(JSON.parse(txt)); } catch { /* non-JSON */ } };
    navigator.sendBeacon = (url, blob) => {
      if (String(url).includes('/api/t')) {
        Promise.resolve(blob && blob.text ? blob.text() : blob).then(push);
      }
      return true;
    };
    const orig = window.fetch ? window.fetch.bind(window) : null;
    window.fetch = (url, opts) => {
      if (typeof url === 'string' && url.includes('/api/t') && opts?.body) push(String(opts.body));
      return orig ? orig(url, opts) : Promise.resolve(new Response('{}'));
    };
  });
}

const flush = async (page) => page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
});

const versions = async (page) => page.evaluate(() =>
  (window.__rail || []).filter((b) => b && b.events && b.events.length).map((b) => b.app_version));

test.describe('client build pin', () => {
  test('a deploy landing mid-session does NOT change the version the page reports', async ({ page }) => {
    // Serve A, and let the route be swappable underneath the page.
    // /api/rev is a Vercel FUNCTION, so it does not exist under `npx serve`;
    // stubbing it is required, not a convenience. Counting hits is also how the
    // pin is proven: a client that re-read the endpoint would show up here.
    let current = SHA_A;
    let revHits = 0;
    await page.route((u) => u.pathname === '/api/rev', (r) => {
      revHits += 1;
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'cache-control': 'no-store' },
        body: JSON.stringify({ rev: current }),
      });
    });
    await captureRail(page);
    await page.goto('/');

    // The pin is fetched at init and is not awaited, so wait for it to land
    // rather than racing it. Polling on the rail itself would conflate "not
    // pinned yet" with "pin broken".
    await expect.poll(() => revHits, { timeout: 15_000 }).toBeGreaterThan(0);
    await page.waitForTimeout(400);

    // A real event source: opening a document emits doc_open. window.v2.getTool()
    // emits nothing, so flushing after it produced zero batches and the first
    // draft of this test failed for its own reasons rather than the pin's.
    await page.setInputFiles('#file-input', FIXTURE);
    await expectFirstPage(page);
    await flush(page);
    await expect.poll(async () => (await versions(page)).length, { timeout: 20_000 }).toBeGreaterThan(0);
    const first = await versions(page);
    expect(first[0], 'the page never adopted the served SHA').toBe(SHA_A);

    // ---- A NEW BUILD GOES LIVE, mid-session ----
    current = SHA_B;

    // VACUITY GUARD. Re-fetching /api/rev from the page to "prove" the swap was
    // the wrong instrument: the endpoint does not exist locally, so that fetch
    // returned the static server's HTML and the guard failed for its own
    // reasons. What actually proves the stub is live is that the route was hit
    // at all, and what proves the PIN is that it is never hit again.
    expect(revHits, 'the /api/rev stub was never reached, so nothing here is under test').toBeGreaterThan(0);
    const hitsBefore = revHits;

    // More activity, more flushes — and the activity has to be an event source
    // that actually FIRES, which re-importing the fixture is not.
    //
    // WHY NOT setInputFiles here: with a document already open, feeding the same
    // file to #file-input emits nothing at all. Instrumenting the rail through
    // this loop showed the batch count flat at 1 across the first iteration; the
    // second batch only appeared when some incidental event happened to fire, so
    // the assertion below was really polling on luck and failed ~2 runs in 3.
    // Clearing input.value and restoring visibilityState were both tried and
    // neither brought doc_open back — the app does not re-open a document it is
    // already showing, which is correct behaviour and not the thing under test.
    //
    // Opening the page manager is a real user action carrying a guaranteed event
    // (tool_use/pages_open — the single openPagesSheet() in js/v2/app.js, which
    // that function's own comment explains is deliberately the only call site),
    // so every iteration now has something real to flush. The property under
    // test is untouched: still >1 batch, still every batch pinned to SHA_A.
    for (let i = 0; i < 2; i++) {
      await page.click('#btn-pages');
      await page.click('#pm-close');
      await flush(page);
      await page.waitForTimeout(200);
    }
    await expect.poll(async () => (await versions(page)).length, { timeout: 15_000 }).toBeGreaterThan(1);

    const all = await versions(page);
    expect(all.length, 'only one batch was captured, so nothing spans the deploy').toBeGreaterThan(1);

    // The pin is a ONE-SHOT read. A client that re-read per flush would both
    // bump this and start reporting SHA_B, which is the defect being guarded.
    expect(
      revHits, `the page re-read /api/rev ${revHits - hitsBefore} more time(s) after the deploy. `
      + 'The version is meant to be pinned at page load; re-reading it reintroduces exactly the '
      + 'drift /api/rev was built to remove.',
    ).toBe(hitsBefore);

    // THE PROPERTY THE LIST DEPENDS ON: one page load, one build.
    expect(
      [...new Set(all)],
      `this session reported ${new Set(all).size} builds: ${JSON.stringify(all)}. A deploy landing `
      + 'mid-session changed what the page claims to be running, so a failure can no longer be '
      + 'attributed to the build that produced it.',
    ).toEqual([SHA_A]);
  });

  test('an unreachable /api/rev degrades to "dev", never to a guess', async ({ page }) => {
    // Offline at load means the honest answer is "I do not know", and api/t.js
    // then falls back to its own deploy SHA. Inventing one would be worse than
    // the problem this endpoint solves.
    await page.route('**/api/rev', (r) => r.abort());
    await captureRail(page);
    await page.goto('/');
    await page.waitForTimeout(800);
    await page.setInputFiles('#file-input', FIXTURE);
    await expectFirstPage(page);
    await flush(page);
    await expect.poll(async () => (await versions(page)).length, { timeout: 15_000 }).toBeGreaterThan(0);
    const all = await versions(page);
    expect([...new Set(all)]).toEqual(['dev']);
  });
});
