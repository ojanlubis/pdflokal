/*
 * BOOT GUARD, END TO END: a real browser, a deliberately mismatched asset set.
 * ============================================================================
 * ⚠️ WRITTEN BUT NOT RUN by the session that added it (2026-09-07) — port 5050
 * serialises across sessions and the seat owns the single gate run. If this is
 * its first execution, treat a failure as unknown-state, not as a regression.
 *
 * WHY IT HAS TO EXIST ALONGSIDE tests/core/boot-guard.test.mjs: that file runs
 * the snippet against a stubbed window and proves its LOGIC. It cannot prove
 * the premise the whole guard rests on — that a browser reports a module LINK
 * failure (an import naming an export the loaded module does not have) as a
 * window `error` event with a message we can classify. That is a browser
 * behaviour claim, and only a browser can answer it.
 *
 * The mismatch is manufactured the way the deploy manufactures it: the module
 * graph is served as a MIXTURE. js/core/telemetry-schema.js is rewritten on the
 * wire with `ocrLinesBucket` removed, exactly the shape of Sentry JAVASCRIPT-Y/Z
 * (2026-08-25, 08-28), while every sibling is served fresh. The interception is
 * then dropped, so the reload the guard triggers gets a coherent set — which is
 * what a real heal gets once the stale cache is gone.
 */
import { test, expect } from '@playwright/test';

const SCHEMA_URL = /js\/core\/telemetry-schema\.js/;

test('a stale module beside fresh siblings self-heals: exactly one reload, then a booted editor', async ({ page }) => {
  let loads = 0;
  // Counted in the PAGE, not from navigation events: a reload the guard triggers
  // and a navigation Playwright triggers look identical from the outside, and
  // this test's whole verdict is "how many times did the document execute".
  await page.addInitScript(() => { window.__bootCount = (window.__bootCount || 0) + 1; });
  page.on('load', () => { loads++; });

  // THE SKEW. One module served stale (its `ocrLinesBucket` export removed);
  // every sibling untouched and fresh. app.js:30 imports that binding, so the
  // graph fails to LINK — no code in it ever runs.
  await page.route(SCHEMA_URL, async (route) => {
    const res = await route.fetch();
    const body = (await res.text()).replace(/export function ocrLinesBucket/, 'function ocrLinesBucket');
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/javascript' }, body });
  });

  await page.goto('/');

  // The guard empties caches, unregisters the SW and reloads. Drop the skew
  // first-come-first-served: by the time the reload's request lands, the route
  // is gone and the second load gets a coherent set.
  await page.waitForTimeout(500);
  await page.unroute(SCHEMA_URL);

  // The editor booted — the toolbar exists and the module graph is alive.
  await expect(page.locator('#btn-open')).toBeVisible({ timeout: 15000 });
  await page.waitForFunction(() => document.getElementById('fm-pages') !== null);

  // EXACTLY ONE heal. Two would be a loop, zero would mean the browser never
  // dispatched the link failure to window and the guard is decoration.
  expect(loads).toBe(2);
  expect(await page.evaluate(() => window.__bootCount)).toBe(2);

  // And the one-shot is spent, so a later error in this tab cannot reload again.
  expect(await page.evaluate(() => sessionStorage.getItem('pdflokal_boot_healed'))).toBe('1');
});

test('a coherent set does not heal — the guard is inert on a healthy boot', async ({ page }) => {
  let loads = 0;
  page.on('load', () => { loads++; });
  await page.goto('/');
  await expect(page.locator('#btn-open')).toBeVisible();
  await page.waitForTimeout(500);
  expect(loads).toBe(1);
  // The falsifier for the test above: if the guard healed here, the "exactly one
  // reload" assertion there would be measuring the guard's eagerness, not a heal.
  expect(await page.evaluate(() => sessionStorage.getItem('pdflokal_boot_healed'))).toBe(null);
});
