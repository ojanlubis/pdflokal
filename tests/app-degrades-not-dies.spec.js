/*
 * A MISSING ELEMENT COSTS ONE CONTROL, IN A REAL BROWSER.
 * ============================================================================
 * ⚠️ WRITTEN BUT NOT RUN by the session that added it (2026-09-07) — port 5050
 * serialises across sessions and the seat owns the single gate run.
 *
 * tests/core/app-boot-dom-guards.test.mjs proves the on() helper declines and
 * that no top-level dereference is left in the source. Neither is the
 * user-facing claim, which is: with an element genuinely absent, THE EDITOR
 * STILL BOOTS. Only a browser executing the real module graph can say that.
 *
 * The exact incident is reproduced — HTML without `id="fm-pages"` served beside
 * a fresh app.js (Sentry JAVASCRIPT-V/J, 6 events, 2026-08-18 → 08-30). Before
 * the guards this took down the whole product; the claim now is that it takes
 * down the File-menu's "Kelola Halaman" row and nothing else.
 *
 * It asserts on `pageerror` for the same reason tests/module-graph-alive.spec.js
 * does: the failure this covers renders a page that LOOKS perfect and has every
 * control dead, so "the page loaded" proves nothing.
 *
 * ⚠️ NO CLICK ON #btn-file. It ships `disabled` in the empty state, so
 * `click()` would wait for enabled and time out at 30s — a red that says
 * nothing about the guards. Presence in the DOM is the whole claim here: those
 * two rows were bound AFTER #fm-pages in source order, so before the guards
 * they were collateral damage of the very same throw.
 */
import { test, expect } from '@playwright/test';

test('HTML missing #fm-pages: the editor still boots, only that one row is dead', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(`sessionStorage.setItem('__boots', String(Number(sessionStorage.getItem('__boots') || 0) + 1));`);

  // A predicate, not a literal origin string: the base URL belongs to
  // playwright.config.js and hard-coding it here would break the day it moves.
  await page.route((url) => url.pathname === '/', async (route) => {
    const res = await route.fetch();
    const body = (await res.text()).replace(/\sid="fm-pages"/, '');
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body });
  });

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // THE CLAIM: nothing threw during module evaluation, so the graph is alive.
  expect(
    errors,
    'app.js threw while evaluating with #fm-pages absent — a single missing element is still '
    + 'taking down the whole module graph, which is the defect the on() helper exists to end.',
  ).toEqual([]);

  await expect(page.locator('#fm-pages')).toHaveCount(0); // genuinely absent — the fixture is real
  await expect(page.locator('#btn-open')).toBeVisible();
  await expect(page.locator('#btn-file')).toBeVisible();

  // The siblings bound after it survived.
  await expect(page.locator('#fm-add')).toHaveCount(1);
  await expect(page.locator('#fm-new')).toHaveCount(1);

  // And the boot guard did NOT fire: there was no error for it to fire on.
  expect(await page.evaluate(() => Number(sessionStorage.getItem('__boots') || 0))).toBe(1);
  expect(await page.evaluate(() => sessionStorage.getItem('pdflokal_boot_healed'))).toBe(null);
});
