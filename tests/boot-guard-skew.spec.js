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
 * behaviour claim, and only a browser can answer it. tests/module-graph-alive.js
 * already relies on the same mechanism reaching `pageerror`, for the null-DOM
 * half; this covers the missing-export half and the recovery.
 *
 * ⚠️ THREE THINGS THE OBVIOUS VERSION OF THIS TEST GETS WRONG, all of which
 * make a CORRECT guard look broken. Written down because each one cost a read:
 *
 *   1. `page.on('load')` cannot count the heal. The module error fires before
 *      `load`, and purging two empty caches takes milliseconds — so the reload
 *      usually lands before the first document's `load` event ever fires, and a
 *      correct heal reports ONE load. The counter has to live in
 *      sessionStorage, which survives a reload in the same tab.
 *   2. `addInitScript` writing to `window` cannot count it either: every
 *      document gets a fresh window, so the count is always 1.
 *   3. The stale route must serve the stale body EXACTLY ONCE, not be removed
 *      on a timer. The reload re-requests the module within milliseconds; a
 *      route still armed serves it stale a second time, the second boot dies
 *      too, the guard correctly reports 'repeat' and does NOT reload — and the
 *      test fails having measured its own race.
 */
import { test, expect } from '@playwright/test';

const BOOTS = `sessionStorage.setItem('__boots', String(Number(sessionStorage.getItem('__boots') || 0) + 1));`;

async function boots(page) {
  // Tolerates the execution context being destroyed mid-navigation, which is
  // exactly what this test is trying to observe.
  try {
    return await page.evaluate(() => Number(sessionStorage.getItem('__boots') || 0));
  } catch {
    return -1;
  }
}

test('a stale module beside fresh siblings self-heals: exactly one reload, then a booted editor', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(BOOTS);

  // THE SKEW. One module served stale (its `ocrLinesBucket` export removed);
  // every sibling untouched and fresh. app.js imports that binding, so the graph
  // fails to LINK and no code in it ever runs. ONCE — see note 3 above.
  let served = false;
  await page.route(/js\/core\/telemetry-schema\.js/, async (route) => {
    if (served) { await route.continue(); return; }
    served = true;
    const res = await route.fetch();
    const body = (await res.text()).replace(/export function ocrLinesBucket/, 'function ocrLinesBucket');
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/javascript' }, body });
  });

  // `commit`, not the default `load`: the guard's reload interrupts the first
  // navigation, and goto() waiting on `load` can reject on that interruption.
  await page.goto('/', { waitUntil: 'commit' });

  // The heal happened: the document executed twice in this tab.
  await expect.poll(() => boots(page), { timeout: 20000 }).toBe(2);
  await page.waitForLoadState('networkidle');

  // The SECOND boot was clean. Exactly one throw in the whole test — the skewed
  // first load. A second entry would mean the reload did not fix anything.
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatch(/ocrLinesBucket|does not provide an export|Importing binding|import not found/);

  // The editor is alive, and the one-shot is spent so nothing can loop.
  await expect(page.locator('#btn-open')).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('pdflokal_boot_healed'))).toBe('1');
  expect(await boots(page)).toBe(2); // still 2 — it did not keep reloading
});

test('a coherent set does not heal — the guard is inert on a healthy boot', async ({ page }) => {
  // The falsifier for the test above. Without it, "exactly one reload" could be
  // measuring the guard's eagerness rather than a heal.
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(BOOTS);

  await page.goto('/');
  await expect(page.locator('#btn-open')).toBeVisible();
  await page.waitForLoadState('networkidle');

  expect(errors).toEqual([]);
  expect(await boots(page)).toBe(1);
  expect(await page.evaluate(() => sessionStorage.getItem('pdflokal_boot_healed'))).toBe(null);
});
